# iroh-lighthouse

Topic rendezvous and peer discovery for [iroh](https://iroh.computer), from
TypeScript. Point it at a [lighthouse](https://github.com/Jezza/iroh-lighthouse)
URL with a topic name and a secret, and get back everyone else on that topic.

No backend of your own: a static page and a lighthouse URL is the whole
deployment. ~18KB gzipped, two dependencies, no WASM.

```sh
npm install iroh-lighthouse
```

## Quick start

```ts
import { Lighthouse, NodeKey, Topic, endpointAddr, join } from "iroh-lighthouse";

const lighthouse = new Lighthouse("https://iroh.example.com");
const key = NodeKey.generate();                  // your identity
const topic = Topic.withSecret("my-app/room-1", "a shared phrase");

const session = await join(lighthouse, key, topic, endpointAddr(key.id));
session.onPeers((peers) => {
  console.log(`${peers.length} others here`);
  for (const peer of peers) console.log(peer.addr.id, peer.addr.addrs);
});

// later
await session.leave();
```

One-shot calls are there too when you do not want a session:

```ts
await lighthouse.announce(key, topic, addr, 3600); // register, get members
await lighthouse.lookup(topic);                    // read without joining
await lighthouse.resolve(someNodeId);              // directory lookup, or null
await lighthouse.info();                           // version and limits
```

## Topics

A topic is a name plus an optional secret. Both are hashed into an ed25519
keypair on this side, and only the **public half** goes on the wire — the
lighthouse never learns the name or the secret, and topic ids are safe to log.

```ts
Topic.create("public-room");                  // anyone who knows the name
Topic.withSecret("private-room", "hunter2");  // only secret holders
```

Same name, different secret, different topic entirely. This is what lets you
compute a rendezvous rather than register one: a topic can be derived from a
rounded location, an hour, a scanned code — anything both sides already know.
Rotate the secret and yesterday's topic id tells an observer nothing about
today's.

## Identity

`NodeKey` is an ed25519 keypair whose public half is the endpoint id. Persist
it if you want to be the same peer across reloads:

```ts
const saved = localStorage.getItem("my-key");
const key = saved ? NodeKey.fromHex(saved) : NodeKey.generate();
localStorage.setItem("my-key", key.toHex());
```

That is a private key in `localStorage`. Fine for a throwaway identity; not for
anything you would mind someone else holding.

**If you are also running iroh** (via WASM), use *its* secret key here and
announce the address iroh gives you, so the key you sign with and the endpoint
you advertise are the same thing. `endpointAddr()` is a convenience for the
simple case, but iroh knows about relays and hole-punched candidates that you
cannot guess.

A browser tab is a client, not a listening endpoint — it has no dialable
address of its own. Announcing with an empty address list still registers your
id on the topic, which is enough to see who is there and to exchange addresses
by other means.

## Sessions

`join()` returns a `Session` that keeps itself registered: it re-announces at
half the granted TTL, polls for membership changes in between, and backs off
when the lighthouse is unreachable.

```ts
const session = await join(lighthouse, key, topic, addr, {
  ttlSecs: 3600,
  pollIntervalMs: 10_000,   // null disables polling
  refreshOnVisible: true,   // re-announce when the tab comes back
  leaveOnUnload: true,      // best-effort unregister on pagehide
});
```

`onPeers` fires only when membership or an address actually changes — not on
every poll, and not when a TTL ticks down. It is called immediately with the
current list, so you can use it to render.

Two browser-specific behaviours are on by default and worth knowing about:

- **Background tabs have their timers throttled**, so a session can miss its
  keep-alive and age out. `refreshOnVisible` re-announces on the way back
  rather than waiting for a timer that may be long overdue.
- **A closed page never gets to call `leave()`**, so the entry would linger
  until its TTL expired. `leaveOnUnload` sends a best-effort unregister via
  `sendBeacon` — which the browser may drop, so the TTL is the real guarantee.

## How the signing works

A signed request carries its body as a base64url string, and the signature
covers exactly `domain || "." || payload`, all ASCII. Nothing re-encodes a
parsed body, which is why this library needs no binary codec: `JSON.stringify`,
base64url, ed25519, done. Field order does not matter, and an unknown field
added by a future version still verifies.

One asymmetry to know if you implement this yourself: **keys are hex strings on
the wire, signatures are arrays of bytes.** That is how the Rust types
serialize, and a hex signature is rejected with
`invalid type: string, expected bytestring of length 64`.

## Tests

```sh
bun test                                   # vectors + unit, no network
bun run test:live                          # also against a running lighthouse
```

`test/vectors.json` is generated by the Rust implementation
(`cargo run -p iroh-lighthouse-protocol --example vectors`) and committed in both
repos, as `spec/vectors.json` on the Rust side.
Ed25519 is deterministic, so every signature in it must reproduce bit for bit —
that is what proves the two clients can actually talk to the same server rather
than merely looking like they should.

The live tests need a lighthouse:

```sh
cargo run -p iroh-lighthouse -- \
    --http-listen 127.0.0.1:8099 --no-iroh --no-snapshot
```

They skip rather than fail when `LIGHTHOUSE_URL` is unset, so `bun test` stays
useful offline.

## Demo

```sh
bun run demo        # bundles, then serves on :8100
```

Open `http://127.0.0.1:8100/demo/` in two windows and watch them find each
other. It is one HTML file and the bundle — no framework, no build step beyond
the bundle itself.

## Requirements

The lighthouse must send CORS headers, or the browser refuses the request
before it leaves the page. Servers from v0.1.0 onward do this by default.

## License

Licensed under either of [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
