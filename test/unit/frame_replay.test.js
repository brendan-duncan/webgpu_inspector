// Unit tests for the CPU side of Compile & Replay (src/devtools/frame_replay.js).
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { affectedTextures, collectReplaySteps } from "../../src/devtools/frame_replay.js";

class TextureView {
    constructor(id, texture) {
        this.id = id;
        this.texture = texture;
        this.descriptor = {};
    }
}
TextureView.className = "TextureView";

function world() {
    const objects = new Map();
    const add = (o) => { objects.set(o.id, o); return o; };
    add({ id: 1, descriptor: { vertex: { module: { __id: 70 } }, fragment: { module: { __id: 71 } } } });
    add({ id: 2, descriptor: { vertex: { module: { __id: 70 } }, fragment: { module: { __id: 72 } } } });
    add({ id: 3, descriptor: { compute: { module: { __id: 73 } } } });
    for (const id of [10, 11, 12, 13]) {
        add({ id, descriptor: { usage: id === 13 ? 0x08 : 0x10 } });
        add(new TextureView(id + 10, id));
    }
    add({ id: 40, descriptor: { entries: [{ binding: 0, resource: { __id: 23 } }] } });
    const database = { getObject: (id) => objects.get(id) ?? null, getTextureFromView: (v) => objects.get(v.texture) };
    return database;
}

const ref = (id) => ({ __id: id });

function frame() {
    const pass = (encoder, passId, target, pipeline) => [
        { class: "GPUCommandEncoder", object: encoder, method: "beginRenderPass", args: [{ colorAttachments: [{ view: ref(target) }] }], result: passId },
        { class: "GPURenderPassEncoder", object: passId, method: "setPipeline", args: [ref(pipeline)] },
        { class: "GPURenderPassEncoder", object: passId, method: "draw", args: [3] },
        { class: "GPURenderPassEncoder", object: passId, method: "end", args: [] },
    ];
    return [
        { class: "GPUDevice", object: 0, method: "createCommandEncoder", args: [], result: 100 },
        ...pass(100, 101, 20, 1),                // module 71 -> texture 10
        { class: "GPUCommandEncoder", object: 100, method: "copyTextureToTexture", args: [{ texture: ref(10) }, { texture: ref(11) }, [4, 4, 1]] },
        ...pass(100, 102, 22, 2),                // module 72 -> texture 12
        { class: "GPUCommandEncoder", object: 100, method: "beginComputePass", args: [{}], result: 103 },
        { class: "GPUComputePassEncoder", object: 103, method: "setPipeline", args: [ref(3)] },
        { class: "GPUComputePassEncoder", object: 103, method: "setBindGroup", args: [0, ref(40)] },
        { class: "GPUComputePassEncoder", object: 103, method: "dispatchWorkgroups", args: [1] },
        { class: "GPUComputePassEncoder", object: 103, method: "end", args: [] },
        { class: "GPUCommandEncoder", object: 100, method: "finish", args: [], result: 104 },
        { class: "GPUQueue", object: 2, method: "submit", args: [[ref(104)]] },
    ];
}

test("frame replay: steps are passes and copies in execution order", () => {
    const steps = collectReplaySteps(frame());
    assert.deepEqual(steps.map((s) => s.kind), ["render", "transfer", "render", "compute"]);
    assert.equal(steps[0].commands.length, 2);
    assert.equal(steps[1].command.method, "copyTextureToTexture");
});

test("frame replay: an edit affects everything written from its first use on", () => {
    const database = world();
    const steps = collectReplaySteps(frame());

    // Module 70 (the shared vertex shader) is used by the first pass: every write counts.
    let r = affectedTextures(steps, database, 70);
    assert.equal(r.firstAffected, 0);
    assert.deepEqual([...r.affected].sort(), [10, 11, 12, 13]);

    // Module 72 is first used by the second render pass: the first pass and copy are unaffected.
    r = affectedTextures(steps, database, 72);
    assert.equal(r.firstAffected, 2);
    assert.deepEqual([...r.affected].sort(), [12, 13], "the second pass's target and the compute pass's storage texture");

    r = affectedTextures(steps, database, 999);
    assert.equal(r.firstAffected, -1);
    assert.equal(r.affected.size, 0);
});
