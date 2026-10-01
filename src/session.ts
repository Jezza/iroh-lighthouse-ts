/**
 * A topic membership that keeps itself registered and watches the others.
 *
 * Mirrors the Rust `Session`: re-announce at half the granted TTL, poll for
 * membership changes in between, back off when the lighthouse is unreachable,
 * and unregister on leave.
 *
 * Browser-specific behaviour worth knowing about:
 *
 * - Timers are throttled or suspended in background tabs, so a session can
 *   miss its keep-alive and age out. The session re-announces immediately on
 *   `visibilitychange` back to visible, rather than waiting for a timer that
 *   may be long overdue.
 * - A page that is closed never gets to call {@link Session.leave}, so the
 *   entry would linger until its TTL expired. A `pagehide` handler sends a
 *   best-effort unregister via `sendBeacon`.
 */

import type { Lighthouse } from "./client.js";
import { LighthouseError, type EndpointAddr, type Peer } from "./protocol.js";
import type { NodeKey, Topic } from "./topic.js";

/** How often a session polls the topic unless told otherwise. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

const MIN_REFRESH_MS = 1_000;
const INITIAL_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;

/** Called when the membership changes. */
export type PeersListener = (peers: Peer[]) => void;

export interface JoinOptions {
  /** Requested registration lifetime. Default 1 hour. */
  ttlSecs?: number;
  /** How often to poll for membership changes. `null` disables polling. */
  pollIntervalMs?: number | null;
  /**
   * Re-announce when the tab becomes visible again. Default true.
   *
   * Background tabs have their timers throttled, so without this a session
   * can silently age out while the user is on another tab.
   */
  refreshOnVisible?: boolean;
  /**
   * Try to unregister when the page goes away. Default true.
   *
   * Uses `sendBeacon`, which is best-effort by design: the browser may drop
   * it. The TTL is the real guarantee.
   */
  leaveOnUnload?: boolean;
}

/**
 * A live registration on one topic.
 *
 * Get one from {@link join}. Subscribe with {@link Session.onPeers}, and call
 * {@link Session.leave} when you are done.
 */
export class Session {
  readonly topic: Topic;
  #peers: Peer[] = [];
  #listeners = new Set<PeersListener>();
  #announceTimer: ReturnType<typeof setTimeout> | undefined;
  #pollTimer: ReturnType<typeof setTimeout> | undefined;
  #backoff = INITIAL_BACKOFF_MS;
  #closed = false;
  #cleanup: Array<() => void> = [];

  private constructor(
    private readonly lighthouse: Lighthouse,
    private readonly key: NodeKey,
    topic: Topic,
    private readonly addr: EndpointAddr,
    private readonly ttlSecs: number,
    private readonly pollIntervalMs: number | null,
  ) {
    this.topic = topic;
  }

  /** The other members as of the last successful announce or poll. */
  get peers(): Peer[] {
    return this.#peers;
  }

