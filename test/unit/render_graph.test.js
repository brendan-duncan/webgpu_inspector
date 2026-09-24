// Unit tests for the frame render graph (src/devtools/render_graph.js).
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import {
    analyzeRenderGraph,
    buildFrameRenderGraph,
    executionOrder,
    groupResourceRows,
} from "../../src/devtools/render_graph.js";

// ---------------------------------------------------------------------------
// Fixtures: minimal stand-ins for the devtools GPU objects.
// ---------------------------------------------------------------------------

class Texture {
    constructor(id, { label = "", width = 256, height = 256, format = "rgba8unorm", mips = 1, layers = 1, sampleCount = 1 } = {}) {
        this.id = id;
        this.label = label;
        this.descriptor = { size: [width, height, layers], format, mipLevelCount: mips, sampleCount };
    }
    get format() { return this.descriptor.format; }
    get dimension() { return "2d"; }
    get width() { return this.descriptor.size[0]; }
    get height() { return this.descriptor.size[1]; }
    get depthOrArrayLayers() { return this.descriptor.size[2]; }
    get mipLevelCount() { return this.descriptor.mipLevelCount; }
    get sampleCount() { return this.descriptor.sampleCount; }
    get resolutionString() { return `${this.width}x${this.height}`; }
    getMipSize(m) { return [this.width >> m, this.height >> m, this.depthOrArrayLayers]; }
    getGpuSize() { return this.width * this.height * 4; }
}
Texture.className = "Texture";

class TextureView {
    constructor(id, texture, descriptor = {}) {
        this.id = id;
        this.texture = texture;
        this.descriptor = descriptor;
    }
}
TextureView.className = "TextureView";

class Buffer {
    constructor(id, size, usage = 0, label = "") {
        this.id = id;
        this.label = label;
        this.descriptor = { size, usage };
    }
}
Buffer.className = "Buffer";

class BindGroup {
    constructor(id, entries, layout = null) {
        this.id = id;
        this.descriptor = { entries, layout: layout ? { __id: layout } : undefined };
    }
}
BindGroup.className = "BindGroup";

class BindGroupLayout {
    constructor(id, entries) {
        this.id = id;
        this.descriptor = { entries };
    }
}

class Pipeline {
    constructor(id, descriptor) {
        this.id = id;
        this.descriptor = descriptor;
    }
}

function makeWorld() {
    const objects = new Map();
    const add = (o) => { objects.set(o.id, o); return o; };
    const resolver = {
        getObject: (id) => objects.get(id) ?? null,
        getTextureFromView: (view) => view.texture,
    };
    return { objects, add, resolver };
}

const ref = (id, cls) => ({ __id: id, __class: cls });

// Command record helpers, shaped like the inspector's capture records.
function encoderCommands(encoderId, body, commandBufferId) {
    return [
        { class: "GPUDevice", object: 1, method: "createCommandEncoder", args: [], result: encoderId },
        ...body,
        { class: "GPUCommandEncoder", object: encoderId, method: "finish", args: [], result: commandBufferId },
    ];
}

function renderPass(encoderId, passId, descriptor, body = []) {
    return [
        { class: "GPUCommandEncoder", object: encoderId, method: "beginRenderPass", args: [descriptor], result: passId },
        ...body.map((c) => ({ class: "GPURenderPassEncoder", object: passId, result: 0, ...c })),
        { class: "GPURenderPassEncoder", object: passId, method: "end", args: [], result: 0 },
    ];
}

function computePass(encoderId, passId, body = [], label) {
    return [
        { class: "GPUCommandEncoder", object: encoderId, method: "beginComputePass", args: [label ? { label } : {}], result: passId },
        ...body.map((c) => ({ class: "GPUComputePassEncoder", object: passId, result: 0, ...c })),
        { class: "GPUComputePassEncoder", object: passId, method: "end", args: [], result: 0 },
    ];
}

function submit(...commandBuffers) {
    return { class: "GPUQueue", object: 2, method: "submit", args: [commandBuffers.map((id) => ref(id, "GPUCommandBuffer"))], result: 0 };
}

function colorAttachment(viewId, loadOp = "clear", storeOp = "store", extra = {}) {
    return { view: ref(viewId, "GPUTextureView"), loadOp, storeOp, ...extra };
}

