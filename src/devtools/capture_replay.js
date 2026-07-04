// GPU replay of a captured frame on the DevTools panel's own device.
//
// CaptureReplay materializes real GPU objects (buffers, textures, samplers,
// bind group layouts, pipelines, bind groups) from the capture database's
// stored descriptors, resolving {__id} cross-references, and uploads the
// buffer bytes the capture attached to binding commands. It is the seed for
// general frame replay; the first consumer is the overdraw view.
//
// replayOverdraw() re-encodes every render pass that targets a texture, using
// each draw's original vertex stage but a stub fragment shader that outputs 1
// into an r16float target with additive blending — so the real GPU rasterizer
// counts, per pixel, how many fragments the frame rasterized. Because the
// depth/stencil attachment is dropped and the stub shader never discards,
// counts are rasterized fragments (after culling, viewport, scissor, and depth
// clip), matching the CPU engine in overdraw.js — but including indirect
// draws, all topologies, and running at GPU speed.

// Usage flag constants (kept literal so this module imports under node for
// unit tests, where the WebGPU globals don't exist).
const BUFFER_MAP_READ = 0x0001;
const BUFFER_MAP_WRITE = 0x0002;
const BUFFER_COPY_SRC = 0x0004;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_QUERY_RESOLVE = 0x0200;
const MAX_QUERIES_PER_SET = 4096;
const TEXTURE_COPY_SRC = 0x01;
const TEXTURE_TEXTURE_BINDING = 0x04;
const TEXTURE_RENDER_ATTACHMENT = 0x10;

const COUNT_FORMAT = "r16float";
const F16_MAX = 65504;

const STUB_FRAGMENT = `@fragment fn overdrawMain() -> @location(0) vec4f { return vec4f(1.0); }`;

// Decode an IEEE half-float bit pattern to a number.
export function halfToFloat(h) {
    const sign = h & 0x8000 ? -1 : 1;
    const exponent = (h >> 10) & 0x1f;
    const mantissa = h & 0x3ff;
    if (exponent === 0) {
        return sign * mantissa * 2 ** -24;
    }
    if (exponent === 31) {
        return mantissa ? NaN : sign * Infinity;
    }
    return sign * (1024 + mantissa) * 2 ** (exponent - 25);
}

// The (group, binding) pairs a shader entry point statically uses, as a Set of
// "group:binding" strings — what WebGPU's "auto" pipeline layout contains for
// that stage. Returns null if the entry point can't be found.
export function vertexStageBindings(reflection, entryPoint) {
    const entries = reflection?.entry?.vertex;
    if (!entries?.length) {
        return null;
    }
    const entry = (entryPoint ? entries.find((e) => e.name === entryPoint) : null) ?? entries[0];
    if (!entry) {
        return null;
    }
    const bindings = new Set();
    for (const r of entry.resources ?? []) {
        bindings.add(`${r.group}:${r.binding}`);
    }
    return bindings;
}

function isDepthStencilFormat(format) {
    return !!format && (format.includes("depth") || format.includes("stencil"));
}

function align(value, alignment) {
    return Math.ceil(value / alignment) * alignment;
}

// ---------------------------------------------------------------------------
// CaptureReplay: descriptor → GPU object materialization
// ---------------------------------------------------------------------------

export class CaptureReplay {
    constructor(device, database) {
        this.device = device;
        this.database = database;
        this.notes = new Set();
        this.placeholderTextures = new Set(); // texture ids bound with stand-in contents
        this._objects = new Map(); // memo key -> materialized object (or null)
        this._destroyables = [];   // GPUBuffers/GPUTextures we created
    }

    destroy() {
        for (const obj of this._destroyables) {
            try {
                obj.destroy();
            } catch (_) { /* already destroyed */ }
        }
        this._destroyables.length = 0;
        this._objects.clear();
    }

    _memo(key, create) {
        if (this._objects.has(key)) {
            return this._objects.get(key);
        }
        let result = null;
        try {
            result = create();
        } catch (e) {
            this.notes.add(`Replay object creation failed: ${e.message ?? e}`);
        }
        this._objects.set(key, result);
        return result;
    }

    getShaderModule(id) {
        return this._memo(`shader:${id}`, () => {
            const module = this.database.getObject(id);
            const code = module?.code;
            if (!code) {
                return null;
            }
            return this.device.createShaderModule({ code });
        });
    }

    getBindGroupLayout(id) {
        return this._memo(`bgl:${id}`, () => {
            const bgl = this.database.getObject(id);
            // Layouts that came from pipeline.getBindGroupLayout() have no
            // creation descriptor; the caller falls back to the auto path.
            if (!bgl?.descriptor?.entries) {
                return null;
            }
            return this.device.createBindGroupLayout(bgl.descriptor);
        });
    }

    getPipelineLayout(id) {
        return this._memo(`layout:${id}`, () => {
            const layout = this.database.getObject(id);
            const bglRefs = layout?.descriptor?.bindGroupLayouts;
            if (!bglRefs) {
                return null;
            }
            const bindGroupLayouts = [];
            for (const ref of bglRefs) {
                const bgl = this.getBindGroupLayout(ref?.__id);
                if (!bgl) {
                    return null;
                }
                bindGroupLayouts.push(bgl);
            }
            return { layout: this.device.createPipelineLayout({ bindGroupLayouts }), bindGroupLayouts };
        });
    }

