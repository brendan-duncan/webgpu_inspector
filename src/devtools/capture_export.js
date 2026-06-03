import { captureStreamToLines, captureStreamToBlob, captureStreamLines } from "../utils/local_capture.js";
import { Texture } from "./gpu_objects/texture.js";
import { TextureView } from "./gpu_objects/texture_view.js";
import { Buffer } from "./gpu_objects/buffer.js";
import { ShaderModule } from "./gpu_objects/shader_module.js";

// 1.1 splits payload bytes out of the metadata into NDJSON payload lines so the
// panel's "Save Capture" never builds one >512MB string. Loaders accept 1.0 too.
const SCHEMA_VERSION = "1.1";

// Collects payload byte blobs during serialization, handing back `{__payloadId}`
// references (mirrors PayloadCollector in src/utils/local_capture.js).
class PayloadCollector {
  constructor() {
    this.payloads = []; // [{ id, typedArray, bytes }]
  }

  add(typedArray, length, bytes) {
    const id = this.payloads.length;
    this.payloads.push({ id, typedArray, bytes });
    return {
      __payloadId: id,
      __typedArray: typedArray,
      __length: length,
      __byteLength: bytes.length
    };
  }
}

// Fields on command objects that are internal UI/loading state and must not be serialized.
const _commandSkipKeys = new Set([
  "widget",
  "header",
  "bufferData",
  "loadedDataChunks",
  "isBufferDataLoaded",
  "dataPending",
  "_passIndex"
]);

/**
 * Build a serializable reference for a GPU object the database knows about.
 * @param {number} id
 * @param {ObjectDatabase} database
 * @returns {{__id: number, __class: string|undefined, __label: string|undefined}}
 */
function _objectRef(id, database) {
  const obj = database.getObject(id);
  const ref = { __id: id };
  if (obj) {
    ref.__class = obj.constructor.className;
    if (obj.label) {
      ref.__label = obj.label;
    }
  }
  return ref;
}

/**
 * Recursively clone a value into a JSON-safe structure, expanding internal
 * `__id` markers into richer `{__id, __class, __label}` references.
 */
function _cloneValue(value, database, collector) {
  if (value === null || value === undefined) {
    return value ?? null;
  }
  const t = typeof value;
  if (t === "string" || t === "boolean") {
    return value;
  }
  if (t === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (t === "bigint") {
    return value.toString();
  }
  if (ArrayBuffer.isView(value)) {
    // TypedArray — store the bytes out-of-band and reference them.
    const bytes = value instanceof Uint8Array
      ? value
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return collector.add(value.constructor.name, value.length, bytes);
  }
  if (value instanceof ArrayBuffer) {
    return collector.add("ArrayBuffer", value.byteLength, new Uint8Array(value));
  }
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; ++i) {
      out[i] = _cloneValue(value[i], database, collector);
    }
    return out;
  }
  if (t === "object") {
    if (value.__id !== undefined && Object.keys(value).length <= 3) {
      // GPU object reference marker from the page side. Expand it.
      return _objectRef(value.__id, database);
    }
    const out = {};
    for (const k in value) {
      if (!Object.prototype.hasOwnProperty.call(value, k)) {
        continue;
      }
      out[k] = _cloneValue(value[k], database, collector);
    }
    return out;
  }
  // Functions, symbols, etc. are skipped.
  return null;
}

/**
 * Serialize a single GPU object from the database into a JSON-safe record.
 */
function _serializeObject(obj, database, collector) {
  const record = {
    id: obj.id,
    type: obj.constructor.className,
    label: obj.label || undefined,
    descriptor: obj.descriptor ? _cloneValue(obj.descriptor, database, collector) : null
  };
  const stack = obj.stacktrace;
  if (stack) {
    record.stacktrace = stack;
  }
  if (obj instanceof Buffer && obj.size != null) {
    record.size = obj.size;
  }
  if (obj instanceof Texture) {
    record.width = obj.width;
    record.height = obj.height;
    record.depthOrArrayLayers = obj.depthOrArrayLayers;
    record.mipLevelCount = obj.mipLevelCount;
    record.format = obj.format;
    record.dimension = obj.dimension;
    const gpuSize = obj.getGpuSize();
    if (gpuSize >= 0) {
      record.gpuSize = gpuSize;
    }
    // Loaded pixel data, per mip level. Render-pass attachments captured
    // during the frame populate this automatically; other textures land here
    // when the user requests their data via the Inspect panel.
    const mipData = [];
    if (Array.isArray(obj.imageData)) {
      for (let level = 0; level < obj.imageData.length; ++level) {
        const bytes = obj.imageData[level];
        if (!(bytes instanceof Uint8Array)) {
          continue;
        }
        if (Array.isArray(obj.isImageDataLoaded) && obj.isImageDataLoaded[level] === false) {
          continue;
        }
        mipData.push({
          mipLevel: level,
          byteLength: bytes.length,
          ...collector.add("Uint8Array", bytes.length, bytes)
        });
      }
    }
    if (mipData.length) {
      record.mipData = mipData;
    }
  }
  if (obj instanceof TextureView && obj.texture != null) {
    record.texture = _objectRef(obj.texture, database);
  }
  if (obj instanceof ShaderModule) {
    record.hasVertexEntries = obj.hasVertexEntries;
    record.hasFragmentEntries = obj.hasFragmentEntries;
    record.hasComputeEntries = obj.hasComputeEntries;
    if (obj.replacementCode != null) {
      record.replacementCode = obj.replacementCode;
    }
  }
  return record;
}

