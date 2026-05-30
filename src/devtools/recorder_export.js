// Serialize a recording held by RecorderData back out to disk, in the same formats webgpu_recorder
// produces during a live capture:
//   - Binary (.wgpu): the compact "WGPR" container (see RecorderData.loadBinary for the layout).
//   - HTML (.html): a self-contained playback page that embeds the binary bytes (base64) plus the
//     generic WebGPUPlayer interpreter, so it replays without any external files.
//
// This is the inverse of RecorderData.loadBinary / the live-record message path: those parse a
// recording into the in-memory command/data model; these turn that model back into a file.

import { encodeBase64 } from "../utils/base64.js";
// The generic binary-recording interpreter, inlined as source text by the rollup "stringer" plugin
// (see rollup.config.js). Embedded verbatim into the generated HTML page.
import playerSource from "webgpu_player_source";

// Strip the in-memory-only fields (UI widgets, loader bookkeeping) and re-stringify the parsed args
// back to the JSON-string form the binary container / player expect.
function _serializeCommand(command) {
  const record = {
    object: command.object,
    method: command.method,
    args: JSON.stringify(command.args ?? []),
    async: command.async ? true : ""
  };
  if (command.result !== undefined && command.result !== null) {
    record.result = command.result;
  }
  return record;
}

function _serializeCommandList(commands) {
  const out = [];
  for (const command of commands || []) {
    if (command) {
      out.push(_serializeCommand(command));
    }
  }
  return out;
}

/**
 * Serialize the recording into the binary "WGPR" container.
 * @param {RecorderData} recorderData
 * @returns {ArrayBuffer}
 */
export function buildBinaryRecording(recorderData) {
  const init = _serializeCommandList(recorderData.initializeCommands);
  const frames = recorderData.frames.map((f) => _serializeCommandList(f));

  const dataTable = [];
  const blobs = [];
  let offset = 0;
  for (let i = 0; i < recorderData.data.length; ++i) {
    const arr = recorderData.data[i];
    if (!arr || arr.byteLength === 0) {
      dataTable.push({ type: "", length: 0, offset: 0 });
      continue;
    }
    const bytes = new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength);
    const type = recorderData.dataTypes[i] || (arr instanceof Uint32Array ? "Uint32Array" : "Uint8Array");
    dataTable.push({ type, length: bytes.byteLength, offset });
    blobs.push(bytes);
    offset += bytes.byteLength;
  }
  const dataTotal = offset;

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

// Trigger a browser download of `data` (an ArrayBuffer or string) as `filename`.
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

/** Build and download the recording as a binary .wgpu file. */
export function downloadBinaryRecording(recorderData, name) {
  _download(buildBinaryRecording(recorderData), `${name || "webgpu_record"}.wgpu`, "application/octet-stream");
}

/** Build and download the recording as a self-contained .html playback page. */
export function downloadHtmlRecording(recorderData, name) {
  _download(buildHtmlRecording(recorderData), `${name || "webgpu_record"}.html`, "text/html");
}