    getSampler(id) {
        return this._memo(`sampler:${id}`, () => {
            const sampler = this.database.getObject(id);
            return this.device.createSampler(sampler?.descriptor ?? undefined);
        });
    }

    // A GPUBuffer sized like the original, with COPY_DST so captured bytes can
    // be uploaded. Contents start zeroed; uploads happen per pass.
    getBuffer(id) {
        return this._memo(`buffer:${id}`, () => {
            const buffer = this.database.getObject(id);
            const desc = buffer?.descriptor;
            if (!desc?.size) {
                return null;
            }
            const usage = (desc.usage & ~(BUFFER_MAP_READ | BUFFER_MAP_WRITE)) | BUFFER_COPY_DST;
            const gpuBuffer = this.device.createBuffer({ size: desc.size, usage });
            this._destroyables.push(gpuBuffer);
            return gpuBuffer;
        });
    }

    // A GPUTexture to satisfy a texture binding. Reuses the panel's captured
    // copy (texture.gpuTexture) when it's compatible; depth-stencil and
    // multisampled textures get an uninitialized stand-in with the original
    // format, since their captured copies are format-converted.
    getTexture(id) {
        return this._memo(`texture:${id}`, () => {
            const texture = this.database.getObject(id);
            const desc = texture?.descriptor;
            if (!desc) {
                return null;
            }
            const isDepth = isDepthStencilFormat(desc.format);
            const isMultisampled = (desc.sampleCount ?? 1) > 1;
            if (!isDepth && !isMultisampled && texture.gpuTexture?.object) {
                return texture.gpuTexture.object;
            }
            const gpuTexture = this.device.createTexture({
                label: `overdraw stand-in for ${texture.label || `Texture ${id}`}`,
                size: [texture.width, texture.height, texture.depthOrArrayLayers ?? 1],
                dimension: desc.dimension ?? "2d",
                format: desc.format,
                mipLevelCount: desc.mipLevelCount ?? 1,
                sampleCount: desc.sampleCount ?? 1,
                usage: TEXTURE_TEXTURE_BINDING | TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SRC,
            });
            this._destroyables.push(gpuTexture);
            // The caller decides whether this is worth a note: placeholder
            // contents only matter when the vertex stage samples the texture.
            this.placeholderTextures.add(id);
            return gpuTexture;
        });
    }
}

// ---------------------------------------------------------------------------
// Overdraw replay
// ---------------------------------------------------------------------------

// Run `create` inside a validation error scope; returns null (with a note) if
// the created object is invalid.
async function validated(replay, what, create) {
    replay.device.pushErrorScope("validation");
    let result = null;
    try {
        result = create();
    } catch (e) {
        await replay.device.popErrorScope();
        replay.notes.add(`${what}: ${e.message ?? e}`);
        return null;
    }
    const error = await replay.device.popErrorScope();
    if (error) {
        replay.notes.add(`${what}: ${error.message}`);
        return null;
    }
    return result;
}

// Materialize the replay variant of a captured render pipeline: original
// vertex stage and primitive state, stub fragment stage writing 1 to the
// additive r16float count target, no depth-stencil, no multisampling.
// `ignoreCull` disables face culling — the pixel-coverage query uses it so
// culled-but-covering draws are still detected (the CPU simulation reports
// why they didn't contribute).
async function getOverdrawPipeline(replay, pipelineId, stubModule, ignoreCull = false) {
    const key = `overdraw-pipeline:${pipelineId}:${ignoreCull ? 1 : 0}`;
    if (replay._objects.has(key)) {
        return replay._objects.get(key);
    }

    const build = async () => {
        const pipeline = replay.database.getObject(pipelineId);
        const desc = pipeline?.descriptor;
        if (!desc?.vertex) {
            return { error: "The draw's render pipeline was not captured." };
        }

        const vertexModuleObj = replay.database.getObject(desc.vertex.module?.__id);
        const vertexModule = replay.getShaderModule(desc.vertex.module?.__id);
        if (!vertexModule) {
            return { error: "The draw's vertex shader was not captured." };
        }
        const vsBindings = vertexStageBindings(vertexModuleObj?.reflection, desc.vertex.entryPoint);

        // Prefer the original explicit layout; fall back to "auto" when it (or
        // any of its bind group layouts) has no captured descriptor.
        let layout = "auto";
        let layoutBGLs = null;
        if (desc.layout && desc.layout !== "auto") {
            const pl = replay.getPipelineLayout(desc.layout.__id);
            if (pl) {
                layout = pl.layout;
                layoutBGLs = pl.bindGroupLayouts;
            }
        }
        if (layout === "auto" && !vsBindings) {
            return { error: "The pipeline layout requires shader reflection, which failed for the vertex shader." };
        }

        const primitive = { ...(desc.primitive ?? {}) };
        if (ignoreCull) {
            primitive.cullMode = "none";
        }
        if (primitive.unclippedDepth && !replay.device.features.has("depth-clip-control")) {
            delete primitive.unclippedDepth;
            replay.notes.add("A pipeline uses unclippedDepth but the DevTools device lacks depth-clip-control; depth clipping is applied.");
        }
        if ((desc.multisample?.count ?? 1) > 1) {
            replay.notes.add("A multisampled pipeline is replayed at one sample per pixel.");
        }

        const vertex = {
            module: vertexModule,
            entryPoint: desc.vertex.entryPoint,
            buffers: desc.vertex.buffers ?? undefined,
        };
        if (desc.vertex.constants) {
            vertex.constants = desc.vertex.constants;
        }

        const gpuPipeline = await validated(replay, `Pipeline ${pipeline.label || pipelineId} could not be replayed`, () =>
            replay.device.createRenderPipeline({
                label: `overdraw ${pipeline.label || pipelineId}`,
                layout,
                vertex,
                primitive,
                fragment: {
                    module: stubModule,
                    entryPoint: "overdrawMain",
                    targets: [{
                        format: COUNT_FORMAT,
                        blend: {
                            color: { srcFactor: "one", dstFactor: "one", operation: "add" },
                            alpha: { srcFactor: "one", dstFactor: "one", operation: "add" },
                        },
                    }],
                },
            }));
        if (!gpuPipeline) {
            return { error: "The pipeline could not be re-created for replay." };
        }
        return { pipeline: gpuPipeline, isAuto: layout === "auto", layoutBGLs, vsBindings };
    };

    const info = await build();
    replay._objects.set(key, info);
    return info;
}