/**
 * Pick out the set of objects to include in the export. We take the union of
 * `allObjects` (live in the database) and `capturedObjects` (ref-bumped during
 * the capture so they survive a delete during the frame).
 */
function _collectObjects(database) {
  const seen = new Map();
  const add = (map) => {
    if (!map) {
      return;
    }
    map.forEach((obj, id) => {
      if (!seen.has(id) && obj) {
        seen.set(id, obj);
      }
    });
  };
  add(database.allObjects);
  add(database.capturedObjects);
  return seen;
}

/**
 * Convert a captured command into a JSON-safe record. Keeps the loaded
 * indirect / mapped-read buffer data as base64 chunks.
 */
function _serializeCommand(command, index, database, collector) {
  const record = {
    index,
    method: command.method
  };
  if (command.object !== undefined) {
    record.object = _cloneValue(command.object, database, collector);
  }
  if (command.args !== undefined) {
    record.args = _cloneValue(command.args, database, collector);
  }
  if (command.result !== undefined) {
    record.result = _cloneValue(command.result, database, collector);
  }
  if (command.stacktrace) {
    record.stacktrace = command.stacktrace;
  }
  if (command._passIndex !== undefined) {
    record.passIndex = command._passIndex;
  }
  if (command.duration !== undefined) {
    record.duration = command.duration;
    record.startTime = command.startTime;
    record.endTime = command.endTime;
  }

  if (command.bufferData && command.isBufferDataLoaded) {
    const entries = [];
    for (let i = 0; i < command.bufferData.length; ++i) {
      if (!command.isBufferDataLoaded[i]) {
        continue;
      }
      const bytes = command.bufferData[i];
      if (!bytes) {
        continue;
      }
      entries.push({
        entryIndex: i,
        byteLength: bytes.length,
        ...collector.add("Uint8Array", bytes.length, bytes)
      });
    }
    if (entries.length) {
      record.bufferData = entries;
    }
  }

  // Pass through any unknown scalar/object fields that aren't internal state.
  for (const k in command) {
    if (!Object.prototype.hasOwnProperty.call(command, k)) {
      continue;
    }
    if (k in record || _commandSkipKeys.has(k) || k.startsWith("_")) {
      continue;
    }
    if (k === "id" || k === "method" || k === "object" || k === "args" || k === "result") {
      continue;
    }
    record[k] = _cloneValue(command[k], database, collector);
  }

  return record;
}

/**
 * Build the export object for a captured frame.
 * @param {number} frame
 * @param {Array<Object>} commands
 * @param {ObjectDatabase} database
 * @param {CaptureStatistics} statistics
 * @param {string} toolVersion
 */
export function buildCaptureStream(frame, commands, database, statistics, toolVersion) {
  const collector = new PayloadCollector();
  const stats = {};
  if (statistics) {
    for (const k in statistics) {
      if (!Object.prototype.hasOwnProperty.call(statistics, k) || k.startsWith("_")) {
        continue;
      }
      const v = statistics[k];
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") {
        stats[k] = v;
      }
    }
  }

  const validationErrors = [];
  database.validationErrors.forEach((err) => {
    validationErrors.push({
      id: err.id,
      objectId: err.object || 0,
      message: err.message,
      stacktrace: err.stacktrace || ""
    });
  });

  const objects = {};
  const objectMap = _collectObjects(database);
  objectMap.forEach((obj, id) => {
    objects[String(id)] = _serializeObject(obj, database, collector);
  });

  const cmdRecords = new Array(commands.length);
  for (let i = 0; i < commands.length; ++i) {
    const c = commands[i];
    cmdRecords[i] = c ? _serializeCommand(c, i, database, collector) : null;
  }

  const metadata = {
    schemaVersion: SCHEMA_VERSION,
    tool: "webgpu_inspector",
    toolVersion: toolVersion || "",
    exportedAt: new Date().toISOString(),
    frame,
    statistics: stats,
    validationErrors,
    objects,
    commands: cmdRecords,
    payloadCount: collector.payloads.length
  };

  return { metadata, payloads: collector.payloads };
}

