// Unit tests for VS Out shader generation (src/devtools/vs_out.js).
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { WgslReflect } from "wgsl_reflect/wgsl_reflect.module.js";
import {
    buildVsOutShader,
    clipStats,
    demoteVertexEntryPoint,
    packVsInputs,
    parseIoType,
    unpackVsOutputs,
} from "../../src/devtools/vs_out.js";

const SHADER = `
struct VIn {
    @location(0) pos : vec3f,
    @location(2) uv : vec2<f32>,
    @builtin(instance_index) inst : u32,
};
struct VOut {
    @builtin(position) pos : vec4f,
    @location(0) @interpolate(flat) id : u32,
    @location(1) uv : vec2f,
};
@group(0) @binding(0) var<uniform> mvp : mat4x4f;
@group(1) @binding(0) var tex : texture_2d<f32>;

@vertex
fn vsMain(v : VIn, @builtin(vertex_index) vi : u32) -> VOut {
    var o : VOut;
    o.pos = mvp * vec4f(v.pos, 1.0);
    o.id = vi + v.inst;
    o.uv = v.uv;
    return o;
}

@fragment fn fsMain(@location(1) uv : vec2f) -> @location(0) vec4f {
    return textureLoad(tex, vec2i(uv), 0);
}
`;

function entryOf(code, name) {
    return new WgslReflect(code).entry.vertex.find((e) => e.name === name);
}

test("vs out: parseIoType", () => {
    assert.deepEqual(parseIoType("vec3f"), { scalar: "f32", components: 3 });
    assert.deepEqual(parseIoType("vec2<u32>"), { scalar: "u32", components: 2 });
    assert.deepEqual(parseIoType("vec4h"), { scalar: "f16", components: 4 });
    assert.deepEqual(parseIoType("i32"), { scalar: "i32", components: 1 });
    assert.equal(parseIoType("mat4x4f"), null);
});

test("vs out: demoting the entry point strips @vertex and signature IO attributes only", () => {
    const out = demoteVertexEntryPoint(SHADER, "vsMain");
    const reflect = new WgslReflect(out);
    assert.deepEqual(reflect.entry.vertex.map((e) => e.name), [], "vsMain is no longer an entry point");
    assert.deepEqual(reflect.entry.fragment.map((e) => e.name), ["fsMain"], "other entry points are untouched");
    assert.match(out, /fn vsMain\(v : VIn,\s+vi : u32\) -> VOut/);
    // Struct member attributes stay.
    assert.match(out, /@builtin\(position\) pos : vec4f/);
    assert.throws(() => demoteVertexEntryPoint(SHADER, "missing"), /not found/);
});

test("vs out: the generated compute shader calls the vertex function per element", () => {
    const entry = entryOf(SHADER, "vsMain");
    const layout = buildVsOutShader({
        code: SHADER,
        entry,
        declaredBindings: [{ group: 0, binding: 0 }, { group: 1, binding: 0 }],
        usedBindings: new Set(["0:0"]),
    });
    // Group 1 is declared (by the fragment shader) but unused by the vertex stage.
    assert.equal(layout.group, 1);
    assert.deepEqual([layout.inBinding, layout.outBinding], [1, 2]);
    // vertex_index, instance_index, then pos (3) and uv (2) by location.
    assert.deepEqual(layout.inputs.map((i) => [i.location, i.components, i.offset]), [[0, 3, 2], [2, 2, 5]]);
    assert.equal(layout.inStride, 7);
    assert.deepEqual(layout.outputs.map((o) => [o.name, o.builtin, o.location, o.components, o.offset]),
        [["pos", "position", null, 4, 0], ["id", null, 0, 1, 4], ["uv", null, 1, 2, 5]]);
    assert.equal(layout.outStride, 7);

    const reflect = new WgslReflect(layout.code);
    assert.deepEqual(reflect.entry.compute.map((e) => e.name), ["_vsOutMain"]);
    assert.match(layout.code, /let _r = vsMain\(VIn\(vec3f\(bitcast<f32>\(_vsIn\[_base \+ 2u\]\)/);
    assert.match(layout.code, /_vsIn\[_base \+ 1u\]\), _vsIn\[_base\]\);/, "instance_index member and vertex_index argument");
    assert.match(layout.code, /_vsOut\[_o \+ 4u\] = _r\.id;/);
});

test("vs out: a bare position return and a group-0-only shader", () => {
    const code = `@vertex fn vs(@location(0) p : vec4f) -> @builtin(position) vec4f { return p; }`;
    const layout = buildVsOutShader({ code, entry: entryOf(code, "vs"), declaredBindings: [], usedBindings: new Set() });
    assert.equal(layout.group, 0);
    assert.deepEqual(layout.outputs.map((o) => [o.name, o.builtin]), [["position", "position"]]);
    assert.match(layout.code, /_vsOut\[_o \+ 3u\] = bitcast<u32>\(f32\(_r\[3\]\)\);/);
    assert.equal(new WgslReflect(layout.code).entry.vertex.length, 0);
});

test("vs out: packing conforms inputs and unpacking reads outputs back", () => {
    const layout = {
        inStride: 6,
        inputs: [{ location: 0, scalar: "f32", components: 4, offset: 2 }],
        outStride: 2,
        outputs: [{ name: "a", builtin: null, location: 0, scalar: "f32", components: 1, offset: 0 },
                  { name: "b", builtin: null, location: 1, scalar: "i32", components: 1, offset: 1 }],
    };
    const mesh = {
        count: 2,
        vertexIndices: new Int32Array([7, 9]),
        attributes: [{ location: 0, components: 3 }],
        values: [new Float64Array([1, 2, 3, 4, 5, NaN])],
    };
    const words = packVsInputs(mesh, layout, 3);
    const f32 = new Float32Array(words.buffer);
    assert.deepEqual([words[0], words[1]], [7, 3]);
    assert.deepEqual([...f32.subarray(2, 6)], [1, 2, 3, 1], "w defaults to 1");
    assert.deepEqual([...f32.subarray(8, 12)], [4, 5, 0, 1], "NaN packs as 0");

    const out = new Uint32Array(4);
    new Float32Array(out.buffer)[0] = 0.5;
    new Int32Array(out.buffer)[3] = -4;
    const { attributes, values } = unpackVsOutputs(out, layout, 2);
    assert.deepEqual(attributes.map((a) => a.format), ["float32x1", "sint32x1"]);
    assert.equal(values[0][0], 0.5);
    assert.equal(values[1][1], -4);
});

test("vs out: clip statistics", () => {
    const clip = new Float64Array([
        0, 0, 0.5, 1,      // inside
        2, 0, 0.5, 1,      // outside +x
        3, 0, 0.5, 1,      // outside +x
        2.5, 1, 0.5, 1,    // outside +x
        0, 0, 0.5, -1,     // behind the eye
        NaN, 0, 0, 1,      // NaN
        0, 0, 0.5, 1,      // same point as element 0
    ]);
    const vertexIndices = new Int32Array([0, 1, 2, 3, 4, 5, 6]);
    const stats = clipStats(clip, vertexIndices, new Uint32Array([1, 2, 3, 0, 6, 0, 0, 1, 5]));
    assert.equal(stats.nan, 1);
    assert.equal(stats.behind, 1);
    assert.equal(stats.outside, 4, "three past +x and the one behind the eye");
    assert.equal(stats.culledTriangles, 1);
    assert.equal(stats.zeroArea, 1);
});