// Whether the vertex stage can read a bind group entry: prefer the shader's
// reflected resource usage; fall back to the bind group layout's declared
// visibility; assume yes when neither is known.
function vertexStageUsesBinding(replay, pipelineInfo, bgObj, groupIndex, binding) {
    if (pipelineInfo.vsBindings) {
        return pipelineInfo.vsBindings.has(`${groupIndex}:${binding}`);
    }
    const bglEntries = replay.database.getObject(bgObj.descriptor.layout?.__id)?.descriptor?.entries;
    const layoutEntry = bglEntries?.find((e) => e.binding === binding);
    if (layoutEntry?.visibility !== undefined) {
        return (layoutEntry.visibility & 1) !== 0; // GPUShaderStage.VERTEX
    }
    return true;
}

// Materialize a bind group for a draw. With an explicit layout the original
// entries are used verbatim; with an "auto" layout the entries are filtered to
// the bindings the vertex shader statically uses (matching what the auto
// layout contains for the replaced-fragment pipeline).
async function getBindGroupForDraw(replay, pipelineInfo, pipelineId, groupIndex, bgState) {
    const bgId = bgState.bgId;
    const bgObj = replay.database.getObject(bgId);
    if (!bgObj?.descriptor?.entries) {
        return { error: `Bind group ${bgId} was not captured.` };
    }

    let layout = replay.getBindGroupLayout(bgObj.descriptor.layout?.__id) ??
        (pipelineInfo.layoutBGLs ? pipelineInfo.layoutBGLs[groupIndex] : null);
    let filter = null;
    let key = `bg:${bgId}:${groupIndex}:${pipelineInfo.layoutBGLs ? pipelineId : "own"}`;
    if (!layout) {
        // Auto layouts never have dynamic offsets, so original dynamic offsets
        // can't be replayed through one.
        if (bgState.dynamicOffsets?.length) {
            return { error: "The bind group uses dynamic offsets but its layout descriptor was not captured." };
        }
        layout = pipelineInfo.pipeline.getBindGroupLayout(groupIndex);
        filter = pipelineInfo.vsBindings;
        key = `bg-auto:${pipelineId}:${groupIndex}:${bgId}`;
    }

    if (replay._objects.has(key)) {
        return replay._objects.get(key);
    }

    const build = async () => {
        const entries = [];
        for (const entry of bgObj.descriptor.entries) {
            if (filter && !filter.has(`${groupIndex}:${entry.binding}`)) {
                continue;
            }
            if (entry.resource?.buffer?.__id !== undefined) {
                const gpuBuffer = replay.getBuffer(entry.resource.buffer.__id);
                if (!gpuBuffer) {
                    return { error: `A bound buffer (binding ${entry.binding}) was not captured.` };
                }
                const resource = { buffer: gpuBuffer };
                if (entry.resource.offset) {
                    resource.offset = entry.resource.offset;
                }
                if (entry.resource.size) {
                    resource.size = entry.resource.size;
                }
                entries.push({ binding: entry.binding, resource });
                continue;
            }
            const resourceObj = replay.database.getObject(entry.resource?.__id);
            const className = resourceObj?.constructor?.className;
            if (className === "TextureView") {
                const texture = replay.database.getTextureFromView(resourceObj);
                const gpuTexture = texture ? replay.getTexture(texture.id) : null;
                if (!gpuTexture) {
                    return { error: `A bound texture (binding ${entry.binding}) was not captured.` };
                }
                // Placeholder contents only affect counts when the vertex
                // stage samples the texture (fragment-only bindings — shadow
                // maps and the like — are irrelevant to the stub shader).
                if (replay.placeholderTextures.has(texture.id) &&
                    vertexStageUsesBinding(replay, pipelineInfo, bgObj, groupIndex, entry.binding)) {
                    replay.notes.add(`Texture ${texture.label || texture.id} is sampled by a vertex shader but is bound with placeholder contents (its data isn't available in the original format); positions may be wrong.`);
                }
                entries.push({ binding: entry.binding, resource: gpuTexture.createView(resourceObj.descriptor ?? undefined) });
            } else if (className === "Sampler") {
                const sampler = replay.getSampler(entry.resource.__id);
                if (!sampler) {
                    return { error: `A bound sampler (binding ${entry.binding}) could not be re-created.` };
                }
                entries.push({ binding: entry.binding, resource: sampler });
            } else {
                return { error: `Binding ${entry.binding} uses a resource type replay doesn't support (e.g. an external texture).` };
            }
        }
        const bindGroup = await validated(replay, `Bind group ${bgObj.label || bgId} could not be replayed`, () =>
            replay.device.createBindGroup({ layout, entries }));
        return bindGroup ? { bindGroup } : { error: "The bind group could not be re-created for replay." };
    };

    const info = await build();
    replay._objects.set(key, info);
    return info;
}

