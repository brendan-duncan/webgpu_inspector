// Page-side store that mirrors what the devtools panel keeps when a frame is
// captured. Lets the inspector script be used outside of devtools to capture
// frames and save them as JSON files in the exact same format the devtools
// Capture panel reads with its "Load Capture" action.
//
// The flow:
// - `processMessage(msg)` consumes the same messages `_postMessage` posts to
//   devtools (object lifecycle, captured command batches, texture/buffer
//   readback chunks). The page-side inspector hands them in directly.
// - `buildCaptureStream()` produces the export payload (metadata + out-of-band
//   payloads) that mirrors `src/devtools/capture_export.js#buildCaptureStream` —
//   they must agree on schema so files round-trip.

import { Actions } from "./actions.js";
import { encodeBase64, decodeBase64 } from "./base64.js";
import { TextureFormatInfo } from "./texture_format_info.js";

// 1.1 splits payload bytes (buffer/texture data) out of the metadata into a
// side list referenced by `{__payloadId}`, so the capture can be streamed as
// NDJSON and never built as one >512MB string. Loaders still accept 1.0 files,
// which inlined the bytes as `__base64`.
const SCHEMA_VERSION = "1.1";

const _hasOwn = Object.prototype.hasOwnProperty;

// Collects payload byte blobs during serialization and hands back lightweight
// references to embed in the metadata. Each blob gets a sequential id; the
// bytes are streamed out-of-band (see BridgeClient / saveCaptureData).
class PayloadCollector {
  constructor() {
    this.payloads = []; // [{ id, typedArray, bytes: Uint8Array }]
  }

  // `length` is the element count of the original view; `bytes` is the captured
  // byte slice; `originalByteLength` (optional) is the true length when the
  // capture cap truncated the data. Returns the metadata reference.
  add(typedArray, length, bytes, originalByteLength) {
    const id = this.payloads.length;
    this.payloads.push({ id, typedArray, bytes });
    const ref = {
      __payloadId: id,
      __typedArray: typedArray,
      __length: length,
      __byteLength: bytes.length
    };
    if (originalByteLength && originalByteLength > bytes.length) {
      ref.__truncated = { byteLength: originalByteLength, capturedBytes: bytes.length };
    }
    return ref;
  }
}

export class LocalCaptureStore {
  constructor() {
    // id -> record { id, type, label, descriptor, stacktrace, pending, parent,
    //                 imageData[], isImageDataLoaded[], _loadedImageChunks[] }
    this._objects = new Map();
    this._validationErrors = [];
    // commandId -> command record. Used to route CaptureBufferData chunks back
    // to the command they belong to.
    this._commandsById = new Map();
    // Concatenated commands across every frame the user captured, in order.
    this._commands = [];
    // CaptureFrameResults reserves the next slice in `_commands`; the
    // CaptureFrameCommands batches fill it in.
    this._currentSlot = null;
    // Track the frame number of the first captured frame so the export reports
    // a meaningful `frame` field. Defaults to 0 if nothing was captured.
    this._firstFrame = null;
    // commandId -> array of CaptureBufferData messages that arrived before the
    // corresponding command record. Drained when the command lands.
    this._pendingBufferData = new Map();
    // Timestamp readback (commandId === -1000). Accumulated chunks; once all
    // chunks arrive, decode and merge per-pass timings onto the matching
    // beginRenderPass/beginComputePass command records so they survive
    // saveCaptureData()/importCaptureJson() round-trips.
    this._timestampBytes = null;
    this._timestampChunksRemaining = 0;
  }

  hasCapturedCommands() {
    return this._commands.length > 0 || this._currentSlot !== null;
  }

  // Clear everything: object records, captured frames, validation errors.
  // Used when the user calls `initialize()` after a save to start over.
  reset() {
    this._objects.clear();
    this._validationErrors = [];
    this._commandsById.clear();
    this._commands = [];
    this._currentSlot = null;
    this._firstFrame = null;
    this._pendingBufferData.clear();
  }

  // Clear just the captured commands (and the pending-by-id state that goes
  // with them). Keeps object records so a subsequent capture-then-save still
  // has access to the GPU objects created earlier.
  resetCaptures() {
    this._commandsById.clear();
    this._commands = [];
    this._currentSlot = null;
    this._firstFrame = null;
    this._pendingBufferData.clear();
    this._timestampBytes = null;
    this._timestampChunksRemaining = 0;
  }

