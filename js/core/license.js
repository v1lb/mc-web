// Offline Pro keys, the same as in the Android app. Format: MC1.<payload base64url>.<signature base64url>,
// ECDSA P-256 / SHA-256 (DER) over "MC1.<payload>". Payload: {"id": "...", "exp": unix seconds (optional), "note": "..."}.

export const PUBLIC_KEY_BASE64 = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE84nzSRhInK2CpP4c9eaFKRU/2FPI3GraJ8DeyFpDbO1WP2BdT8vgJfGgWLxr/HThgXsfqfE6DiFPE7XD5iboFA==';
const PREFIX = 'MC1';
const MAX_TOKEN_CHARS = 2048;

export class LicenseError extends Error {
  constructor(code) { super(code); this.code = code; }
}

function base64ToBytes(text, url = false) {
  let s = text;
  if (url) s = s.replace(/-/g, '+').replace(/_/g, '/');
  s = s.replace(/=+$/, '');
  if (/[^A-Za-z0-9+/]/.test(s)) throw new LicenseError('MALFORMED');
  const bin = atob(s + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** DER ECDSA signature (SEQUENCE of two INTEGERs) → raw r|s, 32 bytes each, as WebCrypto expects. */
function derToRaw(der) {
  let p = 0;
  const fail = () => { throw new LicenseError('BAD_SIGNATURE'); };
  if (der[p++] !== 0x30) fail();
  if (der[p] & 0x80) p += 1 + (der[p] & 0x7F); else p++;
  const out = new Uint8Array(64);
  for (let i = 0; i < 2; i++) {
    if (der[p++] !== 0x02) fail();
    const len = der[p++];
    let bytes = der.subarray(p, p + len);
    p += len;
    while (bytes.length > 32 && bytes[0] === 0) bytes = bytes.subarray(1);
    if (bytes.length > 32) fail();
    out.set(bytes, i * 32 + 32 - bytes.length);
  }
  return out;
}

/** Resolves to { id, expiresAt, note }. Rejects with LicenseError: NOT_ENABLED, MALFORMED, BAD_SIGNATURE, EXPIRED. */
export async function verifyLicense(raw, publicKeyBase64 = PUBLIC_KEY_BASE64, nowSeconds = Date.now() / 1000) {
  if (!publicKeyBase64.trim()) throw new LicenseError('NOT_ENABLED');
  const token = String(raw).trim();
  if (token.length > MAX_TOKEN_CHARS) throw new LicenseError('MALFORMED');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) throw new LicenseError('MALFORMED');
  try {
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signature = derToRaw(base64ToBytes(parts[2], true));
    const key = await crypto.subtle.importKey('spki', base64ToBytes(publicKeyBase64.trim()), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, signature, signed);
    if (!ok) throw new LicenseError('BAD_SIGNATURE');
    const payload = JSON.parse(new TextDecoder().decode(base64ToBytes(parts[1], true)));
    const id = typeof payload.id === 'string' ? payload.id : '';
    if (!id.trim() || id.length > 64) throw new LicenseError('MALFORMED');
    const expiresAt = payload.exp != null ? Number(payload.exp) : null;
    if (expiresAt != null && (!Number.isFinite(expiresAt) || nowSeconds > expiresAt)) throw new LicenseError(Number.isFinite(expiresAt) ? 'EXPIRED' : 'MALFORMED');
    const note = typeof payload.note === 'string' && payload.note.trim() ? payload.note.slice(0, 100) : null;
    return { id, expiresAt, note };
  } catch (e) {
    if (e instanceof LicenseError) throw e;
    throw new LicenseError('MALFORMED');
  }
}
