// Unit tests for the pixel-history engine (src/devtools/pixel_history.js).
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    blendPixel,
    compareFunc,
    stencilOp,
    extractFsOutput,
    selectNeededPasses,
    runPixelHistory,
    runPixelHistoryGen,
} from "../../src/devtools/pixel_history.js";

// ---------------------------------------------------------------------------
// Helpers to build synthetic pass/draw records.
// ---------------------------------------------------------------------------

const WIDTH = 4;
const HEIGHT = 4;

// A clip-space triangle covering the whole target.
const FULLSCREEN = {
    positions: [[-1, -1, 0.5, 1], [3, -1, 0.5, 1], [-1, 3, 0.5, 1]],
};

function makeGetVertex(positions, varyings) {
    return (vi) => ({
        position: positions[vi],
        varyings: varyings ? varyings[vi] : {},
    });
}

function makeDraw(overrides = {}) {
    return {
        command: { method: "draw", args: [3] },
        viewport: { x: 0, y: 0, w: WIDTH, h: HEIGHT, minDepth: 0, maxDepth: 1 },
        scissor: null,
        stencilReference: 0,
        blendConstant: [1, 1, 1, 1],
        frontFace: "ccw",
        cullMode: "none",
        unclippedDepth: false,
        depthStencilState: null,
        targets: [{}],
        triangles: [[0, 1, 2]],
        instanceCount: 1,
        firstInstance: 0,
        getVertex: makeGetVertex(FULLSCREEN.positions),
        runFragment: () => ({ output: [1, 0, 0, 1], discarded: false }),
        fsOutputs: [{ name: "color", locationType: "location", location: 0 }],
        error: null,
        ...overrides,
    };
}

function makePass(overrides = {}) {
    return {
        passIndex: 0,
        command: { method: "beginRenderPass" },
        width: WIDTH,
        height: HEIGHT,
        colorAttachments: [{ textureId: 1, slot: 0, loadOp: "clear", clearValue: [0, 0, 0, 1], storeOp: "store" }],
        depthStencil: null,
        draws: [],
        ...overrides,
    };
}

function fragments(entries) {
    return entries.filter((e) => e.type === "fragment");
}

// ---------------------------------------------------------------------------
// blendPixel
// ---------------------------------------------------------------------------

test("blendPixel: no blend replaces the destination", () => {
    const out = blendPixel([1, 0.5, 0, 1], [0, 0, 0, 0], null, 0xf, null);
    assert.deepEqual(out, [1, 0.5, 0, 1]);
});

test("blendPixel: write mask keeps unwritten channels", () => {
    const out = blendPixel([1, 1, 1, 1], [0, 0.25, 0.5, 0.75], null, 0x5, null); // R|B
    assert.deepEqual(out, [1, 0.25, 1, 0.75]);
});

test("blendPixel: standard alpha blend", () => {
    const blend = {
        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "zero", operation: "add" },
    };
    const out = blendPixel([1, 0, 0, 0.5], [0, 1, 0, 1], blend, 0xf, null);
    assert.deepEqual(out.map((v) => Math.round(v * 100) / 100), [0.5, 0.5, 0, 0.5]);
});

test("blendPixel: unknown destination poisons dst-dependent blends", () => {
    const blend = {
        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "zero", operation: "add" },
    };
    const out = blendPixel([1, 0, 0, 0.5], null, blend, 0xf, null);
    assert.deepEqual(out, [null, null, null, 0.5]); // alpha doesn't read dst
});

test("blendPixel: unknown destination is fine when blend ignores dst", () => {
    const blend = {
        color: { srcFactor: "one", dstFactor: "zero", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "zero", operation: "add" },
    };
    const out = blendPixel([0.25, 0.5, 0.75, 1], null, blend, 0xf, null);
    assert.deepEqual(out, [0.25, 0.5, 0.75, 1]);
});

test("blendPixel: constant blend factor", () => {
    const blend = {
        color: { srcFactor: "constant", dstFactor: "zero", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "zero", operation: "add" },
    };
    const out = blendPixel([1, 1, 1, 1], [0, 0, 0, 0], blend, 0xf, [0.5, 0.25, 0.125, 1]);
    assert.deepEqual(out, [0.5, 0.25, 0.125, 1]);
});

