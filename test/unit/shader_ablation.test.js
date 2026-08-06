// Unit tests for the ablation source transformation
// (src/devtools/shader_ablation.js). The GPU side — that differencing the cut
// measurements actually recovers per-statement cost — is covered by
// test/browser/ablation_harness.html.
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    instrumentForAblation,
    attributeAblation,
    typeToWgsl,
} from "../../src/devtools/shader_ablation.js";
import { WgslParser } from "wgsl_reflect/wgsl_reflect.module.js";

const FRAGMENT_WGSL = `
struct U { base : u32 }
@group(0) @binding(0) var<uniform> u : U;

@fragment fn fsMain() -> @location(0) vec4f {
  var acc = 0.0;
  acc = acc + f32(u.base);
  return vec4f(acc, 0.0, 0.0, 1.0);
}
`;

const COMPUTE_WGSL = `
@group(0) @binding(0) var<storage, read_write> data : array<f32>;

@compute @workgroup_size(64)
fn csMain(@builtin(global_invocation_id) gid : vec3u) {
  var x = data[gid.x];
  x = sqrt(x);
  data[gid.x] = x;
}
`;

function parses(code) {
    try {
        new WgslParser().parse(code);
        return true;
    } catch (e) {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Type rendering
// ---------------------------------------------------------------------------

test("typeToWgsl renders plain and templated types", () => {
    assert.equal(typeToWgsl({ name: "f32" }), "f32");
    assert.equal(typeToWgsl({ name: "vec4f" }), "vec4f");
    assert.equal(typeToWgsl({ name: "vec4", format: { name: "f32" } }), "vec4<f32>");
    assert.equal(typeToWgsl({ name: "MyStruct" }), "MyStruct");
});

test("typeToWgsl refuses anything that isn't a safe identifier", () => {
    assert.equal(typeToWgsl(null), null);
    assert.equal(typeToWgsl({ name: "" }), null);
    // A name that isn't a bare identifier could inject arbitrary source.
    assert.equal(typeToWgsl({ name: "f32; @compute fn evil()" }), null);
});

// ---------------------------------------------------------------------------
// Instrumentation
// ---------------------------------------------------------------------------

test("instrumentation produces one cut point per top-level statement", () => {
    const result = instrumentForAblation(FRAGMENT_WGSL, { stage: "fragment", entryPoint: "fsMain" });
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.cutPoints.length, 3);
    assert.equal(result.fullCut, 3);
    assert.deepEqual(result.cutPoints.map((c) => c.label), [
        "var acc = 0.0;",
        "acc = acc + f32(u.base);",
        "return vec4f(acc, 0.0, 0.0, 1.0);",
    ]);
});

test("the instrumented shader is still valid WGSL", () => {
    const result = instrumentForAblation(FRAGMENT_WGSL, { stage: "fragment", entryPoint: "fsMain" });
    assert.ok(parses(result.code), `instrumented shader does not parse:\n${result.code}`);
});

test("a guard is emitted before every statement, using the return type's zero value", () => {
    const result = instrumentForAblation(FRAGMENT_WGSL, { stage: "fragment", entryPoint: "fsMain" });
    for (let i = 0; i < result.cutPoints.length; ++i) {
        assert.ok(result.code.includes(`cut == ${i}u`), `no guard for cut ${i}`);
    }
    // vec4f is the declared return type, so the early return must produce one.
    assert.ok(result.code.includes("return vec4f();"),
        `expected a zero-value return, got:\n${result.code}`);
});

test("the ablation uniform goes in a bind group the shader isn't using", () => {
    const result = instrumentForAblation(FRAGMENT_WGSL, { stage: "fragment", entryPoint: "fsMain" });
    // The shader occupies group 0, so the uniform must not.
    assert.equal(result.group, 1);
    assert.ok(result.code.includes(`@group(1) @binding(0) var<uniform>`));
});

test("avoidGroups keeps the uniform clear of groups only the layout declares", () => {
    // Reflection sees group 0 (the shader reads it). An explicit pipeline
    // layout can declare groups 0-2 that the shader never reads; putting the
    // ablation uniform in one of those would collide.
    const plain = instrumentForAblation(FRAGMENT_WGSL, { stage: "fragment", entryPoint: "fsMain" });
    assert.equal(plain.group, 1);

    const avoided = instrumentForAblation(FRAGMENT_WGSL, {
        stage: "fragment", entryPoint: "fsMain", avoidGroups: [0, 1, 2],
    });
    assert.equal(avoided.group, 3);
    assert.ok(avoided.code.includes("@group(3) @binding(0) var<uniform>"));
});

test("avoidGroups covering every group reports failure", () => {
    const result = instrumentForAblation(FRAGMENT_WGSL, {
        stage: "fragment", entryPoint: "fsMain", avoidGroups: [0, 1, 2, 3],
    });
    assert.equal(result.ok, false);
    assert.match(result.reason, /all 4 bind groups/);
});

test("a void compute entry point gets a bare return", () => {
    const result = instrumentForAblation(COMPUTE_WGSL, { stage: "compute", entryPoint: "csMain" });
    assert.equal(result.ok, true, result.reason);
    assert.ok(result.code.includes("return; }"), `expected a bare return, got:\n${result.code}`);
    assert.ok(parses(result.code));
    assert.equal(result.cutPoints.length, 3);
});

test("guards are inserted at statement boundaries, not inside statements", () => {
    // Splicing back-to-front matters: a front-to-back splice would shift every
    // later offset and land guards in the middle of statements.
    const result = instrumentForAblation(FRAGMENT_WGSL, { stage: "fragment", entryPoint: "fsMain" });
    assert.ok(parses(result.code));
    // Each original statement must survive intact.
    for (const label of ["var acc = 0.0;", "acc = acc + f32(u.base);"]) {
        assert.ok(result.code.includes(label), `statement was mangled: ${label}`);
    }
});

test("an ambiguous stage requires an explicit entry point", () => {
    const two = `
@fragment fn a() -> @location(0) vec4f { return vec4f(1.0); }
@fragment fn b() -> @location(0) vec4f { return vec4f(2.0); }
`;
    const ambiguous = instrumentForAblation(two, { stage: "fragment" });
    assert.equal(ambiguous.ok, false);
    assert.match(ambiguous.reason, /no single fragment entry point/i);

    const named = instrumentForAblation(two, { stage: "fragment", entryPoint: "b" });
    assert.equal(named.ok, true, named.reason);
});

test("a shader the parser rejects fails with a reason, not a throw", () => {
    // The WGSL parser is lenient, so this has to be something it genuinely
    // can't get through — a malformed argument list rather than plain garbage.
    const bad = instrumentForAblation("@fragment fn f( -> {", { stage: "fragment" });
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /could not be parsed/);
});