// Mirror of the capture-side bind-group buffer plan (_getBindGroupCapturePlan
// in webgpu_inspector.js): which offset each command.bufferData[entryIndex]
// slice was read from, so uploads land where the replayed binding reads.
function bindGroupUploads(replay, command, uploads, missing) {
    if (!command.bufferData) {
        return;
    }
    const bgObj = replay.database.getObject(command.args[1]?.__id);
    const entries = bgObj?.descriptor?.entries;
    if (!entries) {
        return;
    }
    const bglEntries = replay.database.getObject(bgObj.descriptor.layout?.__id)?.descriptor?.entries;

    // Dynamic offsets arrive in positional BGL-entry order; the capture
    // consumed them reordered by binding number. Reproduce that ordering.
    let mappedDynamicOffsets = null;
    const dynamicOffsets = Array.isArray(command.args[2]) ? command.args[2] : null;
    if (bglEntries && dynamicOffsets?.length) {
        const dynEntries = [];
        let srcIndex = 0;
        for (const e of bglEntries) {
            if (e.buffer?.hasDynamicOffset) {
                dynEntries.push({ binding: parseInt(e.binding), srcIndex: srcIndex++ });
            }
        }
        dynEntries.sort((a, b) => a.binding - b.binding);
        mappedDynamicOffsets = dynEntries.map((e) => dynamicOffsets[e.srcIndex]);
    }

    let dynIdx = 0;
    for (let entryIndex = 0; entryIndex < entries.length; ++entryIndex) {
        const entry = entries[entryIndex];
        const bufferRef = entry?.resource?.buffer;
        if (!bufferRef) {
            continue;
        }
        const layoutEntry = bglEntries ? bglEntries[entryIndex] : undefined;
        let offset = entry.resource.offset ?? 0;
        if (layoutEntry?.buffer?.hasDynamicOffset && mappedDynamicOffsets) {
            offset = mappedDynamicOffsets[dynIdx++];
        }
        const bufferObj = replay.database.getObject(bufferRef.__id);
        const expected = align(entry.resource.size ?? ((bufferObj?.descriptor?.size ?? 0) - offset), 4);
        addUpload(replay, command, entryIndex, bufferRef.__id, offset, expected, uploads, missing);
    }
}

function addUpload(replay, command, entryIndex, bufferId, offset, expectedSize, uploads, missing) {
    const data = command.bufferData?.[entryIndex];
    const bufferObj = replay.database.getObject(bufferId);
    const name = bufferObj?.label || `Buffer ${bufferId}`;
    if (!data) {
        missing.add(`${name}: no captured bytes — its contents replay as zeros.`);
        return;
    }
    if (command.isBufferDataLoaded && command.isBufferDataLoaded[entryIndex] === false) {
        missing.add(`${name}: captured bytes are still loading; contents may be incomplete.`);
    } else if (expectedSize && data.length < expectedSize) {
        missing.add(`${name}: truncated by the capture's Max Buffer Size (${data.length} of ${expectedSize} bytes); capture again with a larger Max Buffer Size.`);
    }
    uploads.push({ bufferId, offset, data });
}

