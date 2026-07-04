// Unit tests for the rasterization harness (src/devtools/fragment_debug.js),
// currently focused on near-w triangle clipping.
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { clipTriangleToNearW, W_CLIP_EPSILON } from "../../src/devtools/fragment_debug.js";

function v(x, y, z, w, varying) {
    return { position: [x, y, z, w], varyings: varying === undefined ? {} : { 0: varying } };
}

function closeTo(actual, expected, eps = 1e-4) {
    assert.ok(Math.abs(actual - expected) < eps, `${actual} !~= ${expected}`);
}

test("clipTriangleToNearW: fully in front is returned unchanged", () => {
    const v0 = v(0, 0, 0, 1);
    const v1 = v(1, 0, 0, 1);
    const v2 = v(0, 1, 0, 1);
    const tris = clipTriangleToNearW(v0, v1, v2);
    assert.equal(tris.length, 1);
    assert.deepEqual(tris[0], [v0, v1, v2]); // same vertex objects, no copies
});

test("clipTriangleToNearW: fully behind is dropped", () => {
    assert.deepEqual(clipTriangleToNearW(v(0, 0, 0, -1), v(1, 0, 0, 0), v(0, 1, 0, -2)), []);
});

test("clipTriangleToNearW: one vertex behind yields a quad (two triangles)", () => {
    const v0 = v(0, 0, 0, 1, 10);
    const v1 = v(2, 0, 0, 1, 20);
    const v2 = v(0, 2, 0, -1, 30);
    const tris = clipTriangleToNearW(v0, v1, v2);
    assert.equal(tris.length, 2);
    for (const tri of tris) {
        for (const vert of tri) {
            assert.ok(vert.position[3] > 0, "every clipped vertex must be projectable");
        }
    }
    // The clip points sit halfway along the crossing edges (w: 1 -> -1), so
    // positions and varyings interpolate at t ~= 0.5.
    const clipVerts = tris.flat().filter((vert) => vert !== v0 && vert !== v1);
    assert.equal(new Set(clipVerts).size, 2);
    const varyings = clipVerts.map((vert) => vert.varyings[0]).sort((a, b) => a - b);
    closeTo(varyings[0], 20); // v2 -> v0 midpoint: 30 + 0.5 * (10 - 30)
    closeTo(varyings[1], 25); // v1 -> v2 midpoint: 20 + 0.5 * (30 - 20)
    for (const vert of clipVerts) {
        closeTo(vert.position[3], W_CLIP_EPSILON, 1e-6);
    }
});

test("clipTriangleToNearW: two vertices behind yields one triangle", () => {
    const v0 = v(0, 0, 0, 1, 10);
    const v1 = v(2, 0, 0, -1, 20);
    const v2 = v(0, 2, 0, -1, 30);
    const tris = clipTriangleToNearW(v0, v1, v2);
    assert.equal(tris.length, 1);
    assert.ok(tris[0].includes(v0));
    for (const vert of tris[0]) {
        assert.ok(vert.position[3] > 0);
    }
});

test("clipTriangleToNearW: vector varyings interpolate componentwise", () => {
    const v0 = { position: [0, 0, 0, 1], varyings: { 2: [0, 8] } };
    const v1 = { position: [1, 0, 0, 1], varyings: { 2: [4, 8] } };
    const v2 = { position: [0, 1, 0, -1], varyings: { 2: [8, 0] } };
    const tris = clipTriangleToNearW(v0, v1, v2);
    const clipVerts = tris.flat().filter((vert) => vert !== v0 && vert !== v1);
    for (const vert of clipVerts) {
        assert.equal(vert.varyings[2].length, 2);
        for (const c of vert.varyings[2]) {
            assert.ok(Number.isFinite(c));
        }
    }
    // v0 -> v2 midpoint: [4, 4].
    const fromV0 = clipVerts.find((vert) => Math.abs(vert.varyings[2][0] - 4) < 1e-3 && Math.abs(vert.varyings[2][1] - 4) < 1e-3);
    assert.ok(fromV0, `expected a [4, 4] clip vertex, got ${JSON.stringify(clipVerts.map((x) => x.varyings[2]))}`);
});
