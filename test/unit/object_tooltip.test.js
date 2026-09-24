// Unit tests for the Inspect list hover text (src/devtools/object_tooltip.js).
//
// Run with: node --test test/unit/

import { test } from "node:test";
import assert from "node:assert/strict";

import { objectTooltip } from "../../src/devtools/object_tooltip.js";

class Texture {
    constructor(id, descriptor, label = "") {
        this.id = id;
        this.label = label;
        this.descriptor = descriptor;
    }
    get idName() { return this.id; }
    get format() { return this.descriptor.format; }
    get dimension() { return this.descriptor.dimension ?? "2d"; }
    get width() { return this.descriptor.size[0]; }
    get height() { return this.descriptor.size[1]; }
    get depthOrArrayLayers() { return this.descriptor.size[2] ?? 1; }
    get mipLevelCount() { return this.descriptor.mipLevelCount ?? 1; }
    get sampleCount() { return this.descriptor.sampleCount ?? 1; }
    get stacktrace() { return "    at createTargets (app.js:120:15)\n    at init (app.js:10:3)"; }
    getMipSize(m) { return [Math.max(1, this.width >> m), Math.max(1, this.height >> m), 1]; }
    getGpuSize() { return 1920 * 1080 * 4 * 4 / 3; }
}
Texture.className = "Texture";

class TextureView {
    constructor(id, texture, descriptor) {
        this.id = id;
        this.label = "";
        this.texture = texture;
        this.descriptor = descriptor;
    }
    get idName() { return this.id; }
}
TextureView.className = "TextureView";

class Buffer {
    constructor(id, descriptor) {
        this.id = id;
        this.label = "";
        this.descriptor = descriptor;
    }
    get idName() { return this.id; }
}
Buffer.className = "Buffer";

class RenderPipeline {
    constructor(id, descriptor) {
        this.id = id;
        this.label = "opaque";
        this.descriptor = descriptor;
    }
    get idName() { return this.id; }
}
RenderPipeline.className = "RenderPipeline";

class BindGroup {
    constructor(id, descriptor) {
        this.id = id;
        this.label = "";
        this.descriptor = descriptor;
    }
    get idName() { return this.id; }
}
BindGroup.className = "BindGroup";

test("tooltip: a texture lists format, size, mips, usage, memory and where it was created", () => {
    const texture = new Texture(5, { format: "rgba16float", size: [1920, 1080, 1], mipLevelCount: 11, usage: 0x10 | 0x04 }, "hdr");
    const text = objectTooltip(texture);
    assert.match(text, /^"hdr" Texture 5/);
    assert.match(text, /Format: rgba16float/);
    assert.match(text, /Size: 1920 x 1080 \(2d\)/);
    assert.match(text, /Mip levels: 11 \(smallest 1 x 1\)/);
    assert.match(text, /Usage: TEXTURE_BINDING \| RENDER_ATTACHMENT/);
    assert.match(text, /Memory: 10\.55 MB/);
    assert.match(text, /Created at: createTargets \(app\.js:120:15\)/);
});

test("tooltip: a texture view shows its range and its texture's details", () => {
    const texture = new Texture(5, { format: "depth32float", size: [512, 512, 6], mipLevelCount: 1, usage: 0x10 });
    const view = new TextureView(6, 5, { dimension: "2d", baseArrayLayer: 2, arrayLayerCount: 1 });
    const database = { getObject: (id) => (id === 5 ? texture : null), getTextureFromView: () => texture };
    const text = objectTooltip(view, database);
    assert.match(text, /View: 2d, layers 2–2/);
    assert.match(text, /Texture: Texture 5/);
    assert.match(text, /Size: 512 x 512, 6 layers/);
});

test("tooltip: buffers, pipelines and bind groups", () => {
    const buffer = new Buffer(7, { size: 65536, usage: 0x40 | 0x08 });
    let text = objectTooltip(buffer);
    assert.match(text, /Size: 64\.00 KB \(65,536 bytes\)/);
    assert.match(text, /Usage: COPY_DST \| UNIFORM/);

    const pipeline = new RenderPipeline(8, {
        layout: "auto",
        vertex: { module: { __id: 3 }, entryPoint: "vs" },
        fragment: { module: { __id: 3 }, entryPoint: "fs", targets: [{ format: "bgra8unorm", blend: {} }] },
        primitive: { topology: "triangle-strip", cullMode: "back" },
        depthStencil: { format: "depth24plus", depthCompare: "less", depthWriteEnabled: true },
    });
    text = objectTooltip(pipeline);
    assert.match(text, /Vertex: vs in ShaderModule 3/);
    assert.match(text, /Topology: triangle-strip, cull back/);
    assert.match(text, /Targets: bgra8unorm \(blend\)/);
    assert.match(text, /Depth-stencil: depth24plus, compare less, write/);
    assert.match(text, /Layout: auto/);

    const database = { getObject: (id) => (id === 7 ? buffer : null) };
    const bindGroup = new BindGroup(9, { layout: { __id: 12 }, entries: [{ binding: 0, resource: { buffer: { __id: 7 }, offset: 256, size: 64 } }] });
    text = objectTooltip(bindGroup, database);
    assert.match(text, /0: Buffer 7 @256 \(64 bytes\)/);
});
