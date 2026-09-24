import { CaptureReplay, applyUploads, encodeDraw, walkPassCommands } from "./capture_replay.js";
import { executionOrder } from "./render_graph.js";

/**
 * Whole-frame GPU replay with real pipelines, for Compile & Replay: re-run a
 * captured frame's render passes, compute passes and copies on the DevTools
 * device, in execution order, with one persistent texture per captured
 * texture so what one pass writes is what the next pass reads — and with any
 * shader module's source replaced by edited code.
 *
 * Replaying the frame twice, once as captured and once with the edit, and
 * comparing the textures the two runs leave behind shows exactly what the
 * edit changes. Both runs start from the same state (textures seeded from
 * their captured contents, buffers from the bytes captured at each binding),
 * so the replay's own approximations cancel out of the comparison.
 */

const TEXTURE_COPY_SRC = 0x01;
const TEXTURE_COPY_DST = 0x02;
const TEXTURE_TEXTURE_BINDING = 0x04;
const TEXTURE_STORAGE_BINDING = 0x08;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_STORAGE = 0x0080;

const DRAW_METHODS = new Set(["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"]);
const DISPATCH_METHODS = new Set(["dispatchWorkgroups", "dispatchWorkgroupsIndirect"]);
const TRANSFER_METHODS = new Set(["copyBufferToBuffer", "copyBufferToTexture", "copyTextureToBuffer", "copyTextureToTexture", "clearBuffer"]);

function isDepthFormat(format) {
    return !!format && (format.includes("depth") || format.includes("stencil"));
}

function isCompressedFormat(format) {
    return /^(bc|etc2|eac|astc)/.test(format ?? "");
}

/**
 * Split a frame's commands into replay steps, in execution order: render and
 * compute passes (with their commands) and encoder-level copies.
 */
export function collectReplaySteps(commands) {
    const steps = [];
    let current = null;
    for (const { command, index } of executionOrder(commands)) {
        const method = command.method;
        if (method === "beginRenderPass" || method === "beginComputePass") {
            current = { kind: method === "beginRenderPass" ? "render" : "compute", begin: command, index, commands: [] };
            steps.push(current);
            continue;
        }
        if (current) {
            if (method === "end") {
                current = null;
            } else {
                current.commands.push(command);
            }
            continue;
        }
        if (TRANSFER_METHODS.has(method)) {
            steps.push({ kind: "transfer", command, index });
        }
    }
    return steps;
}

/**
 * The shader modules each step's pipelines use.
 * @returns {Set<number>}
 */
function stepModules(step, getObject) {
    const modules = new Set();
    if (step.kind === "transfer") {
        return modules;
    }
    const visit = (command) => {
        if (command.method !== "setPipeline") {
            return;
        }
        const desc = getObject(command.args?.[0]?.__id)?.descriptor;
        for (const stage of [desc?.vertex, desc?.fragment, desc?.compute]) {
            if (stage?.module?.__id !== undefined) {
                modules.add(stage.module.__id);
            }
        }
    };
    for (const command of step.commands) {
        visit(command);
        if (command.method === "executeBundles") {
            for (const ref of command.args?.[0] ?? []) {
                for (const c of getObject(ref?.__id)?.commands ?? []) {
                    visit(c);
                }
            }
        }
    }
    return modules;
}

export class FrameReplay {
    /**
     * @param {Object} params
     * @param {GPUDevice} params.device
     * @param {Object} params.database
     * @param {(attachment:Object)=>Object} params.getTextureFromAttachment
     * @param {Map<number,string>} [params.overrides] - shader module id -> replacement WGSL
     */
    constructor({ device, database, getTextureFromAttachment, overrides }) {
        this.device = device;
        this.database = database;
        this.getTextureFromAttachment = getTextureFromAttachment;
        this.overrides = overrides ?? new Map();
        this.replay = new CaptureReplay(device, database);
        this.notes = new Set();
        this.textures = new Map();     // texture id -> { gpu, texture }
        this.written = new Set();      // texture ids written by a replayed step
        this._gpuWrittenBuffers = new Set();
        this._modules = new Map();
        this._pipelines = new Map();
        this._bindGroups = new Map();
        this.skippedDraws = 0;
        this.failedSteps = [];
    }

