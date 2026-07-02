// Binary capture container ("WGPUCAP") — Node twin of
// src/utils/capture_binary.js. The plugin server is distributed standalone and
// cannot import from src/, so the codec is duplicated; the two files must stay
// in sync (the format description lives in the src twin, and
// test/run.js round-trips files across both).
//
// Layout: "WGPUCAP <version> <jsonByteLength>\n", then the metadata JSON
// (UTF-8), newline padding to an 8-byte boundary, then raw payload bytes
// located by metadata.payloadTable ([byteOffset, byteLength] per payloadId,
// offsets relative to the binary section, each payload zero-padded to 8 bytes).

const MAGIC = "WGPUCAP";
const CONTAINER_VERSION = 1;
const MAX_HEADER_LENGTH = 64;

const _textEncoder = new TextEncoder();
const _textDecoder = new TextDecoder();

// Arithmetic (not bitwise) so offsets past 2^31 don't truncate.
function _align8(n) {
  return Math.ceil(n / 8) * 8;
}

// True if `bytes` (at least the first 8 bytes of a file) starts with the
// binary capture magic.
export function isCaptureBinary(bytes) {
  if (!bytes || bytes.length < MAGIC.length + 1) {
    return false;
  }
  for (let i = 0; i < MAGIC.length; ++i) {
    if (bytes[i] !== MAGIC.charCodeAt(i)) {
      return false;
    }
  }
  return bytes[MAGIC.length] === 0x20; // "WGPUCAP "
}

// Encode `{ metadata, payloads: [{ id, bytes }] }` into an ordered list of
// byte chunks (payload bytes referenced, not copied). Write the parts
// sequentially to a stream or concatenate them.
export function encodeCaptureBinaryParts(stream) {
  const payloads = stream.payloads || [];
  const table = [];
  let offset = 0;
  for (const p of payloads) {
    const len = p.bytes ? p.bytes.length : 0;
    while (table.length < p.id) {
      table.push(null);
    }
    table[p.id] = [offset, len];
    offset = _align8(offset + len);
  }

  const metadata = { ...stream.metadata, payloadTable: table };
  const jsonBytes = _textEncoder.encode(JSON.stringify(metadata));
  const header = _textEncoder.encode(`${MAGIC} ${CONTAINER_VERSION} ${jsonBytes.length}\n`);

  const parts = [header, jsonBytes];
  const preludeLength = header.length + jsonBytes.length;
  let byteLength = _align8(preludeLength);
  const preludePad = byteLength - preludeLength;
  if (preludePad) {
    parts.push(new Uint8Array(preludePad).fill(0x0a));
  }

  for (const p of payloads) {
    const bytes = p.bytes || new Uint8Array(0);
    if (bytes.length) {
      parts.push(bytes);
      byteLength += bytes.length;
    }
    const pad = _align8(bytes.length) - bytes.length;
    if (pad) {
      parts.push(new Uint8Array(pad));
      byteLength += pad;
    }
  }

  return { parts, byteLength };
}

// Decode a binary capture from a Buffer/Uint8Array over the whole file.
// Returns `{ metadata, payloads: Map<payloadId, Uint8Array> }`; payload values
// are zero-copy views. Payloads whose table entry runs past the end of the
// file are absent from the map (loaders treat missing payloads as omitted).
export function decodeCaptureBinary(bytes) {
  if (!isCaptureBinary(bytes)) {
    throw new Error("Not a WebGPU Inspector binary capture (missing WGPUCAP header).");
  }
  const headerLimit = Math.min(bytes.length, MAX_HEADER_LENGTH);
  let newline = -1;
  for (let i = 0; i < headerLimit; ++i) {
    if (bytes[i] === 0x0a) {
      newline = i;
      break;
    }
  }
  if (newline < 0) {
    throw new Error("Malformed binary capture: header line not terminated.");
  }
  const header = _textDecoder.decode(bytes.subarray(0, newline)).split(" ");
  const version = parseInt(header[1], 10);
  const jsonLength = parseInt(header[2], 10);
  if (!Number.isFinite(version) || !Number.isFinite(jsonLength) || jsonLength < 0) {
    throw new Error("Malformed binary capture: bad header line.");
  }
  if (version > CONTAINER_VERSION) {
    throw new Error(`Binary capture container version ${version} is newer than this ` +
      `loader (max ${CONTAINER_VERSION}). Update the webgpu-inspector plugin to load this file.`);
  }
  const jsonStart = newline + 1;
  const jsonEnd = jsonStart + jsonLength;
  if (jsonEnd > bytes.length) {
    throw new Error("Malformed binary capture: file shorter than its metadata.");
  }
  const metadata = JSON.parse(_textDecoder.decode(bytes.subarray(jsonStart, jsonEnd)));

  const binaryStart = _align8(jsonEnd);
  const payloads = new Map();
  const table = Array.isArray(metadata.payloadTable) ? metadata.payloadTable : [];
  for (let id = 0; id < table.length; ++id) {
    const entry = table[id];
    if (!entry) {
      continue;
    }
    const start = binaryStart + entry[0];
    const len = entry[1];
    if (!(len >= 0) || start + len > bytes.length) {
      continue;
    }
    payloads.set(id, bytes.subarray(start, start + len));
  }
  return { metadata, payloads };
}
