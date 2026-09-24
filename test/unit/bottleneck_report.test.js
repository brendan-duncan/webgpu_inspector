// Unit tests for the GPU Bottlenecks statistics and rules
// (src/devtools/bottleneck_report.js), without the GPU measurement.
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { analyzePasses, collectPassStats } from "../../src/devtools/bottleneck_report.js";

const ref = (id) => ({ __id: id });

function world() {
    const objects = new Map();
    const add = (o) => { objects.set(o.id, o); return o; };
    add({ id: 1, code: "@fragment fn fs() -> @location(0) vec4f { if (true) { discard; } return vec4f(1.0); }" });
    add({ id: 2, code: "@fragment fn fs() -> @location(0) vec4f { return vec4f(1.0); }" });
    add({ id: 40, descriptor: { primitive: { topology: "triangle-list" }, fragment: { module: ref(1), targets: [{ format: "rgba16float" }] }, depthStencil: { format: "depth24plus" } } });
    add({ id: 41, descriptor: { primitive: { topology: "triangle-strip" }, fragment: { module: ref(2), targets: [{ format: "rgba8unorm", blend: {} }] } } });
    const textures = {
        20: { id: 10, width: 100, height: 100, sampleCount: 1, format: "rgba16float" },
        21: { id: 11, width: 100, height: 100, sampleCount: 1, format: "depth24plus" },
    };
    return {
        getObject: (id) => objects.get(id) ?? null,
        getTextureFromAttachment: (a) => textures[a.view.__id] ?? null,
    };
}

function frame() {
    const R = (object, method, args) => ({ class: "GPURenderPassEncoder", object, method, args });
    return [
        { class: "GPUDevice", object: 0, method: "createCommandEncoder", args: [], result: 100 },
        { class: "GPUCommandEncoder", object: 100, method: "beginRenderPass", result: 101, duration: 3,
          args: [{ label: "opaque", colorAttachments: [{ view: ref(20) }], depthStencilAttachment: { view: ref(21) } }] },
        R(101, "setPipeline", [ref(40)]),
        R(101, "draw", [30000, 2]),                        // 20,000 triangles
        R(101, "end", []),
        { class: "GPUCommandEncoder", object: 100, method: "beginRenderPass", result: 102, duration: 1,
          args: [{ label: "ui", colorAttachments: [{ view: ref(20) }] }] },
        R(102, "setPipeline", [ref(41)]),
        R(102, "draw", [4]),                               // a 2-triangle strip
        R(102, "end", []),
        { class: "GPUCommandEncoder", object: 100, method: "finish", args: [], result: 103 },
        { class: "GPUQueue", object: 2, method: "submit", args: [[ref(103)]] },
    ];
}

test("bottlenecks: pass statistics from the capture", () => {
    const passes = collectPassStats(frame(), world());
    assert.equal(passes.length, 2);
    const [opaque, ui] = passes;
    assert.equal(opaque.primitives, 20000);
    assert.equal(opaque.bytesPerPixel, 8 + 4);
    assert.deepEqual([...opaque.lateDepth], ["discard"]);
    assert.equal(opaque.durationMs, 3);
    assert.equal(ui.primitives, 2);
    assert.equal(ui.blending, true);
    assert.equal(ui.lateDepth.size, 0, "discard only matters with a depth test");
});

test("bottlenecks: the rules find tiny triangles, overdraw and shade-then-reject", () => {
    const passes = collectPassStats(frame(), world());
    const [opaque, ui] = passes;
    // 10,000 pixels. The opaque pass rasterizes 60,000 fragments (6x overdraw,
    // 3 px per triangle) and 80% of them fail the depth test or are discarded.
    opaque.rasterized = 60000;
    opaque.survived = 12000;
    ui.rasterized = 2000;
    ui.survived = 2000;
    const { issues } = analyzePasses(passes);
    const titles = issues.filter((f) => f.pass === opaque).map((f) => f.title);
    assert.ok(titles.includes("Tiny triangles"));
    assert.ok(titles.includes("High overdraw"));
    assert.ok(titles.includes("Shaded, then rejected"));
    assert.equal(opaque.share, 0.75);
    assert.ok(Math.abs(opaque.rejected - 0.8) < 1e-9);
    assert.equal(ui.findings.length, 0);
    assert.equal(ui.verdict, "Nothing stands out");
    assert.equal(issues[0].severity, "high");
});

test("bottlenecks: without measurements only capture-derived findings remain", () => {
    const passes = collectPassStats(frame(), world());
    const { issues } = analyzePasses(passes);
    assert.ok(issues.every((f) => f.title !== "High overdraw" && f.title !== "Tiny triangles"));
    assert.equal(passes[0].overdraw, null);
});