    destroy() {
        for (const record of this.textures.values()) {
            try {
                record.gpu.destroy();
            } catch (_) { /* ignore */ }
        }
        this.textures.clear();
        this.replay.destroy();
    }

    // ------------------------------------------------------------ textures

    texture(id) {
        let record = this.textures.get(id);
        if (record) {
            return record;
        }
        const texture = this.database.getObject(id);
        const desc = texture?.descriptor;
        if (!desc?.format) {
            return null;
        }
        const usage = (desc.usage ?? 0) & (TEXTURE_RENDER_ATTACHMENT | TEXTURE_STORAGE_BINDING);
        const gpu = this.device.createTexture({
            label: `replay ${texture.label || `Texture ${id}`}`,
            size: [texture.width, texture.height, texture.depthOrArrayLayers ?? 1],
            dimension: desc.dimension ?? "2d",
            format: desc.format,
            mipLevelCount: desc.mipLevelCount ?? 1,
            sampleCount: desc.sampleCount ?? 1,
            usage: usage | TEXTURE_TEXTURE_BINDING | TEXTURE_COPY_SRC | TEXTURE_COPY_DST,
        });
        record = { gpu, texture };
        this.textures.set(id, record);
        this._seed(record);
        return record;
    }

    // Start a texture from its captured contents (depth, multisampled and
    // compressed textures start zeroed; their captured copies aren't in the
    // original format).
    _seed({ gpu, texture }) {
        const format = texture.format;
        if (isDepthFormat(format) || (texture.sampleCount ?? 1) > 1 || isCompressedFormat(format)) {
            return;
        }
        for (let mip = 0; mip < (texture.mipLevelCount ?? 1); ++mip) {
            const data = texture.imageData?.[mip];
            if (!data) {
                continue;
            }
            try {
                this.device.queue.writeTexture(
                    { texture: gpu, mipLevel: mip },
                    data,
                    { offset: 0, bytesPerRow: texture.bytesPerRow >> mip, rowsPerImage: texture.height >> mip },
                    texture.getMipSize(mip));
            } catch (e) {
                this.notes.add(`Texture ${texture.label || texture.id} could not be seeded with its captured contents: ${e.message ?? e}`);
                return;
            }
        }
    }

    // A view of a replay texture from a view reference in command args.
    view(ref) {
        if (!ref || ref.__id === undefined) {
            return null;
        }
        const viewObj = this.database.getObject(ref.__id);
        let texture = ref.__texture?.__id !== undefined ? this.database.getObject(ref.__texture.__id) : null;
        if (!texture && viewObj) {
            texture = this.database.getTextureFromView(viewObj);
        }
        const record = texture ? this.texture(texture.id) : null;
        if (!record) {
            return null;
        }
        const desc = { ...(viewObj?.descriptor ?? {}) };
        delete desc.label;
        return { view: record.gpu.createView(desc), record, desc };
    }

    // -------------------------------------------------------------- objects

    async _module(id) {
        if (this._modules.has(id)) {
            return this._modules.get(id);
        }
        const moduleObj = this.database.getObject(id);
        const edited = this.overrides.has(id);
        const code = edited ? this.overrides.get(id) : moduleObj?.code;
        let module = null;
        if (code) {
            module = this.device.createShaderModule({ code, label: moduleObj?.label });
            const info = await module.getCompilationInfo();
            const errors = info.messages.filter((m) => m.type === "error");
            if (errors.length) {
                if (edited) {
                    const e = errors[0];
                    throw new Error(`The edited shader doesn't compile: ${e.message} (line ${e.lineNum}:${e.linePos})`);
                }
                module = null;
            }
        }
        this._modules.set(id, module);
        return module;
    }

    async _layout(desc) {
        if (desc.layout && desc.layout !== "auto") {
            const pl = this.replay.getPipelineLayout(desc.layout.__id);
            if (pl) {
                return pl.layout;
            }
        }
        return "auto";
    }

