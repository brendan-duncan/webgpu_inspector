// Serialize a recording held by RecorderData back out to disk, in the same formats webgpu_recorder
// produces during a live capture:
//   - Binary (.wgpu): the compact "WGPR" container (see RecorderData.loadBinary for the layout).
//   - HTML (.html): a self-contained playback page that embeds the binary bytes (base64) plus the
//     generic WebGPUPlayer interpreter, so it replays without any external files.
//
// This is the inverse of RecorderData.loadBinary / the live-record message path: those parse a
// recording into the in-memory command/data model; these turn that model back into a file.

import { encodeBase64 } from "../utils/base64.js";
import { Dialog } from "./widget/dialog.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Input } from "./widget/input.js";
import { Button } from "./widget/button.js";
// The generic binary-recording interpreter, inlined as source text by the rollup "stringer" plugin
// (see rollup.config.js). Embedded verbatim into the generated HTML page.
import playerSource from "webgpu_player_source";

// A command is kept in the saved recording unless it's disabled — explicitly by the user or
// implicitly by a dependency (see RecorderData's implicit-disabling rules).
function _isKept(command) {
  return !!command && !command.disabled && !command._implicit;
}

// Collect the data-blob indices a command references (so unused blobs can be dropped on save).
// Most commands reference data via {__data: index} markers in their args; __writeData uses a raw
// index as its first argument.
function _collectDataIndices(command, into) {
  if (command.method === "__writeData") {
    const idx = Array.isArray(command.args) ? command.args[0] : undefined;
    if (typeof idx === "number") {
      into.add(idx);
    }
    return;
  }
  const walk = (v) => {
    if (!v || typeof v !== "object") {
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) {
        walk(x);
      }
      return;
    }
    if (typeof v.__data === "number") {
      into.add(v.__data);
      return;
    }
    for (const k in v) {
      walk(v[k]);
    }
  };
  walk(command.args);
}

// Clone args, rewriting data-blob indices through `remap` (old index -> new compacted index), so a
// command still points at its data after unused blobs are removed.
function _remapData(args, method, remap) {
  const clone = (v) => {
    if (Array.isArray(v)) {
      return v.map(clone);
    }
    if (v && typeof v === "object") {
      if (typeof v.__data === "number") {
        const n = remap.get(v.__data);
        return { ...v, __data: n === undefined ? v.__data : n };
      }
      const o = {};
      for (const k in v) {
        o[k] = clone(v[k]);
      }
      return o;
    }
    return v;
  };
  let out = clone(args ?? []);
  if (method === "__writeData" && Array.isArray(out) && typeof out[0] === "number") {
    const n = remap.get(out[0]);
    if (n !== undefined) {
      out = [n, ...out.slice(1)];
    }
  }
  return out;
}

// Strip the in-memory-only fields (UI widgets, loader bookkeeping) and re-stringify the parsed args
// (with data indices remapped) back to the JSON-string form the binary container / player expect.
function _serializeCommand(command, remap) {
  const record = {
    object: command.object,
    method: command.method,
    args: JSON.stringify(_remapData(command.args, command.method, remap)),
    async: command.async ? true : ""
  };
  if (command.result !== undefined && command.result !== null) {
    record.result = command.result;
  }
  return record;
}

/**
 * Serialize the recording into the binary "WGPR" container. Disabled commands and any data blobs
 * no longer referenced by a kept command are dropped, and the remaining data is renumbered.
 * @param {RecorderData} recorderData
 * @returns {ArrayBuffer}
 */
