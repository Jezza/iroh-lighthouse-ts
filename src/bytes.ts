/**
 * Byte helpers, written against what every modern runtime already has.
 *
 * Deliberately no dependency on Node's `Buffer`: this library is meant to run
 * in a browser from a static file server, so everything here uses only
 * `TextEncoder`, `atob`/`btoa` where available, and plain loops.
 */

const ENCODER = /* @__PURE__ */ new TextEncoder();
const DECODER = /* @__PURE__ */ new TextDecoder();

/** UTF-8 encode a string. */
export function utf8(s: string): Uint8Array {
  return ENCODER.encode(s);
}

/** UTF-8 decode bytes. */
export function fromUtf8(b: Uint8Array): string {
  return DECODER.decode(b);
}

const HEX = "0123456789abcdef";

/** Lowercase hex, matching how iroh renders keys. */
export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += HEX[b >> 4]! + HEX[b & 15]!;
  return out;
}

/** Parse lowercase or uppercase hex. */
export function hexToBytes(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new TypeError("hex string has an odd length");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new TypeError(`invalid hex at offset ${i * 2}`);
    out[i] = byte;
  }
  return out;
}

/**
 * base64url without padding — the alphabet the protocol uses.
 *
 * Built on `btoa` so it works in a browser with no polyfill, with a manual
 * fallback for runtimes that lack it.
 */
export function base64urlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 =
    typeof btoa === "function" ? btoa(binary) : nodeBtoa(binary);
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Inverse of {@link base64urlEncode}. Tolerates missing padding. */
export function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const binary = typeof atob === "function" ? atob(padded) : nodeAtob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/* Fallbacks for runtimes without the browser globals. Kept tiny and local
 * rather than pulling in a polyfill package. */

function nodeBtoa(binary: string): string {
  const g = globalThis as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } };
  if (!g.Buffer) throw new Error("no base64 encoder available in this runtime");
  return g.Buffer.from(binary, "binary").toString("base64");
}

function nodeAtob(b64: string): string {
  const g = globalThis as { Buffer?: { from(s: string, enc: string): { toString(enc: string): string } } };
  if (!g.Buffer) throw new Error("no base64 decoder available in this runtime");
  return g.Buffer.from(b64, "base64").toString("binary");
}

/** Constant-ish time comparison, used for ids rather than secrets. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}