    async _renderPipeline(id) {
        if (this._pipelines.has(id)) {
            return this._pipelines.get(id);
        }
        const pipeline = this.database.getObject(id);
        const desc = pipeline?.descriptor;
        let result = null;
        if (desc?.vertex) {
            const vertexModule = await this._module(desc.vertex.module?.__id);
            const fragmentModule = desc.fragment ? await this._module(desc.fragment.module?.__id) : null;
            if (vertexModule && (!desc.fragment || fragmentModule)) {
                const primitive = { ...(desc.primitive ?? {}) };
                if (primitive.unclippedDepth && !this.device.features.has("depth-clip-control")) {
                    delete primitive.unclippedDepth;
                    this.notes.add("A pipeline uses unclippedDepth but the DevTools device lacks depth-clip-control; depth clipping is applied.");
                }
                const descriptor = {
                    label: `replay ${pipeline.label || id}`,
                    layout: await this._layout(desc),
                    vertex: { ...desc.vertex, module: vertexModule },
                    primitive,
                };
                if (desc.fragment) {
                    descriptor.fragment = { ...desc.fragment, module: fragmentModule };
                }
                if (desc.depthStencil) {
                    descriptor.depthStencil = desc.depthStencil;
                }
                if (desc.multisample) {
                    descriptor.multisample = desc.multisample;
                }
                result = await this._validated(`Pipeline ${pipeline.label || id}`, () => this.device.createRenderPipeline(descriptor));
            }
        }
        this._pipelines.set(id, result);
        return result;
    }

    async _computePipeline(id) {
        if (this._pipelines.has(id)) {
            return this._pipelines.get(id);
        }
        const pipeline = this.database.getObject(id);
        const desc = pipeline?.descriptor;
        let result = null;
        if (desc?.compute) {
            const module = await this._module(desc.compute.module?.__id);
            if (module) {
                const descriptor = {
                    label: `replay ${pipeline.label || id}`,
                    layout: await this._layout(desc),
                    compute: { ...desc.compute, module },
                };
                result = await this._validated(`Compute pipeline ${pipeline.label || id}`, () => this.device.createComputePipeline(descriptor));
            }
        }
        this._pipelines.set(id, result);
        return result;
    }

    async _bindGroup(bgId, pipeline, pipelineId, groupIndex) {
        const bgObj = this.database.getObject(bgId);
        const explicit = this.replay.getBindGroupLayout(bgObj?.descriptor?.layout?.__id);
        const key = explicit ? `bg:${bgId}` : `bg:${bgId}:${pipelineId}:${groupIndex}`;
        if (this._bindGroups.has(key)) {
            return this._bindGroups.get(key);
        }
        let result = null;
        if (bgObj?.descriptor?.entries) {
            const entries = [];
            let ok = true;
            for (const entry of bgObj.descriptor.entries) {
                const ref = entry.resource;
                const bufferId = ref?.buffer?.__id ?? (ref?.__class === "GPUBuffer" ? ref.__id : undefined);
                if (bufferId !== undefined) {
                    const buffer = this.replay.getBuffer(bufferId);
                    if (!buffer) {
                        ok = false;
                        break;
                    }
                    const resource = { buffer };
                    if (ref.offset) {
                        resource.offset = ref.offset;
                    }
                    if (ref.size) {
                        resource.size = ref.size;
                    }
                    entries.push({ binding: entry.binding, resource });
                    continue;
                }
                const object = this.database.getObject(ref?.__id);
                const className = object?.constructor?.className;
                if (className === "TextureView") {
                    const v = this.view(ref);
                    if (!v) {
                        ok = false;
                        break;
                    }
                    entries.push({ binding: entry.binding, resource: v.view });
                } else if (className === "Sampler") {
                    entries.push({ binding: entry.binding, resource: this.replay.getSampler(ref.__id) });
                } else {
                    this.notes.add("A bind group uses a resource replay doesn't support (e.g. an external texture); draws using it are skipped.");
                    ok = false;
                    break;
                }
            }
            if (ok) {
                const layout = explicit ?? pipeline.getBindGroupLayout(groupIndex);
                result = await this._validated(`Bind group ${bgObj.label || bgId}`, () => this.device.createBindGroup({ layout, entries }));
            }
        }
        this._bindGroups.set(key, result);
        return result;
    }

