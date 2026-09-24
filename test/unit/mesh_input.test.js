// Unit tests for the Mesh view's input model (src/devtools/mesh_input.js).
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    assemblePrimitives,
    attributeColors,
    attributePositions,
    buildMeshInput,
    filterPrimitives,
    guessPositionAttribute,
} from "../../src/devtools/mesh_input.js";

// Interleaved position (float32x3) + uv (unorm8x2, padded to 4 bytes): stride 16.
function interleaved(vertices) {
    const buffer = new ArrayBuffer(vertices.length * 16);
    const view = new DataView(buffer);
    vertices.forEach(([x, y, z, u, v], i) => {
        view.setFloat32(i * 16, x, true);
        view.setFloat32(i * 16 + 4, y, true);
        view.setFloat32(i * 16 + 8, z, true);
        view.setUint8(i * 16 + 12, u);
        view.setUint8(i * 16 + 13, v);
    });
    return new Uint8Array(buffer);
}

const pipelineDesc = (topology = "triangle-list", extraBuffers = []) => ({
    primitive: { topology },
    vertex: {
        buffers: [
            { arrayStride: 16, attributes: [
                { shaderLocation: 1, offset: 12, format: "unorm8x2" },
                { shaderLocation: 0, offset: 0, format: "float32x3" },
            ] },
            ...extraBuffers,
        ],
    },
});

const shaderInputs = [
    { name: "position", locationType: "location", location: 0 },
    { name: "uv", locationType: "location", location: 1 },
];

const quad = [[0, 0, 0, 0, 0], [1, 0, 0, 255, 0], [1, 1, 0, 255, 255], [0, 1, 0, 0, 255]];

test("mesh input: a non-indexed draw decodes attributes in location order", () => {
    const mesh = buildMeshInput({
        command: { method: "draw", args: [3, 1, 1] },
        pipelineDesc: pipelineDesc(),
        shaderInputs,
        vertexBufferCommands: [{ bufferData: [interleaved(quad)] }],
    });
    assert.equal(mesh.count, 3);
    assert.deepEqual([...mesh.vertexIndices], [1, 2, 3]);
    assert.deepEqual(mesh.attributes.map((a) => a.name), ["position", "uv"]);
    assert.deepEqual([...mesh.values[0].subarray(0, 3)], [1, 0, 0]);
    assert.deepEqual([...mesh.values[1].subarray(2, 4)], [1, 1]);
    assert.deepEqual(mesh.warnings, []);
});

test("mesh input: indexed draws apply firstIndex and baseVertex", () => {
    const indices = new Uint16Array([9, 0, 1, 2, 0, 2]);
    const mesh = buildMeshInput({
        command: { method: "drawIndexed", args: [3, 1, 1, 1] },
        pipelineDesc: pipelineDesc(),
        vertexBufferCommands: [{ bufferData: [interleaved(quad)] }],
        indexBufferCommand: { args: [{ __id: 5 }, "uint16"], bufferData: [new Uint8Array(indices.buffer)] },
    });
    assert.deepEqual([...mesh.vertexIndices], [1, 2, 3]);
    assert.deepEqual([...mesh.values[0].subarray(6, 9)], [0, 1, 0]);
});

test("mesh input: indices past the captured bytes are reported, not decoded", () => {
    const mesh = buildMeshInput({
        command: { method: "drawIndexed", args: [6] },
        pipelineDesc: pipelineDesc(),
        vertexBufferCommands: [{ bufferData: [interleaved(quad)] }],
        indexBufferCommand: { args: [{ __id: 5 }, "uint32"], bufferData: [new Uint8Array(new Uint32Array([0, 1, 2]).buffer)] },
    });
    assert.deepEqual([...mesh.vertexIndices].slice(3), [-2, -2, -2]);
    assert.ok(mesh.warnings.some((w) => /beyond the captured index buffer/.test(w)));
    assert.equal(assemblePrimitives(mesh).triangles.length, 3, "only the complete triangle");
});

test("mesh input: instance-stepped attributes read the chosen instance", () => {
    const offsets = new Float32Array([10, 20, 30, 40, 50, 60]);
    const mesh = buildMeshInput({
        command: { method: "draw", args: [3, 2] },
        pipelineDesc: pipelineDesc("triangle-list", [
            { arrayStride: 12, stepMode: "instance", attributes: [{ shaderLocation: 2, offset: 0, format: "float32x3" }] },
        ]),
        vertexBufferCommands: [{ bufferData: [interleaved(quad)] }, { bufferData: [null, new Uint8Array(offsets.buffer)] }],
        instance: 1,
    });
    assert.deepEqual([...mesh.values[2].subarray(0, 3)], [40, 50, 60]);
    assert.deepEqual([...mesh.values[2].subarray(6, 9)], [40, 50, 60]);
});

test("mesh input: missing vertex bytes leave NaN and a warning", () => {
    const mesh = buildMeshInput({
        command: { method: "draw", args: [3] },
        pipelineDesc: pipelineDesc(),
        vertexBufferCommands: [],
    });
    assert.ok(Number.isNaN(mesh.values[0][0]));
    assert.ok(mesh.warnings.some((w) => /slot 0 has no captured bytes/.test(w)));
    const { invalid, valid } = attributePositions(mesh, 0);
    assert.equal(invalid, 3);
    assert.deepEqual([...valid], [0, 0, 0]);
});

test("mesh input: triangle strips split at restart and keep winding", () => {
    const indices = new Uint32Array([0, 1, 2, 3, 0xffffffff, 0, 1, 2]);
    const mesh = buildMeshInput({
        command: { method: "drawIndexed", args: [8] },
        pipelineDesc: pipelineDesc("triangle-strip"),
        vertexBufferCommands: [{ bufferData: [interleaved(quad)] }],
        indexBufferCommand: { args: [{ __id: 5 }, "uint32"], bufferData: [new Uint8Array(indices.buffer)] },
    });
    assert.equal(mesh.vertexIndices[4], -1);
    const { triangles } = assemblePrimitives(mesh);
    // Elements 0..3 give two triangles (the second with swapped winding), 5..7 give one.
    assert.deepEqual([...triangles], [0, 1, 2, 2, 1, 3, 5, 6, 7]);
});

test("mesh input: position guess, colors and primitive filtering", () => {
    const mesh = buildMeshInput({
        command: { method: "draw", args: [3] },
        pipelineDesc: pipelineDesc(),
        shaderInputs,
        vertexBufferCommands: [{ bufferData: [interleaved(quad)] }],
    });
    assert.equal(guessPositionAttribute(mesh.attributes), 0);
    const colors = attributeColors(mesh, 1);
    // uv (0,0) -> black, (1,0) -> red, (1,1) -> yellow; the third channel is unused.
    assert.deepEqual([...colors], [0, 0, 0, 1, 0, 0, 1, 1, 0]);
    const { min, max } = attributePositions(mesh, 0);
    assert.deepEqual(min, [0, 0, 0]);
    assert.deepEqual(max, [1, 1, 0]);
    assert.deepEqual([...filterPrimitives(new Uint32Array([0, 1, 2, 1, 2, 3]), 3, new Uint8Array([1, 1, 1, 0]))], [0, 1, 2]);
});
