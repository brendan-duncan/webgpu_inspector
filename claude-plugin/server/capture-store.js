// In-memory index of captures, backed by capture files on disk.
//
// Captures arrive two ways:
//  - Live: uploaded by an instrumented page through the bridge.
//  - File: a previously saved capture explicitly loaded with load_capture_file.
//
// A capture is stored as small metadata (object descriptors, command list,
// validation errors) plus out-of-band payloads (buffer/texture bytes) kept in a
// Map keyed by payload id. Both halves are written to a single WGPUCAP binary
// file (ASCII header + metadata JSON + raw payload bytes; see
// capture-binary.js) so a capture survives and can be reopened here or in the
// DevTools "Load Capture" action. Loading also still accepts the legacy NDJSON
// (schema 1.1) and single-JSON (1.0) formats.

import { createReadStream } from "node:fs";
import { createWriteStream } from "node:fs";
import { open, readFile, mkdir } from "node:fs/promises";
import { createInterface } from "node:readline";
import { resolve, isAbsolute, join } from "node:path";

import { summarize } from "./analysis.js";
import { isCaptureBinary, decodeCaptureBinary, encodeCaptureBinaryParts } from "./capture-binary.js";

export class CaptureStore {
  constructor(options) {
    options = options || {};
    this._dir = options.dir || resolve(process.cwd(), "captures");
    // id -> { id, label, source, path, receivedAt, json, payloads, summary }
    // payloads: Map<payloadId, { typedArray, base64, bytes? }>
    this._captures = new Map();
    this._counter = 0;
  }

  async init() {
    try {
      await mkdir(this._dir, { recursive: true });
    } catch (e) {
      // Non-fatal: live captures just won't be persisted to disk.
      process.stderr.write(`[webgpu-bridge] could not create captures dir: ${e.message}\n`);
    }
  }

  _nextId() {
    this._counter++;
    return `cap-${this._counter}`;
  }

  // Register a capture. `capture` is `{ metadata, payloads }` where payloads is a
  // Map<payloadId, { typedArray, base64 }>. Returns the stored entry metadata.
  async addLive(capture, meta) {
    meta = meta || {};
    const id = this._nextId();
    const json = capture.metadata || capture; // tolerate a bare metadata object
    const payloads = capture.payloads instanceof Map ? capture.payloads : new Map();
    const entry = {
      id,
      label: meta.label || `live capture from ${meta.pageName || "page"}`,
      source: "live",
      pageName: meta.pageName || "",
      receivedAt: new Date().toISOString(),
      path: null,
      json,
      payloads,
      summary: safeSummary(json)
    };

    // Persist so the capture survives and is loadable elsewhere. Written as
    // the WGPUCAP binary container, chunk by chunk with backpressure, so even
    // a multi-GB capture never builds a giant string or double-buffers.
    const filePath = join(this._dir, `${id}.wgpuc`);
    try {
      await writeCaptureBinary(filePath, json, payloads);
      entry.path = filePath;
    } catch (e) {
      process.stderr.write(`[webgpu-bridge] failed to write ${filePath}: ${e.message}\n`);
    }

    this._captures.set(id, entry);
    return this.describe(entry);
  }

  // Load a capture from a file on disk and index it. Accepts all formats:
  //  - WGPUCAP binary: metadata JSON + raw payload bytes (the save format).
  //  - 1.1 NDJSON: metadata line + one base64 payload line each.
  //  - 1.0 legacy: a single JSON object with base64 payloads inlined.
  async addFile(filePath) {
    const abs = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
    const { metadata, payloads } = await readCaptureFile(abs);
    if (!metadata || typeof metadata !== "object" || !Array.isArray(metadata.commands)) {
      throw new Error("File does not look like a WebGPU Inspector capture.");
    }
    const id = this._nextId();
    const entry = {
      id,
      label: `file: ${abs}`,
      source: "file",
      pageName: "",
      receivedAt: new Date().toISOString(),
      path: abs,
      json: metadata,
      payloads,
      summary: safeSummary(metadata)
    };
    this._captures.set(id, entry);
    return this.describe(entry);
  }

  get(id) {
    return this._captures.get(id) || null;
  }

  getJson(id) {
    const entry = this._captures.get(id);
    return entry ? entry.json : null;
  }

  // Return the decoded bytes (a Buffer) for an out-of-band payload, or null if
  // the capture or payload id is unknown. Decoded bytes are cached on the entry.
  getPayload(id, payloadId) {
    const entry = this._captures.get(id);
    if (!entry || !entry.payloads) {
      return null;
    }
    const p = entry.payloads.get(payloadId);
    if (!p) {
      return null;
    }
    if (!p.bytes) {
      p.bytes = Buffer.from(p.base64 || "", "base64");
    }
    return p.bytes;
  }

