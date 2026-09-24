// Unit tests for the frame issue rules (src/devtools/frame_issues.js).
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzeFrameIssues } from "../../src/devtools/frame_issues.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

class Texture {
    constructor(id, { label = "", format = "rgba8unorm" } = {}) {
        this.id = id;
        this.label = label;
        this.descriptor = { size: [64, 64, 1], format, mipLevelCount: 1, sampleCount: 1 };
    }
    get format() { return this.descriptor.format; }
    get dimension() { return "2d"; }
    get width() { return 64; }
    get height() { return 64; }
    get depthOrArrayLayers() { return 1; }
    get mipLevelCount() { return 1; }
    get sampleCount() { return 1; }
    getMipSize() { return [64, 64, 1]; }
    getGpuSize() { return 64 * 64 * 4; }
}

class TextureView {
    constructor(id, texture) {
        this.id = id;
        this.texture = texture;
        this.descriptor = {};
    }
}
TextureView.className = "TextureView";

function world() {
    const objects = new Map();
    const add = (o) => { objects.set(o.id, o); return o; };
    return { add, resolver: { getObject: (id) => objects.get(id) ?? null } };
}

const ref = (id) => ({ __id: id });

// One encoder, one render pass to the canvas holding `body`, submitted.
function frame(body, { canvasLoadOp = "clear", before = [], after = [] } = {}) {
    return [
        ...before,
        { class: "GPUDevice", object: 1, method: "createCommandEncoder", args: [], result: 100 },
        { class: "GPUCommandEncoder", object: 100, method: "beginRenderPass",
          args: [{ label: "main", colorAttachments: [{ view: ref(22), loadOp: canvasLoadOp, storeOp: "store" }] }], result: 101 },
        ...body.map((c) => ({ class: "GPURenderPassEncoder", object: 101, result: 0, ...c })),
        { class: "GPURenderPassEncoder", object: 101, method: "end", args: [], result: 0 },
        { class: "GPUCommandEncoder", object: 100, method: "finish", args: [], result: 102 },
        { class: "GPUQueue", object: 2, method: "submit", args: [[ref(102)]], result: 0 },
        ...after,
    ];
}

function canvasWorld() {
    const w = world();
    const canvas = w.add(new Texture(-5, { format: "bgra8unorm" }));
    w.add(new TextureView(22, canvas.id));
    return w;
}

const rulesOf = (result) => result.findings.map((f) => f.rule);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("frame issues: a clean frame has no findings", () => {
    const { resolver } = canvasWorld();
    const result = analyzeFrameIssues(frame([
        { method: "setPipeline", args: [ref(40)] },
        { method: "draw", args: [3] },
    ]), resolver);
    assert.deepEqual(result.findings, []);
});

test("frame issues: redundant binds are flagged on the repeated command", () => {
    const { resolver } = canvasWorld();
    const commands = frame([
        { method: "setPipeline", args: [ref(40)] },
        { method: "setBindGroup", args: [0, ref(30), []] },
        { method: "draw", args: [3] },
        { method: "setPipeline", args: [ref(40)] },
        { method: "setBindGroup", args: [0, ref(30), []] },
        { method: "setBindGroup", args: [0, ref(30), [256]] },
        { method: "setViewport", args: [0, 0, 64, 64, 0, 1] },
        { method: "setViewport", args: [0, 0, 64, 64, 0, 1] },
        { method: "draw", args: [3] },
    ]);
    const result = analyzeFrameIssues(commands, resolver);
    const pipeline = result.findings.find((f) => f.rule === "redundant-pipeline-bind");
    assert.equal(pipeline.count, 1);
    assert.equal(pipeline.command, commands[5]);
    // A different dynamic offset is a real change, not a redundant bind.
    assert.equal(result.findings.find((f) => f.rule === "redundant-bind-group").count, 1);
    assert.equal(result.findings.find((f) => f.rule === "redundant-state").count, 1);
    assert.deepEqual(result.byCommand.get(commands[5]).map((f) => f.rule), ["redundant-pipeline-bind"]);
});

test("frame issues: pass state resets between passes", () => {
    const { resolver } = canvasWorld();
    const commands = frame([{ method: "setPipeline", args: [ref(40)] }, { method: "draw", args: [3] }]);
    // Same pipeline set again in a second pass: not redundant.
    const second = frame([{ method: "setPipeline", args: [ref(40)] }, { method: "draw", args: [3] }], { canvasLoadOp: "load" })
        .map((c) => ({ ...c, object: c.object === 100 ? 200 : c.object === 101 ? 201 : c.object, result: c.result === 100 ? 200 : c.result === 101 ? 201 : c.result === 102 ? 202 : c.result }));
    second[second.length - 1].args = [[ref(202)]];
    const result = analyzeFrameIssues([...commands, ...second], resolver);
    assert.ok(!rulesOf(result).includes("redundant-pipeline-bind"));
});

test("frame issues: synchronous pipeline creation mid-frame is high severity", () => {
    const { resolver } = canvasWorld();
    const create = { class: "GPUDevice", object: 1, method: "createRenderPipeline", args: [{ label: "late" }], result: 41 };
    const result = analyzeFrameIssues(frame([{ method: "draw", args: [3] }], { before: [create] }), resolver);
    const f = result.findings[0];
    assert.equal(f.rule, "pipeline-created-in-frame");
    assert.equal(f.severity, "high");
    assert.match(f.message, /"late"/);
    assert.equal(f.command, create);
});