    async _validated(what, create) {
        this.device.pushErrorScope("validation");
        let result = null;
        try {
            result = create();
        } catch (e) {
            await this.device.popErrorScope();
            this.notes.add(`${what} could not be replayed: ${e.message ?? e}`);
            return null;
        }
        const error = await this.device.popErrorScope();
        if (error) {
            this.notes.add(`${what} could not be replayed: ${error.message}`);
            return null;
        }
        return result;
    }

    // -------------------------------------------------------------- replay

    /**
     * Replay the frame.
     * @param {Object[]} commands
     * @param {(done:number, total:number)=>void} [onProgress]
     */
    async run(commands, onProgress) {
        const steps = collectReplaySteps(commands);
        for (let i = 0; i < steps.length; ++i) {
            const step = steps[i];
            onProgress?.(i, steps.length);
            try {
                if (step.kind === "render") {
                    await this._renderPass(step);
                } else if (step.kind === "compute") {
                    await this._computePass(step);
                } else {
                    await this._transfer(step.command);
                }
            } catch (e) {
                if (/edited shader doesn't compile/.test(e.message)) {
                    throw e;
                }
                this.failedSteps.push({ step, message: e.message ?? String(e) });
            }
        }
        onProgress?.(steps.length, steps.length);
        await this.device.queue.onSubmittedWorkDone();
        return steps;
    }

    _uploads(passCommands) {
        const uploads = [];
        const missing = new Set();
        const plans = walkPassCommands(this.replay, passCommands, uploads, missing, { skippedDraws: 0 });
        // Buffers an earlier replayed step wrote keep the replayed contents:
        // captured bytes would overwrite the effect of an edited compute shader.
        applyUploads(this.replay, uploads.filter((u) => !this._gpuWrittenBuffers.has(u.bufferId)));
        return plans;
    }

    async _renderPass(step) {
        const desc = step.begin.args?.[0] ?? {};
        let width = 0;
        let height = 0;
        const colorAttachments = [];
        for (const attachment of desc.colorAttachments ?? []) {
            if (!attachment) {
                colorAttachments.push(null);
                continue;
            }
            const v = this.view(attachment.view);
            if (!v) {
                throw new Error("A color attachment's texture was not captured.");
            }
            const mip = v.desc.baseMipLevel ?? 0;
            [width, height] = v.record.texture.getMipSize(mip);
            this.written.add(v.record.texture.id);
            const out = { view: v.view, loadOp: attachment.loadOp, storeOp: attachment.storeOp };
            if (attachment.clearValue !== undefined) {
                out.clearValue = attachment.clearValue;
            }
            if (attachment.depthSlice !== undefined) {
                out.depthSlice = attachment.depthSlice;
            }
            if (attachment.resolveTarget) {
                const r = this.view(attachment.resolveTarget);
                if (r) {
                    out.resolveTarget = r.view;
                    this.written.add(r.record.texture.id);
                }
            }
            colorAttachments.push(out);
        }
        let depthStencilAttachment;
        if (desc.depthStencilAttachment) {
            const ds = desc.depthStencilAttachment;
            const v = this.view(ds.view);
            if (!v) {
                throw new Error("The depth-stencil attachment's texture was not captured.");
            }
            [width, height] = v.record.texture.getMipSize(v.desc.baseMipLevel ?? 0);
            depthStencilAttachment = { ...ds, view: v.view };
            if (!ds.depthReadOnly || !ds.stencilReadOnly) {
                this.written.add(v.record.texture.id);
            }
        }

        const plans = this._uploads(step.commands);
        const items = [];
        for (const plan of plans) {
            if (!DRAW_METHODS.has(plan.method)) {
                continue;
            }
            const item = await this._prepare(plan, false);
            if (item) {
                items.push(item);
            } else {
                this.skippedDraws++;
            }
        }
        if (step.commands.some((c) => c.method === "executeBundles")) {
            this.notes.add("Render bundles are not replayed; their draws are missing from the results.");
        }

        this.device.pushErrorScope("validation");
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({ colorAttachments, depthStencilAttachment });
        for (const item of items) {
            encodeDraw(pass, this.replay, item, width, height, null, null);
        }
        pass.end();
        this.device.queue.submit([encoder.finish()]);
        const error = await this.device.popErrorScope();
        if (error) {
            throw new Error(`Render pass ${step.begin.args?.[0]?.label ?? ""} failed validation during replay: ${error.message}`);
        }
    }

