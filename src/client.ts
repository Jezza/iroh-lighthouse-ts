/**
 * The client: announce, look up, resolve, and ask a lighthouse about itself.
 *
 * One class over HTTP(S). No backend of your own is involved — this talks
 * directly to a lighthouse from wherever it runs, including a browser page
 * served off static files.
 */

import {
  ANNOUNCE_DOMAIN,
  type AnnounceBody,
  type EndpointAddr,
  HTTP_ANNOUNCE,
  HTTP_INFO,
  HTTP_LOOKUP,
  HTTP_RESOLVE,
  type Info,
  LOOKUP_DOMAIN,
  LighthouseError,
  type LookupBody,
  MAX_MESSAGE_SIZE,
  type Peer,
  type Response as ProtocolResponse,
  encodePayload,
  encodeSignature,
  nowUnix,
  signingBytes,
} from "./protocol.js";
import type { NodeKey, Topic } from "./topic.js";

/** Result of a successful announce. */
export interface Announced {
  /** The lifetime the lighthouse actually granted, in seconds. */
  ttlSecs: number;
  /** The other members of the topic. Empty for a directory publish. */
  peers: Peer[];
}

/** Options for {@link Lighthouse}. */
export interface LighthouseOptions {
  /**
   * `fetch` to use. Defaults to the global one. Supply your own to add
   * timeouts, retries, or a test double.
   */
  fetch?: typeof globalThis.fetch;
}

/**
 * Normalise a lighthouse address, filling in the scheme when it is left out.
 *
 * `iroh.example.com` becomes `https://iroh.example.com`. `localhost` and IP
 * literals get `http://` instead, since those are local and usually have no
 * certificate. Input that already has a scheme is used as is. This matches the
 * Rust client's behaviour so the same string works in both.
 */
export function parseUrl(input: string): URL {
  if (input.includes("://")) return new URL(input);
  const https = new URL(`https://${input}`);
  const host = https.hostname;
  const isLocal =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    host.startsWith("[");
  return isLocal ? new URL(`http://${input}`) : https;
}

/** A handle to one lighthouse. Cheap to construct; holds no connection. */
export class Lighthouse {
  readonly url: URL;
  readonly #fetch: typeof globalThis.fetch;

  constructor(url: string | URL, options: LighthouseOptions = {}) {
    this.url = typeof url === "string" ? parseUrl(url) : url;
    // Bound to globalThis: an unbound `fetch` throws "Illegal invocation" in
    // browsers.
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  /**
   * Register `addr` on `topic` for `ttlSecs`, and get the other members back
   * in the same round trip.
   *
   * Pass `topic: null` to publish to the directory instead, which is how a
   * node makes itself resolvable by id. A `ttlSecs` of zero unregisters.
   */
  async announce(
    key: NodeKey,
    topic: Topic | null,
    addr: EndpointAddr,
    ttlSecs: number,
  ): Promise<Announced> {
    const body: AnnounceBody = {
      topic: topic?.id ?? null,
      addr,
      ttl_secs: ttlSecs,
      ts: nowUnix(),
    };
    const payload = encodePayload(body);
    const bytes = signingBytes(ANNOUNCE_DOMAIN, payload);

    const response = await this.#post(HTTP_ANNOUNCE, {
      payload,
      node_sig: encodeSignature(key.sign(bytes)),
      topic_sig: topic ? encodeSignature(topic.sign(bytes)) : null,
    });
    if (response.type !== "announced") throw unexpected(response);
    return { ttlSecs: response.ttl_secs, peers: response.peers };
  }

  /** Read the members of a topic without registering on it. */
  async lookup(topic: Topic): Promise<Peer[]> {
    const body: LookupBody = { topic: topic.id, ts: nowUnix() };
    const payload = encodePayload(body);

    const response = await this.#post(HTTP_LOOKUP, {
      payload,
      topic_sig: encodeSignature(topic.sign(signingBytes(LOOKUP_DOMAIN, payload))),
    });
    if (response.type !== "peers") throw unexpected(response);
    return response.peers;
  }

  /**
   * Look up a node by id in the directory.
   *
   * Returns `null` when the lighthouse has no entry, rather than throwing:
   * "not published" is an ordinary answer, not a failure.
   */
  async resolve(id: string): Promise<Peer | null> {
    try {
      const response = await this.#get(`${HTTP_RESOLVE}/${id}`);
      if (response.type !== "resolved") throw unexpected(response);
      return response.peer;
    } catch (err) {
      if (err instanceof LighthouseError && err.code === "not_found") return null;
      throw err;
    }
  }

  /** Describe the lighthouse: version, iroh address, and limits. */
  async info(): Promise<Info> {
    const response = await this.#get(HTTP_INFO);
    if (response.type !== "info") throw unexpected(response);
    const { type: _type, ...info } = response;
    return info;
  }

  /** True if the lighthouse answers its health route. */
  async healthy(): Promise<boolean> {
    try {
      const res = await this.#fetch(this.#route("/v1/health"));
      return res.ok;
    } catch {
      return false;
    }
  }

  #route(path: string): string {
    return `${this.url.toString().replace(/\/$/, "")}${path}`;
  }

  async #post(path: string, body: unknown): Promise<ProtocolResponse> {
    const res = await this.#fetch(this.#route(path), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return this.#decode(res);
  }

  async #get(path: string): Promise<ProtocolResponse> {
    return this.#decode(await this.#fetch(this.#route(path)));
  }

  async #decode(res: Response): Promise<ProtocolResponse> {
    const text = await res.text();
    if (text.length > MAX_MESSAGE_SIZE) {
      throw new LighthouseError("response exceeds the protocol size limit", {
        status: res.status,
      });
    }
    let parsed: ProtocolResponse;
    try {
      parsed = JSON.parse(text) as ProtocolResponse;
    } catch {
      // A non-protocol body: a proxy error page, most likely. Surface the
      // status and a snippet rather than a bare JSON parse error.
      throw new LighthouseError(
        `http ${res.status} with non-protocol body: ${text.slice(0, 200)}`,
        { status: res.status },
      );
    }
    if (parsed.type === "error") {
      throw new LighthouseError(parsed.message, {
        code: parsed.code,
        status: res.status,
      });
    }
    return parsed;
  }
}

function unexpected(response: ProtocolResponse): LighthouseError {
  return new LighthouseError(`unexpected response: ${response.type}`);
}
