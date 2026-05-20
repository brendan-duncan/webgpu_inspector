// In-memory index of captures, backed by JSON files on disk.
//
// Captures arrive two ways:
//  - Live: uploaded by an instrumented page through the bridge.
//  - File: a previously saved capture explicitly loaded with load_capture_file.
//
// Live captures are also written to disk so they can be reopened later (here
// or in the DevTools "Load Capture" action).

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, isAbsolute, join } from "node:path";

import { summarize } from "./analysis.js";

export class CaptureStore {
  constructor(options) {
    options = options || {};
    this._dir = options.dir || resolve(process.cwd(), "captures");
    this._captures = new Map(); // id -> { id, label, source, path, receivedAt, json, summary }
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

  // Register a capture JSON object. Returns the stored entry (without the
  // full json payload, which stays in the map for later tool calls).
  async addLive(json, meta) {
    meta = meta || {};
    const id = this._nextId();
    const entry = {
      id,
      label: meta.label || `live capture from ${meta.pageName || "page"}`,
      source: "live",
      pageName: meta.pageName || "",
      receivedAt: new Date().toISOString(),
      path: null,
      json,
      summary: safeSummary(json)
    };

    // Persist so the capture survives and is loadable elsewhere.
    const filePath = join(this._dir, `${id}.json`);
    try {
      await writeFile(filePath, JSON.stringify(json, null, 2), "utf8");
      entry.path = filePath;
    } catch (e) {
      process.stderr.write(`[webgpu-bridge] failed to write ${filePath}: ${e.message}\n`);
    }

    this._captures.set(id, entry);
    return this.describe(entry);
  }

  // Load a capture from a .json file on disk and index it.
  async addFile(filePath) {
    const abs = isAbsolute(filePath) ? filePath : resolve(process.cwd(), filePath);
    const text = await readFile(abs, "utf8");
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`File is not valid JSON: ${e.message}`);
    }
    if (!json || typeof json !== "object" || !Array.isArray(json.commands)) {
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
      json,
      summary: safeSummary(json)
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

  // Metadata view of an entry — never includes the raw json payload.
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
