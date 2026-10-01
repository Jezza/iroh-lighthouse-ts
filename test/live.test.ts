/**
 * End-to-end against a real lighthouse server.
 *
 * The vector tests prove the crypto matches Rust; these prove the client
 * actually talks to the Rust *server* — signatures accepted, peers returned,
 * TTLs honoured, errors surfaced.
 *
 * Start a server first:
 *
 * ```sh
 * cargo run -p iroh-lighthouse -- \
 *     --http-listen 127.0.0.1:8099 --no-iroh --no-snapshot
 * ```
 *
 * then `LIGHTHOUSE_URL=http://127.0.0.1:8099 bun test`. Without that variable
 * the suite skips rather than fails, so `bun test` stays useful offline.
 */

import { beforeAll, describe, expect, test } from "bun:test";

import { Lighthouse, LighthouseError, NodeKey, Topic, endpointAddr, join } from "../src/index.js";

const URL_FROM_ENV = process.env.LIGHTHOUSE_URL;
const lighthouse = URL_FROM_ENV ? new Lighthouse(URL_FROM_ENV) : null;

/** A topic nobody else is using, so runs never collide. */
function uniqueTopic(name: string): Topic {
  return Topic.withSecret(name, crypto.randomUUID());
}

function addrFor(key: NodeKey, port: number) {
  return endpointAddr(key.id, [`127.0.0.1:${port}`]);
}

describe.skipIf(!lighthouse)("against a live lighthouse", () => {
  beforeAll(async () => {
    expect(await lighthouse!.healthy()).toBe(true);
  });

  test("info reports the server's limits", async () => {
    const info = await lighthouse!.info();
    expect(info.version).toBeString();
    expect(info.max_peers_per_topic).toBeGreaterThan(0);
    expect(info.min_ttl_secs).toBeLessThanOrEqual(info.max_ttl_secs);
  });

  test("an announce is accepted and returns the other members", async () => {
    const topic = uniqueTopic("ts-announce");
    const a = NodeKey.generate();
    const b = NodeKey.generate();

    const first = await lighthouse!.announce(a, topic, addrFor(a, 4001), 60);
    expect(first.peers).toBeEmpty();
    expect(first.ttlSecs).toBeGreaterThan(0);

    const second = await lighthouse!.announce(b, topic, addrFor(b, 4002), 60);
    expect(second.peers).toHaveLength(1);
    expect(second.peers[0]!.addr.id).toBe(a.id);
    // The address survives the round trip intact, which is what makes a peer
    // dialable without any further discovery.
    expect(second.peers[0]!.addr.addrs).toEqual([{ Ip: "127.0.0.1:4001" }]);
  });

  test("lookup reads a topic without joining it", async () => {
    const topic = uniqueTopic("ts-lookup");
    const a = NodeKey.generate();
    await lighthouse!.announce(a, topic, addrFor(a, 4010), 60);

    const peers = await lighthouse!.lookup(topic);
    expect(peers.map((p) => p.addr.id)).toEqual([a.id]);
  });

  test("a ttl of zero unregisters", async () => {
    const topic = uniqueTopic("ts-unregister");
    const a = NodeKey.generate();
    await lighthouse!.announce(a, topic, addrFor(a, 4020), 60);
    expect(await lighthouse!.lookup(topic)).toHaveLength(1);

    await lighthouse!.announce(a, topic, addrFor(a, 4020), 0);
    expect(await lighthouse!.lookup(topic)).toBeEmpty();
  });

  test("the topic secret really gates the topic", async () => {
    const right = Topic.withSecret("ts-secret", "correct horse");
    const wrong = Topic.withSecret("ts-secret", "wrong horse");
    const a = NodeKey.generate();
    await lighthouse!.announce(a, right, addrFor(a, 4030), 60);

    // Same name, different secret: a different topic entirely.
    expect(await lighthouse!.lookup(wrong)).toBeEmpty();
    expect((await lighthouse!.lookup(right)).length).toBeGreaterThan(0);
  });

  test("resolve returns null for an unpublished id", async () => {
    expect(await lighthouse!.resolve(NodeKey.generate().id)).toBeNull();
  });

  test("a directory announce makes a node resolvable by id", async () => {
    const a = NodeKey.generate();
    await lighthouse!.announce(a, null, addrFor(a, 4040), 60);

    const found = await lighthouse!.resolve(a.id);
    expect(found).not.toBeNull();
    expect(found!.addr.id).toBe(a.id);
  });

  test("a bad signature is rejected with a protocol error", async () => {
    const topic = uniqueTopic("ts-badsig");
    const a = NodeKey.generate();
    // Sign with one key but claim another's address: exactly the forgery the
    // node signature exists to stop.
    const impostor = NodeKey.generate();
    const promise = lighthouse!.announce(impostor, topic, addrFor(a, 4050), 60);

    await expect(promise).rejects.toThrow(LighthouseError);
    await promise.catch((err: LighthouseError) => {
      expect(err.code).toBe("bad_signature");
    });
  });

  test("a session keeps itself registered and sees others arrive", async () => {
    const topic = uniqueTopic("ts-session");
    const a = NodeKey.generate();
    const b = NodeKey.generate();

    const session = await join(lighthouse!, a, topic, addrFor(a, 4060), {
      ttlSecs: 30,
      pollIntervalMs: 500,
      refreshOnVisible: false,
      leaveOnUnload: false,
    });

    try {
      expect(session.peers).toBeEmpty();

      // Someone else joins; the session's poll should notice without being asked.
      const seen = new Promise<string[]>((resolve) => {
        session.onPeers((peers) => {
          if (peers.length > 0) resolve(peers.map((p) => p.addr.id));
        });
      });
      await lighthouse!.announce(b, topic, addrFor(b, 4061), 30);

      const ids = await Promise.race([
        seen,
        new Promise<string[]>((_, reject) =>
          setTimeout(() => reject(new Error("session never saw the new peer")), 5000),
        ),
      ]);
      expect(ids).toEqual([b.id]);
    } finally {
      await session.leave();
    }

    // After leaving, only the other node remains.
    const remaining = await lighthouse!.lookup(topic);
    expect(remaining.map((p) => p.addr.id)).toEqual([b.id]);
  });

  test("onPeers fires only when membership actually changes", async () => {
    const topic = uniqueTopic("ts-quiet");
    const a = NodeKey.generate();
    const session = await join(lighthouse!, a, topic, addrFor(a, 4070), {
      ttlSecs: 30,
      pollIntervalMs: 200,
      refreshOnVisible: false,
      leaveOnUnload: false,
    });

    try {
      let calls = 0;
      session.onPeers(() => calls++);
      expect(calls).toBe(1); // immediate call with the current list

      // Several polls pass with nobody joining or leaving.
      await new Promise((r) => setTimeout(r, 1200));
      expect(calls).toBe(1);
    } finally {
      await session.leave();
    }
  });
});

describe("url parsing", () => {
  test("bare hosts default to https, local ones to http", () => {
    expect(new Lighthouse("iroh.example.com").url.toString()).toBe("https://iroh.example.com/");
    expect(new Lighthouse("localhost:8080").url.toString()).toBe("http://localhost:8080/");
    expect(new Lighthouse("127.0.0.1:8099").url.toString()).toBe("http://127.0.0.1:8099/");
  });

  test("an explicit scheme is kept", () => {
    expect(new Lighthouse("http://iroh.example.com").url.toString()).toBe(
      "http://iroh.example.com/",
    );
  });
});
