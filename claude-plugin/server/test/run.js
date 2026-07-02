// Node test suite for the WebGPU Inspector bridge server's pure logic:
// binary (WGPUCAP) capture round-trips, legacy NDJSON/JSON loads, payload
// truncation markers, vertex decode math, and per-draw state resolution. No
// browser or MCP SDK needed.
//
//   node claude-plugin/server/test/run.js

import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  stripHeavy,
  resolvePayloadBytes,
  getDrawState,
  decodeVertexBufferBytes,
  decodeVertexBuffer,
  diffDraws,
  summarize
} from "../analysis.js";
import { CaptureStore } from "../capture-store.js";
import { Bridge } from "../bridge.js";
import { isCaptureBinary, decodeCaptureBinary } from "../capture-binary.js";
import { captureStreamToLines } from "../../../src/utils/local_capture.js";
// The browser-side twin of capture-binary.js — cross-codec tests below keep
// the two implementations agreeing on the format.
import {
  encodeCaptureBinaryParts as pageEncodeBinaryParts,
  decodeCaptureBinary as pageDecodeBinary
} from "../../../src/utils/capture_binary.js";

function concatParts(parts) {
  return Buffer.concat(parts.map((p) => Buffer.from(p.buffer, p.byteOffset, p.byteLength)));
}

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    process.stdout.write(`  ok  ${name}\n`);
  } catch (e) {
    failures.push({ name, e });
    process.stdout.write(`FAIL  ${name}\n      ${e.message}\n`);
  }
}

// --- Fixtures --------------------------------------------------------------

// Two interleaved vertices: pos float32x3 @0, uv float32x2 @12, arrayStride 20.
function vertexBytes() {
  const f = new Float32Array([1, 2, 3, 0.5, 0.5, 4, 5, 6, 0.25, 0.75]);
  return Buffer.from(f.buffer.slice(0));
}

function syntheticCapture() {
  return {
    schemaVersion: "1.1",
    frame: 7,
    objects: {
      10: {
        id: 10, type: "RenderPipeline", label: "gbuffer-pipe",
        descriptor: {
          vertex: {
            buffers: [
              {
                arrayStride: 20,
                attributes: [
                  { shaderLocation: 0, format: "float32x3", offset: 0 },
                  { shaderLocation: 1, format: "float32x2", offset: 12 }
                ]
              }
            ]
          }
        }
      },
      20: { id: 20, type: "Buffer", label: "positions", descriptor: { size: 40 }, size: 40 }
    },
    commands: [
      { index: 0, method: "beginRenderPass", object: 5, result: 6, args: [{ label: "gbuffer" }] },
      { index: 1, method: "setPipeline", object: 6, args: [{ __id: 10 }] },
      {
        index: 2, method: "setVertexBuffer", object: 6, args: [0, { __id: 20 }, 0],
        bufferData: [{ entryIndex: 0, byteLength: 40, __payloadId: 0, __typedArray: "Uint8Array", __byteLength: 40 }]
      },
      { index: 3, method: "draw", object: 6, args: [3, 1, 0, 0] },
      { index: 4, method: "end", object: 6 }
    ],
    validationErrors: []
  };
}

// --- Tests -----------------------------------------------------------------

await test("decodeVertexBufferBytes decodes interleaved float attributes", () => {
  const layout = {
    arrayStride: 20,
    attributes: [
      { shaderLocation: 0, format: "float32x3", offset: 0 },
      { shaderLocation: 1, format: "float32x2", offset: 12 }
    ]
  };
  const out = decodeVertexBufferBytes(vertexBytes(), layout, 2, 0);
  assert.equal(out.vertexCount, 2);
  assert.deepEqual(out.vertices[0].attributes[0].value, [1, 2, 3]);
  assert.deepEqual(out.vertices[0].attributes[1].value, [0.5, 0.5]);
  assert.deepEqual(out.vertices[1].attributes[0].value, [4, 5, 6]);
  assert.deepEqual(out.vertices[1].attributes[1].value, [0.25, 0.75]);
});

