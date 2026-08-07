// Unit tests for the pure parts of the GPU replay layer
// (src/devtools/capture_replay.js). The device-dependent paths can't run
// under node; they are exercised in the browser.
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    halfToFloat,
    vertexStageBindings,
    collectTargetPasses,
    walkPassCommands,
} from "../../src/devtools/capture_replay.js";

// ---------------------------------------------------------------------------
// halfToFloat
// ---------------------------------------------------------------------------

test("halfToFloat: decodes common values", () => {
    assert.equal(halfToFloat(0x0000), 0);
    assert.equal(halfToFloat(0x3c00), 1);
    assert.equal(halfToFloat(0x4000), 2);
    assert.equal(halfToFloat(0x4500), 5);
    assert.equal(halfToFloat(0xc000), -2);
    assert.equal(halfToFloat(0x7bff), 65504); // f16 max
    assert.equal(halfToFloat(0x3555), 0.333251953125);
});

test("halfToFloat: subnormals, infinity and NaN", () => {
    assert.equal(halfToFloat(0x0001), 2 ** -24); // smallest subnormal
    assert.equal(halfToFloat(0x7c00), Infinity);
    assert.equal(halfToFloat(0xfc00), -Infinity);
    assert.ok(Number.isNaN(halfToFloat(0x7c01)));
});

test("halfToFloat: every small integer count round-trips exactly", () => {
    // Additive 1.0 blending in f16 is exact for integers up to 2048; the
    // heatmap only needs small counts, but spot check a range.
    // f16 bit pattern for integer n in [1, 2048]: build via exponent/mantissa.
    const toHalf = (n) => {
        const e = Math.floor(Math.log2(n));
        const m = Math.round((n / 2 ** e - 1) * 1024);
        return ((e + 15) << 10) | m;
    };
    for (const n of [1, 2, 3, 7, 8, 100, 255, 1000, 2048]) {
        assert.equal(halfToFloat(toHalf(n)), n, `count ${n}`);
    }
});

// ---------------------------------------------------------------------------
// vertexStageBindings
// ---------------------------------------------------------------------------

function makeReflection(vertexEntries) {
    return { entry: { vertex: vertexEntries } };
}

test("vertexStageBindings: collects the entry's resources", () => {
    const reflection = makeReflection([{
        name: "vsMain",
        resources: [
            { group: 0, binding: 0 },
            { group: 1, binding: 2 },
        ],
    }]);
    const bindings = vertexStageBindings(reflection, "vsMain");
    assert.deepEqual(Array.from(bindings).sort(), ["0:0", "1:2"]);
});

test("vertexStageBindings: falls back to the first vertex entry", () => {
    const reflection = makeReflection([
        { name: "a", resources: [{ group: 0, binding: 1 }] },
        { name: "b", resources: [{ group: 0, binding: 2 }] },
    ]);
    assert.deepEqual(Array.from(vertexStageBindings(reflection, undefined)), ["0:1"]);
    assert.deepEqual(Array.from(vertexStageBindings(reflection, "missing")), ["0:1"]);
    assert.deepEqual(Array.from(vertexStageBindings(reflection, "b")), ["0:2"]);
});

test("vertexStageBindings: null without reflection or vertex entries", () => {
    assert.equal(vertexStageBindings(null, "main"), null);
    assert.equal(vertexStageBindings(makeReflection([]), "main"), null);
});

test("vertexStageBindings: empty resources yields an empty set", () => {
    const bindings = vertexStageBindings(makeReflection([{ name: "m", resources: [] }]), "m");
    assert.equal(bindings.size, 0);
});

// ---------------------------------------------------------------------------
// collectTargetPasses
// ---------------------------------------------------------------------------

// Attachments carry a fake view id; the lookup maps it to a texture object.
function makeCommands() {
    return [
        { method: "beginRenderPass", args: [{ colorAttachments: [{ view: 10 }] }] },
        { method: "setPipeline", args: [{ __id: 1 }] },
        { method: "draw", args: [3] },
        { method: "end", args: [] },
        { method: "beginComputePass", args: [{}] },
        { method: "dispatchWorkgroups", args: [1] },
        { method: "end", args: [] },
        { method: "beginRenderPass", args: [{ colorAttachments: [{ view: 20 }], depthStencilAttachment: { view: 30 } }] },
        { method: "draw", args: [6] },
        { method: "end", args: [] },
    ];
}

const textures = {
    10: { id: 100 },
    20: { id: 200 },
    30: { id: 300 },
};
const lookup = (attachment) => textures[attachment.view] ?? null;

test("collectTargetPasses: slices only passes with the target attached", () => {
    const { passes } = collectTargetPasses(makeCommands(), { id: 100 }, lookup);
    assert.equal(passes.length, 1);
    assert.deepEqual(passes[0].map((c) => c.method), ["setPipeline", "draw"]);
});

test("collectTargetPasses: depth-stencil attachments count as targets", () => {
    const { passes } = collectTargetPasses(makeCommands(), { id: 300 }, lookup);
    assert.equal(passes.length, 1);
    assert.deepEqual(passes[0].map((c) => c.method), ["draw"]);
});

test("collectTargetPasses: compute passes and other targets are ignored", () => {
    const { passes } = collectTargetPasses(makeCommands(), { id: 999 }, lookup);
    assert.equal(passes.length, 0);
});