// Encode a batch of prepared draws as one render pass over the count target
// (loadOp "load": the target is cleared once up front, so counts accumulate
// across batches and passes). Each draw sets its complete state, so ordering
// quirks can't leak between draws.
// Encode one prepared draw into a render pass, setting its complete state so
// ordering quirks can't leak between draws. `scissorOverride` replaces the
// draw's scissor (the pixel-coverage query restricts rasterization to one
// pixel — deliberately ignoring the original scissor, so scissored-out draws
// are still detected and the simulation can report why they didn't land).
function encodeDraw(pass, replay, item, width, height, scissorOverride) {
    const { plan, pipelineInfo, bindGroups } = item;
    pass.setPipeline(pipelineInfo.pipeline);
    for (const bg of bindGroups) {
        if (bg.dynamicOffsets?.length) {
            pass.setBindGroup(bg.index, bg.bindGroup, bg.dynamicOffsets);
        } else {
            pass.setBindGroup(bg.index, bg.bindGroup);
        }
    }
    for (let slot = 0; slot < plan.vertexBuffers.length; ++slot) {
        const vb = plan.vertexBuffers[slot];
        if (!vb) {
            continue;
        }
        const gpuBuffer = replay.getBuffer(vb.bufferId);
        if (gpuBuffer) {
            pass.setVertexBuffer(slot, gpuBuffer, vb.offset, vb.size);
        }
    }
    if (plan.indexBuffer) {
        const gpuBuffer = replay.getBuffer(plan.indexBuffer.bufferId);
        if (gpuBuffer) {
            pass.setIndexBuffer(gpuBuffer, plan.indexBuffer.format, plan.indexBuffer.offset, plan.indexBuffer.size);
        }
    }
    const vp = plan.viewport;
    pass.setViewport(vp?.[0] ?? 0, vp?.[1] ?? 0, vp?.[2] ?? width, vp?.[3] ?? height, vp?.[4] ?? 0, vp?.[5] ?? 1);
    const sc = scissorOverride ?? plan.scissor;
    pass.setScissorRect(sc?.[0] ?? 0, sc?.[1] ?? 0, sc?.[2] ?? width, sc?.[3] ?? height);

    if (plan.method === "draw") {
        pass.draw(plan.args[0], plan.args[1] ?? 1, plan.args[2] ?? 0, plan.args[3] ?? 0);
    } else if (plan.method === "drawIndexed") {
        pass.drawIndexed(plan.args[0], plan.args[1] ?? 1, plan.args[2] ?? 0, plan.args[3] ?? 0, plan.args[4] ?? 0);
    } else if (plan.method === "drawIndirect") {
        pass.drawIndirect(replay.getBuffer(plan.indirect.bufferId), plan.indirect.offset);
    } else if (plan.method === "drawIndexedIndirect") {
        pass.drawIndexedIndirect(replay.getBuffer(plan.indirect.bufferId), plan.indirect.offset);
    }
}

function encodeDraws(replay, draws, countView, width, height) {
    const encoder = replay.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
        colorAttachments: [{ view: countView, loadOp: "load", storeOp: "store" }],
    });
    for (const item of draws) {
        encodeDraw(pass, replay, item, width, height, null);
    }
    pass.end();
    return encoder.finish();
}

// Submit a batch of draws; returns null on success or the validation message.
async function trySubmitDraws(replay, draws, countView, width, height) {
    replay.device.pushErrorScope("validation");
    try {
        const commandBuffer = encodeDraws(replay, draws, countView, width, height);
        replay.device.queue.submit([commandBuffer]);
    } catch (e) {
        await replay.device.popErrorScope();
        return `${e.message ?? e}`;
    }
    const error = await replay.device.popErrorScope();
    return error ? error.message : null;
}

// Submit draws with failure isolation. A single invalid draw invalidates the
// whole command buffer — nothing executes — so a naive one-pass encode loses
// every count when any draw fails validation (e.g. a bind group that isn't
// group-equivalent to the re-created pipeline layout). Bisect on failure so
// only the genuinely bad draws are skipped, with a note.
async function submitDraws(replay, draws, countView, width, height, stats) {
    if (!draws.length) {
        return;
    }
    const error = await trySubmitDraws(replay, draws, countView, width, height);
    if (error === null) {
        return;
    }
    if (draws.length === 1) {
        stats.skippedDraws++;
        replay.notes.add(`Not counted — ${draws[0].plan.method}: failed validation during replay: ${error}`);
        return;
    }
    const mid = draws.length >> 1;
    await submitDraws(replay, draws.slice(0, mid), countView, width, height, stats);
    await submitDraws(replay, draws.slice(mid), countView, width, height, stats);
}

// Walk one captured render pass's commands, tracking encoder state, and
// produce a plan per draw carrying the complete state that draw needs (plus
// the captured-byte uploads the pass requires).
function walkPassCommands(replay, passCommands, uploads, missing, stats) {
    const state = {
        pipelineId: null,
        bindGroups: [],
        vertexBuffers: [],
        indexBuffer: null,
        viewport: null,
        scissor: null,
    };
    const drawPlans = [];

    for (const command of passCommands) {
        const args = command.args ?? [];
        switch (command.method) {
            case "setPipeline":
                state.pipelineId = args[0]?.__id;
                break;
            case "setBindGroup":
                state.bindGroups[args[0]] = { bgId: args[1]?.__id, dynamicOffsets: Array.isArray(args[2]) ? args[2] : null };
                bindGroupUploads(replay, command, uploads, missing);
                break;
            case "setVertexBuffer": {
                const offset = args[2] ?? 0;
                const bufferObj = replay.database.getObject(args[1]?.__id);
                const expected = args[3] ?? ((bufferObj?.descriptor?.size ?? 0) - offset);
                // Captured args pass through JSON, which turns an omitted
                // (undefined) size into null — and WebIDL coerces null to a
                // zero-size binding rather than "rest of the buffer".
                // Normalize back to undefined.
                state.vertexBuffers[args[0]] = { bufferId: args[1]?.__id, offset, size: args[3] ?? undefined };
                addUpload(replay, command, args[0], args[1]?.__id, offset, expected, uploads, missing);
                break;
            }
            case "setIndexBuffer": {
                const bufferObj = replay.database.getObject(args[0]?.__id);
                state.indexBuffer = { bufferId: args[0]?.__id, format: args[1], offset: args[2] ?? 0, size: args[3] ?? undefined };
                addUpload(replay, command, 0, args[0]?.__id, 0, bufferObj?.descriptor?.size ?? 0, uploads, missing);
                break;
            }
            case "setViewport":
                state.viewport = args.slice(0, 6);
                break;
            case "setScissorRect":
                state.scissor = args.slice(0, 4);
                break;
            case "executeBundles":
                stats.skippedDraws++;
                replay.notes.add("Render bundles are not replayed; their draws are not counted.");
                break;
            case "draw":
            case "drawIndexed":
            case "drawIndirect":
            case "drawIndexedIndirect": {
                const plan = {
                    command,
                    method: command.method,
                    args,
                    pipelineId: state.pipelineId,
                    bindGroups: state.bindGroups.slice(),
                    vertexBuffers: state.vertexBuffers.slice(),
                    indexBuffer: state.indexBuffer,
                    viewport: state.viewport,
                    scissor: state.scissor,
                };
                if (command.method === "drawIndirect" || command.method === "drawIndexedIndirect") {
                    const bufferObj = replay.database.getObject(args[0]?.__id);
                    plan.indirect = { bufferId: args[0]?.__id, offset: args[1] ?? 0 };
                    addUpload(replay, command, 0, args[0]?.__id, 0, bufferObj?.descriptor?.size ?? 0, uploads, missing);
                }
                drawPlans.push(plan);
                break;
            }
        }
    }

    return drawPlans;
}

