// Synchronous base64 helpers. Used to ferry binary buffer/texture chunks across the
// page → content-script → background → panel pipeline, which is JSON-only.
//
// Prefer the native Uint8Array.prototype.toBase64 / Uint8Array.fromBase64 when present
// (Chrome 137+, Firefox 132+). Fall back to btoa/atob with chunked String.fromCharCode
// for older runtimes.

const _hasNativeToBase64 = typeof Uint8Array.prototype.toBase64 === "function";
const _hasNativeFromBase64 = typeof Uint8Array.fromBase64 === "function";

// 0x8000 keeps String.fromCharCode.apply below typical engine argument limits.
const _fromCharCodeChunk = 0x8000;

export function encodeBase64(bytes) {
  if (_hasNativeToBase64) {
    return bytes.toBase64();
  }
  let binary = "";
  const len = bytes.length;
  for (let i = 0; i < len; i += _fromCharCodeChunk) {
    const end = i + _fromCharCodeChunk < len ? i + _fromCharCodeChunk : len;
    binary += String.fromCharCode.apply(null, bytes.subarray(i, end));
  }
  return btoa(binary);
}

export function decodeBase64(str) {
  if (_hasNativeFromBase64) {
    return Uint8Array.fromBase64(str);
  }
  const binary = atob(str);
  const len = binary.length;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

// Legacy async helpers retained as thin wrappers so anything still importing them
// keeps working. New code should use the sync helpers above.
export async function encodeDataUrl(bytes, type = "application/octet-stream") {
  return `data:${type};base64,${encodeBase64(bytes)}`;
}

export async function decodeDataUrl(dataUrl) {
  const comma = dataUrl.indexOf(",");
  return decodeBase64(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
}