export function buildBinaryRecording(recorderData) {
  const initCommands = (recorderData.initializeCommands || []).filter(_isKept);
  const frameCommands = recorderData.frames.map((f) => (f || []).filter(_isKept));

  // Which data blobs are still referenced by a kept command — the rest are removed on save.
  const usedData = new Set();
  for (const command of initCommands) {
    _collectDataIndices(command, usedData);
  }
  for (const frame of frameCommands) {
    for (const command of frame) {
      _collectDataIndices(command, usedData);
    }
  }

  // Compact the data table to just the used blobs, building an old-index -> new-index remap.
  const usedSorted = [...usedData]
    .filter((i) => i >= 0 && i < recorderData.data.length)
    .sort((a, b) => a - b);
  const remap = new Map();
  const dataTable = [];
  const blobs = [];
  let offset = 0;
  for (const oldIndex of usedSorted) {
    remap.set(oldIndex, dataTable.length);
    const arr = recorderData.data[oldIndex];
    if (!arr || arr.byteLength === 0) {
      dataTable.push({ type: "", length: 0, offset: 0 });
      continue;
    }
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const type = recorderData.dataTypes[oldIndex] || (arr instanceof Uint32Array ? "Uint32Array" : "Uint8Array");
    dataTable.push({ type, length: bytes.byteLength, offset });
    blobs.push(bytes);
    offset += bytes.byteLength;
  }
  const dataTotal = offset;

  const init = initCommands.map((c) => _serializeCommand(c, remap));
  const frames = frameCommands.map((f) => f.map((c) => _serializeCommand(c, remap)));

  const { width, height } = recorderData.getCanvasSize();
  const header = {
    version: 1,
    canvasWidth: width,
    canvasHeight: height,
    gpuVar: recorderData.gpuVar || "x1",
    contextVar: recorderData.contextVar || "context",
    init,
    frames,
    data: dataTable
  };
  const headerBytes = new TextEncoder().encode(JSON.stringify(header));

  const buffer = new ArrayBuffer(12 + headerBytes.byteLength + dataTotal);
  const view = new DataView(buffer);
  const u8 = new Uint8Array(buffer);
  u8[0] = 0x57; u8[1] = 0x47; u8[2] = 0x50; u8[3] = 0x52; // "WGPR"
  view.setUint32(4, 1, true);                            // version
  view.setUint32(8, headerBytes.byteLength, true);       // header byte length
  u8.set(headerBytes, 12);
  let p = 12 + headerBytes.byteLength;
  for (const b of blobs) {
    u8.set(b, p);
    p += b.byteLength;
  }
  return buffer;
}

// The page-side bootstrap: decode the embedded recording, hand it to WebGPUPlayer, and drive a
// frame-by-frame playback loop (looping back to the start when it reaches the end). Mirrors the
// requestAnimationFrame structure of webgpu_recorder's generated HTML.
const _htmlBootstrap = `
async function b64ToArrayBuffer(s) {
  if (Uint8Array.fromBase64) {
    return Uint8Array.fromBase64(s).buffer;
  }
  const bin = atob(s);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; ++i) {
    bytes[i] = bin.charCodeAt(i);
  }
  return bytes.buffer;
}

async function main() {
  const canvas = document.getElementById("webgpu");
  const frameLabel = document.createElement("div");
  frameLabel.style = "position: absolute; top: 10px; left: 10px; font-size: 24pt; color: #f00;";
  document.body.append(frameLabel);

  const buffer = await b64ToArrayBuffer(RECORDING_DATA);
  const player = new WebGPUPlayer(buffer);
  await player.load(canvas);

  const frameCount = player.getFrameCount();
  if (frameCount <= 0) {
    await player.executeAll();
    return;
  }

  await player.resetForPlayback();
  let frame = 0;
  let lastFrame = -1;
  let t0 = performance.now();
  async function renderFrame() {
    if (frame >= frameCount) {
      frame = 0;
      lastFrame = -1;
      await player.resetForPlayback();
    }
    requestAnimationFrame(renderFrame);
    if (frame === lastFrame) {
      return;
    }
    lastFrame = frame;
    const t1 = performance.now();
    frameLabel.innerText = "F: " + (frame + 1) + "  T:" + (t1 - t0).toFixed(2);
    t0 = t1;
    try {
      await player.renderFrame(frame);
    } catch (err) {
      console.error("Error Frame:", frame, err.message);
    }
    frame++;
  }
  requestAnimationFrame(renderFrame);
}
main();
`;

/**
 * Build a self-contained HTML playback page for the recording.
 * @param {RecorderData} recorderData
 * @returns {string}
 */
