// Serialize a recording held by RecorderData back out to disk, in the same formats webgpu_recorder
// produces during a live capture:
//   - Binary (.wgpu): the compact "WGPR" container (see RecorderData.loadBinary for the layout).
//   - HTML (.html): a self-contained playback page that emits every recorded command as plain
//     JavaScript (matching webgpu_recorder's generated HTML), with only the raw buffer/texture
//     bytes carried as base64 data blobs. No interpreter is embedded — the page is the recording.
//
// This is the inverse of RecorderData.loadBinary / the live-record message path: those parse a
// recording into the in-memory command/data model; these turn that model back into a file.

import { encodeBase64 } from "../utils/base64.js";
import { Dialog } from "./widget/dialog.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Input } from "./widget/input.js";
import { Button } from "./widget/button.js";

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

// The variable name used in the generated JS for data blob `index` (the raw buffer/texture bytes
// carried as base64 and decoded into a TypedArray at load).
function _dataVariable(index) {
  return `D${index}`;
}

// Serialize one parsed argument value to JavaScript source text. Mirrors webgpu_recorder's
// _stringifyArgs/_stringifyObject: {__id} markers become the referenced object's variable, {__data}
// markers become the data-blob variable, and shader code is emitted as a template literal so it
// stays readable. `method` is threaded through so createShaderModule strings use backticks.
function _valueToJs(value, method) {
  if (value === null) {
    return "null";
  }
  if (value === undefined) {
    return "undefined";
  }
  if (Array.isArray(value)) {
    return "[" + value.map((v) => _valueToJs(v, method)).join(", ") + "]";
  }
  if (typeof value === "object") {
    if (typeof value.__id === "string") {
      return value.__id;
    }
    if (typeof value.__data === "number") {
      return _dataVariable(value.__data);
    }
    const parts = [];
    for (const k in value) {
      // The recorder strips internal (underscore-prefixed) and undefined fields from the output.
      if (k.startsWith("_")) {
        continue;
      }
      const v = value[k];
      if (v === undefined) {
        continue;
      }
      parts.push(JSON.stringify(k) + ": " + _valueToJs(v, method));
    }
    return "{ " + parts.join(", ") + " }";
  }
  if (typeof value === "string") {
    if (method === "createShaderModule") {
      // Template literal: escape backslashes, backticks, and ${ so WGSL source survives verbatim.
      const escaped = value.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${");
      return "`" + escaped + "`";
    }
    return JSON.stringify(value);
  }
  return String(value);
}

// Serialize a command's parsed argument list to the inside of a call's parentheses.
function _argsToJs(args, method) {
  if (!Array.isArray(args)) {
    return "";
  }
  return args.map((a) => _valueToJs(a, method)).join(", ");
}

// Convert one recorded command into a JavaScript statement (or several, for requestAdapter). The
// pseudo-methods the recorder/player use internally are expanded into their real-call equivalents,
// matching the JS that webgpu_recorder emits directly during a live HTML capture. `ctx.adapterDone`
// guards the one-time requiredFeatures/requiredLimits boilerplate that requestDevice consumes.
function _commandToJs(command, ctx) {
  const method = command.method;
  const objVar = command.object;
  const resultVar = command.result;

  switch (method) {
    case "__setCanvasSize": {
      const a = command.args || [];
      return `setCanvasSize(${objVar}.canvas, ${a[0] | 0}, ${a[1] | 0});`;
    }
    case "__writeData": {
      // Restore a mapped buffer range's contents before unmap (object is the mapped ArrayBuffer).
      const a = command.args || [];
      return `new Uint8Array(${objVar}).set(${_dataVariable(a[0])});`;
    }
    case "__writeTexture":
      return `${objVar}.writeTexture(${_argsToJs(command.args, "writeTexture")});`;
    case "__getQueue":
      return `${resultVar} = ${objVar}.queue;`;
    case "requestAdapter": {
      // The recorded args are dropped on load; request a bare adapter, then build the
      // requiredFeatures/requiredLimits the recorded requestDevice expects from this adapter.
      const lines = [`${resultVar} = await ${objVar}.requestAdapter();`];
      if (!ctx.adapterDone) {
        ctx.adapterDone = true;
        lines.push(
          `const requiredFeatures = [];`,
          `for (const _f of ${resultVar}.features) { requiredFeatures.push(_f); }`,
          `const requiredLimits = {};`,
          `const _excludedLimits = new Set(["minSubgroupSize", "maxSubgroupSize"]);`,
          `for (const _l in ${resultVar}.limits) { if (!_excludedLimits.has(_l)) { requiredLimits[_l] = ${resultVar}.limits[_l]; } }`
        );
      }
      return lines.join("\n      ");
    }
    case "requestDevice":
      return `${resultVar} = await ${objVar}.requestDevice({ requiredFeatures, requiredLimits });`;
    default: {
      const awaitStr = command.async ? "await " : "";
      const argStr = _argsToJs(command.args, method);
      if (resultVar) {
        return `${resultVar} = ${awaitStr}${objVar}.${method}(${argStr});`;
      }
      return `${awaitStr}${objVar}.${method}(${argStr});`;
    }
  }
}

// Page helpers shared by every generated HTML recording: resize the canvas on demand and decode a
// base64 data URL back into the TypedArray a data blob was captured as.
const _htmlHelpers = `
    function setCanvasSize(canvas, width, height) {
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
    }

    async function B64ToA(type, length, s) {
      if (Uint8Array.fromBase64) {
        const b = Uint8Array.fromBase64(s.substr(s.indexOf(",") + 1));
        return type === "Uint32Array" ? new Uint32Array(b.buffer) : b;
      }
      const res = await fetch(s);
      const x = new Uint8Array(await res.arrayBuffer());
      return type === "Uint32Array" ? new Uint32Array(x.buffer, 0, x.length / 4) : x;
    }`;

/**
 * Build a self-contained HTML playback page for the recording. Every kept command is emitted as
 * JavaScript; only the raw buffer/texture bytes are carried as base64 data blobs (decoded by
 * loadData() at startup). Disabled commands and any data no longer referenced are dropped.
 * @param {RecorderData} recorderData
 * @returns {string}
 */
export function buildHtmlRecording(recorderData) {
  const initCommands = (recorderData.initializeCommands || []).filter(_isKept);
  const frameCommands = recorderData.frames.map((f) => (f || []).filter(_isKept));

  // Which data blobs are still referenced by a kept command — the rest are dropped on save.
  const usedData = new Set();
  for (const command of initCommands) {
    _collectDataIndices(command, usedData);
  }
  for (const frame of frameCommands) {
    for (const command of frame) {
      _collectDataIndices(command, usedData);
    }
  }
  const usedSorted = [...usedData]
    .filter((i) => i >= 0 && i < recorderData.data.length)
    .sort((a, b) => a - b);

  const gpuVar = recorderData.gpuVar || "x1";
  const contextVar = recorderData.contextVar || "context";

  // Declare every created object once at function scope so all frame functions can share them
  // (the gpu root and the canvas context are declared/assigned explicitly, so exclude them here).
  const objectVars = new Set();
  const collectResult = (command) => {
    if (command.result && command.result !== gpuVar && command.result !== contextVar) {
      objectVars.add(command.result);
    }
  };
  for (const command of initCommands) {
    collectResult(command);
  }
  for (const frame of frameCommands) {
    for (const command of frame) {
      collectResult(command);
    }
  }

  const ctx = { adapterDone: false };
  const initLines = [`${gpuVar} = navigator.gpu;`];
  for (const command of initCommands) {
    initLines.push(_commandToJs(command, ctx));
  }

  const frameFns = frameCommands.map((frame, fi) => {
    const lines = frame.map((command) => _commandToJs(command, ctx));
    return `    async function f${fi}() {\n      ${lines.join("\n      ")}\n    }`;
  });

  // loadData(): decode each used data blob's base64 back into its captured TypedArray.
  const dataDecls = usedSorted.map((i) => _dataVariable(i)).join(", ");
  const dataLines = usedSorted.map((i) => {
    const arr = recorderData.data[i];
    const bytes = arr && arr.byteLength
      ? new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)
      : new Uint8Array(0);
    const type = recorderData.dataTypes[i] || (arr instanceof Uint32Array ? "Uint32Array" : "Uint8Array");
    const url = "data:application/octet-stream;base64," + encodeBase64(bytes);
    return `      ${_dataVariable(i)} = await B64ToA(${JSON.stringify(type)}, ${bytes.byteLength}, ${JSON.stringify(url)});`;
  });

  const { width, height } = recorderData.getCanvasSize();
  const objectDecls = objectVars.size ? `let ${[...objectVars].join(", ")};` : "";

  return `<!DOCTYPE html>
<html>
  <body style="text-align: center; margin: 0; padding: 0;">
    <canvas id="webgpu" width=${width} height=${height}></canvas>
    <script>
    ${dataDecls ? `let ${dataDecls};` : ""}
    let ${gpuVar};

    async function main() {
      const canvas = document.getElementById("webgpu");
      const ${contextVar} = canvas.getContext("webgpu");
      const frameLabel = document.createElement("div");
      frameLabel.style = "position: absolute; top: 10px; left: 10px; font-size: 24pt; color: #f00;";
      document.body.append(frameLabel);

      await loadData();

      ${objectDecls}
      ${initLines.join("\n      ")}

${frameFns.join("\n")}
      const frames = [${frameCommands.map((_, fi) => `f${fi}`).join(", ")}];
      if (frames.length === 0) {
        return;
      }

      let frame = 0;
      let lastFrame = -1;
      let t0 = performance.now();
      async function renderFrame() {
        if (frame >= frames.length) {
          frame = 0;
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
          await frames[frame]();
        } catch (err) {
          console.error("Error Frame:", frame, err.message);
        }
        frame++;
      }
      requestAnimationFrame(renderFrame);
    }
${_htmlHelpers}

    async function loadData() {
${dataLines.join("\n")}
    }

    main();
    </script>
  </body>
</html>
`;
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
