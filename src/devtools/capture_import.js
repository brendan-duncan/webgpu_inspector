import { decodeBase64 } from "../utils/base64.js";
import { CaptureStatistics } from "./capture_statistics.js";
import * as GPU from "./gpu_objects/index.js";

const _typeConstructors = {
  Adapter: GPU.Adapter,
  Device: GPU.Device,
  Sampler: GPU.Sampler,
  Texture: GPU.Texture,
  TextureView: GPU.TextureView,
  Buffer: GPU.Buffer,
  BindGroup: GPU.BindGroup,
  BindGroupLayout: GPU.BindGroupLayout,
  ShaderModule: GPU.ShaderModule,
  PipelineLayout: GPU.PipelineLayout,
  RenderPipeline: GPU.RenderPipeline,
  ComputePipeline: GPU.ComputePipeline,
  RenderBundle: GPU.RenderBundle
};

const _typedArrayCtors = {
  Uint8Array,
  Int8Array,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
  BigInt64Array,
  BigUint64Array,
  Uint8ClampedArray
};

// Reconstruct a TypedArray/ArrayBuffer of the named type from raw bytes.
function _bytesToTypedArray(typedArray, bytes) {
  if (typedArray === "ArrayBuffer") {
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  }
  const Ctor = _typedArrayCtors[typedArray];
  if (!Ctor || Ctor === Uint8Array) {
    return bytes;
  }
  const bpe = Ctor.BYTES_PER_ELEMENT;
  if (bytes.byteOffset % bpe !== 0 || bytes.byteLength % bpe !== 0) {
    // Re-align by copying into a fresh buffer.
    const copy = new Uint8Array(bytes.byteLength);
    copy.set(bytes);
    return new Ctor(copy.buffer);
  }
  return new Ctor(bytes.buffer, bytes.byteOffset, bytes.byteLength / bpe);
}

// Bytes for a payload reference: a 1.1 `{__payloadId}` resolved from the
// out-of-band payloads map, or legacy 1.0 inline `__base64`. Returns null if
// the bytes are not available (e.g. the payload was omitted/truncated away).
function _payloadBytes(ref, payloads) {
  if (typeof ref.__payloadId === "number") {
    return (payloads && payloads.get(ref.__payloadId)) || null;
  }
  if (typeof ref.__base64 === "string") {
    return decodeBase64(ref.__base64);
  }
  return null;
}

/**
 * Recursively rewrite a value coming from an exported JSON capture:
 * - `__id` markers get their id remapped by the per-import offset
 * - `{__typedArray, __base64}` (1.0) and `{__payloadId}` (1.1) payload markers
 *   get reconstructed into TypedArrays
 * Everything else is cloned through.
 */
function _rewriteValue(value, idOffset, payloads) {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; ++i) {
      out[i] = _rewriteValue(value[i], idOffset, payloads);
    }
    return out;
  }
  if (typeof value.__id === "number") {
    const ref = { __id: value.__id + idOffset };
    if (value.__class) ref.__class = value.__class;
    if (value.__label) ref.__label = value.__label;
    return ref;
  }
  if (typeof value.__typedArray === "string" &&
      (typeof value.__base64 === "string" || typeof value.__payloadId === "number")) {
    const bytes = _payloadBytes(value, payloads);
    if (!bytes) {
      // Payload omitted (truncated/out-of-scope); keep the lightweight marker.
      return { __typedArray: value.__typedArray, __length: value.__length, __base64Omitted: true };
    }
    return _bytesToTypedArray(value.__typedArray, bytes);
  }
  const out = {};
  for (const k in value) {
    if (!Object.prototype.hasOwnProperty.call(value, k)) {
      continue;
    }
    out[k] = _rewriteValue(value[k], idOffset, payloads);
  }
  return out;
}

/**
 * Parse capture file text into `{ data, payloads }`, accepting both formats:
 *  - 1.0 legacy: a single JSON object with base64 inlined (payloads empty).
 *  - 1.1 NDJSON: a metadata line followed by one payload line each; payloads is
 *    a Map<payloadId, Uint8Array>.
 */
