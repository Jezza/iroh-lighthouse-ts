/**
 * Topic rendezvous for iroh, from the browser, with no backend of your own.
 *
 * ```ts
 * import { Lighthouse, NodeKey, Topic, join } from "iroh-lighthouse";
 *
 * const lighthouse = new Lighthouse("https://iroh.example.com");
 * const key = NodeKey.generate();
 * const topic = Topic.withSecret("my-app/room-1", "a shared phrase");
 *
 * const session = await join(lighthouse, key, topic, myAddr);
 * session.onPeers((peers) => console.log(peers.length, "others here"));
 * ```
 *
 * The lighthouse never learns the topic name or its secret: both are hashed
 * into a keypair on this side, and only the public half goes on the wire.
 */

export { Lighthouse, parseUrl, type Announced, type LighthouseOptions } from "./client.js";
export {
  DEFAULT_POLL_INTERVAL_MS,
  Session,
  join,
  type JoinOptions,
  type PeersListener,
} from "./session.js";
export { NodeKey, Topic } from "./topic.js";
export {
  ALPN,
  ANNOUNCE_DOMAIN,
  LOOKUP_DOMAIN,
  LighthouseError,
  decodePayload,
  encodePayload,
  nowUnix,
  signingBytes,
  type AnnounceBody,
  type EndpointAddr,
  type ErrorCode,
  type Info,
  type LookupBody,
  type Peer,
  type TransportAddr,
} from "./protocol.js";
export {
  base64urlDecode,
  base64urlEncode,
  bytesToHex,
  hexToBytes,
} from "./bytes.js";

/**
 * Build an {@link EndpointAddr} from a node id and `host:port` strings.
 *
 * A convenience for the common case. When you are running iroh itself (via
 * WASM), use the address iroh gives you instead — it knows about relays and
 * hole-punched candidates that you cannot guess.
 */
export function endpointAddr(id: string, addrs: string[] = []): import("./protocol.js").EndpointAddr {
  return { id, addrs: addrs.map((a) => ({ Ip: a })) };
}
