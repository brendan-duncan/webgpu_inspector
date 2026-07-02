// Unit tests for vertex attribute fetching and shader-type conformance
// (src/devtools/vertex_fetcher.js). Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { conformVertexInput, fetchVertexInputs } from "../../src/devtools/vertex_fetcher.js";

test("conformVertexInput expands a vec3 to a declared vec4 with w=1", () => {
    assert.deepEqual(conformVertexInput([1, 2, 3], { name: "vec4f" }), [1, 2, 3, 1]);
});

test("conformVertexInput expands a scalar to a declared vector", () => {
    assert.deepEqual(conformVertexInput(5, { name: "vec4f" }), [5, 0, 0, 1]);
    assert.deepEqual(conformVertexInput(5, { name: "vec2f" }), [5, 0]);
});

test("conformVertexInput truncates extra components", () => {
    assert.deepEqual(conformVertexInput([1, 2, 3, 4], { name: "vec2f" }), [1, 2]);
    assert.equal(conformVertexInput([1, 2, 3], { name: "f32" }), 1);
});

test("conformVertexInput handles template-style type names", () => {
    assert.deepEqual(conformVertexInput([1, 2], { name: "vec3" }), [1, 2, 0]);
});

test("conformVertexInput leaves values alone without type info", () => {
    assert.deepEqual(conformVertexInput([1, 2, 3], null), [1, 2, 3]);
    assert.deepEqual(conformVertexInput([1, 2, 3], undefined), [1, 2, 3]);
});

test("fetchVertexInputs conforms attributes to the shader's declared inputs", () => {
    const pipelineDesc = {
        vertex: {
            buffers: [{
                arrayStride: 12,
                attributes: [{ shaderLocation: 0, offset: 0, format: "float32x3" }],
            }],
        },
    };
    const data = new Float32Array([1, 2, 3, 4, 5, 6]);
    const shaderInputs = [{ locationType: "location", location: 0, type: { name: "vec4f" } }];

    const inputs = fetchVertexInputs(pipelineDesc, [data], 1, 0, shaderInputs);
    assert.deepEqual(inputs[0], [4, 5, 6, 1]);
    assert.equal(inputs.vertex_index, 1);

    // Without shader inputs the raw format-sized value passes through.
    const raw = fetchVertexInputs(pipelineDesc, [data], 1, 0);
    assert.deepEqual(raw[0], [4, 5, 6]);
});
