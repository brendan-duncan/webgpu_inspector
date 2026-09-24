// Unit tests for the CPU side of the per-draw overlays
// (src/devtools/draw_overlay.js): wireframe index generation, draw argument
// resolution, viewport state and the draw list.
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    buildWireframeIndices,
    collectTargetDraws,
    resolveDrawArgs,
    viewportState,
} from "../../src/devtools/draw_overlay.js";

const edges = (indices) => {
    const out = [];
    for (let i = 0; i < indices.length; i += 2) {
        out.push([indices[i], indices[i + 1]]);
    }
    return out;
};

test("wireframe: a non-indexed triangle list gives three edges per triangle", () => {
    const indices = buildWireframeIndices({
        topology: "triangle-list",
        drawArgs: { indexed: false, count: 6, first: 10 },
    });
    assert.deepEqual(edges(indices), [[10, 11], [11, 12], [12, 10], [13, 14], [14, 15], [15, 13]]);
});

test("wireframe: indexed draws read the captured uint16 indices at firstIndex", () => {
    const data = new Uint16Array([9, 9, 0, 1, 2, 2, 1, 3]);
    const indices = buildWireframeIndices({
        topology: "triangle-list",
        drawArgs: { indexed: true, count: 6, first: 2 },
        indexBytes: new Uint8Array(data.buffer),
        indexFormat: "uint16",
    });
    assert.deepEqual(edges(indices), [[0, 1], [1, 2], [2, 0], [2, 1], [1, 3], [3, 2]]);
});

test("wireframe: indexed draws past the captured bytes give null", () => {
    const indices = buildWireframeIndices({
        topology: "triangle-list",
        drawArgs: { indexed: true, count: 30, first: 0 },
        indexBytes: new Uint8Array(12),
        indexFormat: "uint32",
    });
    assert.equal(indices, null);
});

test("wireframe: a triangle strip honors primitive restart", () => {
    const data = new Uint32Array([0, 1, 2, 3, 0xffffffff, 4, 5, 6]);
    const indices = buildWireframeIndices({
        topology: "triangle-strip",
        drawArgs: { indexed: true, count: 8, first: 0 },
        indexBytes: new Uint8Array(data.buffer),
        indexFormat: "uint32",
    });
    const set = new Set(edges(indices).map(([a, b]) => `${Math.min(a, b)}-${Math.max(a, b)}`));
    // Strip 0,1,2,3: triangles 012 and 123. Strip 4,5,6: triangle 456.
    for (const e of ["0-1", "1-2", "0-2", "2-3", "1-3", "4-5", "5-6", "4-6"]) {
        assert.ok(set.has(e), `missing edge ${e}`);
    }
    assert.ok(!set.has("3-4"), "restart must break the strip");
});

test("wireframe: line strips become line lists; points have no edges", () => {
    const indices = buildWireframeIndices({ topology: "line-strip", drawArgs: { indexed: false, count: 3, first: 0 } });
    assert.deepEqual(edges(indices), [[0, 1], [1, 2]]);
    assert.equal(buildWireframeIndices({ topology: "point-list", drawArgs: { indexed: false, count: 3, first: 0 } }), null);
});

test("draw args: direct and indirect draws", () => {
    assert.deepEqual(resolveDrawArgs({ method: "draw", args: [3] }),
        { indexed: false, count: 3, instanceCount: 1, first: 0, baseVertex: 0, firstInstance: 0 });
    assert.deepEqual(resolveDrawArgs({ method: "drawIndexed", args: [6, 2, 3, -1, 4] }),
        { indexed: true, count: 6, instanceCount: 2, first: 3, baseVertex: -1, firstInstance: 4 });

    const indirect = new ArrayBuffer(36);
    const view = new DataView(indirect);
    // 16 bytes of padding, then drawIndexedIndirect args at offset 16.
    [12, 1, 6].forEach((v, i) => view.setUint32(16 + i * 4, v, true));
    view.setInt32(28, -2, true);
    view.setUint32(32, 5, true);
    const plan = {
        method: "drawIndexedIndirect",
        args: [{ __id: 1 }, 16],
        indirect: { bufferId: 1, offset: 16 },
        command: { bufferData: [new Uint8Array(indirect)] },
    };
    assert.deepEqual(resolveDrawArgs(plan), { indexed: true, count: 12, instanceCount: 1, first: 6, baseVertex: -2, firstInstance: 5 });
    assert.equal(resolveDrawArgs({ ...plan, command: {} }), null, "uncaptured indirect args");
});

test("viewport state: the last viewport and scissor set before the draw", () => {
    const draw = { method: "draw", args: [3] };
    const commands = [
        { method: "setViewport", args: [0, 0, 100, 100, 0, 1] },
        { method: "setScissorRect", args: [10, 10, 20, 20] },
        { method: "setViewport", args: [5, 5, 50, 50, 0, 1] },
        draw,
        { method: "setScissorRect", args: [0, 0, 1, 1] },
    ];
    assert.deepEqual(viewportState(commands, draw), { viewport: [5, 5, 50, 50, 0, 1], scissor: [10, 10, 20, 20] });
});

test("draw list: only passes rendering to the target, labeled per pass", () => {
    const target = { id: 10 };
    const other = { id: 11 };
    const textures = { 20: target, 21: other };
    const getTextureFromAttachment = (a) => textures[a.view.__id] ?? null;
    const commands = [
        { method: "beginRenderPass", args: [{ label: "shadow", colorAttachments: [{ view: { __id: 21 } }] }], _passIndex: 0 },
        { method: "draw", args: [3] },
        { method: "end", args: [] },
        { method: "beginRenderPass", args: [{ colorAttachments: [], depthStencilAttachment: { view: { __id: 20 } } }], _passIndex: 1 },
        { method: "setPipeline", args: [{ __id: 40 }] },
        { method: "draw", args: [3] },
        { method: "drawIndexed", args: [6] },
        { method: "end", args: [] },
    ];
    const draws = collectTargetDraws(commands, target, getTextureFromAttachment);
    assert.equal(draws.length, 2);
    assert.equal(draws[0].command, commands[5]);
    assert.equal(draws[1].indexInPass, 1);
    assert.equal(draws[1].label, "Pass 1 drawIndexed #2");
    assert.equal(draws[1].passCommands.length, 3);
});