// ---------------------------------------------------------------------------
// compareFunc / stencilOp / extractFsOutput
// ---------------------------------------------------------------------------

test("compareFunc covers all comparison functions", () => {
    assert.equal(compareFunc("never", 0, 1), false);
    assert.equal(compareFunc("less", 0, 1), true);
    assert.equal(compareFunc("equal", 1, 1), true);
    assert.equal(compareFunc("less-equal", 1, 1), true);
    assert.equal(compareFunc("greater", 2, 1), true);
    assert.equal(compareFunc("not-equal", 2, 1), true);
    assert.equal(compareFunc("greater-equal", 1, 1), true);
    assert.equal(compareFunc("always", 0, 1), true);
});

test("stencilOp covers all operations", () => {
    assert.equal(stencilOp("keep", 5, 9), 5);
    assert.equal(stencilOp("zero", 5, 9), 0);
    assert.equal(stencilOp("replace", 5, 9), 9);
    assert.equal(stencilOp("invert", 0xf0, 0), 0x0f);
    assert.equal(stencilOp("increment-clamp", 0xff, 0), 0xff);
    assert.equal(stencilOp("decrement-clamp", 0, 0), 0);
    assert.equal(stencilOp("increment-wrap", 0xff, 0), 0);
    assert.equal(stencilOp("decrement-wrap", 0, 0), 0xff);
});

test("extractFsOutput maps a bare return to the single location", () => {
    const out = extractFsOutput([1, 0, 0, 1], [{ name: "c", locationType: "location", location: 0 }]);
    assert.deepEqual(out.colors[0], [1, 0, 0, 1]);
    assert.equal(out.fragDepth, null);
});

test("extractFsOutput maps struct outputs and frag_depth", () => {
    const fsOutputs = [
        { name: "color", locationType: "location", location: 0 },
        { name: "normal", locationType: "location", location: 1 },
        { name: "depth", locationType: "builtin", location: "frag_depth" },
    ];
    const out = extractFsOutput({ color: [1, 0, 0, 1], normal: [0, 0, 1], depth: 0.25 }, fsOutputs);
    assert.deepEqual(out.colors[0], [1, 0, 0, 1]);
    assert.deepEqual(out.colors[1], [0, 0, 1, 1]); // padded
    assert.equal(out.fragDepth, 0.25);
});

// ---------------------------------------------------------------------------
// runPixelHistory end-to-end
// ---------------------------------------------------------------------------

test("history: clear + fullscreen draw + end", () => {
    const pass = makePass({ draws: [makeDraw()] });
    const { entries, finalValue } = runPixelHistory([pass], 2, 2, 1);

    assert.deepEqual(entries.map((e) => e.type), ["clear", "fragment", "end"]);
    assert.deepEqual(entries[0].value, [0, 0, 0, 1]);
    assert.equal(entries[1].status, "written");
    assert.deepEqual(entries[1].value, [1, 0, 0, 1]);
    assert.deepEqual(finalValue, [1, 0, 0, 1]);
});

test("history: pixel not covered yields no fragment entries", () => {
    const positions = [[-1, -1, 0.5, 1], [-0.9, -1, 0.5, 1], [-1, -0.9, 0.5, 1]]; // tiny corner triangle
    const pass = makePass({ draws: [makeDraw({ getVertex: makeGetVertex(positions) })] });
    const { entries } = runPixelHistory([pass], 2, 2, 1);
    assert.deepEqual(entries.map((e) => e.type), ["clear", "end"]);
});

test("history: backface culling is reported", () => {
    // Same fullscreen triangle with reversed winding.
    const positions = [FULLSCREEN.positions[1], FULLSCREEN.positions[0], FULLSCREEN.positions[2]];
    const pass = makePass({
        draws: [makeDraw({ cullMode: "back", getVertex: makeGetVertex(positions) })],
    });
    const { entries } = runPixelHistory([pass], 2, 2, 1);
    const frags = fragments(entries);
    assert.equal(frags.length, 1);
    assert.equal(frags[0].status, "backface-culled");
});