export function parseCaptureText(text) {
  // Legacy single-object captures parse whole.
  try {
    const json = JSON.parse(text);
    if (json && typeof json === "object" && Array.isArray(json.commands)) {
      return { data: json, payloads: new Map() };
    }
  } catch (e) {
    // Not a single JSON object — fall through to NDJSON parsing.
  }
  let data = null;
  const payloads = new Map();
  const lines = text.split("\n");
  for (const line of lines) {
    if (!line) {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (data === null) {
      data = obj;
    } else if (obj && typeof obj.__payloadId === "number" && typeof obj.base64 === "string") {
      payloads.set(obj.__payloadId, decodeBase64(obj.base64));
    }
  }
  return { data, payloads };
}

/**
 * Deserialize an exported capture JSON file and install its objects into the
 * given database under a fresh ID range.
 *
 * @param {Object} data - The parsed JSON object.
 * @param {ObjectDatabase} database - The live database; imported objects are
 *   added to `database.capturedObjects` under remapped IDs.
 * @param {number} idOffset - The offset to add to every imported ID.
 * @returns {{
 *   frame: number,
 *   commands: Array<Object>,
 *   statistics: CaptureStatistics,
 *   importedObjectIds: Set<number>
 * }}
 */
export function importCaptureJson(data, database, idOffset, payloads) {
  if (!data || typeof data !== "object") {
    throw new Error("Capture JSON is empty or not an object.");
  }
  payloads = payloads || new Map();

  const importedObjectIds = new Set();

  const objects = data.objects || {};
  for (const idStr in objects) {
    if (!Object.prototype.hasOwnProperty.call(objects, idStr)) {
      continue;
    }
    const rec = objects[idStr];
    const Ctor = _typeConstructors[rec.type];
    if (!Ctor) {
      continue;
    }
    const newId = Number(idStr) + idOffset;
    const desc = _rewriteValue(rec.descriptor, idOffset, payloads);
    let obj;
    if (Ctor === GPU.TextureView) {
      // Live TextureViews store `texture` as the parent texture's numeric id
      // (set from `message.parent` in object_database.js _addObject). The
      // export records this as an `{__id, __class, __label}` ref; pull the
      // numeric id back out so getTextureFromView() can Map.get() it.
      const rawTexRef = rec.texture;
      const parentRawId = rawTexRef && typeof rawTexRef.__id === "number"
        ? rawTexRef.__id
        : Number(rawTexRef ?? 0);
      const parentId = Number.isFinite(parentRawId) ? parentRawId + idOffset : 0;
      obj = new Ctor(newId, parentId, desc || {}, rec.stacktrace || "");
    } else {
      obj = new Ctor(newId, desc || {}, rec.stacktrace || "");
    }
    if (rec.label) {
      obj.label = rec.label;
    }
    // Restore loaded texture pixel data, if present.
    if (Ctor === GPU.Texture && Array.isArray(rec.mipData)) {
      for (const mip of rec.mipData) {
        if (!mip) {
          continue;
        }
        const bytes = _payloadBytes(mip, payloads);
        if (!bytes) {
          continue;
        }
        obj.imageData[mip.mipLevel] = bytes;
        obj.isImageDataLoaded[mip.mipLevel] = true;
        obj.imageDataPending[mip.mipLevel] = false;
      }
    }
    // Bump well above zero so casual decrements don't sweep the object away
    // before the import tab is closed (the close handler does its own cleanup).
    obj._referenceCount = 1_000_000;
    database.capturedObjects.set(newId, obj);
    importedObjectIds.add(newId);
  }

  const rawCommands = Array.isArray(data.commands) ? data.commands : [];
  const commands = new Array(rawCommands.length);
  for (let i = 0; i < rawCommands.length; ++i) {
    const c = rawCommands[i];
    if (!c) {
      commands[i] = null;
      continue;
    }
    const cmd = {
      id: i,
      method: c.method
    };
    if (c.object !== undefined) cmd.object = _rewriteValue(c.object, idOffset, payloads);
    if (c.args !== undefined) cmd.args = _rewriteValue(c.args, idOffset, payloads);
    if (c.result !== undefined) cmd.result = _rewriteValue(c.result, idOffset, payloads);
    if (c.stacktrace) cmd.stacktrace = c.stacktrace;
    if (c.passIndex !== undefined) cmd._passIndex = c.passIndex;
    if (c.duration !== undefined) {
      cmd.duration = c.duration;
      cmd.startTime = c.startTime;
      cmd.endTime = c.endTime;
    }
    if (Array.isArray(c.bufferData)) {
      cmd.bufferData = [];
      cmd.isBufferDataLoaded = [];
      for (const entry of c.bufferData) {
        if (!entry) {
          continue;
        }
        const bytes = _payloadBytes(entry, payloads);
        if (!bytes) {
          continue;
        }
        cmd.bufferData[entry.entryIndex] = bytes;
        cmd.isBufferDataLoaded[entry.entryIndex] = true;
      }
    }
    commands[i] = cmd;
  }

  const statistics = new CaptureStatistics();
  if (data.statistics && typeof data.statistics === "object") {
    for (const k in data.statistics) {
      if (Object.prototype.hasOwnProperty.call(statistics, k) &&
          typeof data.statistics[k] === typeof statistics[k]) {
        statistics[k] = data.statistics[k];
      }
    }
  }

  return {
    frame: typeof data.frame === "number" ? data.frame : 0,
    commands,
    statistics,
    importedObjectIds
  };
}