// Materialize one draw plan's GPU objects (pipeline + bind groups), each
// validated once. Returns { pipelineInfo, bindGroups } or { error }.
async function prepareDraw(replay, plan, stubModule, ignoreCull) {
    const pipelineInfo = await getOverdrawPipeline(replay, plan.pipelineId, stubModule, ignoreCull);
    if (pipelineInfo.error) {
        return { error: pipelineInfo.error };
    }
    const bindGroups = [];
    let failed = null;
    for (let g = 0; g < plan.bindGroups.length; ++g) {
        const bgState = plan.bindGroups[g];
        if (!bgState) {
            continue;
        }
        const info = await getBindGroupForDraw(replay, pipelineInfo, plan.pipelineId, g, bgState);
        if (info.error) {
            failed = info.error;
            break;
        }
        bindGroups.push({ index: g, bindGroup: info.bindGroup, dynamicOffsets: bgState.dynamicOffsets });
    }
    if (!failed) {
        // A draw referencing a buffer that couldn't be re-created must be
        // skipped up front: encoding it would invalidate the whole pass and
        // lose every other draw's results.
        for (const vb of plan.vertexBuffers) {
            if (vb && !replay.getBuffer(vb.bufferId)) {
                failed = "A vertex buffer could not be re-created.";
                break;
            }
        }
        if (!failed && plan.method.startsWith("drawIndexed") && plan.indexBuffer && !replay.getBuffer(plan.indexBuffer.bufferId)) {
            failed = "The index buffer could not be re-created.";
        }
        if (!failed && plan.indirect && !replay.getBuffer(plan.indirect.bufferId)) {
            failed = "The indirect argument buffer could not be re-created.";
        }
    }
    if (failed) {
        return { error: failed };
    }
    return { pipelineInfo, bindGroups };
}

// Upload captured buffer contents (writeBuffer requires 4-byte-aligned sizes;
// pad the tail when a captured slice isn't).
function applyUploads(replay, uploads) {
    for (const upload of uploads) {
        const gpuBuffer = replay.getBuffer(upload.bufferId);
        if (!gpuBuffer) {
            continue;
        }
        let data = upload.data;
        if (data.length % 4) {
            const padded = new Uint8Array(align(data.length, 4));
            padded.set(data);
            data = padded;
        }
        const room = gpuBuffer.size - upload.offset;
        if (room <= 0) {
            continue;
        }
        if (data.length > room) {
            data = data.subarray(0, room & ~3);
        }
        replay.device.queue.writeBuffer(gpuBuffer, upload.offset, data);
    }
}

// Replay one captured render pass into the count target: walk its commands,
// materialize each draw's pipeline/bind groups, upload the captured buffer
// bytes, then encode and submit with failure isolation.
async function replayPass(replay, passCommands, countView, width, height, stubModule, stats) {
    const uploads = [];
    const missing = new Set();
    const plans = walkPassCommands(replay, passCommands, uploads, missing, stats);
    for (const note of missing) {
        replay.notes.add(note);
    }
    const encodable = [];
    for (const plan of plans) {
        if (plan.pipelineId === null || plan.pipelineId === undefined) {
            stats.skippedDraws++;
            continue;
        }
        const prep = await prepareDraw(replay, plan, stubModule, false);
        if (prep.error) {
            stats.skippedDraws++;
            replay.notes.add(`Not counted — ${plan.method}: ${prep.error}`);
            continue;
        }
        encodable.push({ plan, pipelineInfo: prep.pipelineInfo, bindGroups: prep.bindGroups });
    }
    applyUploads(replay, uploads);
    await submitDraws(replay, encodable, countView, width, height, stats);
}