test("history: scissor rejects fragments outside the rect", () => {
    const pass = makePass({
        draws: [makeDraw({ scissor: { x: 0, y: 0, w: 1, h: 1 } })],
    });
    const { entries } = runPixelHistory([pass], 2, 2, 1);
    assert.equal(fragments(entries)[0].status, "scissor-failed");
});

test("history: depth test kills the farther fragment", () => {
    const depthStencilState = { depthWriteEnabled: true, depthCompare: "less", format: "depth24plus" };
    const near = makeDraw({
        depthStencilState,
        getVertex: makeGetVertex(FULLSCREEN.positions.map((p) => [p[0], p[1], 0.25, 1])),
        runFragment: () => ({ output: [0, 1, 0, 1], discarded: false }),
    });
    const far = makeDraw({
        depthStencilState,
        getVertex: makeGetVertex(FULLSCREEN.positions.map((p) => [p[0], p[1], 0.75, 1])),
        runFragment: () => ({ output: [1, 0, 0, 1], discarded: false }),
    });
    const pass = makePass({
        depthStencil: {
            textureId: 2,
            depthLoadOp: "clear", depthClearValue: 1, depthReadOnly: false,
            stencilLoadOp: "clear", stencilClearValue: 0, stencilReadOnly: false,
        },
        draws: [near, far],
    });

    const { entries, finalValue } = runPixelHistory([pass], 2, 2, 1);
    const frags = fragments(entries);
    assert.equal(frags.length, 2);
    assert.equal(frags[0].status, "written");
    assert.equal(frags[1].status, "depth-failed");
    assert.equal(frags[1].fragDepth, 0.75);
    assert.equal(frags[1].depthBefore, 0.25);
    assert.deepEqual(finalValue, [0, 1, 0, 1]);
});

test("history: depth attachment as the target reports depth writes", () => {
    const depthStencilState = { depthWriteEnabled: true, depthCompare: "less", format: "depth24plus" };
    const draw = makeDraw({
        depthStencilState,
        getVertex: makeGetVertex(FULLSCREEN.positions.map((p) => [p[0], p[1], 0.25, 1])),
    });
    const pass = makePass({
        depthStencil: {
            textureId: 2,
            depthLoadOp: "clear", depthClearValue: 1, depthReadOnly: false,
            stencilLoadOp: "clear", stencilClearValue: 0, stencilReadOnly: false,
        },
        draws: [draw],
    });

    const { entries, finalValue } = runPixelHistory([pass], 2, 2, 2);
    const frags = fragments(entries);
    assert.equal(frags[0].status, "written");
    assert.deepEqual(frags[0].value, [0.25]);
    assert.deepEqual(finalValue, [0.25]);
});

test("history: discard is reported and writes nothing", () => {
    const pass = makePass({
        draws: [makeDraw({ runFragment: () => ({ output: null, discarded: true }) })],
    });
    const { entries, finalValue } = runPixelHistory([pass], 2, 2, 1);
    assert.equal(fragments(entries)[0].status, "discarded");
    assert.deepEqual(finalValue, [0, 0, 0, 1]); // still the clear value
});

test("history: loadOp load with no earlier writer is unknown, blend poisons value", () => {
    const blend = {
        color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
        alpha: { srcFactor: "one", dstFactor: "zero", operation: "add" },
    };
    const pass = makePass({
        colorAttachments: [{ textureId: 1, slot: 0, loadOp: "load", clearValue: null, storeOp: "store" }],
        draws: [makeDraw({
            targets: [{ blend }],
            runFragment: () => ({ output: [1, 0, 0, 0.5], discarded: false }),
        })],
    });
    const { entries, finalValue } = runPixelHistory([pass], 2, 2, 1);
    assert.equal(entries[0].type, "load");
    assert.equal(entries[0].value, null);
    assert.deepEqual(finalValue, [null, null, null, 0.5]);
});

