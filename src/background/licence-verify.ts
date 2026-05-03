/**
 * Licence token verifier — Ed25519 signature check.
 *
 * Token format: wfc_lic_<base64url(payloadJson)>.<base64url(signature)>
 * Payload: { u: string (userId), i: number (issuedAt ms), e?: number (expiry ms) }
 *
 * The public key below is the *only* secret in the extension code. It can verify
 * but never sign — the matching private key is held offline by the owner. Even
 * if every byte of the extension is reverse-engineered, no attacker can forge a
 * valid token without solving the discrete log problem on the Curve25519 group.
 */

// 32-byte Ed25519 public key (raw, base64url-encoded).
// Generated 2026-04 with Node crypto.generateKeyPairSync('ed25519').
const OWNER_PUBLIC_KEY_B64URL = "VigQhxIpVo-8gMZf8N6ljD7vrkGXkbEbIhB-Diw90cI";

const TOKEN_PREFIX = "wfc_lic_";

let cachedPubKey: CryptoKey | null = null;

function base64urlToBytes(b64url: string): Uint8Array {
  // Convert base64url → base64
  const b64 = b64url.replace(/-/g, "+").replace(/_/g, "/");
  // Add padding
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  const bin = atob(padded);
  // Allocate a fresh ArrayBuffer-backed Uint8Array (avoids SharedArrayBuffer typing)
  const buf = new ArrayBuffer(bin.length);
  const out = new Uint8Array(buf);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function asArrayBuffer(u8: Uint8Array): ArrayBuffer {
  // Slice the underlying buffer to a fresh ArrayBuffer (Web Crypto rejects SharedArrayBuffer)
  return u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength) as ArrayBuffer;
}

async function getPubKey(): Promise<CryptoKey> {
  if (cachedPubKey) return cachedPubKey;
  const keyBytes = base64urlToBytes(OWNER_PUBLIC_KEY_B64URL);
  cachedPubKey = await crypto.subtle.importKey(
    "raw",
    asArrayBuffer(keyBytes),
    { name: "Ed25519" } as unknown as AlgorithmIdentifier,
    false,
    ["verify"],
  );
  return cachedPubKey;
}

interface LicencePayload {
  u: string;        // userId
  i: number;        // issuedAt (ms)
  e?: number;       // optional expiry (ms)
}

export interface VerifyResult {
  valid: boolean;
  userId?: string;
  expiresAt?: number;
}

export async function verifyLicenceToken(token: string): Promise<VerifyResult> {
  if (!token.startsWith(TOKEN_PREFIX)) return { valid: false };

  const body = token.slice(TOKEN_PREFIX.length);
  const dotIdx = body.indexOf(".");
  if (dotIdx <= 0 || dotIdx === body.length - 1) return { valid: false };

  const payloadB64 = body.slice(0, dotIdx);
  const signatureB64 = body.slice(dotIdx + 1);

  let payloadBytes: Uint8Array;
  let signatureBytes: Uint8Array;
  try {
    payloadBytes = base64urlToBytes(payloadB64);
    signatureBytes = base64urlToBytes(signatureB64);
  } catch {
    return { valid: false };
  }

  // Ed25519 signatures are exactly 64 bytes
  if (signatureBytes.length !== 64) return { valid: false };

  let pubKey: CryptoKey;
  try {
    pubKey = await getPubKey();
  } catch {
    return { valid: false };
  }

  let ok: boolean;
  try {
    ok = await crypto.subtle.verify(
      { name: "Ed25519" } as unknown as AlgorithmIdentifier,
      pubKey,
      asArrayBuffer(signatureBytes),
      asArrayBuffer(payloadBytes),
    );
  } catch {
    return { valid: false };
  }
  if (!ok) return { valid: false };

  let payload: LicencePayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes)) as LicencePayload;
  } catch {
    return { valid: false };
  }

  if (typeof payload.u !== "string" || payload.u.length === 0) return { valid: false };
  if (typeof payload.i !== "number") return { valid: false };

  if (payload.e !== undefined) {
    if (typeof payload.e !== "number") return { valid: false };
    if (payload.e < Date.now()) return { valid: false };
  }

  return { valid: true, userId: payload.u, expiresAt: payload.e };
}