  processMessage(message) {
    if (!message?.action) {
      return;
    }
    switch (message.action) {
      case Actions.AddObject:
        this._handleAddObject(message);
        break;
      case Actions.DeleteObject:
        // Keep records around: a captured command may still reference an
        // object the page has since destroyed, and the devtools-side capture
        // also retains these via `capturedObjects`.
        break;
      case Actions.DeleteObjects:
        break;
      case Actions.ObjectSetLabel: {
        const o = this._objects.get(message.id);
        if (o) {
          o.label = message.label || "";
        }
        break;
      }
      case Actions.ResolveAsyncObject: {
        const o = this._objects.get(message.id);
        if (o) {
          o.pending = false;
        }
        break;
      }
      case Actions.ValidationError:
        this._validationErrors.push({
          id: this._validationErrors.length + 1,
          objectId: message.id ?? 0,
          message: message.message,
          stacktrace: message.stacktrace || ""
        });
        break;
      case Actions.CaptureFrameResults:
        this._handleCaptureFrameResults(message);
        break;
      case Actions.CaptureFrameCommands:
        this._handleCaptureFrameCommands(message);
        break;
      case Actions.CaptureBufferData:
        this._handleCaptureBufferData(message);
        break;
      case Actions.CaptureTextureData:
        this._handleCaptureTextureData(message);
        break;
      default:
        // Ignore frame timing, recording, handshake, and progress messages.
        break;
    }
  }

  _handleAddObject(message) {
    let descriptor = null;
    if (message.descriptor) {
      try {
        descriptor = JSON.parse(message.descriptor);
      } catch (e) {
        descriptor = null;
      }
    }
    const id = message.id;
    const existing = this._objects.get(id);
    if (existing) {
      // Re-add of an existing id (the wrapper does this for some types).
      existing.descriptor = descriptor;
      existing.stacktrace = message.stacktrace || "";
      existing.pending = !!message.pending;
      existing.parent = message.parent;
      if (descriptor?.label) {
        existing.label = descriptor.label;
      }
      return;
    }
    this._objects.set(id, {
      id,
      type: message.type,
      label: descriptor?.label ?? "",
      descriptor,
      stacktrace: message.stacktrace || "",
      parent: message.parent,
      pending: !!message.pending,
      imageData: [],
      isImageDataLoaded: [],
      _loadedImageChunks: []
    });
  }

  _handleCaptureFrameResults(message) {
    const count = message.count | 0;
    const start = this._commands.length;
    // Reserve slots; CaptureFrameCommands batches will fill them.
    this._commands.length = start + count;
    this._currentSlot = {
      frame: message.frame,
      start,
      count,
      batchesRemaining: message.batches | 0
    };
    if (this._firstFrame === null) {
      this._firstFrame = message.frame;
    }
  }

  _handleCaptureFrameCommands(message) {
    const slot = this._currentSlot;
    if (!slot) {
      return;
    }
    const base = slot.start + (message.index | 0);
    const commands = message.commands || [];
    for (let i = 0; i < message.count; ++i) {
      const cmd = commands[i];
      this._commands[base + i] = cmd;
      if (cmd && cmd.commandId !== undefined) {
        this._commandsById.set(cmd.commandId, cmd);
        // Drain any CaptureBufferData chunks that arrived before this
        // command's batch.
        const pending = this._pendingBufferData.get(cmd.commandId);
        if (pending) {
          for (const pendingMessage of pending) {
            this._applyBufferDataChunk(cmd, pendingMessage);
          }
          this._pendingBufferData.delete(cmd.commandId);
        }
      }
    }
    slot.batchesRemaining--;
    if (slot.batchesRemaining <= 0) {
      this._currentSlot = null;
    }
  }

  _handleCaptureBufferData(message) {
    if (message.commandId === -1000) {
      this._handleTimestampChunk(message);
      return;
    }
    const cmd = this._commandsById.get(message.commandId);
    if (!cmd) {
      // The command batch hasn't been flushed to us yet. Park the chunk and
      // apply it once the command record arrives.
      let bucket = this._pendingBufferData.get(message.commandId);
      if (!bucket) {
        bucket = [];
        this._pendingBufferData.set(message.commandId, bucket);
      }
      bucket.push(message);
      return;
    }
    this._applyBufferDataChunk(cmd, message);
  }