test("collectTargetPasses: flags multisampled attachments", () => {
    const commands = [
        { method: "beginRenderPass", args: [{ colorAttachments: [{ view: 10, resolveTarget: 11 }] }] },
        { method: "draw", args: [3] },
        { method: "end", args: [] },
    ];
    const { passes, msaa } = collectTargetPasses(commands, { id: 100 }, lookup);
    assert.equal(passes.length, 1);
    assert.equal(msaa, true);
    assert.equal(collectTargetPasses(makeCommands(), { id: 100 }, lookup).msaa, false);
});

// ---------------------------------------------------------------------------
// walkPassCommands
// ---------------------------------------------------------------------------

// Only the database lookup and the note sink are reached by the pure paths;
// anything touching the GPU is exercised in the browser harnesses.
function makeReplay(objects = {}) {
    return {
        database: { getObject: (id) => objects[id] ?? null },
        notes: new Set(),
    };
}

function walk(replay, commands) {
    const uploads = [];
    const missing = new Set();
    const stats = { skippedDraws: 0 };
    const plans = walkPassCommands(replay, commands, uploads, missing, stats);
    return { plans, uploads, missing, stats };
}

test("walkPassCommands: a dispatch carries the bound pipeline and bind groups", () => {
    const { plans } = walk(makeReplay(), [
        { method: "setPipeline", args: [{ __id: 7 }] },
        { method: "setBindGroup", args: [0, { __id: 11 }, null] },
        { method: "setBindGroup", args: [1, { __id: 12 }, [256]] },
        { method: "dispatchWorkgroups", args: [8, 4, 2] },
    ]);
    assert.equal(plans.length, 1);
    const plan = plans[0];
    assert.equal(plan.method, "dispatchWorkgroups");
    assert.equal(plan.pipelineId, 7);
    assert.deepEqual(plan.args, [8, 4, 2]);
    assert.deepEqual(plan.bindGroups[0], { bgId: 11, dynamicOffsets: null });
    assert.deepEqual(plan.bindGroups[1], { bgId: 12, dynamicOffsets: [256] });
    // A compute pass has no raster state to carry.
    assert.deepEqual(plan.vertexBuffers, []);
    assert.equal(plan.indexBuffer, null);
    assert.equal(plan.viewport, null);
});

test("walkPassCommands: each dispatch snapshots the state current at that point", () => {
    const { plans } = walk(makeReplay(), [
        { method: "setPipeline", args: [{ __id: 1 }] },
        { method: "dispatchWorkgroups", args: [1] },
        { method: "setPipeline", args: [{ __id: 2 }] },
        { method: "setBindGroup", args: [0, { __id: 9 }, null] },
        { method: "dispatchWorkgroups", args: [64] },
    ]);
    assert.equal(plans.length, 2);
    assert.equal(plans[0].pipelineId, 1);
    assert.equal(plans[0].bindGroups.length, 0);
    assert.equal(plans[1].pipelineId, 2);
    assert.deepEqual(plans[1].bindGroups[0], { bgId: 9, dynamicOffsets: null });
});

test("walkPassCommands: an indirect dispatch records its argument buffer and bytes", () => {
    const replay = makeReplay({ 5: { label: "args", descriptor: { size: 16 } } });
    const data = new Uint8Array(16);
    const { plans, uploads, missing } = walk(replay, [
        { method: "setPipeline", args: [{ __id: 3 }] },
        { method: "dispatchWorkgroupsIndirect", args: [{ __id: 5 }, 4], bufferData: [data] },
    ]);
    assert.equal(plans.length, 1);
    assert.deepEqual(plans[0].indirect, { bufferId: 5, offset: 4 });
    assert.deepEqual(uploads, [{ bufferId: 5, offset: 0, data }]);
    assert.equal(missing.size, 0);
});

test("walkPassCommands: an indirect dispatch without captured bytes is noted", () => {
    const replay = makeReplay({ 5: { label: "args", descriptor: { size: 16 } } });
    const { uploads, missing } = walk(replay, [
        { method: "dispatchWorkgroupsIndirect", args: [{ __id: 5 }, 0] },
    ]);
    assert.equal(uploads.length, 0);
    assert.deepEqual(Array.from(missing), ["args: no captured bytes — its contents replay as zeros."]);
});

test("walkPassCommands: draws still carry their raster state", () => {
    const replay = makeReplay({ 20: { descriptor: { size: 48 } } });
    const { plans } = walk(replay, [
        { method: "setPipeline", args: [{ __id: 4 }] },
        { method: "setVertexBuffer", args: [0, { __id: 20 }, 0, 48] },
        { method: "setViewport", args: [0, 0, 100, 50, 0, 1] },
        { method: "setScissorRect", args: [1, 2, 3, 4] },
        { method: "draw", args: [3, 1, 0, 0] },
    ]);
    assert.equal(plans.length, 1);
    assert.equal(plans[0].method, "draw");
    assert.deepEqual(plans[0].vertexBuffers[0], { bufferId: 20, offset: 0, size: 48 });
    assert.deepEqual(plans[0].viewport, [0, 0, 100, 50, 0, 1]);
    assert.deepEqual(plans[0].scissor, [1, 2, 3, 4]);
});
