/**
 * Cross-implementation checks against the Rust vectors.
 *
 * `vectors.json` is produced by `cargo run -p iroh-lighthouse --example
 * vectors` and committed in both repos. Ed25519 is deterministic, so a correct
 * implementation reproduces every signature in it bit for bit — this is the
 * test that proves the TypeScript and Rust clients can actually talk to the
 * same server, rather than merely looking like they should.
 */

import { describe, expect, test } from "bun:test";

import vectors from "./vectors.json";
import { NodeKey, Topic } from "../src/topic.js";
import {
  ANNOUNCE_DOMAIN,
  LOOKUP_DOMAIN,
  decodePayload,
  encodePayload,
  encodeSignature,
  signingBytes,
} from "../src/protocol.js";
import { base64urlDecode, base64urlEncode, bytesToHex, hexToBytes } from "../src/bytes.js";

type Vector = {
  body: Record<string, unknown>;
  payload: string;
  signing_bytes_hex: string;
  signing_bytes_utf8: string;
  node_sig?: string;
  topic_sig?: string | null;
};

const entries = Object.entries(vectors.vectors as Record<string, Vector>);
const privateTopic = Topic.withSecret("chat", "hunter2");
const publicTopic = Topic.create("chat");
const nodeKey = NodeKey.fromHex(vectors.node_secret_key_bytes);

describe("key derivation matches Rust", () => {
  test("a private topic derives the same id", () => {
    expect(privateTopic.id).toBe(vectors.topic_private.id);
  });

  test("a public topic is the same as an empty secret", () => {
    expect(publicTopic.id).toBe(vectors.topic_public.id);
    expect(Topic.withSecret("chat", "").id).toBe(publicTopic.id);
  });

  test("the node key derives the same endpoint id", () => {
    expect(nodeKey.id).toBe(vectors.node_id);
  });

  test("the secret changes the topic id", () => {
    expect(Topic.withSecret("chat", "other").id).not.toBe(privateTopic.id);
  });

  test("name and secret cannot be confused for one another", () => {
    // "ab" + "c" must not collide with "a" + "bc": the length prefix is why.
    expect(Topic.withSecret("ab", "c").id).not.toBe(Topic.withSecret("a", "bc").id);
  });
});

describe("signing bytes match Rust", () => {
  for (const [name, vector] of entries) {
    test(name, () => {
      const domain = name.startsWith("announce") ? ANNOUNCE_DOMAIN : LOOKUP_DOMAIN;
      const bytes = signingBytes(domain, vector.payload);
      expect(new TextDecoder().decode(bytes)).toBe(vector.signing_bytes_utf8);
      expect(bytesToHex(bytes)).toBe(vector.signing_bytes_hex);
    });
  }
});

describe("signatures match Rust", () => {
  for (const [name, vector] of entries) {
    test(name, () => {
      const domain = name.startsWith("announce") ? ANNOUNCE_DOMAIN : LOOKUP_DOMAIN;
      const bytes = signingBytes(domain, vector.payload);

      if (vector.node_sig) {
        expect(bytesToHex(nodeKey.sign(bytes))).toBe(vector.node_sig);
      }
      if (vector.topic_sig) {
        const body = vector.body as { topic?: string | null };
        const topic = body.topic === vectors.topic_public.id ? publicTopic : privateTopic;
        expect(bytesToHex(topic.sign(bytes))).toBe(vector.topic_sig);
      }
      // A directory announce carries no topic signature at all.
      if (name === "announce_directory") {
        expect(vector.topic_sig ?? null).toBeNull();
      }
    });
  }
});

describe("payloads", () => {
  for (const [name, vector] of entries) {
    test(`${name} decodes to the stated body`, () => {
      expect(decodePayload(vector.payload)).toEqual(vector.body);
    });
  }

  /**
   * Field order deliberately does NOT have to match Rust.
   *
   * This is the property the protocol change bought us: the signature covers
   * the payload string we send, so our own JSON.stringify order is fine. The
   * Rust-generated payloads happen to use struct order; `vectors.json` lists
   * the same body alphabetised. Both verify, because neither side re-encodes
   * the other's body.
   */
  test("our encoding round-trips even when the key order differs", () => {
    const vector = (vectors.vectors as Record<string, Vector>).announce_topic_v4!;
    const ours = encodePayload(vector.body);
    expect(ours).not.toBe(vector.payload); // different key order
    expect(decodePayload(ours)).toEqual(decodePayload(vector.payload)); // same content
  });
});

/**
 * The vectors pin the SIGNING bytes but not the on-wire encoding of a
 * signature, which is a genuine gap in them: a hex signature produces the
 * right bytes and is still rejected by the server. Caught by the live tests,
 * recorded here so a refactor cannot quietly reintroduce it.
 */
describe("wire encoding of signatures", () => {
  test("signatures are byte arrays, not hex", () => {
    const bytes = signingBytes(ANNOUNCE_DOMAIN, "payload");
    const wire = encodeSignature(privateTopic.sign(bytes));
    expect(Array.isArray(wire)).toBe(true);
    expect(wire).toHaveLength(64);
    for (const b of wire) expect(b).toBeWithin(0, 256);
    // Keys, by contrast, ARE hex in the same messages.
    expect(privateTopic.id).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("byte helpers", () => {
  test("base64url round trips and has no padding", () => {
    for (let len = 0; len < 40; len++) {
      const bytes = crypto.getRandomValues(new Uint8Array(len));
      const encoded = base64urlEncode(bytes);
      expect(encoded).not.toContain("=");
      expect(encoded).not.toContain("+");
      expect(encoded).not.toContain("/");
      expect([...base64urlDecode(encoded)]).toEqual([...bytes]);
    }
  });

  test("hex round trips", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    expect([...hexToBytes(bytesToHex(bytes))]).toEqual([...bytes]);
  });

  test("hex rejects malformed input", () => {
    expect(() => hexToBytes("abc")).toThrow();
    expect(() => hexToBytes("zz")).toThrow();
  });
});

describe("node keys", () => {
  test("round trip through hex", () => {
    const key = NodeKey.generate();
    expect(NodeKey.fromHex(key.toHex()).id).toBe(key.id);
  });

  test("reject the wrong length", () => {
    expect(() => NodeKey.fromBytes(new Uint8Array(31))).toThrow(TypeError);
  });

  test("two generated keys differ", () => {
    expect(NodeKey.generate().id).not.toBe(NodeKey.generate().id);
  });
});