export function buildHtmlRecording(recorderData) {
  const buffer = buildBinaryRecording(recorderData);
  const b64 = encodeBase64(new Uint8Array(buffer));
  const { width, height } = recorderData.getCanvasSize();

  return [
    "<!DOCTYPE html>",
    "<html>",
    "  <body style=\"text-align: center; margin: 0; padding: 0;\">",
    `    <canvas id="webgpu" width=${width} height=${height}></canvas>`,
    "    <script>",
    playerSource,
    "const RECORDING_DATA = " + JSON.stringify(b64) + ";",
    _htmlBootstrap,
    "    </script>",
    "  </body>",
    "</html>",
    ""
  ].join("\n");
}

// Trigger a browser download of `data` (an ArrayBuffer or string) as `filename`. This drops the
// file straight into the browser's Downloads folder with no prompt. Used as the fallback when the
// File System Access API isn't available (e.g. Firefox).
function _download(data, filename, mimeType) {
  const blob = new Blob([data], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

// Fallback "Save As" for browsers without the File System Access API (e.g. Firefox): a small modal
// asking for the filename, pre-filled with `suggestedName`, with Save and Cancel buttons. Resolves
// to the chosen name, or null if the user cancels. The plain download that follows still lands in
// the browser's Downloads folder, but at least the name can be changed here first.
function _promptForFilename(suggestedName) {
  return new Promise((resolve) => {
    // No close (x) button: the only ways out are Save/Cancel, so the promise always settles.
    const dialog = new Dialog({ title: "Save As", width: 320, draggable: true, noCloseButton: true });

    let settled = false;
    const finish = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      dialog.close();
      resolve(value);
    };

    const row = new Div(dialog.body, { style: "padding: 10px;" });
    new Span(row, { text: "Filename:" });
    const nameInput = new Input(row, { type: "text", value: suggestedName, style: "width: 100%; margin-top: 4px;" });

    const buttonRow = new Div(dialog.body, { style: "padding: 0 10px 10px; margin-top: 10px;" });
    new Button(buttonRow, { label: "Save", callback: () => finish(nameInput.value || suggestedName) });
    new Button(buttonRow, { label: "Cancel", style: "margin-left: 15px;", callback: () => finish(null) });

    // Enter saves, Escape cancels.
    nameInput.element.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finish(nameInput.value || suggestedName);
      } else if (e.key === "Escape") {
        e.preventDefault();
        finish(null);
      }
    });

    nameInput.focus();
    nameInput.select();
  });
}

// Save `data` (an ArrayBuffer or string) as `filename` via a native "Save As" dialog using the
// File System Access API, letting the user choose the folder and name. When the API is unavailable
// (Firefox) or unusable in this context, fall back to prompting for a name with a modal and then a
// plain download. `accept` describes the file type for the picker, e.g.
// { "application/octet-stream": [".wgpu"] }.
async function _save(data, filename, mimeType, accept) {
  if (typeof globalThis.showSaveFilePicker === "function") {
    try {
      const handle = await globalThis.showSaveFilePicker({
        suggestedName: filename,
        types: [{ description: filename, accept }]
      });
      const writable = await handle.createWritable();
      await writable.write(new Blob([data], { type: mimeType }));
      await writable.close();
      return;
    } catch (e) {
      // The user cancelling the dialog is not an error; just stop. Anything else (e.g. the API
      // being blocked in this context) falls through to the name-prompt fallback below.
      if (e && e.name === "AbortError") {
        return;
      }
    }
  }
  const chosen = await _promptForFilename(filename);
  if (chosen === null) {
    return;
  }
  _download(data, chosen, mimeType);
}

/** Build the recording and save it as a binary .wgpu file via a "Save As" dialog. */
export function downloadBinaryRecording(recorderData, name) {
  return _save(buildBinaryRecording(recorderData), `${name || "webgpu_record"}.wgpu`,
    "application/octet-stream", { "application/octet-stream": [".wgpu"] });
}

/** Build the recording and save it as a self-contained .html playback page via a "Save As" dialog. */
export function downloadHtmlRecording(recorderData, name) {
  return _save(buildHtmlRecording(recorderData), `${name || "webgpu_record"}.html`,
    "text/html", { "text/html": [".html"] });
}