    async _computePass(step) {
        const plans = this._uploads(step.commands);
        const items = [];
        for (const plan of plans) {
            if (!DISPATCH_METHODS.has(plan.method)) {
                continue;
            }
            const item = await this._prepare(plan, true);
            if (item) {
                items.push(item);
            } else {
                this.skippedDraws++;
            }
        }
        this.device.pushErrorScope("validation");
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        for (const item of items) {
            pass.setPipeline(item.pipelineInfo.pipeline);
            for (const bg of item.bindGroups) {
                pass.setBindGroup(bg.index, bg.bindGroup, bg.dynamicOffsets ?? []);
            }
            const plan = item.plan;
            if (plan.method === "dispatchWorkgroups") {
                pass.dispatchWorkgroups(plan.args[0] ?? 1, plan.args[1] ?? 1, plan.args[2] ?? 1);
            } else {
                pass.dispatchWorkgroupsIndirect(this.replay.getBuffer(plan.indirect.bufferId), plan.indirect.offset);
            }
        }
        pass.end();
        this.device.queue.submit([encoder.finish()]);
        const error = await this.device.popErrorScope();
        if (error) {
            throw new Error(`Compute pass failed validation during replay: ${error.message}`);
        }
        // What a compute pass can write: its storage buffers and textures.
        for (const item of items) {
            for (const bgState of item.plan.bindGroups) {
                const entries = this.database.getObject(bgState?.bgId)?.descriptor?.entries ?? [];
                for (const entry of entries) {
                    const ref = entry.resource;
                    const bufferId = ref?.buffer?.__id;
                    const buffer = bufferId !== undefined ? this.database.getObject(bufferId) : null;
                    if (buffer && (buffer.descriptor?.usage & BUFFER_STORAGE)) {
                        this._gpuWrittenBuffers.add(bufferId);
                    }
                    const view = ref?.__id !== undefined ? this.database.getObject(ref.__id) : null;
                    if (view?.constructor?.className === "TextureView") {
                        const texture = this.database.getTextureFromView(view);
                        if (texture && (texture.descriptor?.usage & TEXTURE_STORAGE_BINDING)) {
                            this.written.add(texture.id);
                        }
                    }
                }
            }
        }
    }

    async _prepare(plan, compute) {
        if (plan.pipelineId === null || plan.pipelineId === undefined) {
            return null;
        }
        const pipeline = compute ? await this._computePipeline(plan.pipelineId) : await this._renderPipeline(plan.pipelineId);
        if (!pipeline) {
            return null;
        }
        const bindGroups = [];
        for (let g = 0; g < plan.bindGroups.length; ++g) {
            const state = plan.bindGroups[g];
            if (!state) {
                continue;
            }
            const bindGroup = await this._bindGroup(state.bgId, pipeline, plan.pipelineId, g);
            if (!bindGroup) {
                return null;
            }
            bindGroups.push({ index: g, bindGroup, dynamicOffsets: state.dynamicOffsets });
        }
        for (const vb of plan.vertexBuffers) {
            if (vb && !this.replay.getBuffer(vb.bufferId)) {
                return null;
            }
        }
        if (plan.method.startsWith("drawIndexed") && plan.indexBuffer && !this.replay.getBuffer(plan.indexBuffer.bufferId)) {
            return null;
        }
        if (plan.indirect && !this.replay.getBuffer(plan.indirect.bufferId)) {
            return null;
        }
        return { plan, pipelineInfo: { pipeline }, bindGroups };
    }

