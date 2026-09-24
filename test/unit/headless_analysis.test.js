// Unit tests for the capture analyses the Claude Code plugin runs outside the
// panel (src/devtools/headless_analysis.js), on a capture in the exported
// (Save Capture) format.
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  compareCaptures,
  debugShader,
  getFrameIssues,
  getRenderGraph,
  getShaderFlameGraph,
  openCapture,
} from "../../src/devtools/headless_analysis.js";

const CODE = `
@vertex fn vs(@location(0) p : vec3f) -> @builtin(position) vec4f {
  let scaled = p * 2.0;
  return vec4f(scaled, 1.0);
}
@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0, 0.5, 0.25, 1.0); }`;

const ref = (id) => ({ __id: id });

function exported({ code = CODE, label = "main" } = {}) {
  const vertices = new Float32Array([0, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0.25]);
  const payloads = new Map([[0, new Uint8Array(vertices.buffer)]]);
  const data = {
    schemaVersion: "1.1",
    frame: 7,
    objects: {
      1: { type: "ShaderModule", label: "tri", descriptor: { code } },
      2: { type: "RenderPipeline", descriptor: {
        layout: "auto",
        vertex: { module: ref(1), entryPoint: "vs", buffers: [{ arrayStride: 12, attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }] }] },
        fragment: { module: ref(1), entryPoint: "fs", targets: [{ format: "rgba8unorm" }] },
      } },
      3: { type: "Texture", label: "target", descriptor: { size: [64, 64, 1], format: "rgba8unorm", usage: 0x10 } },
      4: { type: "TextureView", texture: ref(3), descriptor: {} },
      5: { type: "Buffer", descriptor: { size: 36, usage: 0x20 } },
    },
    commands: [
      { method: "createCommandEncoder", object: 0, args: [], result: 100 },
      { method: "beginRenderPass", object: 100, result: 101, args: [{ label, colorAttachments: [{ view: ref(4), loadOp: "clear", storeOp: "store" }] }] },
      { method: "setPipeline", object: 101, args: [ref(2)] },
      { method: "setVertexBuffer", object: 101, args: [0, ref(5)], bufferData: [{ __typedArray: "Uint8Array", __payloadId: 0, entryIndex: 0 }] },
      { method: "draw", object: 101, args: [3] },
      { method: "end", object: 101, args: [] },
      { method: "finish", object: 100, args: [], result: 102 },
      { method: "submit", object: 2, args: [[ref(102)]] },
    ],
  };
  return { data, payloads };
}

async function open(options) {
  const { data, payloads } = exported(options);
  return openCapture(data, payloads);
}

test("headless: the render graph names passes and command indices", async () => {
  const session = await open();
  const graph = getRenderGraph(session);
  assert.equal(graph.passes.length, 1);
  assert.equal(graph.passes[0].label, "main");
  assert.equal(graph.passes[0].commandIndex, 1);
  assert.equal(graph.passes[0].draws, 1);
  assert.ok(graph.resources.some((r) => r.name.includes("target")));
  // The result is plain JSON: no object graph leaks through.
  assert.doesNotThrow(() => JSON.stringify(graph));
});

test("headless: frame issues are JSON with command indices", async () => {
  const session = await open();
  const issues = getFrameIssues(session);
  assert.equal(typeof issues.total, "number");
  for (const f of issues.findings) {
    assert.ok(f.commandIndices.every((i) => Number.isInteger(i)));
  }
});

test("headless: debug_shader runs a vertex with a trace, and a fragment at a pixel", async () => {
  const session = await open();
  const vertex = debugShader(session, { commandIndex: 4, vertexIndex: 2, watch: ["scaled"] });
  assert.equal(vertex.stage, "vertex");
  assert.deepEqual(vertex.inputs[0], [0.5, -0.5, 0.25]);
  assert.deepEqual(vertex.outputs.position, [1, -1, 0.5, 1]);
  assert.deepEqual(vertex.trace.map((t) => t.scaled), [[1, -1, 0.5]]);

  const fragment = debugShader(session, { commandIndex: 4, x: 32, y: 36 });
  assert.equal(fragment.stage, "fragment");
  assert.equal(fragment.discarded, false);
  assert.deepEqual(fragment.outputs["@location(0)"], [1, 0.5, 0.25, 1]);
  assert.throws(() => debugShader(session, { commandIndex: 4, x: 0, y: 0 }), /No primitive/);
  assert.throws(() => debugShader(session, { commandIndex: 2 }), /not a draw or dispatch/);
});

test("headless: the shader flame graph ranks one module's statements", async () => {
  const session = await open();
  const result = getShaderFlameGraph(session, { shaderModuleId: 1 });
  assert.deepEqual(result.entryPoints.map((e) => e.stage).sort(), ["fragment", "vertex"]);
  const vertex = result.entryPoints.find((e) => e.stage === "vertex");
  assert.ok(vertex.hottest.some((h) => h.name.includes("scaled") && h.lines === "3"));
});

test("headless: compare_captures reports changed shaders and passes", async () => {
  const a = await open();
  const b = await open({ code: CODE.replace("2.0", "3.0"), label: "main2" });
  const diff = compareCaptures(a, b);
  assert.deepEqual(diff.shaderChanges.map((c) => c.change), ["code changed"]);
  assert.deepEqual(diff.passChanges.map((p) => p.change).sort(), ["added", "removed"]);
  assert.deepEqual(compareCaptures(a, a).shaderChanges, []);
});