await test("decodeVertexBufferBytes normalizes unorm8 and stops at truncation", () => {
  const bytes = Buffer.from([0, 255, 128, 0]); // 1 vertex of unorm8x2 (uses 2 bytes)
  const layout = { arrayStride: 2, attributes: [{ shaderLocation: 0, format: "unorm8x2", offset: 0 }] };
  const out = decodeVertexBufferBytes(bytes, layout, 8, 0);
  assert.equal(out.vertices[0].attributes[0].value[0], 0);
  assert.equal(out.vertices[0].attributes[0].value[1], 1);
  // Only 2 full vertices fit in 4 bytes; the loop stops cleanly.
  assert.equal(out.vertexCount, 2);
});

await test("getDrawState resolves pipeline, layout, and vertex buffer command", () => {
  const cap = syntheticCapture();
  const ds = getDrawState(cap, 3);
  assert.equal(ds.pipeline.id, 10);
  assert.equal(ds.pipeline.label, "gbuffer-pipe");
  assert.equal(ds.vertexBuffers.length, 1);
  assert.equal(ds.vertexBuffers[0].slot, 0);
  assert.equal(ds.vertexBuffers[0].bufferId, 20);
  assert.equal(ds.vertexBuffers[0].bufferDataCommandIndex, 2);
  assert.equal(ds.vertexBuffers[0].layout.arrayStride, 20);
  assert.equal(ds.vertexBuffers[0].layout.attributes.length, 2);
});

await test("getDrawState rejects a non-draw command", () => {
  const ds = getDrawState(syntheticCapture(), 1);
  assert.ok(ds.error && /not a draw/.test(ds.error));
});

await test("decodeVertexBuffer auto-derives layout from the following draw", () => {
  const cap = syntheticCapture();
  const bytes = vertexBytes();
  const resolver = (pid) => (pid === 0 ? bytes : null);
  const out = decodeVertexBuffer(cap, { commandIndex: 2, firstN: 2 }, resolver);
  assert.equal(out.slot, 0);
  assert.equal(out.bufferId, 20);
  assert.deepEqual(out.vertices[1].attributes[1].value, [0.25, 0.75]);
});

await test("stripHeavy turns payload refs into compact omitted markers", () => {
  const stripped = stripHeavy({
    foo: { __payloadId: 3, __typedArray: "Uint8Array", __length: 64, __byteLength: 64, __truncated: { byteLength: 1000, capturedBytes: 64 } }
  });
  assert.equal(stripped.foo.__base64Omitted, true);
  assert.equal(stripped.foo.__payloadId, 3);
  assert.deepEqual(stripped.foo.truncated, { byteLength: 1000, capturedBytes: 64 });
});

await test("resolvePayloadBytes handles both payloadId and inline base64", () => {
  const bytes = Buffer.from([1, 2, 3, 4]);
  assert.equal(resolvePayloadBytes({ __payloadId: 0 }, () => bytes), bytes);
  const inline = resolvePayloadBytes({ __base64: bytes.toString("base64") });
  assert.deepEqual([...inline], [1, 2, 3, 4]);
});

await test("diffDraws reports identical and changed bindings", () => {
  // Two draws sharing a pipeline but binding different vertex buffers.
  const cap = syntheticCapture();
  cap.commands.push(
    { index: 5, method: "beginRenderPass", object: 5, result: 7, args: [{ label: "gbuffer" }] },
    { index: 6, method: "setPipeline", object: 7, args: [{ __id: 10 }] },
    { index: 7, method: "setVertexBuffer", object: 7, args: [0, { __id: 99 }, 0] },
    { index: 8, method: "draw", object: 7, args: [3, 1, 0, 0] },
    { index: 9, method: "end", object: 7 }
  );
  const diff = diffDraws(cap, 3, 8);
  assert.equal(diff.identical, false);
  assert.ok(diff.differences.some((d) => d.field === "vertexBuffer[0].bufferId" && d.a === 20 && d.b === 99));
});