  list() {
    return [...this._captures.values()].map((e) => this.describe(e));
  }

  // The most recently added capture, if any.
  latest() {
    let latest = null;
    for (const entry of this._captures.values()) {
      latest = entry;
    }
    return latest ? this.describe(latest) : null;
  }

  // Metadata view of an entry — never includes the raw json/payloads.
  describe(entry) {
    return {
      id: entry.id,
      label: entry.label,
      source: entry.source,
      pageName: entry.pageName,
      receivedAt: entry.receivedAt,
      path: entry.path,
      frame: entry.summary ? entry.summary.frame : 0,
      totalCommands: entry.summary ? entry.summary.totalCommands : 0,
      totalObjects: entry.summary ? entry.summary.totalObjects : 0,
      validationErrorCount: entry.summary ? entry.summary.validationErrorCount : 0
    };
  }
}

function safeSummary(json) {
  try {
    return summarize(json);
  } catch (e) {
    return null;
  }
}

// Stream a capture to disk as a WGPUCAP binary file. Payload entries may hold
// raw `bytes` (binary uploads) or `base64` (legacy NDJSON uploads); base64 is
// decoded once here and the bytes cached back on the entry for getPayload.
async function writeCaptureBinary(filePath, metadata, payloads) {
  const list = [];
  for (const [payloadId, p] of payloads) {
    if (!p.bytes && typeof p.base64 === "string") {
      p.bytes = Buffer.from(p.base64, "base64");
    }
    list.push({ id: payloadId, bytes: p.bytes || Buffer.alloc(0) });
  }
  const { parts } = encodeCaptureBinaryParts({ metadata, payloads: list });
  const out = createWriteStream(filePath);
  const finished = new Promise((resolveP, reject) => {
    out.on("error", reject);
    out.on("finish", resolveP);
  });
  for (const part of parts) {
    if (!out.write(part)) {
      await new Promise((resolveP) => out.once("drain", resolveP));
    }
  }
  out.end();
  await finished;
}

// Read a capture file, sniffing the format from its first bytes: WGPUCAP
// binary files are read whole and decoded with zero-copy payload views; text
// files fall back to the legacy NDJSON / single-JSON parsing below.
async function readCaptureFile(abs) {
  const fh = await open(abs, "r");
  let head;
  try {
    head = Buffer.alloc(8);
    const { bytesRead } = await fh.read(head, 0, 8, 0);
    head = head.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }
  if (isCaptureBinary(head)) {
    const { metadata, payloads: raw } = decodeCaptureBinary(await readFile(abs));
    const payloads = new Map();
    for (const [id, bytes] of raw) {
      payloads.set(id, { bytes });
    }
    return { metadata, payloads };
  }
  return readCaptureText(abs);
}

// Read a legacy text capture file line by line. The first non-empty line is
// the metadata; each remaining line is a payload. If the file is a single
// legacy 1.0 JSON object, the whole thing parses as the metadata and payloads
// stays empty (its base64 blobs are resolved inline by the accessors).
async function readCaptureText(abs) {
  // Fast path for small files / legacy single-object captures: a quick whole-
  // file parse. If it succeeds and yields a capture object, it's legacy 1.0.
  // (A 1.1 NDJSON file has multiple JSON objects and fails to whole-parse.)
  try {
    const text = await readFile(abs, "utf8");
    const trimmed = text.trimStart();
    // Only attempt a whole-parse when it plausibly is a single JSON object;
    // for very large files this still works, and NDJSON will throw and fall
    // through to the streaming line reader below.
    const json = JSON.parse(text);
    if (json && typeof json === "object" && Array.isArray(json.commands)) {
      return { metadata: json, payloads: new Map() };
    }
    // Parsed but not a capture: fall through to streaming (unlikely).
    void trimmed;
  } catch (e) {
    // Not a single JSON object (NDJSON) or too large to parse whole — stream it.
  }

  let metadata = null;
  const payloads = new Map();
  const rl = createInterface({ input: createReadStream(abs, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) {
      continue;
    }
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue;
    }
    if (metadata === null) {
      metadata = obj;
    } else if (obj && typeof obj.__payloadId === "number") {
      payloads.set(obj.__payloadId, { typedArray: obj.__typedArray, base64: obj.base64 });
    }
  }
  return { metadata, payloads };
}