// A G-buffer pass followed by a lighting pass that samples it and draws to the
// canvas; the depth buffer is stored but never read.
function deferredFrame() {
    const { add, resolver } = makeWorld();
    const albedo = add(new Texture(10, { label: "albedo" }));
    const depth = add(new Texture(11, { label: "depth", format: "depth24plus" }));
    const canvas = add(new Texture(-5, { format: "bgra8unorm" }));
    add(new TextureView(20, albedo));
    add(new TextureView(21, depth));
    add(new TextureView(22, canvas));
    add(new BindGroup(30, [{ binding: 0, resource: ref(20, "GPUTextureView") }]));
    add(new Pipeline(40, { vertex: {}, fragment: {} }));

    const commands = [
        ...encoderCommands(100, [
            ...renderPass(100, 101, {
                label: "GBuffer",
                colorAttachments: [colorAttachment(20)],
                depthStencilAttachment: { view: ref(21, "GPUTextureView"), depthLoadOp: "clear", depthStoreOp: "store" },
            }, [
                { method: "setPipeline", args: [ref(40, "GPURenderPipeline")] },
                { method: "draw", args: [3] },
            ]),
            ...renderPass(100, 102, {
                label: "Lighting",
                colorAttachments: [colorAttachment(22)],
            }, [
                { method: "setPipeline", args: [ref(40, "GPURenderPipeline")] },
                { method: "setBindGroup", args: [0, ref(30, "GPUBindGroup")] },
                { method: "draw", args: [3] },
            ]),
        ], 103),
        submit(103),
    ];
    return { commands, resolver };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test("render graph: a sampled attachment becomes an edge between passes", () => {
    const { commands, resolver } = deferredFrame();
    const graph = buildFrameRenderGraph(commands, resolver);

    assert.deepEqual(graph.nodes.map((n) => n.label), ["GBuffer", "Lighting"]);
    const [gbuffer, lighting] = graph.nodes;
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].from, gbuffer);
    assert.equal(graph.edges[0].to, lighting);
    assert.equal(graph.edges[0].usage, "sampled");
    assert.equal(gbuffer.draws, 1);

    // The lighting pass writes the canvas, which is presented; the G-buffer
    // pass's albedo is read, so neither pass is unread.
    assert.equal(lighting.unread, false);
    assert.equal(gbuffer.unread, false);
    assert.equal(graph.externalInputs.length, 0);
});

test("render graph: unread-store flags a stored depth buffer nothing reads", () => {
    const { commands, resolver } = deferredFrame();
    const graph = buildFrameRenderGraph(commands, resolver);
    const { findings } = analyzeRenderGraph(graph);
    const unread = findings.find((f) => f.rule === "unread-store");
    assert.ok(unread, "expected an unread-store finding");
    assert.equal(unread.count, 1);
    assert.match(unread.message, /"depth"/);
    assert.equal(unread.node.label, "GBuffer");
});

test("render graph: passes follow submit order, not recording order", () => {
    const { add, resolver } = makeWorld();
    const a = add(new Texture(10, { label: "A" }));
    add(new TextureView(20, a));
    const commands = [
        ...encoderCommands(100, renderPass(100, 101, { label: "first recorded", colorAttachments: [colorAttachment(20)] }), 103),
        ...encoderCommands(200, renderPass(200, 201, { label: "second recorded", colorAttachments: [colorAttachment(20)] }), 203),
        submit(203, 103),
    ];
    const graph = buildFrameRenderGraph(commands, resolver);
    assert.deepEqual(graph.nodes.map((n) => n.label), ["second recorded", "first recorded"]);

    const order = executionOrder(commands).map((e) => e.command.method);
    assert.equal(order[0], "beginRenderPass");
});

test("render graph: an unsubmitted encoder is placed last with a warning", () => {
    const { add, resolver } = makeWorld();
    const a = add(new Texture(10));
    add(new TextureView(20, a));
    const commands = [
        ...encoderCommands(100, renderPass(100, 101, { label: "never submitted", colorAttachments: [colorAttachment(20)] }), 103),
        ...encoderCommands(200, renderPass(200, 201, { label: "submitted", colorAttachments: [colorAttachment(20, "load")] }), 203),
        submit(203),
    ];
    const graph = buildFrameRenderGraph(commands, resolver);
    assert.deepEqual(graph.nodes.map((n) => n.label), ["submitted", "never submitted"]);
    assert.ok(graph.warnings.some((w) => /not submitted/.test(w)));
});