    async _transfer(command) {
        const args = command.args ?? [];
        const buffer = (ref) => (ref?.__id !== undefined ? this.replay.getBuffer(ref.__id) : null);
        const copyTexture = (ct) => {
            const record = ct?.texture?.__id !== undefined ? this.texture(ct.texture.__id) : null;
            return record ? { ...ct, texture: record.gpu } : null;
        };
        this.device.pushErrorScope("validation");
        const encoder = this.device.createCommandEncoder();
        switch (command.method) {
            case "copyBufferToBuffer": {
                const short = args[1]?.__id !== undefined;
                const src = buffer(args[0]);
                const dst = buffer(short ? args[1] : args[2]);
                if (!src || !dst) {
                    break;
                }
                if (short) {
                    encoder.copyBufferToBuffer(src, dst, args[2]);
                } else {
                    encoder.copyBufferToBuffer(src, args[1] ?? 0, dst, args[3] ?? 0, args[4]);
                }
                this._gpuWrittenBuffers.add((short ? args[1] : args[2]).__id);
                break;
            }
            case "clearBuffer": {
                const dst = buffer(args[0]);
                if (dst) {
                    encoder.clearBuffer(dst, args[1] ?? 0, args[2]);
                    this._gpuWrittenBuffers.add(args[0].__id);
                }
                break;
            }
            case "copyBufferToTexture": {
                const src = buffer(args[0]?.buffer);
                const dst = copyTexture(args[1]);
                if (src && dst) {
                    encoder.copyBufferToTexture({ ...args[0], buffer: src }, dst, args[2]);
                    this.written.add(args[1].texture.__id);
                }
                break;
            }
            case "copyTextureToBuffer": {
                const src = copyTexture(args[0]);
                const dst = buffer(args[1]?.buffer);
                if (src && dst) {
                    encoder.copyTextureToBuffer(src, { ...args[1], buffer: dst }, args[2]);
                    this._gpuWrittenBuffers.add(args[1].buffer.__id);
                }
                break;
            }
            case "copyTextureToTexture": {
                const src = copyTexture(args[0]);
                const dst = copyTexture(args[1]);
                if (src && dst) {
                    encoder.copyTextureToTexture(src, dst, args[2]);
                    this.written.add(args[1].texture.__id);
                }
                break;
            }
        }
        this.device.queue.submit([encoder.finish()]);
        const error = await this.device.popErrorScope();
        if (error) {
            throw new Error(`${command.method} failed during replay: ${error.message}`);
        }
    }
}

// ---------------------------------------------------------------------------
// Texture comparison
// ---------------------------------------------------------------------------

function sampleKind(format) {
    if (isDepthFormat(format)) {
        return format.startsWith("stencil") ? null : "depth";
    }
    if (/uint$/.test(format)) {
        return "uint";
    }
    if (/sint$/.test(format)) {
        return "sint";
    }
    return "float";
}

const DIFF_SHADERS = {};
function diffShader(kind) {
    if (!DIFF_SHADERS[kind]) {
        const type = kind === "depth" ? "texture_depth_2d" : kind === "uint" ? "texture_2d<u32>" : kind === "sint" ? "texture_2d<i32>" : "texture_2d<f32>";
        DIFF_SHADERS[kind] = `
@group(0) @binding(0) var a : ${type};
@group(0) @binding(1) var b : ${type};
@group(0) @binding(2) var mask : texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(3) var<storage, read_write> counts : array<atomic<u32>, 1>;
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id : vec3u) {
    let size = textureDimensions(a);
    if (id.x >= size.x || id.y >= size.y) {
        return;
    }
    let p = vec2i(id.xy);
    let va = textureLoad(a, p, 0);
    let vb = textureLoad(b, p, 0);
    if (any(vec4f(${kind === "depth" ? "va" : "vec4f(va)"}) != vec4f(${kind === "depth" ? "vb" : "vec4f(vb)"}))) {
        atomicAdd(&counts[0], 1u);
        textureStore(mask, p, vec4f(1.0, 0.1, 0.2, 1.0));
    } else {
        textureStore(mask, p, vec4f(0.0));
    }
}`;
    }
    return DIFF_SHADERS[kind];
}

