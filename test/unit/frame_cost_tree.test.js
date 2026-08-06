// Unit tests for the shader cost model and the frame cost tree
// (src/devtools/frame_cost_tree.js, shader_invocations.js, and the wgsl_reflect
// cost model behind them).
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildFrameCostTree, MS, OPS } from "../../src/devtools/frame_cost_tree.js";
import { collectFrameInvocations, workgroupSizeFor } from "../../src/devtools/shader_invocations.js";
import {
    buildShaderCostTree,
    mergeCostTree,
    rescaleCostTree,
    costByLine,
    walkCostTree,
} from "wgsl_reflect/wgsl_reflect.module.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VERTEX_FRAGMENT_WGSL = `
@group(0) @binding(0) var<uniform> mvp : mat4x4f;
@group(0) @binding(1) var tex : texture_2d<f32>;
@group(0) @binding(2) var samp : sampler;

@vertex
fn vsMain(@location(0) pos : vec3f) -> @builtin(position) vec4f {
  return mvp * vec4f(pos, 1.0);
}

@fragment
fn fsMain(@location(0) uv : vec2f) -> @location(0) vec4f {
  var acc = vec4f(0.0);
  for (var i = 0; i < 4; i = i + 1) {
    acc = acc + textureSample(tex, samp, uv);
  }
  return acc;
}
`;

const COMPUTE_WGSL = `
@group(0) @binding(0) var<storage, read_write> data : array<f32>;

