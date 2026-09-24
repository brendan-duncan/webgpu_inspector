// Unit tests for the shader debugger's CPU-vs-GPU check
// (src/devtools/shader_gpu_compare.js), CPU side.
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { WgslReflect } from "wgsl_reflect/wgsl_reflect.module.js";
import { compareOutputs, cpuFragmentOutputs, cpuVertexOutputs, outputsByKey } from "../../src/devtools/shader_gpu_compare.js";

const VS = `
struct VOut { @builtin(position) pos : vec4f, @location(0) uv : vec2f, @location(1) id : u32 };
@vertex fn vs(@location(0) p : vec3f, @builtin(vertex_index) vi : u32) -> VOut {
    var o : VOut;
    o.pos = vec4f(p * 2.0, 1.0);
    o.uv = p.xy;
    o.id = vi;
    return o;
}`;

const FS = `
@fragment fn fs(@builtin(position) p : vec4f) -> @location(0) vec4f {
    if (p.x < 1.0) {
        discard;
    }
    return vec4f(p.x / 100.0, p.y / 100.0, 0.25, 1.0);
}`;

test("gpu compare: outputs are keyed by builtin or location", () => {
    const entry = new WgslReflect(VS).entry.vertex[0];
    const out = outputsByKey({ pos: [1, 2, 3, 1], uv: new Float32Array([0.5, 0.25]), id: 7 }, entry.outputs);
    assert.deepEqual([...out.keys()], ["position", "@location(0)", "@location(1)"]);
    assert.deepEqual(out.get("@location(0)").value, [0.5, 0.25]);
    assert.deepEqual(out.get("@location(1)"), { name: "id", value: [7] });
    // A bare return is the entry point's one output.
    const bare = outputsByKey([0, 0, 0, 1], [{ name: "", locationType: "builtin", location: "position" }]);
    assert.deepEqual([...bare.keys()], ["position"]);
});

test("gpu compare: comparison tolerates float noise but not real differences", () => {
    const cpu = new Map([["position", { name: "pos", value: [1, 2, 3, 1] }], ["@location(0)", { name: "uv", value: [0.5, 0.5] }]]);
    const gpu = new Map([["position", { name: "pos", value: [1.0000001, 2, 3, 1] }], ["@location(0)", { name: "uv", value: [0.5, 0.75] }]]);
    const rows = compareOutputs(cpu, gpu);
    assert.deepEqual(rows.map((r) => [r.key, r.match]), [["position", true], ["@location(0)", false]]);
    // An output only one side has is shown, but not judged.
    const partial = compareOutputs(cpu, new Map());
    assert.deepEqual(partial.map((r) => r.match), [null, null]);
});

test("gpu compare: the CPU vertex run returns every output", () => {
    const entry = new WgslReflect(VS).entry.vertex[0];
    const out = cpuVertexOutputs({ code: VS, entry, inputs: { 0: [0.25, 0.5, 1], vertex_index: 3, instance_index: 0 }, bindGroups: {} });
    assert.deepEqual(out.get("position").value, [0.5, 1, 2, 1]);
    assert.deepEqual(out.get("@location(0)").value, [0.25, 0.5]);
    assert.deepEqual(out.get("@location(1)").value, [3]);
});

test("gpu compare: the CPU fragment run reports the picked lane's output and discard", () => {
    const entry = new WgslReflect(FS).entry.fragment[0];
    const lane = (x, y) => ({ position: [x + 0.5, y + 0.5, 0.5, 1] });
    const quad = [lane(10, 20), lane(11, 20), lane(10, 21), lane(11, 21)];
    const r = cpuFragmentOutputs({ code: FS, entry, quadInputs: quad, bindGroups: {}, targetLane: 3 });
    assert.equal(r.discarded, false);
    assert.deepEqual(r.outputs.get("@location(0)").value.map((v) => Number(v.toFixed(4))), [0.115, 0.215, 0.25, 1]);

    const edge = [lane(0, 0), lane(1, 0), lane(0, 1), lane(1, 1)];
    assert.equal(cpuFragmentOutputs({ code: FS, entry, quadInputs: edge, bindGroups: {}, targetLane: 0 }).discarded, true);
});
