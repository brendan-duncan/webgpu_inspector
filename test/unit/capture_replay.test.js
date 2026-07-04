// Unit tests for the pure parts of the GPU replay layer
// (src/devtools/capture_replay.js). The device-dependent paths can't run
// under node; they are exercised in the browser.
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { halfToFloat, vertexStageBindings, collectTargetPasses } from "../../src/devtools/capture_replay.js";

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