test("history: a later clear-less pass chains from the earlier pass's value", () => {
    const pass0 = makePass({ passIndex: 0, draws: [makeDraw()] }); // clears black, draws red
    const pass1 = makePass({
        passIndex: 1,
        colorAttachments: [{ textureId: 1, slot: 0, loadOp: "load", clearValue: null, storeOp: "store" }],
        draws: [makeDraw({
            targets: [{ blend: {
                color: { srcFactor: "src-alpha", dstFactor: "one-minus-src-alpha", operation: "add" },
                alpha: { srcFactor: "one", dstFactor: "zero", operation: "add" },
            } }],
            runFragment: () => ({ output: [0, 0, 1, 0.5], discarded: false }),
        })],
    });
    const { entries, finalValue } = runPixelHistory([pass0, pass1], 2, 2, 1);
    // pass1's load sees pass0's red.
    const load = entries.find((e) => e.type === "load");
    assert.deepEqual(load.value, [1, 0, 0, 1]);
    assert.deepEqual(finalValue.map((v) => Math.round(v * 100) / 100), [0.5, 0, 0.5, 0.5]);
});

test("history: instancing evaluates every instance", () => {
    const positions = {
        0: FULLSCREEN.positions.map((p) => [p[0], p[1], 0.5, 1]),
        1: [[-1, -1, 0.5, 1], [-0.9, -1, 0.5, 1], [-1, -0.9, 0.5, 1]], // instance 1 misses
    };
    const pass = makePass({
        draws: [makeDraw({
            instanceCount: 2,
            getVertex: (vi, instance) => ({ position: positions[instance][vi], varyings: {} }),
        })],
    });
    const { entries } = runPixelHistory([pass], 2, 2, 1);
    const frags = fragments(entries);
    assert.equal(frags.length, 1);
    assert.equal(frags[0].instance, 0);
});

test("history: draw errors surface as entries", () => {
    const pass = makePass({
        draws: [{ command: { method: "drawIndirect" }, error: "Indirect draws are not supported by pixel history." }],
    });
    const { entries } = runPixelHistory([pass], 2, 2, 1);
    assert.equal(entries[1].type, "draw-error");
});

test("history: a depth pre-pass feeds the depth test but reports no fragments", () => {
    const depthStencilState = { depthWriteEnabled: true, depthCompare: "less", format: "depth24plus" };
    const depthAttachment = {
        textureId: 2,
        depthLoadOp: "clear", depthClearValue: 1, depthReadOnly: false,
        stencilLoadOp: "clear", stencilClearValue: 0, stencilReadOnly: false,
    };
    // Depth-only pre-pass: writes 0.25 at the pixel, no fragment stage.
    const prepass = makePass({
        passIndex: 0,
        colorAttachments: [],
        depthStencil: depthAttachment,
        draws: [makeDraw({
            depthStencilState,
            getVertex: makeGetVertex(FULLSCREEN.positions.map((p) => [p[0], p[1], 0.25, 1])),
            runFragment: null,
            fsOutputs: null,
            targets: [],
        })],
    });
    // Main pass: loads the pre-pass depth; its fragment at 0.75 must fail.
    const mainPass = makePass({
        passIndex: 1,
        depthStencil: { ...depthAttachment, depthLoadOp: "load", stencilLoadOp: "load" },
        draws: [makeDraw({
            depthStencilState,
            getVertex: makeGetVertex(FULLSCREEN.positions.map((p) => [p[0], p[1], 0.75, 1])),
        })],
    });

    const { entries, finalValue } = runPixelHistory([prepass, mainPass], 2, 2, 1);
    const frags = fragments(entries);
    assert.equal(frags.length, 1); // only the main pass's fragment
    assert.equal(frags[0].pass.passIndex, 1);
    assert.equal(frags[0].status, "depth-failed");
    assert.equal(frags[0].depthBefore, 0.25);
    assert.deepEqual(finalValue, [0, 0, 0, 1]); // main pass's clear survives
});

// ---------------------------------------------------------------------------
// selectNeededPasses
// ---------------------------------------------------------------------------

