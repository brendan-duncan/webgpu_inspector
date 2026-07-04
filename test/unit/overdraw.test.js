// Unit tests for the overdraw engine (src/devtools/overdraw.js).
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { computeOverdraw, computeOverdrawSync } from "../../src/devtools/overdraw.js";

// ---------------------------------------------------------------------------
// Helpers to build synthetic pass/draw records (matching pixel_history.test.js).
// ---------------------------------------------------------------------------

const WIDTH = 4;
const HEIGHT = 4;

// A clip-space triangle covering the whole target.
const FULLSCREEN = {
    positions: [[-1, -1, 0.5, 1], [3, -1, 0.5, 1], [-1, 3, 0.5, 1]],
};

function makeGetVertex(positions) {
    return (vi) => ({ position: positions[vi], varyings: {} });
}

function makeDraw(overrides = {}) {
    return {
        command: { method: "draw", args: [3] },
        viewport: { x: 0, y: 0, w: WIDTH, h: HEIGHT, minDepth: 0, maxDepth: 1 },
        scissor: null,
        frontFace: "ccw",
        cullMode: "none",
        unclippedDepth: false,
        triangles: [[0, 1, 2]],
        instanceCount: 1,
        firstInstance: 0,
        getVertex: makeGetVertex(FULLSCREEN.positions),
        fsOutputs: null,
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

function countGrid(result) {
    const rows = [];
    for (let y = 0; y < result.height; ++y) {
        rows.push(Array.from(result.counts.subarray(y * result.width, (y + 1) * result.width)));
    }
    return rows;
}

// ---------------------------------------------------------------------------

test("overdraw: a fullscreen triangle counts every pixel once", () => {
    const pass = makePass({ draws: [makeDraw()] });
    const result = computeOverdrawSync([pass], 1);
    assert.equal(result.width, WIDTH);
    assert.equal(result.height, HEIGHT);
    assert.equal(result.maxCount, 1);
    assert.ok(result.counts.every((c) => c === 1));
});

test("overdraw: overlapping draws accumulate", () => {
    const pass = makePass({ draws: [makeDraw(), makeDraw(), makeDraw()] });
    const result = computeOverdrawSync([pass], 1);
    assert.equal(result.maxCount, 3);
    assert.ok(result.counts.every((c) => c === 3));
});

test("overdraw: a partial triangle only counts covered pixels", () => {
    // NDC (-1,-1),(1,-1),(-1,1) projects to fb (0,4),(4,4),(0,0): the lower-left
    // half of the target, hypotenuse from (0,0) to (4,4). A pixel center is
    // inside iff cx <= cy, i.e. x <= y (centers exactly on the edge count).
    const draw = makeDraw({
        getVertex: makeGetVertex([[-1, -1, 0.5, 1], [1, -1, 0.5, 1], [-1, 1, 0.5, 1]]),
    });
    const result = computeOverdrawSync([makePass({ draws: [draw] })], 1);
    assert.deepEqual(countGrid(result), [
        [1, 0, 0, 0],
        [1, 1, 0, 0],
        [1, 1, 1, 0],
        [1, 1, 1, 1],
    ]);
});

test("overdraw: instances each count", () => {
    const pass = makePass({ draws: [makeDraw({ instanceCount: 3 })] });
    const result = computeOverdrawSync([pass], 1);
    assert.ok(result.counts.every((c) => c === 3));
});

test("overdraw: face culling removes fragments", () => {
    const front = computeOverdrawSync([makePass({ draws: [makeDraw({ cullMode: "front" })] })], 1);
    assert.equal(front.maxCount, 0);
    const back = computeOverdrawSync([makePass({ draws: [makeDraw({ cullMode: "back" })] })], 1);
    assert.equal(back.maxCount, 1);
});

test("overdraw: scissor limits the counted region", () => {
    const draw = makeDraw({ scissor: { x: 0, y: 0, w: 2, h: HEIGHT } });
    const result = computeOverdrawSync([makePass({ draws: [draw] })], 1);
    for (let y = 0; y < HEIGHT; ++y) {
        for (let x = 0; x < WIDTH; ++x) {
            assert.equal(result.counts[y * WIDTH + x], x < 2 ? 1 : 0, `pixel (${x}, ${y})`);
        }
    }
});

test("overdraw: viewport maps and clips the draw", () => {
    const draw = makeDraw({ viewport: { x: 2, y: 0, w: 2, h: 2, minDepth: 0, maxDepth: 1 } });
    const result = computeOverdrawSync([makePass({ draws: [draw] })], 1);
    assert.deepEqual(countGrid(result), [
        [0, 0, 1, 1],
        [0, 0, 1, 1],
        [0, 0, 0, 0],
        [0, 0, 0, 0],
    ]);
});

test("overdraw: depth-clipped fragments are not counted", () => {
    const positions = FULLSCREEN.positions.map((p) => [p[0], p[1], 2, 1]); // ndc z = 2
    const clipped = computeOverdrawSync([makePass({ draws: [makeDraw({ getVertex: makeGetVertex(positions) })] })], 1);
    assert.equal(clipped.maxCount, 0);
    const unclipped = computeOverdrawSync([makePass({ draws: [makeDraw({ getVertex: makeGetVertex(positions), unclippedDepth: true })] })], 1);
    assert.equal(unclipped.maxCount, 1);
});

test("overdraw: degenerate triangles are not counted", () => {
    const draw = makeDraw({ getVertex: makeGetVertex([[-1, -1, 0.5, 1], [-1, -1, 0.5, 1], [-1, 3, 0.5, 1]]) });
    const result = computeOverdrawSync([makePass({ draws: [draw] })], 1);
    assert.equal(result.maxCount, 0);
});

test("overdraw: fully-behind (w <= 0) primitives are skipped", () => {
    const positions = FULLSCREEN.positions.map((p) => [p[0], p[1], 0.5, -1]);
    const result = computeOverdrawSync([makePass({ draws: [makeDraw({ getVertex: makeGetVertex(positions) })] })], 1);
    assert.equal(result.maxCount, 0);
});

test("overdraw: triangles crossing w=0 are clipped and counted", () => {
    // A "wall": left edge spans the target, apex behind the camera (w = -1).
    // After near-w clipping the visible part covers the whole target.
    const positions = [[-1, -3, 0, 1], [-1, 3, 0, 1], [3, 0, 0, -1]];
    const result = computeOverdrawSync([makePass({ draws: [makeDraw({ getVertex: makeGetVertex(positions) })] })], 1);
    assert.ok(result.counts.every((c) => c === 1), `counts: ${Array.from(result.counts)}`);
});

test("overdraw: erroring draws are skipped and reported", () => {
    const pass = makePass({ draws: [makeDraw({ error: "Indirect draws are not supported by pixel history." }), makeDraw()] });
    const result = computeOverdrawSync([pass], 1);
    assert.equal(result.skippedDraws, 1);
    assert.equal(result.maxCount, 1);
    assert.ok(result.notes.some((n) => n.includes("Indirect draws")));
});

test("overdraw: passes not targeting the texture are ignored", () => {
    const other = makePass({ colorAttachments: [{ textureId: 2, slot: 0, loadOp: "clear", clearValue: [0, 0, 0, 1], storeOp: "store" }], draws: [makeDraw()] });
    const target = makePass({ draws: [makeDraw()] });
    const result = computeOverdrawSync([other, target], 1);
    assert.ok(result.counts.every((c) => c === 1));
});

test("overdraw: no pass targets the texture", () => {
    const result = computeOverdrawSync([makePass({ draws: [makeDraw()] })], 99);
    assert.equal(result.width, 0);
    assert.equal(result.height, 0);
    assert.equal(result.maxCount, 0);
});

test("overdraw: depth-stencil attachments count as targets", () => {
    const pass = makePass({
        colorAttachments: [],
        depthStencil: { textureId: 5, depthLoadOp: "clear", depthClearValue: 1 },
        draws: [makeDraw()],
    });
    const result = computeOverdrawSync([pass], 5);
    assert.ok(result.counts.every((c) => c === 1));
});

test("overdraw: unevaluable vertices are skipped with a note", () => {
    const draw = makeDraw({ getVertex: () => null });
    const result = computeOverdrawSync([makePass({ draws: [draw] })], 1);
    assert.equal(result.maxCount, 0);
    assert.ok(result.notes.some((n) => n.includes("vertex shader")));
});

test("overdraw: frag_depth output adds a note", () => {
    const draw = makeDraw({ fsOutputs: [{ name: "depth", locationType: "builtin", location: "frag_depth" }] });
    const result = computeOverdrawSync([makePass({ draws: [draw] })], 1);
    assert.equal(result.maxCount, 1);
    assert.ok(result.notes.some((n) => n.includes("frag_depth")));
});

test("overdraw: the generator reports monotonic progress per instance", () => {
    const pass = makePass({ draws: [makeDraw({ instanceCount: 4 })] });
    const it = computeOverdraw([pass], 1);
    const progress = [];
    let r = it.next();
    while (!r.done) {
        progress.push(r.value.progress);
        r = it.next();
    }
    assert.deepEqual(progress, [0.25, 0.5, 0.75, 1]);
    assert.ok(r.value.counts.every((c) => c === 4));
});