test("render graph: a mip chain keys edges per mip, with no self-loop", () => {
    const { add, resolver } = makeWorld();
    const bloom = add(new Texture(10, { label: "bloom", mips: 3 }));
    add(new TextureView(20, bloom, { baseMipLevel: 0, mipLevelCount: 1 }));
    add(new TextureView(21, bloom, { baseMipLevel: 1, mipLevelCount: 1 }));
    add(new BindGroup(30, [{ binding: 0, resource: ref(20, "GPUTextureView") }]));
    add(new Pipeline(40, { vertex: {}, fragment: {} }));

    const commands = [
        ...encoderCommands(100, [
            ...renderPass(100, 101, { label: "mip0", colorAttachments: [colorAttachment(20)] }),
            ...renderPass(100, 102, { label: "mip1", colorAttachments: [colorAttachment(21)] }, [
                { method: "setPipeline", args: [ref(40, "GPURenderPipeline")] },
                { method: "setBindGroup", args: [0, ref(30, "GPUBindGroup")] },
                { method: "draw", args: [3] },
            ]),
        ], 103),
        submit(103),
    ];
    const graph = buildFrameRenderGraph(commands, resolver);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].from.label, "mip0");
    assert.equal(graph.edges[0].to.label, "mip1");
    assert.equal(graph.edges[0].version.resource.label, "\"bloom\" mip 0");

    // Both mips are one row in the chart.
    const rows = groupResourceRows(graph.resources);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].subresources.length, 2);
});

test("render graph: a queue.writeBuffer upload is a host input, not an edge", () => {
    const { add, resolver } = makeWorld();
    add(new Buffer(50, 1024));
    add(new BindGroupLayout(60, [{ binding: 0, buffer: { type: "read-only-storage" } }]));
    add(new BindGroup(30, [{ binding: 0, resource: { buffer: ref(50, "GPUBuffer") } }], 60));
    add(new Pipeline(40, { compute: {} }));

    const commands = [
        { class: "GPUQueue", object: 2, method: "writeBuffer", args: [ref(50, "GPUBuffer"), 0, "Uint8Array 1024"], result: 0 },
        ...encoderCommands(100, computePass(100, 101, [
            { method: "setPipeline", args: [ref(40, "GPUComputePipeline")] },
            { method: "setBindGroup", args: [0, ref(30, "GPUBindGroup")] },
            { method: "dispatchWorkgroups", args: [4] },
        ], "simulate"), 103),
        submit(103),
    ];
    const graph = buildFrameRenderGraph(commands, resolver);
    assert.equal(graph.nodes.length, 1);
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.hostInputs.length, 1);
    assert.equal(graph.externalInputs.length, 0);
    assert.equal(graph.nodes[0].reads[0].usage, "storage (read-only)");
});

test("render graph: overwritten-before-read flags a result cleared away unread", () => {
    const { add, resolver } = makeWorld();
    const t = add(new Texture(10, { label: "scratch" }));
    add(new TextureView(20, t));
    const commands = [
        ...encoderCommands(100, [
            ...renderPass(100, 101, { label: "wasted", colorAttachments: [colorAttachment(20)] }),
            ...renderPass(100, 102, { label: "replaces", colorAttachments: [colorAttachment(20)] }),
        ], 103),
        submit(103),
    ];
    const graph = buildFrameRenderGraph(commands, resolver);
    const { findings } = analyzeRenderGraph(graph);
    const f = findings.find((x) => x.rule === "overwritten-before-read");
    assert.ok(f);
    assert.equal(f.node.label, "wasted");
    assert.equal(findings[0].rule, "overwritten-before-read", "high severity sorts first");
});