test("selectNeededPasses: includes depth-prepass dependencies, excludes unrelated passes", () => {
    const depthPrepass = makePass({
        passIndex: 0,
        colorAttachments: [],
        depthStencil: { textureId: 2, depthLoadOp: "clear", depthClearValue: 1, stencilLoadOp: "clear", stencilClearValue: 0 },
    });
    const shadowPass = makePass({
        passIndex: 1,
        colorAttachments: [],
        depthStencil: { textureId: 9, depthLoadOp: "clear", depthClearValue: 1, stencilLoadOp: "clear", stencilClearValue: 0 },
    });
    const mainPass = makePass({
        passIndex: 2,
        colorAttachments: [{ textureId: 1, slot: 0, loadOp: "clear", clearValue: [0, 0, 0, 1] }],
        depthStencil: { textureId: 2, depthLoadOp: "load", depthClearValue: 1, stencilLoadOp: "load", stencilClearValue: 0 },
    });

    const needed = selectNeededPasses([depthPrepass, shadowPass, mainPass], 1);
    assert.deepEqual(needed.map((p) => p.passIndex), [0, 2]);
});

test("selectNeededPasses: unrelated frames yield nothing", () => {
    const pass = makePass({ colorAttachments: [{ textureId: 5, slot: 0, loadOp: "clear", clearValue: [0, 0, 0, 1] }] });
    assert.deepEqual(selectNeededPasses([pass], 1), []);
});

test("triangles crossing w=0 are clipped, not skipped", () => {
    // A "wall" with its apex behind the camera (w = -1): the GPU clips and
    // rasterizes the visible part, so the history must report its fragment
    // (a large ground plane extending behind the camera is the real-world
    // case this models).
    const draw = makeDraw({ getVertex: makeGetVertex([[-1, -3, 0, 1], [-1, 3, 0, 1], [3, 0, 0, -1]]) });
    const { entries } = runPixelHistory([makePass({ draws: [draw] })], 2, 2, 1);
    const frags = fragments(entries);
    assert.equal(frags.length, 1);
    assert.equal(frags[0].status, "written");
});

test("fully-behind (w <= 0) primitives produce no fragments", () => {
    const positions = FULLSCREEN.positions.map((p) => [p[0], p[1], 0.5, -1]);
    const draw = makeDraw({ getVertex: makeGetVertex(positions) });
    const { entries } = runPixelHistory([makePass({ draws: [draw] })], 2, 2, 1);
    assert.equal(fragments(entries).length, 0);
});

test("runPixelHistoryGen: a draw filter skips rejected draws", () => {
    const drawA = makeDraw();
    const drawB = makeDraw();
    const errorDraw = { command: { method: "drawIndirect" }, error: "Indirect draws are not supported by pixel history." };
    const pass = makePass({ draws: [drawA, errorDraw, drawB] });

    const it = runPixelHistoryGen([pass], 1, 1, 1, (draw) => draw === drawB);
    let r = it.next();
    while (!r.done) {
        r = it.next();
    }
    const frags = fragments(r.value.entries);
    assert.equal(frags.length, 1);
    assert.equal(frags[0].draw, drawB);
    // Erroring draws bypass the filter so their diagnostic entries stay.
    assert.equal(r.value.entries.filter((e) => e.type === "draw-error").length, 1);
});

test("runPixelHistoryGen: yields progress and matches runPixelHistory", () => {
    const pass = makePass({ draws: [makeDraw(), makeDraw({ instanceCount: 3 })] });
    const sync = runPixelHistory([pass], 1, 1, 1);

    const it = runPixelHistoryGen([pass], 1, 1, 1);
    const progress = [];
    let r = it.next();
    while (!r.done) {
        if (r.value) {
            progress.push(r.value);
        }
        r = it.next();
    }
    assert.deepEqual(r.value, sync);
    // A {draw, drawCount} marker precedes each draw, tagged with the pass.
    const drawMarkers = progress.filter((p) => p.drawCount !== undefined);
    assert.deepEqual(drawMarkers.map((p) => p.draw), [0, 1]);
    assert.ok(progress.every((p) => p.passIndex === 0 && p.passCount === 1));
});