test("frame issues: tiny-draws needs many small non-instanced draws", () => {
    const { resolver } = canvasWorld();
    const draws = (n, instances) => Array.from({ length: n }, () => ({ method: "draw", args: [6, instances] }));
    assert.ok(!rulesOf(analyzeFrameIssues(frame(draws(10, 1)), resolver)).includes("tiny-draws"));
    assert.ok(!rulesOf(analyzeFrameIssues(frame(draws(40, 100)), resolver)).includes("tiny-draws"));
    const result = analyzeFrameIssues(frame(draws(40, 1)), resolver);
    assert.equal(result.findings.find((f) => f.rule === "tiny-draws").count, 40);
});

test("frame issues: fragmented writeBuffer calls to one buffer", () => {
    const { resolver } = canvasWorld();
    const writes = Array.from({ length: 10 }, (_, i) =>
        ({ class: "GPUQueue", object: 2, method: "writeBuffer", args: [ref(50), i * 16, "Float32Array 16"], result: 0 }));
    const result = analyzeFrameIssues(frame([{ method: "draw", args: [3] }], { before: writes }), resolver);
    const f = result.findings.find((x) => x.rule === "fragmented-buffer-writes");
    assert.equal(f.commands.length, 10);
    assert.match(f.message, /Buffer 50 \(10 writes\)/);
});

test("frame issues: loading a fresh canvas texture is flagged", () => {
    const { resolver } = canvasWorld();
    const result = analyzeFrameIssues(frame([{ method: "draw", args: [3] }], { canvasLoadOp: "load" }), resolver);
    assert.ok(rulesOf(result).includes("canvas-load"));
    assert.ok(!rulesOf(result).includes("color-load"));
});

test("frame issues: an empty pass is flagged, a clear-only pass is not", () => {
    const { resolver } = canvasWorld();
    assert.ok(!rulesOf(analyzeFrameIssues(frame([]), resolver)).includes("empty-pass"));
    const result = analyzeFrameIssues(frame([], { canvasLoadOp: "load" }), resolver);
    assert.ok(rulesOf(result).includes("empty-pass"));
});

test("frame issues: a single small workgroup dispatch is flagged", () => {
    const { add, resolver } = canvasWorld();
    const module = {
        id: 60,
        reflection: { entry: { compute: [{ name: "main", attributes: [{ name: "workgroup_size", value: ["8"] }], resources: [] }] } },
    };
    add(module);
    add({ id: 40, descriptor: { compute: { module: ref(60), entryPoint: "main" } } });
    const commands = [
        { class: "GPUDevice", object: 1, method: "createCommandEncoder", args: [], result: 100 },
        { class: "GPUCommandEncoder", object: 100, method: "beginComputePass", args: [{}], result: 101 },
        { class: "GPUComputePassEncoder", object: 101, method: "setPipeline", args: [ref(40)], result: 0 },
        { class: "GPUComputePassEncoder", object: 101, method: "dispatchWorkgroups", args: [1], result: 0 },
        { class: "GPUComputePassEncoder", object: 101, method: "dispatchWorkgroups", args: [64], result: 0 },
        { class: "GPUComputePassEncoder", object: 101, method: "end", args: [], result: 0 },
        { class: "GPUCommandEncoder", object: 100, method: "finish", args: [], result: 102 },
        { class: "GPUQueue", object: 2, method: "submit", args: [[ref(102)]], result: 0 },
    ];
    const f = analyzeFrameIssues(commands, resolver).findings.find((x) => x.rule === "small-dispatch");
    assert.equal(f.count, 1);
    assert.equal(f.command, commands[3]);
    assert.match(f.message, /8 invocations/);
});

test("frame issues: render graph findings are included, most severe first", () => {
    const { add, resolver } = canvasWorld();
    const t = add(new Texture(10, { label: "scratch" }));
    add(new TextureView(20, t.id));
    const commands = [
        { class: "GPUDevice", object: 1, method: "createCommandEncoder", args: [], result: 100 },
        { class: "GPUCommandEncoder", object: 100, method: "beginRenderPass", args: [{ label: "a", colorAttachments: [{ view: ref(20), loadOp: "clear", storeOp: "store" }] }], result: 101 },
        { class: "GPURenderPassEncoder", object: 101, method: "draw", args: [3], result: 0 },
        { class: "GPURenderPassEncoder", object: 101, method: "end", args: [], result: 0 },
        { class: "GPUCommandEncoder", object: 100, method: "beginRenderPass", args: [{ label: "b", colorAttachments: [{ view: ref(20), loadOp: "clear", storeOp: "store" }] }], result: 103 },
        { class: "GPURenderPassEncoder", object: 103, method: "draw", args: [3], result: 0 },
        { class: "GPURenderPassEncoder", object: 103, method: "setPipeline", args: [ref(40)], result: 0 },
        { class: "GPURenderPassEncoder", object: 103, method: "setPipeline", args: [ref(40)], result: 0 },
        { class: "GPURenderPassEncoder", object: 103, method: "end", args: [], result: 0 },
        { class: "GPUCommandEncoder", object: 100, method: "finish", args: [], result: 102 },
        { class: "GPUQueue", object: 2, method: "submit", args: [[ref(102)]], result: 0 },
    ];
    const result = analyzeFrameIssues(commands, resolver);
    assert.equal(result.findings[0].rule, "overwritten-before-read");
    assert.equal(result.findings[0].command, commands[1]);
    assert.ok(rulesOf(result).includes("unread-store"));
    assert.equal(result.findings.at(-1).severity, "low");
});
