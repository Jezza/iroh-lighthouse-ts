/**
 * The wire protocol, as types and as the signing rule.
 *
 * Messages are JSON. A signed request carries its body as a base64url string
 * and the signature covers exactly:
 *
 * ```text
 * domain || "." || payload
 * ```
 *
 * all of it ASCII. Nothing re-encodes a parsed body, so this file needs no
 * canonical-encoding machinery — `JSON.stringify` is enough, and field order
 * does not matter because the signature covers the bytes we actually send.
 */

import { base64urlDecode, base64urlEncode, utf8 } from "./bytes.js";

/** ALPN of the iroh carrier, for completeness. This library speaks HTTP. */
export const ALPN = "iroh-lighthouse/1";

/** Domain prefix for announce signatures. */
export const ANNOUNCE_DOMAIN = "iroh-lighthouse/v1/announce";
/** Domain prefix for lookup signatures. */
export const LOOKUP_DOMAIN = "iroh-lighthouse/v1/lookup";

export const HTTP_ANNOUNCE = "/v1/announce";
export const HTTP_LOOKUP = "/v1/lookup";
export const HTTP_RESOLVE = "/v1/resolve";
export const HTTP_INFO = "/v1/info";
export const HTTP_HEALTH = "/v1/health";

/** Largest request or response this library will send or accept. */
export const MAX_MESSAGE_SIZE = 64 * 1024;

/**
 * One way to reach an endpoint.
 *
 * `Ip` is a `host:port` string; `Relay` is a relay URL. The shape mirrors
 * iroh's `TransportAddr` enum as serde renders it in JSON.
 */
export type TransportAddr =
  | { Ip: string }
  | { Relay: string }
  | { Custom: unknown };

/** An endpoint id plus every known way to reach it. */
export interface EndpointAddr {
  /** Hex of the endpoint's public key. */
  id: string;
  addrs: TransportAddr[];
}

/** The signed part of an announce. */
export interface AnnounceBody {
  /** Topic id, or `null` to publish to the directory. */
  topic: string | null;
  addr: EndpointAddr;
  /** Requested lifetime in seconds. Zero unregisters. */
  ttl_secs: number;
  /** Unix seconds when the body was signed. */
  ts: number;
}

/** The signed part of a lookup. */
export interface LookupBody {
  topic: string;
  ts: number;
}

/** A registered node as returned by the lighthouse. */
export interface Peer {
  addr: EndpointAddr;
  expires_in_secs: number;
}

/** What a lighthouse says about itself. */
export interface Info {
  version: string;
  /** The lighthouse's own iroh address, if its iroh carrier is enabled. */
  lighthouse: EndpointAddr | null;
  min_ttl_secs: number;
  max_ttl_secs: number;
  max_peers_per_topic: number;
}

/** Machine-readable error codes the lighthouse can return. */
export type ErrorCode =
  | "malformed"
  | "payload_too_large"
  | "stale_timestamp"
  | "bad_signature"
  | "not_found"
  | "topic_full"
  | "too_many_topics"
  | "internal";

/**
 * A signature on the wire: 64 bytes as a JSON array of numbers.
 *
 * NOT hex, and this catches people out because *keys* are hex in the same
 * messages. The asymmetry comes from how the Rust types serialize: iroh's
 * `PublicKey` has a human-readable branch that renders a string in JSON, while
 * ed25519's `Signature` has no such branch and falls through to plain bytes.
 *
 * Found the hard way: a hex signature is rejected with
 * `malformed: invalid type: string, expected bytestring of length 64`.
 */
export type WireSignature = number[];

/** Encode a signature for the wire. */
export function encodeSignature(sig: Uint8Array): WireSignature {
  return Array.from(sig);
}

export type Request =
  | {
      type: "announce";
      payload: string;
      node_sig: WireSignature;
      topic_sig: WireSignature | null;
    }
  | { type: "lookup"; payload: string; topic_sig: WireSignature }
  | { type: "resolve"; id: string }
  | { type: "info" };

export type Response =
  | { type: "announced"; ttl_secs: number; peers: Peer[] }
  | { type: "peers"; peers: Peer[] }
  | { type: "resolved"; peer: Peer }
  | { type: "info" } & Info
  | { type: "error"; code: ErrorCode; message: string };

/**
 * Encode a body as the `payload` string that gets signed and sent.
 *
 * Whatever `JSON.stringify` produces is what gets signed, so there is no
 * canonical form to agree with the server about.
 */
export function encodePayload(body: unknown): string {
  return base64urlEncode(utf8(JSON.stringify(body)));
}

/** Decode a payload string back into a body. */
export function decodePayload<T>(payload: string): T {
  return JSON.parse(new TextDecoder().decode(base64urlDecode(payload))) as T;
}

/**
 * The exact bytes a signature covers: `domain || "." || payload`.
 *
 * Built from the payload *string*, never from a re-encoded body — that is the
 * whole reason this library needs no binary codec.
 */
export function signingBytes(domain: string, payload: string): Uint8Array {
  return utf8(`${domain}.${payload}`);
}

/** Current unix time in seconds, as the protocol wants it. */
export function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/** An error returned by the lighthouse itself, as opposed to a transport failure. */
export class LighthouseError extends Error {
  readonly code: ErrorCode | undefined;
  readonly status: number | undefined;

  constructor(message: string, options: { code?: ErrorCode; status?: number } = {}) {
    super(message);
    this.name = "LighthouseError";
    this.code = options.code;
    this.status = options.status;
  }
}
