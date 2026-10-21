// Unit tests for the stacktrace switches in src/utils/gpu_object_wrapper.js.
//
// The wrapper has two independent switches: recordObjectStacktraces captures only
// where GPU objects are created (the panel's "Object Stacktraces" setting), and
// recordCommandStacktraces captures every call (a frame capture that asked for
// per-command stacktraces). These tests pin that a creation setting never makes a
// draw or setBindGroup pay for a capture, and that a command capture covers both.
//
// Run with: node --test "test/unit/*.test.js"

import { test, before } from "node:test";
import assert from "node:assert/strict";

// The module reads the WebGPU interfaces at import time to build its type table
// and patch their prototypes, so stand-ins have to exist before it is imported.
const GPU_TYPES = [
  "GPU", "GPUAdapter", "GPUDevice", "GPUBuffer", "GPUTexture", "GPUTextureView", "GPUSampler",
  "GPUBindGroupLayout", "GPUBindGroup", "GPUPipelineLayout", "GPUShaderModule",
  "GPUComputePipeline", "GPURenderPipeline", "GPUCommandBuffer", "GPUCommandEncoder",
  "GPUComputePassEncoder", "GPURenderPassEncoder", "GPURenderBundle", "GPURenderBundleEncoder",
  "GPUQueue", "GPUQuerySet", "GPUCanvasContext"
];

let GPUObjectWrapper = null;
let GPUStacktraceMethods = null;

before(async () => {
  for (const name of GPU_TYPES) {
    if (!globalThis[name]) {
      globalThis[name] = class {};
    }
  }
  ({ GPUObjectWrapper, GPUStacktraceMethods } = await import("../../src/utils/gpu_object_wrapper.js"));
});

// Wraps two methods on a plain object: one that creates an object and one that
// is a per-draw command. Returns the stacktrace each call delivered to onPostCall.
function makeWrapped() {
  const wrapper = new GPUObjectWrapper({ getNextId: () => 1 });
  const seen = {};
  wrapper.onPostCall = (object, method, args, result, stacktrace) => {
    seen[method] = stacktrace;
  };
  const target = {
    createBuffer: wrapper._wrapMethod("createBuffer", function () { return {}; }),
    setBindGroup: wrapper._wrapMethod("setBindGroup", function () { return undefined; }),
  };
  return { wrapper, target, seen };
}

test("creation methods are the ones the object setting records", () => {
  assert.ok(GPUStacktraceMethods.has("createBuffer"));
  assert.ok(GPUStacktraceMethods.has("createBindGroup"));
  assert.ok(GPUStacktraceMethods.has("createView"));
  assert.ok(GPUStacktraceMethods.has("requestDevice"));
  assert.ok(!GPUStacktraceMethods.has("setBindGroup"));
  assert.ok(!GPUStacktraceMethods.has("draw"));
  assert.ok(!GPUStacktraceMethods.has("submit"));
});

test("no stacktraces by default", () => {
  const { target, seen } = makeWrapped();
  target.createBuffer({});
  target.setBindGroup(0, {});
  assert.equal(seen.createBuffer, undefined);
  assert.equal(seen.setBindGroup, undefined);
});

test("object stacktraces cover creations only", () => {
  const { wrapper, target, seen } = makeWrapped();
  wrapper.recordObjectStacktraces = true;
  target.createBuffer({});
  target.setBindGroup(0, {});
  assert.equal(typeof seen.createBuffer, "string");
  assert.ok(seen.createBuffer.length > 0);
  assert.equal(seen.setBindGroup, undefined);
});

test("command stacktraces cover every call, and clear independently", () => {
  const { wrapper, target, seen } = makeWrapped();
  wrapper.recordObjectStacktraces = true;
  wrapper.recordCommandStacktraces = true;
  target.createBuffer({});
  target.setBindGroup(0, {});
  assert.equal(typeof seen.createBuffer, "string");
  assert.equal(typeof seen.setBindGroup, "string");

  // Ending a capture clears the command flag; the object setting keeps working.
  wrapper.recordCommandStacktraces = false;
  target.createBuffer({});
  target.setBindGroup(0, {});
  assert.equal(typeof seen.createBuffer, "string");
  assert.equal(seen.setBindGroup, undefined);
});

test("the wrapped call still returns the native result", () => {
  const { wrapper } = makeWrapped();
  const add = wrapper._wrapMethod("draw", function (a, b) { return a + b; });
  assert.equal(add.call({}, 2, 3), 5);
});