@compute @workgroup_size(8, 4, 1)
fn csMain(@builtin(global_invocation_id) gid : vec3u) {
  data[gid.x] = sqrt(data[gid.x]);
}
`;

// A minimal stand-in for the devtools ShaderModule: the cost model only needs
// `code`, `id` and a `reflection` for the workgroup size lookup.
function makeShaderModule(id, code) {
    return {
        id,
        code,
        get reflection() {
            if (!this._reflection) {
                // Lazily require the real reflect only where a test needs it.
                const { WgslReflect } = globalThis.__wgslReflect;
                this._reflection = new WgslReflect(this.code);
            }
            return this._reflection;
        },
    };
}

const { WgslReflect } = await import("wgsl_reflect/wgsl_reflect.module.js");
globalThis.__wgslReflect = { WgslReflect };

// Build a capture-shaped command list. `object` is the encoder identity the
// walk uses to track bound pipeline state.
function makeCapture({ passDurations } = {}) {
    const vfModule = makeShaderModule(10, VERTEX_FRAGMENT_WGSL);
    const csModule = makeShaderModule(20, COMPUTE_WGSL);

    const renderPipeline = {
        id: 100,
        label: "gbuffer",
        descriptor: {
            vertex: { module: { __id: 10 }, entryPoint: "vsMain" },
            fragment: { module: { __id: 10 }, entryPoint: "fsMain" },
        },
    };
    const computePipeline = {
        id: 200,
        label: "blur",
        descriptor: {
            compute: { module: { __id: 20 }, entryPoint: "csMain" },
        },
    };

    const objects = new Map([
        [10, vfModule],
        [20, csModule],
        [100, renderPipeline],
        [200, computePipeline],
    ]);

    const renderPass = {
        method: "beginRenderPass", object: "enc0", id: 1,
        args: [{ label: "main", colorAttachments: [{ view: { __id: 999 } }] }],
    };
    const computePass = {
        method: "beginComputePass", object: "enc1", id: 5, args: [{}],
    };
    if (passDurations) {
        renderPass.duration = passDurations[0];
        computePass.duration = passDurations[1];
    }

    const commands = [
        renderPass,
        { method: "setPipeline", object: "enc0", args: [{ __id: 100 }] },
        { method: "draw", object: "enc0", id: 2, args: [3, 1, 0, 0] },
        { method: "drawIndexed", object: "enc0", id: 3, args: [6, 2, 0, 0, 0] },
        { method: "end", object: "enc0", id: 4 },
        computePass,
        { method: "setPipeline", object: "enc1", args: [{ __id: 200 }] },
        { method: "dispatchWorkgroups", object: "enc1", id: 6, args: [16, 2, 1] },
        { method: "end", object: "enc1", id: 7 },
    ];

    return { commands, getObject: (id) => objects.get(id) ?? null, vfModule, csModule };
}

// ---------------------------------------------------------------------------
// Cost model
// ---------------------------------------------------------------------------

test("cost model finds every entry point with its stage", () => {
    const result = buildShaderCostTree(VERTEX_FRAGMENT_WGSL);
    const names = result.entries.map((e) => `${e.stage}:${e.name}`).sort();
    assert.deepEqual(names, ["fragment:fsMain", "vertex:vsMain"]);
});

test("a literal-bounded loop gets an exact trip count", () => {
    const result = buildShaderCostTree(VERTEX_FRAGMENT_WGSL);
    const fs = result.entries.find((e) => e.name === "fsMain");
    let loop = null;
    walkCostTree(fs.root, (n) => {
        if (n.kind === "loop") {
            loop = n;
        }
    });
    assert.ok(loop, "expected a loop frame");
    assert.equal(loop.iterations, 4);
    assert.equal(loop.iterationsKnown, true);
    // The loop body samples a texture once per iteration.
    assert.equal(fs.cost.texture, 4);
});

test("a module const resolves as a loop bound", () => {
    const result = buildShaderCostTree(`
        const N : u32 = 12u;
        @compute @workgroup_size(1)
        fn main() {
          var x = 0.0;
          for (var i = 0u; i < N; i = i + 1u) { x = x + sqrt(x); }
        }
    `);
    const entry = result.entries[0];
    let loop = null;
    walkCostTree(entry.root, (n) => {
        if (n.kind === "loop") {
            loop = n;
        }
    });
    assert.equal(loop.iterations, 12);
    assert.equal(loop.iterationsKnown, true);
    assert.equal(entry.cost.sfu, 12, "one sqrt per iteration");
});

test("an unbounded loop is flagged rather than silently assumed", () => {
    const result = buildShaderCostTree(`
        @group(0) @binding(0) var<storage, read> n : u32;
        @compute @workgroup_size(1)
        fn main() {
          var x = 0.0;
          for (var i = 0u; i < n; i = i + 1u) { x = x + sqrt(x); }
        }
    `);
    const entry = result.entries[0];
    assert.equal(entry.root.estimated, true);
    assert.ok(result.warnings.some((w) => /no derivable trip count/.test(w)),
        `expected a trip-count warning, got: ${result.warnings.join(" | ")}`);
});

test("statement frames carry source spans that slice back to the source", () => {
    const result = buildShaderCostTree(VERTEX_FRAGMENT_WGSL);
    const fs = result.entries.find((e) => e.name === "fsMain");
    let spanned = 0;
    walkCostTree(fs.root, (n) => {
        if (n.start >= 0) {
            spanned++;
            const text = VERTEX_FRAGMENT_WGSL.slice(n.start, n.end);
            assert.ok(text.trim().length > 0, `empty span for ${n.name}`);
        }
    });
    assert.ok(spanned > 0, "expected at least one spanned frame");
});

test("costByLine attributes self cost, not subtree cost", () => {
    const result = buildShaderCostTree(VERTEX_FRAGMENT_WGSL);
    const fs = result.entries.find((e) => e.name === "fsMain");
    const lines = costByLine(fs.root);
    let texture = 0;
    for (const cost of lines.values()) {
        texture += cost.texture;
    }
    assert.equal(texture, 4, "the four samples land on the line that does them");
});

test("rescaleCostTree preserves proportions while hitting the target total", () => {
    const result = buildShaderCostTree(VERTEX_FRAGMENT_WGSL);
    const fs = result.entries.find((e) => e.name === "fsMain");
    const merged = mergeCostTree(fs.root, result.weights);
    const scaled = rescaleCostTree(merged, 10);
    assert.ok(Math.abs(scaled.totalCost - 10) < 1e-9);
    for (let i = 0; i < merged.children.length; ++i) {
        const before = merged.children[i].totalCost / merged.totalCost;
        const after = scaled.children[i].totalCost / scaled.totalCost;
        assert.ok(Math.abs(before - after) < 1e-9, "child proportion changed");
    }
});

// ---------------------------------------------------------------------------
// Invocation counts
// ---------------------------------------------------------------------------

test("workgroupSizeFor reads @workgroup_size through reflection", () => {
    const module = makeShaderModule(20, COMPUTE_WGSL);
    assert.deepEqual(workgroupSizeFor(module, "csMain"), [8, 4, 1]);
});

test("draw and dispatch invocation counts come out of the captured args", () => {
    const { commands, getObject } = makeCapture();
    const { passes } = collectFrameInvocations(commands, getObject);
    assert.equal(passes.length, 2);

    const [render, compute] = passes;
    assert.equal(render.kind, "render");
    assert.equal(render.items.length, 2);

    // draw(3, 1) -> 3 vertex invocations, exact.
    const drawVertex = render.items[0].stages.find((s) => s.stage === "vertex");
    assert.equal(drawVertex.invocations, 3);
    assert.equal(drawVertex.confidence, "exact");

    // drawIndexed(6, 2) -> 12, an upper bound because of post-transform reuse.
    const indexedVertex = render.items[1].stages.find((s) => s.stage === "vertex");
    assert.equal(indexedVertex.invocations, 12);
    assert.equal(indexedVertex.confidence, "upperBound");

    // Fragment counts are never derivable from the capture alone.
    for (const item of render.items) {
        const fragment = item.stages.find((s) => s.stage === "fragment");
        assert.equal(fragment.invocations, null);
        assert.equal(fragment.confidence, "unknown");
    }

    // dispatchWorkgroups(16,2,1) with @workgroup_size(8,4,1) -> 16*2*8*4 = 1024.
    const computeStage = compute.items[0].stages[0];
    assert.equal(computeStage.invocations, 1024);
    assert.equal(computeStage.confidence, "exact");
});

test("indirect draws report no invocation count instead of guessing", () => {
    const commands = [
        { method: "beginRenderPass", object: "e", id: 1, args: [{ colorAttachments: [] }] },
        { method: "setPipeline", object: "e", args: [{ __id: 100 }] },
        { method: "drawIndirect", object: "e", id: 2, args: [{ __id: 500 }, 0] },
        { method: "end", object: "e", id: 3 },
    ];
    const pipeline = {
        id: 100,
        descriptor: { vertex: { module: { __id: 10 }, entryPoint: "vsMain" } },
    };
    const objects = new Map([[100, pipeline], [10, makeShaderModule(10, VERTEX_FRAGMENT_WGSL)]]);
    const { passes, warnings } = collectFrameInvocations(commands, (id) => objects.get(id) ?? null);

    assert.equal(passes[0].items[0].stages[0].invocations, null);
    assert.ok(warnings.some((w) => /drawIndirect/.test(w)), "the exclusion must be reported");
});

// ---------------------------------------------------------------------------
// Frame cost tree
// ---------------------------------------------------------------------------

test("without pass timings the frame tree is in modeled op units", () => {
    const { commands, getObject } = makeCapture();
    const result = buildFrameCostTree({ commands, getObject });

    assert.equal(result.units, OPS);
    assert.equal(result.stats.passes, 2);
    assert.ok(result.root.totalCost > 0);
    assert.ok(result.warnings.some((w) => /Profile Passes/.test(w)));
});

test("with pass timings every pass width equals its measured duration", () => {
    const { commands, getObject } = makeCapture({ passDurations: [2.5, 1.25] });
    const result = buildFrameCostTree({ commands, getObject });

    assert.equal(result.units, MS);
    assert.equal(result.root.children.length, 2);
    assert.ok(Math.abs(result.root.children[0].totalCost - 2.5) < 1e-9);
    assert.ok(Math.abs(result.root.children[1].totalCost - 1.25) < 1e-9);
    assert.ok(Math.abs(result.root.totalCost - 3.75) < 1e-9);
});

test("a pass's children sum to the pass total after rescaling", () => {
    const { commands, getObject } = makeCapture({ passDurations: [2.5, 1.25] });
    const result = buildFrameCostTree({ commands, getObject });

    for (const pass of result.root.children) {
        if (!pass.children.length) {
            continue;
        }
        const sum = pass.children.reduce((a, c) => a + c.totalCost, 0);
        assert.ok(Math.abs(sum - pass.totalCost) < 1e-6,
            `${pass.name}: children sum ${sum} != pass total ${pass.totalCost}`);
    }
});

test("unmeasured fragment stages are carried at zero width and reported", () => {
    const { commands, getObject } = makeCapture();
    const result = buildFrameCostTree({ commands, getObject });

    let fragmentFrames = 0;
    walkCostTree(result.root, (n) => {
        if (/^fragment:/.test(n.name)) {
            fragmentFrames++;
            assert.equal(n.totalCost, 0);
            assert.match(n.name, /invocation count unknown/);
        }
    });
    assert.ok(fragmentFrames > 0);
    assert.ok(result.stats.unmeasuredFragmentStages > 0);
    assert.ok(result.warnings.some((w) => /Measure fragments/.test(w)));
});

test("measured fragment counts weight the fragment stage", () => {
    const { commands, getObject } = makeCapture();
    const bare = buildFrameCostTree({ commands, getObject });
    assert.equal(bare.groups.length, 1, "the render pass's one pipeline is a measurable group");

    const fragmentCounts = new Map([[bare.groups[0].key, 50000]]);
    const measured = buildFrameCostTree({ commands, getObject, fragmentCounts });

    let fragmentTotal = 0;
    walkCostTree(measured.root, (n) => {
        if (/^fragment:/.test(n.name)) {
            fragmentTotal += n.totalCost;
            assert.equal(n.confidence, "measured");
            assert.match(n.name, /50,000 measured invocations/);
        }
    });
    assert.ok(fragmentTotal > 0);
    // With 50k texture-sampling fragments against 15 vertex invocations, the
    // fragment stage has to dominate the frame.
    assert.ok(fragmentTotal / measured.root.totalCost > 0.9,
        `fragment share was ${(fragmentTotal / measured.root.totalCost * 100).toFixed(1)}%`);
    assert.equal(measured.stats.unmeasuredFragmentStages, 0);
});

test("per-draw mode splits pipeline frames into one frame per draw", () => {
    const { commands, getObject } = makeCapture();
    const grouped = buildFrameCostTree({ commands, getObject });
    const perDraw = buildFrameCostTree({ commands, getObject, perDraw: true });

    // Two draws share one pipeline: grouped collapses them, per-draw doesn't.
    assert.equal(grouped.root.children[0].children.length, 1);
    assert.equal(perDraw.root.children[0].children.length, 2);
});