/**
 * Compare mip 0, layer 0 of two replay textures of the same format.
 * @returns {Promise<{changed:number, total:number, mask:GPUTexture}|{skipped:string}>}
 *   mask is an rgba8unorm texture, opaque red where texels differ; the caller
 *   destroys it.
 */
export async function diffTextures(device, a, b) {
    const format = a.format;
    if (a.sampleCount > 1) {
        return { skipped: "multisampled (its resolve target is compared instead)" };
    }
    if (a.dimension !== "2d") {
        return { skipped: `${a.dimension} textures are not compared` };
    }
    const kind = sampleKind(format);
    if (!kind) {
        return { skipped: "stencil-only formats are not compared" };
    }
    const width = a.width;
    const height = a.height;
    const sampleType = kind === "depth" ? "depth" : kind === "float" ? "unfilterable-float" : kind;
    const layout = device.createBindGroupLayout({
        entries: [
            { binding: 0, visibility: 4, texture: { sampleType } },
            { binding: 1, visibility: 4, texture: { sampleType } },
            { binding: 2, visibility: 4, storageTexture: { access: "write-only", format: "rgba8unorm" } },
            { binding: 3, visibility: 4, buffer: { type: "storage" } },
        ],
    });
    const pipeline = device.createComputePipeline({
        layout: device.createPipelineLayout({ bindGroupLayouts: [layout] }),
        compute: { module: device.createShaderModule({ code: diffShader(kind) }), entryPoint: "main" },
    });
    const viewDesc = { dimension: "2d", baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 };
    if (kind === "depth") {
        viewDesc.aspect = "depth-only";
    }
    const mask = device.createTexture({ size: [width, height], format: "rgba8unorm", usage: TEXTURE_STORAGE_BINDING | TEXTURE_TEXTURE_BINDING | TEXTURE_COPY_SRC });
    const counts = device.createBuffer({ size: 4, usage: BUFFER_STORAGE | 0x0004 });
    const readback = device.createBuffer({ size: 4, usage: BUFFER_COPY_DST | BUFFER_MAP_READ });
    try {
        device.pushErrorScope("validation");
        const bindGroup = device.createBindGroup({
            layout,
            entries: [
                { binding: 0, resource: a.createView(viewDesc) },
                { binding: 1, resource: b.createView(viewDesc) },
                { binding: 2, resource: mask.createView() },
                { binding: 3, resource: { buffer: counts } },
            ],
        });
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(width / 8), Math.ceil(height / 8));
        pass.end();
        encoder.copyBufferToBuffer(counts, 0, readback, 0, 4);
        device.queue.submit([encoder.finish()]);
        const error = await device.popErrorScope();
        if (error) {
            mask.destroy();
            return { skipped: `could not be compared: ${error.message}` };
        }
        await readback.mapAsync(BUFFER_MAP_READ);
        const changed = new Uint32Array(readback.getMappedRange())[0];
        readback.unmap();
        return { changed, total: width * height, mask };
    } finally {
        counts.destroy();
        readback.destroy();
    }
}

/**
 * Compile & Replay: replay the frame as captured and with `code` replacing
 * shader module `moduleId`, and compare every texture the edit could affect.
 *
 * @returns {Promise<Object>} { results: [{ texture, before, after, changed,
 *   total, mask, skipped }], baseline, edited, notes, affectedSteps } — the
 *   caller must call dispose() on the result when done with the textures.
 */