  /**
   * Subscribe to membership changes. Returns an unsubscribe function.
   *
   * The listener fires only when the set of members or one of their addresses
   * actually changes — not on every poll, and not when a TTL merely ticks
   * down. It is called immediately with the current list.
   */
  onPeers(listener: PeersListener): () => void {
    this.#listeners.add(listener);
    listener(this.#peers);
    return () => this.#listeners.delete(listener);
  }

  /** Announce now, outside the regular schedule, and return the members. */
  async refresh(): Promise<Peer[]> {
    const announced = await this.lighthouse.announce(
      this.key,
      this.topic,
      this.addr,
      this.ttlSecs,
    );
    this.#publish(announced.peers);
    return this.#peers;
  }

  /** Unregister and stop all background work. */
  async leave(): Promise<void> {
    if (this.#closed) return;
    this.#stop();
    await this.lighthouse.announce(this.key, this.topic, this.addr, 0);
  }

  /** Stop background work without unregistering; the entry ages out. */
  close(): void {
    this.#stop();
  }

  /** @internal */
  static async start(
    lighthouse: Lighthouse,
    key: NodeKey,
    topic: Topic,
    addr: EndpointAddr,
    options: JoinOptions,
  ): Promise<Session> {
    const ttlSecs = options.ttlSecs ?? 3600;
    const pollIntervalMs =
      options.pollIntervalMs === null
        ? null
        : Math.max(options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, MIN_REFRESH_MS);

    const session = new Session(lighthouse, key, topic, addr, ttlSecs, pollIntervalMs);
    const announced = await lighthouse.announce(key, topic, addr, ttlSecs);
    session.#publish(announced.peers);
    session.#scheduleAnnounce(announced.ttlSecs);
    session.#schedulePoll();
    if (options.refreshOnVisible ?? true) session.#watchVisibility();
    if (options.leaveOnUnload ?? true) session.#watchUnload();
    return session;
  }

  #stop(): void {
    this.#closed = true;
    clearTimeout(this.#announceTimer);
    clearTimeout(this.#pollTimer);
    for (const undo of this.#cleanup) undo();
    this.#cleanup = [];
    this.#listeners.clear();
  }

  /**
   * Store `next` and notify listeners only if membership or an address moved.
   *
   * Comparing ids alone would miss a peer that changed address, which is one
   * of the events callers most want to know about.
   */
  #publish(next: Peer[]): void {
    const key = (peers: Peer[]) =>
      peers
        .map((p) => `${p.addr.id}|${JSON.stringify(p.addr.addrs)}`)
        .sort()
        .join(",");
    const changed = key(this.#peers) !== key(next);
    this.#peers = next;
    if (!changed) return;
    for (const listener of this.#listeners) {
      try {
        listener(next);
      } catch (err) {
        // A throwing listener must not take down the session's timers.
        console.error("iroh-lighthouse: peers listener threw", err);
      }
    }
  }

  #scheduleAnnounce(grantedTtlSecs: number): void {
    if (this.#closed) return;
    clearTimeout(this.#announceTimer);
    const delay = Math.max((grantedTtlSecs * 1000) / 2, MIN_REFRESH_MS);
    this.#announceTimer = setTimeout(() => void this.#announce(), delay);
  }

  #schedulePoll(): void {
    if (this.#closed || this.pollIntervalMs === null) return;
    clearTimeout(this.#pollTimer);
    this.#pollTimer = setTimeout(() => void this.#poll(), this.pollIntervalMs);
  }

  async #announce(): Promise<void> {
    if (this.#closed) return;
    try {
      const announced = await this.lighthouse.announce(
        this.key,
        this.topic,
        this.addr,
        this.ttlSecs,
      );
      this.#publish(announced.peers);
      this.#backoff = INITIAL_BACKOFF_MS;
      this.#scheduleAnnounce(announced.ttlSecs);
      // The announce just returned fresh peers; space the next poll from here.
      this.#schedulePoll();
    } catch (err) {
      if (this.#closed) return;
      const retry = this.#backoff;
      this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS);
      console.warn(
        `iroh-lighthouse: announce failed, retrying in ${retry}ms`,
        err instanceof LighthouseError ? err.message : err,
      );
      this.#announceTimer = setTimeout(() => void this.#announce(), retry);
    }
  }

  async #poll(): Promise<void> {
    if (this.#closed) return;
    try {
      const peers = await this.lighthouse.lookup(this.topic);
      this.#publish(peers.filter((p) => p.addr.id !== this.key.id));
    } catch {
      // A failed poll is not worth escalating: the keep-alive announce is the
      // thing that must succeed, and it has its own backoff.
    }
    this.#schedulePoll();
  }

  #watchVisibility(): void {
    if (typeof document === "undefined") return;
    const onVisible = () => {
      if (document.visibilityState === "visible" && !this.#closed) {
        void this.#announce();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    this.#cleanup.push(() =>
      document.removeEventListener("visibilitychange", onVisible),
    );
  }

  #watchUnload(): void {
    if (typeof window === "undefined") return;
    const onHide = () => {
      if (this.#closed) return;
      // Best effort: `sendBeacon` is the only request a browser reliably lets
      // you start while the page is going away. The TTL covers us if it fails.
      try {
        const beacon = navigator.sendBeacon?.bind(navigator);
        if (!beacon) return;
        void this.#unregisterBeacon(beacon);
      } catch {
        /* nothing useful to do while the page unloads */
      }
    };
    window.addEventListener("pagehide", onHide);
    this.#cleanup.push(() => window.removeEventListener("pagehide", onHide));
  }

  async #unregisterBeacon(
    beacon: (url: string, data?: BodyInit) => boolean,
  ): Promise<void> {
    // Built inline rather than through the client, because the client awaits a
    // response and nothing will be delivered after unload.
    const { ANNOUNCE_DOMAIN, encodePayload, encodeSignature, nowUnix, signingBytes } =
      await import("./protocol.js");
    const payload = encodePayload({
      topic: this.topic.id,
      addr: this.addr,
      ttl_secs: 0,
      ts: nowUnix(),
    });
    const bytes = signingBytes(ANNOUNCE_DOMAIN, payload);
    const body = JSON.stringify({
      payload,
      node_sig: encodeSignature(this.key.sign(bytes)),
      topic_sig: encodeSignature(this.topic.sign(bytes)),
    });
    const url = `${this.lighthouse.url.toString().replace(/\/$/, "")}/v1/announce`;
    beacon(url, new Blob([body], { type: "application/json" }));
  }
}

/**
 * Join a topic: announce, keep the registration alive, and track the members.
 *
 * ```ts
 * const session = await join(lighthouse, key, topic, addr);
 * session.onPeers((peers) => render(peers));
 * ```
 */
export async function join(
  lighthouse: Lighthouse,
  key: NodeKey,
  topic: Topic,
  addr: EndpointAddr,
  options: JoinOptions = {},
): Promise<Session> {
  return Session.start(lighthouse, key, topic, addr, options);
}