await test("CaptureStore round-trips a live capture (addLive -> getPayload -> reload)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wgpucap-"));
  try {
    const bytes = vertexBytes();
    const payloads = new Map([[0, { typedArray: "Uint8Array", base64: bytes.toString("base64") }]]);
    const store = new CaptureStore({ dir });
    await store.init();
    const meta = await store.addLive({ metadata: syntheticCapture(), payloads }, { pageName: "t" });

    const got = store.getPayload(meta.id, 0);
    assert.deepEqual([...got], [...bytes]);
    assert.equal(meta.totalCommands, 5);

    // Persisted as a WGPUCAP binary file; reload it in a fresh store.
    assert.ok(meta.path.endsWith(".wgpuc"));
    const store2 = new CaptureStore({ dir });
    const meta2 = await store2.addFile(meta.path);
    assert.deepEqual([...store2.getPayload(meta2.id, 0)], [...bytes]);
    assert.equal(summarize(store2.getJson(meta2.id)).frame, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test("CaptureStore loads a legacy 1.0 inline-base64 capture file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wgpucap-"));
  try {
    const bytes = vertexBytes();
    const legacy = syntheticCapture();
    // Inline the payload the old way and drop the ref form.
    legacy.schemaVersion = "1.0";
    legacy.commands[2].bufferData = [{
      entryIndex: 0, byteLength: 40,
      __typedArray: "Uint8Array", __length: 40, __base64: bytes.toString("base64")
    }];
    const p = join(dir, "legacy.json");
    await writeFile(p, JSON.stringify(legacy), "utf8");

    const store = new CaptureStore({ dir });
    const meta = await store.addFile(p);
    const cap = store.getJson(meta.id);
    // Inline payloads resolve without a store payload map.
    const entry = cap.commands[2].bufferData[0];
    assert.deepEqual([...resolvePayloadBytes(entry)], [...bytes]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test("page captureStreamToLines round-trips through the server loader", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wgpucap-"));
  try {
    const bytes = vertexBytes();
    // Mimic what the page builds: metadata with a payload ref + the payload list.
    const metadata = syntheticCapture();
    const stream = { metadata, payloads: [{ id: 0, typedArray: "Uint8Array", bytes }] };
    const lines = captureStreamToLines(stream);
    const p = join(dir, "stream.json");
    await writeFile(p, lines.join(""), "utf8");

    const store = new CaptureStore({ dir });
    const meta = await store.addFile(p);
    assert.equal(meta.frame, 7);
    assert.deepEqual([...store.getPayload(meta.id, 0)], [...bytes]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test("binary codec: page encoder and server decoder agree on the format", () => {
  const bytes = vertexBytes();
  const odd = Buffer.from([9, 8, 7]); // odd length exercises 8-byte padding
  const stream = {
    metadata: syntheticCapture(),
    payloads: [
      { id: 0, typedArray: "Uint8Array", bytes },
      { id: 1, typedArray: "Uint8Array", bytes: odd }
    ]
  };
  const file = concatParts(pageEncodeBinaryParts(stream).parts);

  // The front of the file is readable text: header line + metadata JSON.
  assert.ok(isCaptureBinary(file));
  const text = file.toString("utf8", 0, 64);
  assert.ok(text.startsWith("WGPUCAP 1 "), `header was ${JSON.stringify(text.slice(0, 16))}`);
  assert.ok(text.includes('{"schemaVersion"'));

  // Server decoder reads what the page encoder wrote.
  const { metadata, payloads } = decodeCaptureBinary(file);
  assert.equal(metadata.frame, 7);
  assert.deepEqual([...payloads.get(0)], [...bytes]);
  assert.deepEqual([...payloads.get(1)], [9, 8, 7]);
  // Payloads are 8-aligned so loaders can view them as any TypedArray.
  assert.deepEqual(metadata.payloadTable, [[0, bytes.length], [40, 3]]);

  // And the page decoder reads it too (panel "Load Capture" path).
  const pageSide = pageDecodeBinary(new Uint8Array(file));
  assert.deepEqual([...pageSide.payloads.get(1)], [9, 8, 7]);
});

await test("binary codec: truncated file loads with the cut payload omitted", () => {
  const stream = {
    metadata: syntheticCapture(),
    payloads: [
      { id: 0, typedArray: "Uint8Array", bytes: Buffer.alloc(8).fill(1) },
      { id: 1, typedArray: "Uint8Array", bytes: Buffer.alloc(64).fill(2) }
    ]
  };
  const file = concatParts(pageEncodeBinaryParts(stream).parts);
  const cut = file.subarray(0, file.length - 32); // slices into payload 1
  const { metadata, payloads } = decodeCaptureBinary(cut);
  assert.equal(metadata.frame, 7);
  assert.deepEqual([...payloads.get(0)], [...Buffer.alloc(8).fill(1)]);
  assert.equal(payloads.has(1), false);
});

await test("binary capture file loads through CaptureStore.addFile", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wgpucap-"));
  try {
    const bytes = vertexBytes();
    const stream = { metadata: syntheticCapture(), payloads: [{ id: 0, typedArray: "Uint8Array", bytes }] };
    const p = join(dir, "frame.wgpuc");
    await writeFile(p, concatParts(pageEncodeBinaryParts(stream).parts));

    const store = new CaptureStore({ dir });
    const meta = await store.addFile(p);
    assert.equal(meta.frame, 7);
    assert.deepEqual([...store.getPayload(meta.id, 0)], [...bytes]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

await test("bridge upload sniffs binary and legacy NDJSON bodies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wgpucap-"));
  const PORT = 47823;
  const store = new CaptureStore({ dir });
  await store.init();
  const bridge = new Bridge({ port: PORT, host: "127.0.0.1", store });
  assert.equal(await bridge.start(), true);
  try {
    const bytes = vertexBytes();
    const stream = { metadata: syntheticCapture(), payloads: [{ id: 0, typedArray: "Uint8Array", bytes }] };

    // Binary body (what the page's bridge client uploads now).
    const binBody = concatParts(pageEncodeBinaryParts(stream).parts);
    let res = await fetch(`http://127.0.0.1:${bridge.port}/capture/test-bin`, { method: "POST", body: binBody });
    assert.equal(res.status, 200);
    let captureId = (await res.json()).captureId;
    assert.deepEqual([...store.getPayload(captureId, 0)], [...bytes]);

    // Legacy NDJSON body (older instrumented pages).
    const ndjsonBody = captureStreamToLines(stream).join("");
    res = await fetch(`http://127.0.0.1:${bridge.port}/capture/test-ndjson`, { method: "POST", body: ndjsonBody });
    assert.equal(res.status, 200);
    captureId = (await res.json()).captureId;
    assert.deepEqual([...store.getPayload(captureId, 0)], [...bytes]);
  } finally {
    await bridge.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

await test("Bridge binds a free port and stop() releases it for reuse", async () => {
  const PORT = 47821; // uncommon; avoids the real 9690 a running server may hold
  const b = new Bridge({ port: PORT, host: "127.0.0.1" });
  assert.equal(await b.start(), true);
  assert.equal(b.isListening(), true);
  await b.stop();
  assert.equal(b.isListening(), false);
  // The port must be free again immediately — this is what prevents an orphaned
  // process from blocking the next launch's bind.
  const b2 = new Bridge({ port: PORT, host: "127.0.0.1" });
  assert.equal(await b2.start(), true);
  await b2.stop();
});

await test("Bridge start() on a busy port falls back to an OS-assigned port", async () => {
  const PORT = 47822;
  const holder = new Bridge({ port: PORT, host: "127.0.0.1" });
  assert.equal(await holder.start(), true);
  try {
    // The `ws` library re-emits an EADDRINUSE on the WebSocketServer; without an
    // "error" handler that crashes the whole process. With the handler, a busy
    // port is non-fatal — and rather than disabling live capture (which silently
    // broke every concurrent session that lost the race for the default port),
    // start() now falls back to an OS-assigned free port so this bridge still
    // listens. If the WSS-crash regresses, this process dies here (no summary).
    const second = new Bridge({ port: PORT, host: "127.0.0.1" });
    assert.equal(await second.start(), true);
    assert.equal(second.isListening(), true);
    // It must have bound a *different* port, not the busy one.
    assert.notEqual(second.port, PORT);
    assert.equal(typeof second.port, "number");
    await second.stop();
  } finally {
    await holder.stop();
  }
});

// --- Summary ---------------------------------------------------------------

process.stdout.write(`\n${passed} passed, ${failures.length} failed\n`);
if (failures.length) {
  process.exit(1);
}