// Collect the frame's render passes that have `targetTexture` attached (color
// or depth-stencil), as slices of the command list. Exported for unit tests.
export function collectTargetPasses(commands, targetTexture, getTextureFromAttachment) {
    const passes = [];
    let current = null;
    let msaa = false;
    for (const command of commands) {
        if (!command) {
            continue;
        }
        if (command.method === "beginRenderPass") {
            const desc = command.args?.[0] ?? {};
            let isTarget = false;
            const attachments = [...(desc.colorAttachments ?? [])];
            if (desc.depthStencilAttachment) {
                attachments.push(desc.depthStencilAttachment);
            }
            for (const attachment of attachments) {
                if (!attachment) {
                    continue;
                }
                const texture = getTextureFromAttachment(attachment);
                if (texture?.id === targetTexture.id) {
                    isTarget = true;
                }
                if (attachment.resolveTarget || (texture?.descriptor?.sampleCount ?? 1) > 1) {
                    msaa = true;
                }
            }
            current = isTarget ? [] : null;
            continue;
        }
        if (current === null) {
            continue;
        }
        if (command.method === "end") {
            passes.push(current);
            current = null;
            continue;
        }
        current.push(command);
    }
    return { passes, msaa };
}

// Count the frame's rasterized fragments per pixel of `targetTexture` by GPU
// replay. Returns the same result shape as overdraw.js's computeOverdraw,
// plus `gpu: true`. Throws when replay is impossible (no device); per-draw
// problems become notes/skips instead.
export async function replayOverdraw({ device, database, commands, targetTexture, getTextureFromAttachment }) {
    if (!device) {
        throw new Error("The DevTools GPU device is not available.");
    }
    const width = targetTexture.width;
    const height = targetTexture.height;
    if (!width || !height) {
        throw new Error("The target texture has no size.");
    }

    const replay = new CaptureReplay(device, database);
    const stats = { skippedDraws: 0 };
    const { passes, msaa } = collectTargetPasses(commands, targetTexture, getTextureFromAttachment);
    if (msaa) {
        replay.notes.add("A multisampled attachment is counted at one sample per pixel.");
    }

    const bytesPerRow = align(width * 2, 256);
    let countTexture = null;
    let readback = null;
    try {
        countTexture = device.createTexture({
            label: "overdraw counts",
            size: [width, height],
            format: COUNT_FORMAT,
            usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SRC,
        });
        const countView = countTexture.createView();
        const stubModule = device.createShaderModule({ code: STUB_FRAGMENT });

        // Clear the count target once; every draw batch then loads, so counts
        // accumulate across passes and across bisected submissions.
        {
            const encoder = device.createCommandEncoder();
            encoder.beginRenderPass({
                colorAttachments: [{ view: countView, loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
            }).end();
            device.queue.submit([encoder.finish()]);
        }
        for (const passCommands of passes) {
            await replayPass(replay, passCommands, countView, width, height, stubModule, stats);
        }

        readback = device.createBuffer({
            size: bytesPerRow * height,
            usage: BUFFER_COPY_DST | BUFFER_MAP_READ,
        });
        const encoder = device.createCommandEncoder();
        encoder.copyTextureToBuffer(
            { texture: countTexture },
            { buffer: readback, bytesPerRow },
            [width, height]);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);

        const mapped = new Uint16Array(readback.getMappedRange());
        const counts = new Uint32Array(width * height);
        let maxCount = 0;
        let saturated = false;
        const halfsPerRow = bytesPerRow / 2;
        for (let y = 0; y < height; ++y) {
            const row = y * halfsPerRow;
            for (let x = 0; x < width; ++x) {
                let value = halfToFloat(mapped[row + x]);
                if (!Number.isFinite(value)) {
                    value = F16_MAX;
                    saturated = true;
                }
                const count = Math.max(0, Math.round(value));
                counts[y * width + x] = count;
                if (count > maxCount) {
                    maxCount = count;
                }
            }
        }
        readback.unmap();
        if (saturated) {
            replay.notes.add(`Some counts exceeded ${F16_MAX} and are clamped.`);
        }
        if (maxCount > 2048) {
            replay.notes.add("Counts above 2048 are approximate (16-bit float accumulation).");
        }

        return {
            width,
            height,
            counts,
            maxCount,
            notes: Array.from(replay.notes),
            skippedDraws: stats.skippedDraws,
            gpu: true,
        };
    } finally {
        try {
            readback?.destroy();
        } catch (_) { /* ignore */ }
        try {
            countTexture?.destroy();
        } catch (_) { /* ignore */ }
        replay.destroy();
    }
}

// ---------------------------------------------------------------------------
// Pixel-coverage query (GPU-accelerated pixel history, stage 1)
// ---------------------------------------------------------------------------

// Determine, by GPU replay, which draw commands of the frame rasterize at
// least one fragment at pixel (x, y) — the expensive question the CPU pixel
// history otherwise answers by running every draw's vertex shader on the
// interpreter. Every render pass of the frame is replayed with a 1x1 scissor
// at the pixel and an occlusion query around each draw, using the stub
// fragment stage with culling disabled and no depth-stencil, so fragments
// that would later be culled or fail tests are still detected (the CPU
// simulation reports those outcomes).
//
// Returns { covered, unknown, notes }: `covered` is a Set of draw command
// records with fragments at the pixel; `unknown` holds draws replay couldn't
// answer for (treat as possibly covering). Throws when replay is impossible.
export async function queryPixelCoverage({ device, database, commands, x, y, getTextureFromAttachment }) {
    if (!device) {
        throw new Error("The DevTools GPU device is not available.");
    }

    const replay = new CaptureReplay(device, database);
    const covered = new Set();
    const unknown = new Set();

    try {
        const stubModule = device.createShaderModule({ code: STUB_FRAGMENT });

        // Slice every render pass, sized from its attachments.
        const passes = [];
        let current = null;
        for (const command of commands) {
            if (!command) {
                continue;
            }
            if (command.method === "beginRenderPass") {
                const desc = command.args?.[0] ?? {};
                let width = 0;
                let height = 0;
                const attachments = [...(desc.colorAttachments ?? [])];
                if (desc.depthStencilAttachment) {
                    attachments.push(desc.depthStencilAttachment);
                }
                for (const attachment of attachments) {
                    if (!attachment) {
                        continue;
                    }
                    const texture = getTextureFromAttachment(attachment);
                    width = width || texture?.width || 0;
                    height = height || texture?.height || 0;
                }
                current = { width, height, cmds: [] };
                continue;
            }
            if (current === null) {
                continue;
            }
            if (command.method === "end") {
                passes.push(current);
                current = null;
                continue;
            }
            current.cmds.push(command);
        }

        // One scratch color attachment per attachment size.
        const scratch = new Map();
        const getScratchView = (width, height) => {
            const key = `${width}x${height}`;
            if (!scratch.has(key)) {
                const texture = device.createTexture({
                    label: "pixel coverage scratch",
                    size: [width, height],
                    format: COUNT_FORMAT,
                    usage: TEXTURE_RENDER_ATTACHMENT,
                });
                replay._destroyables.push(texture);
                scratch.set(key, texture.createView());
            }
            return scratch.get(key);
        };

        const stats = { skippedDraws: 0 };
        const pending = [];

        for (const pass of passes) {
            const uploads = [];
            const missing = new Set();
            const plans = walkPassCommands(replay, pass.cmds, uploads, missing, stats);
            const inBounds = pass.width > x && pass.height > y;

            const prepared = [];
            for (const plan of plans) {
                if (plan.pipelineId === null || plan.pipelineId === undefined) {
                    continue; // no pipeline bound: not drawable, not simulatable
                }
                if (!inBounds) {
                    unknown.add(plan.command);
                    continue;
                }
                const prep = await prepareDraw(replay, plan, stubModule, true);
                if (prep.error) {
                    unknown.add(plan.command);
                    continue;
                }
                prepared.push({ plan, pipelineInfo: prep.pipelineInfo, bindGroups: prep.bindGroups });
            }
            if (!prepared.length) {
                continue;
            }
            applyUploads(replay, uploads);

            const scissor = [x, y, 1, 1];
            for (let i = 0; i < prepared.length; i += MAX_QUERIES_PER_SET) {
                const chunk = prepared.slice(i, i + MAX_QUERIES_PER_SET);
                device.pushErrorScope("validation");
                const querySet = device.createQuerySet({ type: "occlusion", count: chunk.length });
                const resolveBuffer = device.createBuffer({
                    size: chunk.length * 8,
                    usage: BUFFER_QUERY_RESOLVE | BUFFER_COPY_SRC,
                });
                const readBuffer = device.createBuffer({
                    size: chunk.length * 8,
                    usage: BUFFER_COPY_DST | BUFFER_MAP_READ,
                });
                let error = null;
                try {
                    const encoder = device.createCommandEncoder();
                    const passEncoder = encoder.beginRenderPass({
                        colorAttachments: [{ view: getScratchView(pass.width, pass.height), loadOp: "clear", storeOp: "discard", clearValue: [0, 0, 0, 0] }],
                        occlusionQuerySet: querySet,
                    });
                    for (let q = 0; q < chunk.length; ++q) {
                        passEncoder.beginOcclusionQuery(q);
                        encodeDraw(passEncoder, replay, chunk[q], pass.width, pass.height, scissor);
                        passEncoder.endOcclusionQuery();
                    }
                    passEncoder.end();
                    encoder.resolveQuerySet(querySet, 0, chunk.length, resolveBuffer, 0);
                    encoder.copyBufferToBuffer(resolveBuffer, 0, readBuffer, 0, chunk.length * 8);
                    device.queue.submit([encoder.finish()]);
                } catch (e) {
                    error = `${e.message ?? e}`;
                }
                const scopeError = await device.popErrorScope();
                if (error || scopeError) {
                    // Conservative: replay couldn't answer for this chunk, so
                    // the CPU simulation keeps all of its draws.
                    for (const item of chunk) {
                        unknown.add(item.plan.command);
                    }
                    replay.notes.add(`Pixel-coverage replay failed for ${chunk.length} draw(s): ${error ?? scopeError.message}`);
                    querySet.destroy();
                    resolveBuffer.destroy();
                    readBuffer.destroy();
                    continue;
                }
                pending.push({ querySet, resolveBuffer, readBuffer, chunk });
            }
        }

        for (const p of pending) {
            await p.readBuffer.mapAsync(GPUMapMode.READ);
            const results = new BigUint64Array(p.readBuffer.getMappedRange());
            for (let i = 0; i < p.chunk.length; ++i) {
                if (results[i] !== 0n) {
                    covered.add(p.chunk[i].plan.command);
                }
            }
            p.readBuffer.unmap();
            p.readBuffer.destroy();
            p.resolveBuffer.destroy();
            p.querySet.destroy();
        }

        return { covered, unknown, notes: Array.from(replay.notes) };
    } finally {
        replay.destroy();
    }
}