  _applyBufferDataChunk(cmd, message) {
    const entryIndex = message.entryIndex | 0;
    if (!cmd.bufferData) {
      cmd.bufferData = [];
    }
    if (!cmd._loadedChunks) {
      cmd._loadedChunks = [];
    }
    if (!cmd.isBufferDataLoaded) {
      cmd.isBufferDataLoaded = [];
    }
    // > 0 only when the capture cap truncated this buffer; remember the true
    // length so the serialized command can mark the payload truncated.
    if (message.originalSize > 0) {
      if (!cmd.bufferOriginalSize) {
        cmd.bufferOriginalSize = [];
      }
      cmd.bufferOriginalSize[entryIndex] = message.originalSize;
    }
    if (!cmd.bufferData[entryIndex] || cmd.bufferData[entryIndex].length !== message.size) {
      cmd.bufferData[entryIndex] = new Uint8Array(message.size);
      cmd._loadedChunks[entryIndex] = new Array(message.count);
    }
    let chunk;
    try {
      chunk = decodeBase64(message.chunk);
    } catch (e) {
      return;
    }
    cmd.bufferData[entryIndex].set(chunk, message.offset);
    cmd._loadedChunks[entryIndex][message.index] = true;
    let loaded = true;
    for (let i = 0; i < message.count; ++i) {
      if (!cmd._loadedChunks[entryIndex][i]) {
        loaded = false;
        break;
      }
    }
    cmd.isBufferDataLoaded[entryIndex] = loaded;
  }

  // Accumulates the raw u64 timestamp buffer streamed in CaptureBufferData
  // messages with commandId === -1000. When the last chunk arrives, decodes the
  // BigInt64Array and writes startTime/endTime/duration onto each
  // beginRenderPass/beginComputePass command in capture order. Mirrors the
  // decode in src/devtools/capture_data.js so the merged fields are picked up
  // unchanged by _serializeCommand → saveCaptureData → importCaptureJson.
  _handleTimestampChunk(message) {
    if (this._timestampBytes === null) {
      this._timestampBytes = new Uint8Array(message.size);
      this._timestampChunksRemaining = message.count;
    }
    let chunk;
    try {
      chunk = decodeBase64(message.chunk);
    } catch (e) {
      return;
    }
    this._timestampBytes.set(chunk, message.offset);
    this._timestampChunksRemaining--;
    if (this._timestampChunksRemaining > 0) {
      return;
    }

    const timestampData = new BigInt64Array(this._timestampBytes.buffer);
    this._timestampBytes = null;

    let i = 2;
    for (let k = 0; k < this._commands.length && i < timestampData.length; k++) {
      const command = this._commands[k];
      if (!command || (command.method !== "beginRenderPass" && command.method !== "beginComputePass")) {
        continue;
      }
      const start = timestampData[i];
      const end = timestampData[i + 1];
      command.startTime = Number(start) / 1000000.0;
      command.endTime = Number(end) / 1000000.0;
      command.duration = Number(end - start) / 1000000.0;
      i += 2;
    }
  }

  _handleCaptureTextureData(message) {
    const obj = this._objects.get(message.id);
    if (!obj) {
      return;
    }
    const mipLevel = message.mipLevel ?? 0;
    if (!(obj.imageData[mipLevel] instanceof Uint8Array) ||
        obj.imageData[mipLevel].length !== message.size) {
      obj.imageData[mipLevel] = new Uint8Array(message.size);
      obj._loadedImageChunks[mipLevel] = new Array(message.count);
    }
    let chunk;
    try {
      chunk = decodeBase64(message.chunk);
    } catch (e) {
      return;
    }
    obj.imageData[mipLevel].set(chunk, message.offset);
    obj._loadedImageChunks[mipLevel][message.index] = true;
    let loaded = true;
    for (let i = 0; i < message.count; ++i) {
      if (!obj._loadedImageChunks[mipLevel][i]) {
        loaded = false;
        break;
      }
    }
    obj.isImageDataLoaded[mipLevel] = loaded;
  }

  // --- Serialization (mirrors src/devtools/capture_export.js) ---