test("render graph: read-after-discard flags sampling a discarded attachment", () => {
    const { add, resolver } = makeWorld();
    const t = add(new Texture(10, { label: "shadow" }));
    const canvas = add(new Texture(-5));
    add(new TextureView(20, t));
    add(new TextureView(22, canvas));
    add(new BindGroup(30, [{ binding: 0, resource: ref(20, "GPUTextureView") }]));
    add(new Pipeline(40, { vertex: {}, fragment: {} }));
    const commands = [
        ...encoderCommands(100, [
            ...renderPass(100, 101, { label: "shadows", colorAttachments: [colorAttachment(20, "clear", "discard")] }),
            ...renderPass(100, 102, { label: "main", colorAttachments: [colorAttachment(22)] }, [
                { method: "setPipeline", args: [ref(40, "GPURenderPipeline")] },
                { method: "setBindGroup", args: [0, ref(30, "GPUBindGroup")] },
                { method: "draw", args: [3] },
            ]),
        ], 103),
        submit(103),
    ];
    const { findings } = analyzeRenderGraph(buildFrameRenderGraph(commands, resolver));
    const f = findings.find((x) => x.rule === "read-after-discard");
    assert.ok(f);
    assert.equal(f.node.label, "main");
});

test("render graph: mergeable-passes flags a pass that loads what the previous stored", () => {
    const { add, resolver } = makeWorld();
    const canvas = add(new Texture(-5));
    add(new TextureView(22, canvas));
    const commands = [
        ...encoderCommands(100, [
            ...renderPass(100, 101, { label: "opaque", colorAttachments: [colorAttachment(22)] }),
            ...renderPass(100, 102, { label: "transparent", colorAttachments: [colorAttachment(22, "load")] }),
        ], 103),
        submit(103),
    ];
    const graph = buildFrameRenderGraph(commands, resolver);
    assert.equal(graph.edges.length, 1);
    const { findings } = analyzeRenderGraph(graph);
    const f = findings.find((x) => x.rule === "mergeable-passes");
    assert.ok(f);
    assert.equal(f.node.label, "transparent");
});

test("render graph: msaa-store flags a resolved MSAA attachment that is also stored", () => {
    const { add, resolver } = makeWorld();
    const msaa = add(new Texture(10, { label: "msaa", sampleCount: 4 }));
    const canvas = add(new Texture(-5));
    add(new TextureView(20, msaa));
    add(new TextureView(22, canvas));
    const commands = [
        ...encoderCommands(100, renderPass(100, 101, {
            label: "main",
            colorAttachments: [colorAttachment(20, "clear", "store", { resolveTarget: ref(22, "GPUTextureView") })],
        }), 103),
        submit(103),
    ];
    const { findings } = analyzeRenderGraph(buildFrameRenderGraph(commands, resolver));
    assert.ok(findings.find((x) => x.rule === "msaa-store"));
    assert.ok(!findings.find((x) => x.rule === "unread-store"), "the resolved attachment is msaa-store's case, not unread-store's");
});

test("render graph: copies are transfer nodes, and MAP_READ destinations are consumed", () => {
    const { add, resolver } = makeWorld();
    const t = add(new Texture(10, { label: "result", width: 16, height: 16 }));
    add(new TextureView(20, t));
    add(new Buffer(50, 1024, 0x0001 | 0x0008, "readback"));
    const commands = [
        ...encoderCommands(100, [
            ...renderPass(100, 101, { label: "draw", colorAttachments: [colorAttachment(20)] }),
            { class: "GPUCommandEncoder", object: 100, method: "copyTextureToBuffer",
              args: [{ texture: ref(10, "GPUTexture") }, { buffer: ref(50, "GPUBuffer"), bytesPerRow: 256 }, [16, 16, 1]], result: 0 },
        ], 103),
        submit(103),
    ];
    const graph = buildFrameRenderGraph(commands, resolver);
    assert.deepEqual(graph.nodes.map((n) => n.kind), ["render", "transfer"]);
    assert.equal(graph.nodes[1].label, "copyTextureToBuffer → \"readback\"");
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.unreadNodes.length, 0, "a MAP_READ buffer is read back by the host");
});

test("render graph: critical path follows measured pass durations", () => {
    const { commands, resolver } = deferredFrame();
    commands.find((c) => c.args?.[0]?.label === "GBuffer").duration = 2;
    commands.find((c) => c.args?.[0]?.label === "Lighting").duration = 1.5;
    const graph = buildFrameRenderGraph(commands, resolver);
    assert.deepEqual(graph.criticalPath.map((n) => n.label), ["GBuffer", "Lighting"]);
    assert.equal(graph.criticalPathMs, 3.5);
});
