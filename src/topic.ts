/**
 * Topics: a name plus an optional secret, hashed into an ed25519 keypair.
 *
 * The public half is the wire id, so a lighthouse only ever sees an opaque
 * 32-byte key and never the name or secret behind it. Everyone who knows the
 * same name and secret derives the same keypair, which is what lets strangers
 * meet without anybody registering anything.
 */

import { blake3 } from "@noble/hashes/blake3.js";
import { ed25519 } from "@noble/curves/ed25519.js";

import { bytesToHex, hexToBytes, utf8 } from "./bytes.js";

/** Domain separation for the topic key derivation. Must match the server. */
const TOPIC_KEY_CONTEXT = utf8("iroh-lighthouse/v1/topic");

/**
 * A topic you hold the key for, and can therefore sign as.
 *
 * Create one with {@link Topic.create} (public) or {@link Topic.withSecret}
 * (private). The secret never leaves this object: it is consumed by the
 * derivation and only the resulting key is kept.
 */
export class Topic {
  /** The 32-byte secret half. Not exported; sign through this class. */
  readonly #key: Uint8Array;
  /** The human-readable name this topic was derived from. */
  readonly name: string;
  /** The wire identifier: hex of the public half. Safe to log. */
  readonly id: string;

  private constructor(name: string, key: Uint8Array) {
    this.name = name;
    this.#key = key;
    this.id = bytesToHex(ed25519.getPublicKey(key));
  }

  /** A public topic: anyone who knows the name derives the same key. */
  static create(name: string): Topic {
    return Topic.withSecret(name, "");
  }

  /**
   * A private topic: only holders of the secret derive the key.
   *
   * The name's length is mixed in before the name itself, so `("ab", "c")`
   * and `("a", "bc")` cannot collide.
   */
  static withSecret(name: string, secret: string | Uint8Array): Topic {
    const n = utf8(name);
    const s = typeof secret === "string" ? utf8(secret) : secret;
    const buf = new Uint8Array(8 + n.length + s.length);
    new DataView(buf.buffer).setBigUint64(0, BigInt(n.length), true);
    buf.set(n, 8);
    buf.set(s, 8 + n.length);
    return new Topic(name, blake3(buf, { context: TOPIC_KEY_CONTEXT, dkLen: 32 }));
  }

  /** Sign with the topic key. */
  sign(message: Uint8Array): Uint8Array {
    return ed25519.sign(message, this.#key);
  }
}

/**
 * A node identity: the ed25519 key an endpoint is known by.
 *
 * In a browser app this is usually generated once and kept in
 * `localStorage`, so a reload keeps the same identity. If you are also running
 * iroh (via WASM), use *its* secret key here so the address you announce and
 * the key you sign with are the same endpoint.
 */
export class NodeKey {
  readonly #secret: Uint8Array;
  /** Hex of the public half. This is the endpoint id. */
  readonly id: string;

  private constructor(secret: Uint8Array) {
    if (secret.length !== 32) {
      throw new TypeError(`node secret must be 32 bytes, got ${secret.length}`);
    }
    this.#secret = secret;
    this.id = bytesToHex(ed25519.getPublicKey(secret));
  }

  /** A fresh random identity. */
  static generate(): NodeKey {
    return new NodeKey(crypto.getRandomValues(new Uint8Array(32)));
  }

  /** From 32 raw bytes. */
  static fromBytes(secret: Uint8Array): NodeKey {
    return new NodeKey(secret);
  }

  /** From 64 hex characters, as produced by {@link NodeKey.toHex}. */
  static fromHex(hex: string): NodeKey {
    return new NodeKey(hexToBytes(hex));
  }

  /**
   * The secret as hex, for persisting.
   *
   * This is the private key. Treat it like one: `localStorage` is fine for a
   * throwaway identity, not for anything you would mind someone else holding.
   */
  toHex(): string {
    return bytesToHex(this.#secret);
  }

  /** Sign with the node key. */
  sign(message: Uint8Array): Uint8Array {
    return ed25519.sign(message, this.#secret);
  }
}