/**
 * Serialize a capture to NDJSON text (metadata line + one payload line each).
 * Used for the in-panel "reopen in a new tab" round-trip.
 */
export function captureToText(frame, commands, database, statistics, toolVersion) {
  return captureStreamToLines(
    buildCaptureStream(frame, commands, database, statistics, toolVersion)
  ).join("");
}

/**
 * Build the capture and trigger an anchor download as NDJSON. The Blob is
 * assembled line by line (captureStreamToBlob) so a large capture's base64
 * inflation isn't all held in the JS heap at once.
 *
 * Note: this deliberately does NOT use the File System Access API
 * (showSaveFilePicker) — it is unreliable inside a DevTools extension panel and
 * could destabilize the panel renderer. The plain anchor download works there.
 */
// Above this many raw payload bytes, assembling the full base64 Blob in the
// DevTools panel renderer risks an out-of-memory crash. Beyond it we stream to
// disk (File System Access API) when possible, otherwise we cap how much payload
// data the Blob fallback includes.
const SAVE_STREAM_THRESHOLD = 32 * 1024 * 1024;
const SAVE_BLOB_BUDGET = 96 * 1024 * 1024;

export async function downloadCaptureJson(frame, commands, database, statistics, toolVersion) {
  console.log("[webgpu-inspector] Save: building capture stream...");
  const stream = buildCaptureStream(frame, commands, database, statistics, toolVersion);
  let payloadBytes = 0;
  for (const p of stream.payloads) {
    payloadBytes += p.bytes ? p.bytes.length : 0;
  }
  const filename = `webgpu_capture_frame_${frame}.json`;
  const fsaAvailable = typeof window !== "undefined" && typeof window.showSaveFilePicker === "function";
  console.log(`[webgpu-inspector] Save: ${Object.keys(stream.metadata.objects).length} objects, ` +
    `${stream.metadata.commands.length} commands, ${stream.payloads.length} payloads, ` +
    `${payloadBytes} payload bytes; showSaveFilePicker=${fsaAvailable}.`);

  // Large captures: stream NDJSON straight to disk so the (base64-inflated)
  // bytes never accumulate in the panel renderer. One line is encoded at a time
  // and flushed, so peak memory stays near the already-in-memory capture size.
  if (fsaAvailable && payloadBytes > SAVE_STREAM_THRESHOLD) {
    try {
      console.log("[webgpu-inspector] Save: opening file picker to stream to disk...");
      const handle = await window.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: "WebGPU Inspector capture", accept: { "application/json": [".json"] } }]
      });
      const writable = await handle.createWritable();
      let i = 0;
      for (const line of captureStreamLines(stream)) {
        await writable.write(line);
        if ((++i % 8) === 0) {
          console.log(`[webgpu-inspector] Save: streamed ${i} lines...`);
        }
      }
      await writable.close();
      console.log(`[webgpu-inspector] Save: streamed ${i} lines to disk. Done.`);
      return;
    } catch (e) {
      if (e && e.name === "AbortError") {
        console.log("[webgpu-inspector] Save: cancelled.");
        return;
      }
      console.warn("[webgpu-inspector] Save: disk streaming failed, falling back to a budgeted in-memory save:", e && e.message);
    }
  }

  // Blob fallback. Budget the payloads so the panel renderer can't OOM; omitted
  // payloads are still referenced in the metadata and load as "omitted".
  const budget = payloadBytes > SAVE_BLOB_BUDGET ? SAVE_BLOB_BUDGET : undefined;
  console.log(`[webgpu-inspector] Save: assembling blob${budget ? ` (capped at ${budget} payload bytes)` : ""}...`);
  const { blob, omittedPayloads, includedPayloads } = captureStreamToBlob(stream, "application/json", budget);
  if (omittedPayloads) {
    console.warn(`[webgpu-inspector] Save: ${omittedPayloads} payload(s) omitted to fit memory ` +
      `(${includedPayloads} included). For a complete save of a large capture, use a browser that ` +
      "supports the File System Access API, or capture via the Claude Code bridge.");
  }
  console.log(`[webgpu-inspector] Save: blob ready (${blob.size} bytes); starting download.`);
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
  console.log("[webgpu-inspector] Save: download triggered.");
}
