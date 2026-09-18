/**
 * The portal's request-signing scheme, reverse-engineered by jsjiit/pyjiit and re-implemented here because
 * jsjiit keeps all of it private (it exports only `WebPortal` and `LoginError`).
 *
 * Two things are built from it:
 * - `generateLocalName()` - the `LocalName` header the API wants on *every* call, authenticated or not.
 * - `serializePayload()` - the encrypted request body most endpoints take instead of plain JSON.
 *
 * Both are AES-CBC with a fixed IV and a key derived from today's date, so a payload is only valid on the
 * day it was built. Runs on WebCrypto, which is `globalThis.crypto` in browsers and in Node 18+.
 */

const IV = new TextEncoder().encode("dcek9wb8frty1pnm");
const CHARSET = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";

function subtle() {
  const c = globalThis.crypto;
  if (!c?.subtle) {
    throw new Error("WebCrypto unavailable - jiit-api needs a browser or Node 18+ (globalThis.crypto.subtle).");
  }
  return c.subtle;
}

function base64Encode(bytes) {
  const arr = new Uint8Array(bytes);
  if (typeof btoa === "function") return btoa(String.fromCharCode.apply(null, arr));
  return Buffer.from(arr).toString("base64");
}

/**
 * The date-derived seed both the key and the `LocalName` nonce are built from: the digits of
 * DD/MM/YY interleaved around the weekday number, exactly as the portal's own frontend does it.
 */
export function generateDateSeq(date = null) {
  const d = date ?? new Date();
  const day = String(d.getDate()).padStart(2, "0");
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const year = String(d.getFullYear()).slice(2);
  const weekday = String(d.getDay());
  return day[0] + month[0] + year[0] + weekday + day[1] + month[1] + year[1];
}

function randomChars(n) {
  let out = "";
  for (let i = 0; i < n; i++) out += CHARSET[Math.floor(Math.random() * CHARSET.length)];
  return out;
}

async function generateKey(date = null) {
  const keyData = new TextEncoder().encode("qa8y" + generateDateSeq(date) + "ty1pn");
  return subtle().importKey("raw", keyData, { name: "AES-CBC" }, false, ["encrypt", "decrypt"]);
}

async function encrypt(bytes, date = null) {
  const key = await generateKey(date);
  return new Uint8Array(await subtle().encrypt({ name: "AES-CBC", iv: IV }, key, bytes));
}

/** The encrypted, base64'd body most endpoints expect in place of plain JSON. */
export async function serializePayload(payload, date = null) {
  return base64Encode(await encrypt(new TextEncoder().encode(JSON.stringify(payload)), date));
}

/** The `LocalName` header value - a fresh random nonce wrapped in the same day-keyed encryption. */
export async function generateLocalName(date = null) {
  const plaintext = new TextEncoder().encode(randomChars(4) + generateDateSeq(date) + randomChars(5));
  return base64Encode(await encrypt(plaintext, date));
}