test("garbage the parser accepts still fails gracefully", () => {
    // "not wgsl {{{" parses to an AST with no entry points; the failure has to
    // come from the entry point lookup rather than an unhandled throw.
    const bad = instrumentForAblation("not wgsl {{{", { stage: "fragment" });
    assert.equal(bad.ok, false);
    assert.ok(bad.reason.length > 0);
});

test("a missing stage fails with a reason", () => {
    const missing = instrumentForAblation(FRAGMENT_WGSL, { stage: "compute" });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /no single compute entry point/i);

    const noStage = instrumentForAblation(FRAGMENT_WGSL, {});
    assert.equal(noStage.ok, false);
    assert.match(noStage.reason, /stage/i);
});

test("a shader using all four bind groups reports that it can't be instrumented", () => {
    let code = "";
    for (let g = 0; g < 4; ++g) {
        code += `@group(${g}) @binding(0) var<uniform> u${g} : vec4f;\n`;
    }
    code += `@fragment fn fsMain() -> @location(0) vec4f {
  var acc = u0 + u1 + u2 + u3;
  return acc;
}
`;
    const result = instrumentForAblation(code, { stage: "fragment", entryPoint: "fsMain" });
    assert.equal(result.ok, false);
    assert.match(result.reason, /all 4 bind groups/);
});

// ---------------------------------------------------------------------------
// Attribution
// ---------------------------------------------------------------------------

test("attribution differences consecutive cuts into per-statement cost", () => {
    const cutPoints = [
        { cut: 0, line: 1, label: "a" },
        { cut: 1, line: 2, label: "b" },
        { cut: 2, line: 3, label: "c" },
    ];
    // Cumulative: 0.01, 0.02, 0.50, 0.51 -> per statement 0.01, 0.48, 0.01
    const measurements = new Map([[0, 0.01], [1, 0.02], [2, 0.50], [3, 0.51]]);
    const result = attributeAblation(cutPoints, measurements, 3);

    assert.ok(Math.abs(result.statements[0].ms - 0.01) < 1e-9);
    assert.ok(Math.abs(result.statements[1].ms - 0.48) < 1e-9);
    assert.ok(Math.abs(result.statements[2].ms - 0.01) < 1e-9);
    assert.equal(result.baselineMs, 0.01);
    assert.equal(result.totalMs, 0.51);
});

test("negative differences are reported as noise, not silently clamped", () => {
    const cutPoints = [{ cut: 0, line: 1, label: "a" }, { cut: 1, line: 2, label: "b" }];
    // Statement `a` measures cheaper than nothing: pure noise.
    const measurements = new Map([[0, 0.05], [1, 0.048], [2, 0.30]]);
    const result = attributeAblation(cutPoints, measurements, 2);

    assert.ok(result.statements[0].ms < 0, "the negative value must survive, not be clamped to 0");
    assert.equal(result.statements[0].negative, true);
    assert.ok(result.notes.some((n) => /noise floor/.test(n)),
        "a negative measurement must be explained");
});

test("a dominant instrumentation baseline is called out", () => {
    const cutPoints = [{ cut: 0, line: 1, label: "a" }];
    // Half the total cost is spent before the first statement runs.
    const measurements = new Map([[0, 0.5], [1, 1.0]]);
    const result = attributeAblation(cutPoints, measurements, 1);
    assert.ok(result.notes.some((n) => /fixed overhead/.test(n)),
        `expected a baseline warning, got: ${result.notes.join(" | ")}`);
});

test("missing measurements yield a null cost rather than a wrong one", () => {
    const cutPoints = [{ cut: 0, line: 1, label: "a" }, { cut: 1, line: 2, label: "b" }];
    const measurements = new Map([[0, 0.01]]);  // cut 1 and 2 never measured
    const result = attributeAblation(cutPoints, measurements, 2);
    assert.equal(result.statements[0].ms, null);
    assert.equal(result.statements[1].ms, null);
});