  // Build the capture as split metadata + out-of-band payloads. Returns
  // `{ metadata, payloads }`; the caller streams them (NDJSON: metadata first,
  // then one line per payload) so no single huge string is ever allocated.
  buildCaptureStream(toolVersion) {
    const collector = new PayloadCollector();

    const objects = {};
    this._objects.forEach((rec, id) => {
      objects[String(id)] = this._serializeObject(rec, collector);
    });

    const cmdRecords = new Array(this._commands.length);
    for (let i = 0; i < this._commands.length; ++i) {
      const c = this._commands[i];
      cmdRecords[i] = c ? this._serializeCommand(c, i, collector) : null;
    }

    const metadata = {
      schemaVersion: SCHEMA_VERSION,
      tool: "webgpu_inspector",
      toolVersion: toolVersion || "",
      exportedAt: new Date().toISOString(),
      frame: this._firstFrame ?? 0,
      statistics: {},
      validationErrors: this._validationErrors.slice(),
      objects,
      commands: cmdRecords,
      payloadCount: collector.payloads.length
    };

    return { metadata, payloads: collector.payloads };
  }

  _objectRef(id) {
    const ref = { __id: id };
    const o = this._objects.get(id);
    if (o) {
      ref.__class = o.type;
      if (o.label) {
        ref.__label = o.label;
      }
    }
    return ref;
  }

  _cloneValue(value, collector) {
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
        out[i] = this._cloneValue(value[i], collector);
      }
      return out;
    }
    if (t === "object") {
      if (value.__id !== undefined && Object.keys(value).length <= 3) {
        // The page side already tags refs with __id/__class; re-emit them
        // expanded with the current label.
        return this._objectRef(value.__id);
      }
      const out = {};
      for (const k in value) {
        if (!_hasOwn.call(value, k)) {
          continue;
        }
        out[k] = this._cloneValue(value[k], collector);
      }
      return out;
    }
    return null;
  }

  _serializeObject(rec, collector) {
    const out = {
      id: rec.id,
      type: rec.type,
      label: rec.label || undefined,
      descriptor: rec.descriptor ? this._cloneValue(rec.descriptor, collector) : null
    };
    if (rec.stacktrace) {
      out.stacktrace = rec.stacktrace;
    }
    if (rec.type === "Buffer") {
      const size = rec.descriptor?.size;
      if (size != null) {
        out.size = size;
      }
    }
    if (rec.type === "Texture") {
      const dims = _textureDims(rec.descriptor);
      out.width = dims.width;
      out.height = dims.height;
      out.depthOrArrayLayers = dims.depthOrArrayLayers;
      out.mipLevelCount = rec.descriptor?.mipLevelCount ?? 1;
      out.format = rec.descriptor?.format ?? "<unknown format>";
      out.dimension = rec.descriptor?.dimension ?? "2d";
      const gpuSize = _textureGpuSize(rec.descriptor);
      if (gpuSize >= 0) {
        out.gpuSize = gpuSize;
      }
      const mipData = [];
      for (let level = 0; level < rec.imageData.length; ++level) {
        const bytes = rec.imageData[level];
        if (!(bytes instanceof Uint8Array)) {
          continue;
        }
        if (rec.isImageDataLoaded[level] === false) {
          continue;
        }
        mipData.push({
          mipLevel: level,
          byteLength: bytes.length,
          ...collector.add("Uint8Array", bytes.length, bytes)
        });
      }
      if (mipData.length) {
        out.mipData = mipData;
      }
    }
    if (rec.type === "TextureView" && rec.parent != null) {
      out.texture = this._objectRef(rec.parent);
    }
    if (rec.type === "ShaderModule") {
      const code = rec.descriptor?.code;
      out.hasVertexEntries = code ? code.indexOf("@vertex") !== -1 : false;
      out.hasFragmentEntries = code ? code.indexOf("@fragment") !== -1 : false;
      out.hasComputeEntries = code ? code.indexOf("@compute") !== -1 : false;
    }
    return out;
  }

  _serializeCommand(command, index, collector) {
    const record = {
      index,
      method: command.method
    };
    if (command.object !== undefined) {
      record.object = this._cloneValue(command.object, collector);
    }
    if (command.args !== undefined) {
      record.args = this._cloneValue(command.args, collector);
    }
    if (command.result !== undefined) {
      record.result = this._cloneValue(command.result, collector);
    }
    if (command.stacktrace) {
      record.stacktrace = command.stacktrace;
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
        const originalSize = command.bufferOriginalSize ? command.bufferOriginalSize[i] : 0;
        entries.push({
          entryIndex: i,
          byteLength: originalSize || bytes.length,
          ...collector.add("Uint8Array", bytes.length, bytes, originalSize)
        });
      }
      if (entries.length) {
        record.bufferData = entries;
      }
    }
    for (const k in command) {
      if (!_hasOwn.call(command, k)) {
        continue;
      }
      if (k in record) {
        continue;
      }
      if (k === "method" || k === "object" || k === "args" || k === "result" ||
          k === "stacktrace" || k === "duration" || k === "startTime" ||
          k === "endTime" || k === "bufferData" || k === "isBufferDataLoaded" ||
          k === "bufferOriginalSize") {
        continue;
      }
      if (k.startsWith("_")) {
        continue;
      }
      record[k] = this._cloneValue(command[k], collector);
    }
    return record;
  }
}

