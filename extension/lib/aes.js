/**
 * HLS AES-128 (full-segment AES-128-CBC with PKCS7) decryption via WebCrypto.
 * This is the standard, non-DRM HLS encryption whose key the player fetches
 * openly; DRM schemes (SAMPLE-AES, FairPlay, Widevine) are refused upstream.
 */

const keyCache = new Map();

async function importKey(keyBytes) {
  const id = Array.from(keyBytes).join(',');
  if (!keyCache.has(id)) {
    keyCache.set(id, globalThis.crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['decrypt']));
  }
  return keyCache.get(id);
}

/**
 * @param {Uint8Array} data encrypted segment
 * @param {Uint8Array} keyBytes 16-byte key
 * @param {Uint8Array} iv 16-byte IV
 * @returns {Promise<Uint8Array>}
 */
export async function decryptAes128(data, keyBytes, iv) {
  if (keyBytes.length !== 16) throw new Error(`AES-128 key must be 16 bytes, got ${keyBytes.length}`);
  const key = await importKey(keyBytes);
  const out = await globalThis.crypto.subtle.decrypt({ name: 'AES-CBC', iv }, key, data);
  return new Uint8Array(out);
}