export async function compileAndReplay({ device, database, commands, getTextureFromAttachment, moduleId, code, onProgress }) {
    if (!device) {
        throw new Error("The DevTools GPU device is not available.");
    }
    const steps = collectReplaySteps(commands);
    const { firstAffected, affected } = affectedTextures(steps, database, moduleId);
    if (firstAffected < 0) {
        throw new Error("No draw or dispatch in this capture uses the shader module.");
    }

    const baseline = new FrameReplay({ device, database, getTextureFromAttachment });
    const edited = new FrameReplay({ device, database, getTextureFromAttachment, overrides: new Map([[moduleId, code]]) });
    const disposables = [];
    const dispose = () => {
        for (const d of disposables) {
            try {
                d.destroy();
            } catch (_) { /* ignore */ }
        }
        baseline.destroy();
        edited.destroy();
    };
    try {
        await edited.run(commands, (done, total) => onProgress?.(`Replaying with the edit… ${done}/${total}`));
        await baseline.run(commands, (done, total) => onProgress?.(`Replaying as captured… ${done}/${total}`));

        const results = [];
        onProgress?.("Comparing render targets…");
        for (const id of affected) {
            const before = baseline.textures.get(id);
            const after = edited.textures.get(id);
            if (!before || !after) {
                continue;
            }
            const diff = await diffTextures(device, before.gpu, after.gpu);
            if (diff.mask) {
                disposables.push(diff.mask);
            }
            results.push({ texture: before.texture, before: before.gpu, after: after.gpu, ...diff });
        }
        results.sort((a, b) => (b.changed ?? -1) - (a.changed ?? -1));
        const notes = [...new Set([...edited.notes, ...baseline.notes])];
        for (const failure of edited.failedSteps) {
            notes.push(failure.message);
        }
        if (edited.skippedDraws) {
            notes.push(`${edited.skippedDraws} draw(s) or dispatch(es) could not be replayed and are missing from both runs.`);
        }
        return { results, notes, affectedSteps: steps.length - firstAffected, dispose };
    } catch (e) {
        dispose();
        throw e;
    }
}

/**
 * The textures an edit to a shader module can change: everything written at
 * or after the first step whose pipelines use the module.
 * @returns {{firstAffected:number, affected:Set<number>}} firstAffected is -1
 *   when no step uses the module
 */
export function affectedTextures(steps, database, moduleId) {
    const getObject = (id) => database.getObject(id);
    const firstAffected = steps.findIndex((step) => stepModules(step, getObject).has(moduleId));
    const affected = new Set();
    if (firstAffected >= 0) {
        for (const step of steps.slice(firstAffected)) {
            for (const id of writtenBy(step, database)) {
                affected.add(id);
            }
        }
    }
    return { firstAffected, affected };
}

// The texture ids a step writes, resolved without replaying it.
function writtenBy(step, db) {
    const ids = new Set();
    const texOf = (ref) => {
        if (!ref) {
            return null;
        }
        if (ref.__texture?.__id !== undefined) {
            return ref.__texture.__id;
        }
        const view = db.getObject(ref.__id);
        return view ? db.getTextureFromView(view)?.id ?? null : null;
    };
    if (step.kind === "render") {
        const desc = step.begin.args?.[0] ?? {};
        for (const a of desc.colorAttachments ?? []) {
            for (const id of [texOf(a?.view), texOf(a?.resolveTarget)]) {
                if (id !== null && id !== undefined) {
                    ids.add(id);
                }
            }
        }
        const ds = desc.depthStencilAttachment;
        if (ds && !(ds.depthReadOnly && ds.stencilReadOnly)) {
            const id = texOf(ds.view);
            if (id !== null && id !== undefined) {
                ids.add(id);
            }
        }
    } else if (step.kind === "compute") {
        for (const command of step.commands) {
            if (command.method !== "setBindGroup") {
                continue;
            }
            for (const entry of db.getObject(command.args?.[1]?.__id)?.descriptor?.entries ?? []) {
                const view = entry.resource?.__id !== undefined ? db.getObject(entry.resource.__id) : null;
                if (view?.constructor?.className === "TextureView") {
                    const texture = db.getTextureFromView(view);
                    if (texture && (texture.descriptor?.usage & TEXTURE_STORAGE_BINDING)) {
                        ids.add(texture.id);
                    }
                }
            }
        }
    } else if (step.command.method === "copyBufferToTexture" || step.command.method === "copyTextureToTexture") {
        const id = step.command.args?.[1]?.texture?.__id;
        if (id !== undefined) {
            ids.add(id);
        }
    }
    return ids;
}