// Lazily yield a capture stream (`{ metadata, payloads }` from buildCaptureStream)
// as NDJSON lines, each terminated by "\n": the metadata object first, then one
// payload object per line (`{ __payloadId, __typedArray, base64 }`). Yielding one
// line at a time matters for large captures: each (potentially multi-MB) base64
// string can be released before the next is built, instead of holding them all.
export function* captureStreamLines(stream) {
  yield JSON.stringify(stream.metadata) + "\n";
  for (const p of stream.payloads) {
    yield JSON.stringify({
      __payloadId: p.id,
      __typedArray: p.typedArray,
      base64: encodeBase64(p.bytes)
    }) + "\n";
  }
}

// All NDJSON lines as an array of individually-bounded strings — no single giant
// string (the V8 ~512MB limit is what made large captures fail). Prefer
// captureStreamToBlob for downloads/uploads: holding every base64 line at once,
// as this does, can still exhaust memory on a texture-heavy capture.
export function captureStreamToLines(stream) {
  return [...captureStreamLines(stream)];
}

// Build a Blob of the NDJSON without ever holding more than one payload's base64
// string in the JS heap at a time: each line is wrapped in its own Blob (which
// the browser can back by disk), so the large intermediate strings are freed as
// we go.
//
// `maxPayloadBytes` (optional) caps the total raw payload bytes included. Once
// the budget is exhausted, further payload lines are skipped — the metadata
// still references them, and loaders treat a missing payload as omitted. This is
// the safety valve for memory-constrained contexts (e.g. the DevTools panel
// renderer) where assembling the full base64 of a multi-hundred-MB capture would
// crash. Returns `{ blob, omittedPayloads, includedPayloads }`.
export function captureStreamToBlob(stream, type, maxPayloadBytes) {
  const parts = [JSON.stringify(stream.metadata) + "\n"];
  let used = 0;
  let omitted = 0;
  let included = 0;
  for (const p of stream.payloads) {
    const len = p.bytes ? p.bytes.length : 0;
    if (maxPayloadBytes != null && used + len > maxPayloadBytes) {
      omitted++;
      continue;
    }
    used += len;
    included++;
    const line = JSON.stringify({
      __payloadId: p.id,
      __typedArray: p.typedArray,
      base64: encodeBase64(p.bytes)
    }) + "\n";
    parts.push(new Blob([line]));
  }
  return {
    blob: new Blob(parts, { type: type || "application/json" }),
    omittedPayloads: omitted,
    includedPayloads: included
  };
}

function _textureDims(descriptor) {
  const size = descriptor?.size;
  let width = 0;
  let height = 1;
  let depthOrArrayLayers = 1;
  if (Array.isArray(size)) {
    width = size[0] ?? 0;
    height = size[1] ?? 1;
    depthOrArrayLayers = size[2] ?? 1;
  } else if (size && typeof size === "object") {
    width = size.width ?? 0;
    height = size.height ?? 1;
    depthOrArrayLayers = size.depthOrArrayLayers ?? 1;
  }
  return { width, height, depthOrArrayLayers };
}

function _textureGpuSize(descriptor) {
  const format = descriptor?.format;
  const info = format ? TextureFormatInfo[format] : null;
  if (!info) {
    return -1;
  }
  const { width, height, depthOrArrayLayers } = _textureDims(descriptor);
  if (width <= 0) {
    return -1;
  }
  const dimension = descriptor?.dimension ?? "2d";
  const blockWidth = width / info.blockWidth;
  const blockHeight = dimension === "1d" ? 1 : height / info.blockHeight;
  return blockWidth * blockHeight * info.bytesPerBlock * depthOrArrayLayers;
}
