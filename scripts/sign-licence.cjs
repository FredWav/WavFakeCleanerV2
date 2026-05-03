#!/usr/bin/env node
/**
 * Sign a WFC licence token with the owner's Ed25519 private key.
 *
 * Usage:
 *   WFC_PRIV_D="<base64url-d>" node scripts/sign-licence.js <userId> [expiryDays]
 *
 * Examples:
 *   WFC_PRIV_D=YGcB... node scripts/sign-licence.js fred-owner
 *   WFC_PRIV_D=YGcB... node scripts/sign-licence.js beta-alice 30
 *
 * The private key MUST never be committed. Keep it in a password manager.
 * Only the matching public key is embedded in the extension code.
 */

const { createPrivateKey, sign } = require("crypto");

const PRIV_D = process.env.WFC_PRIV_D;
const PRIV_X = process.env.WFC_PRIV_X;
if (!PRIV_D || !PRIV_X) {
  console.error("ERROR: set WFC_PRIV_D and WFC_PRIV_X env vars (the JWK d and x base64url coordinates).");
  process.exit(1);
}

const userId = process.argv[2];
if (!userId) {
  console.error("Usage: WFC_PRIV_D=... WFC_PRIV_X=... node scripts/sign-licence.js <userId> [expiryDays]");
  process.exit(1);
}
const expiryDays = process.argv[3] ? parseInt(process.argv[3], 10) : null;

const privKey = createPrivateKey({
  key: { kty: "OKP", crv: "Ed25519", d: PRIV_D, x: PRIV_X },
  format: "jwk",
});

const payload = {
  u: userId,
  i: Date.now(),
};
if (expiryDays && expiryDays > 0) {
  payload.e = Date.now() + expiryDays * 86400 * 1000;
}

const payloadBytes = Buffer.from(JSON.stringify(payload), "utf8");
const signature = sign(null, payloadBytes, privKey);

const token =
  "wfc_lic_" +
  payloadBytes.toString("base64url") +
  "." +
  signature.toString("base64url");

console.log("Token for", userId + ":");
console.log(token);
if (payload.e) {
  console.log("Expires:", new Date(payload.e).toISOString());
} else {
  console.log("Expires: never");
}
