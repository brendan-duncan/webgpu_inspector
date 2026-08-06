/**
 * Per-draw and per-dispatch GPU timing by replay (tier 3a).
 *
 * The frame cost tree can already put a measured millisecond figure on a *pass*
 * — timestamp queries give that directly. What it cannot measure is how that
 * time divides between the draws inside the pass; it distributes it by modeled
 * cost. This module replaces that distribution with measurement.
 *
 * Unlike the overdraw replay in capture_replay.js, which swaps in a stub
 * fragment shader to count coverage, timing has to run the *real* pipelines:
 * the whole point is how long the actual shaders take. That means reconstructing
 * each pass's attachments so the original pipelines are valid against them.
 *
 * Two encoding strategies, picked by what the device supports:
 *
 *   inside-passes - `writeTimestamp()` between draws in one pass. Preferred:
 *                   the pass keeps its original structure. Needs Chrome's
 *                   `chromium-experimental-timestamp-query-inside-passes`.
 *   split-passes  - one pass per draw, each with pass-level `timestampWrites`.
 *                   Portable. Measured to agree with the above to within one
 *                   timestamp quantum on desktop hardware, where an empty
 *                   pass costs nothing measurable. On a tile-based GPU each
 *                   pass is a tile flush, so treat those numbers as relative.
 *
 * Timestamps are quantized (~1µs on the hardware tested), so a draw costing a
 * microsecond or two is indistinguishable from noise. Cheap draws are therefore
 * re-measured with the draw encoded many times and the total divided — trading
 * wall-clock for precision, which is possible only because this is a replay.
 */

import {
    CaptureReplay,
    validated,
    walkPassCommands,
    applyUploads,
    getBindGroupForDraw,
    isDepthStencilFormat,
} from "./capture_replay.js";

const BUFFER_COPY_SRC = 0x0004;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_MAP_READ = 0x0001;
const BUFFER_QUERY_RESOLVE = 0x0200;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const TEXTURE_TEXTURE_BINDING = 0x04;

// Chrome exposes writeTimestamp-inside-passes under a vendor-prefixed name; the
// unprefixed name is what the spec draft used. Probe both.
const INSIDE_PASSES_FEATURES = [
    "chromium-experimental-timestamp-query-inside-passes",
    "timestamp-query-inside-passes",
];

// A query set is a real GPU resource; cap it rather than trying to allocate one
// slot per draw in a 5000-draw frame.
const MAX_QUERIES = 4096;

// Below this, a single measurement is mostly quantization noise, so the draw is
// re-measured with repetition. ~20x the observed 1µs quantum.
const MIN_RELIABLE_MS = 0.02;
// Bounds on the repeat count for the refinement pass.
const MAX_REPEATS = 256;

const NS_TO_MS = 1e-6;

/** Which timing strategy a device can support, and why. */
export function detectTimingSupport(device) {
    if (!device) {
        return { supported: false, reason: "No DevTools GPU device is available." };
    }
    if (!device.features?.has("timestamp-query")) {
        return {
            supported: false,
            reason: "The DevTools GPU device does not expose the timestamp-query feature, so GPU timing is unavailable.",
        };
    }
    const insidePasses = INSIDE_PASSES_FEATURES.find((f) => device.features.has(f)) ?? null;
    return {
        supported: true,
        method: insidePasses ? "inside-passes" : "split-passes",
        insidePassesFeature: insidePasses,
    };
}

// ---------------------------------------------------------------------------
// Pass collection
// ---------------------------------------------------------------------------

/**
 * Slice the command list into passes, keeping each pass's descriptor (needed to
 * rebuild its attachments) alongside its commands.
 */
export function collectPasses(commands) {
    const passes = [];
    let current = null;
    let index = 0;
    for (const command of commands) {
        if (!command) {
            continue;
        }
        if (command.method === "beginRenderPass" || command.method === "beginComputePass") {
            current = {
                index: index++,
                kind: command.method === "beginRenderPass" ? "render" : "compute",
                command,
                descriptor: command.args?.[0] ?? {},
                commands: [],
            };
            passes.push(current);
            continue;
        }
        if (!current) {
            continue;
        }
        if (command.method === "end") {
            current = null;
            continue;
        }
        current.commands.push(command);
    }
    return passes;
}

// ---------------------------------------------------------------------------
// Attachment reconstruction
// ---------------------------------------------------------------------------

/**
 * Rebuild a render pass's attachments.
 *
 * Fresh textures are created rather than reusing the panel's captured copies:
 * those are format-converted for display and may lack RENDER_ATTACHMENT usage.
 * Format, size and sample count are taken from the original attachment's
 * descriptor, which is what the original pipelines were built against — so the
 * pipelines stay valid without inspecting their target state.
 */
export function buildAttachments(replay, pass, getTextureFromAttachment) {
    const descriptor = pass.descriptor;
    const colorAttachments = [];
    let width = 0;
    let height = 0;
    let sampleCount = 1;

    for (const attachment of descriptor.colorAttachments ?? []) {
        if (!attachment) {
            // A null entry is legal and means "no attachment at this location".
            colorAttachments.push(null);
            continue;
        }
        const texture = getTextureFromAttachment(attachment);
        const desc = texture?.descriptor;
        if (!desc?.format) {
            return { error: "A color attachment's texture was not captured, so the pass cannot be replayed for timing." };
        }
        width = Math.max(width, texture.width ?? 0);
        height = Math.max(height, texture.height ?? 0);
        sampleCount = Math.max(sampleCount, desc.sampleCount ?? 1);

        const gpuTexture = replay.device.createTexture({
            label: `timing color target (${desc.format})`,
            size: [texture.width, texture.height, 1],
            format: desc.format,
            sampleCount: desc.sampleCount ?? 1,
            usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_TEXTURE_BINDING,
        });
        replay._destroyables.push(gpuTexture);
        colorAttachments.push({
            view: gpuTexture.createView(),
            loadOp: "clear",
            storeOp: "store",
            clearValue: attachment.clearValue ?? [0, 0, 0, 0],
        });
    }

    let depthStencilAttachment = null;
    if (descriptor.depthStencilAttachment) {
        const texture = getTextureFromAttachment(descriptor.depthStencilAttachment);
        const desc = texture?.descriptor;
        if (desc?.format && isDepthStencilFormat(desc.format)) {
            const gpuTexture = replay.device.createTexture({
                label: `timing depth target (${desc.format})`,
                size: [texture.width, texture.height, 1],
                format: desc.format,
                sampleCount: desc.sampleCount ?? 1,
                usage: TEXTURE_RENDER_ATTACHMENT,
            });
            replay._destroyables.push(gpuTexture);
            width = Math.max(width, texture.width ?? 0);
            height = Math.max(height, texture.height ?? 0);
            sampleCount = Math.max(sampleCount, desc.sampleCount ?? 1);
            depthStencilAttachment = { texture: gpuTexture, format: desc.format };
        } else {
            replay.notes.add("A depth-stencil attachment was not captured; that pass is timed without depth testing, so draws hidden behind others will look more expensive than they are.");
        }
    }

    if (!width || !height) {
        return { error: "The pass's attachments have no size." };
    }
    return { colorAttachments, depthStencilAttachment, width, height, sampleCount };
}

/** A fresh depth-stencil attachment record for one encoded pass. */
export function depthAttachmentFor(attachments) {
    const ds = attachments.depthStencilAttachment;
    if (!ds) {
        return undefined;
    }
    const record = { view: ds.texture.createView() };
    const hasDepth = ds.format.includes("depth");
    const hasStencil = ds.format.includes("stencil");
    if (hasDepth) {
        record.depthClearValue = 1.0;
        record.depthLoadOp = "clear";
        record.depthStoreOp = "store";
    }
    if (hasStencil) {
        record.stencilClearValue = 0;
        record.stencilLoadOp = "clear";
        record.stencilStoreOp = "store";
    }
    return record;
}

// ---------------------------------------------------------------------------
// Pipelines
// ---------------------------------------------------------------------------

/**
 * Materialize a captured render pipeline unchanged — original vertex *and*
 * fragment stages, primitive state, depth-stencil state and multisample state.
 * This is what separates timing from the overdraw replay, which substitutes the
 * fragment stage.
 */
async function getTimingRenderPipeline(replay, pipelineId, attachments) {
    const key = `timing-pipeline:${pipelineId}:${attachments.key}`;
    if (replay._objects.has(key)) {
        return replay._objects.get(key);
    }

    const build = async () => {
        const pipeline = replay.database.getObject(pipelineId);
        const desc = pipeline?.descriptor;
        if (!desc?.vertex) {
            return { error: "The draw's render pipeline was not captured." };
        }
        const vertexModule = replay.getShaderModule(desc.vertex.module?.__id);
        if (!vertexModule) {
            return { error: "The draw's vertex shader was not captured." };
        }
        // Without the real fragment stage there is nothing worth timing.
        if (!desc.fragment?.module) {
            return { error: "The draw's pipeline has no captured fragment stage." };
        }
        const fragmentModule = replay.getShaderModule(desc.fragment.module?.__id);
        if (!fragmentModule) {
            return { error: "The draw's fragment shader was not captured." };
        }

        let layout = "auto";
        let layoutBGLs = null;
        if (desc.layout && desc.layout !== "auto") {
            const pl = replay.getPipelineLayout(desc.layout.__id);
            if (pl) {
                layout = pl.layout;
                layoutBGLs = pl.bindGroupLayouts;
            }
        }

        const primitive = { ...(desc.primitive ?? {}) };
        if (primitive.unclippedDepth && !replay.device.features.has("depth-clip-control")) {
            delete primitive.unclippedDepth;
        }

        const descriptor = {
            label: `timing ${pipeline.label || pipelineId}`,
            layout,
            vertex: {
                module: vertexModule,
                entryPoint: desc.vertex.entryPoint,
                buffers: desc.vertex.buffers ?? undefined,
                constants: desc.vertex.constants ?? undefined,
            },
            primitive,
            fragment: {
                module: fragmentModule,
                entryPoint: desc.fragment.entryPoint,
                constants: desc.fragment.constants ?? undefined,
                // Target formats come from the rebuilt attachments so the
                // pipeline is guaranteed compatible with the pass; blend and
                // write masks are kept from the original, since both affect
                // how much work the raster back-end does.
                targets: attachments.colorAttachments.map((a, i) => {
                    if (!a) {
                        return null;
                    }
                    const original = desc.fragment.targets?.[i];
                    return {
                        format: attachments.formats[i],
                        blend: original?.blend ?? undefined,
                        writeMask: original?.writeMask ?? undefined,
                    };
                }),
            },
        };
        if (desc.depthStencil && attachments.depthStencilAttachment) {
            descriptor.depthStencil = {
                ...desc.depthStencil,
                format: attachments.depthStencilAttachment.format,
            };
        }
        if (attachments.sampleCount > 1) {
            descriptor.multisample = { ...(desc.multisample ?? {}), count: attachments.sampleCount };
        }

        const gpuPipeline = await validated(replay,
            `Pipeline ${pipeline.label || pipelineId} could not be replayed for timing`,
            () => replay.device.createRenderPipeline(descriptor));
        if (!gpuPipeline) {
            return { error: "The pipeline could not be re-created for timing." };
        }
        // vsBindings stays null: with the real fragment stage present, an auto
        // layout contains the fragment bindings too, so nothing may be pruned.
        return { pipeline: gpuPipeline, isAuto: layout === "auto", layoutBGLs, vsBindings: null };
    };

    const info = await build();
    replay._objects.set(key, info);
    return info;
}

async function getTimingComputePipeline(replay, pipelineId) {
    const key = `timing-compute:${pipelineId}`;
    if (replay._objects.has(key)) {
        return replay._objects.get(key);
    }
    const build = async () => {
        const pipeline = replay.database.getObject(pipelineId);
        const desc = pipeline?.descriptor;
        if (!desc?.compute?.module) {
            return { error: "The dispatch's compute pipeline was not captured." };
        }
        const module = replay.getShaderModule(desc.compute.module?.__id);
        if (!module) {
            return { error: "The dispatch's compute shader was not captured." };
        }
        let layout = "auto";
        let layoutBGLs = null;
        if (desc.layout && desc.layout !== "auto") {
            const pl = replay.getPipelineLayout(desc.layout.__id);
            if (pl) {
                layout = pl.layout;
                layoutBGLs = pl.bindGroupLayouts;
            }
        }
        const gpuPipeline = await validated(replay,
            `Compute pipeline ${pipeline.label || pipelineId} could not be replayed for timing`,
            () => replay.device.createComputePipeline({
                label: `timing ${pipeline.label || pipelineId}`,
                layout,
                compute: {
                    module,
                    entryPoint: desc.compute.entryPoint,
                    constants: desc.compute.constants ?? undefined,
                },
            }));
        if (!gpuPipeline) {
            return { error: "The compute pipeline could not be re-created for timing." };
        }
        return { pipeline: gpuPipeline, isAuto: layout === "auto", layoutBGLs, vsBindings: null };
    };
    const info = await build();
    replay._objects.set(key, info);
    return info;
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

export function setRenderState(pass, replay, item, width, height) {
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
    const sc = plan.scissor;
    pass.setScissorRect(sc?.[0] ?? 0, sc?.[1] ?? 0, sc?.[2] ?? width, sc?.[3] ?? height);
}

export function issueDraw(pass, replay, plan) {
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

function issueDispatch(pass, replay, plan) {
    if (plan.method === "dispatchWorkgroups") {
        pass.dispatchWorkgroups(plan.args[0] ?? 1, plan.args[1] ?? 1, plan.args[2] ?? 1);
    } else {
        const buffer = replay.getBuffer(plan.indirect?.bufferId);
        if (buffer) {
            pass.dispatchWorkgroupsIndirect(buffer, plan.indirect.offset);
        }
    }
}

/**
 * Encode one measurement round: every item in `items` timed with `repeats`
 * back-to-back executions. Returns the query index each item's pair starts at.
 */
function encodeRound(replay, encoder, items, context, querySet, method, repeats) {
    const slots = new Map();
    let next = 0;

    if (method === "inside-passes" && context.kind === "render") {
        // One pass, a timestamp before the first draw and after each draw.
        const pass = encoder.beginRenderPass({
            colorAttachments: context.attachments.colorAttachments,
            depthStencilAttachment: depthAttachmentFor(context.attachments),
        });
        pass.writeTimestamp(querySet, next);
        let previous = next;
        next++;
        for (const item of items) {
            setRenderState(pass, replay, item, context.attachments.width, context.attachments.height);
            for (let r = 0; r < repeats; ++r) {
                issueDraw(pass, replay, item.plan);
            }
            pass.writeTimestamp(querySet, next);
            slots.set(item, { begin: previous, end: next });
            previous = next;
            next++;
        }
        pass.end();
        return slots;
    }

    if (method === "inside-passes" && context.kind === "compute") {
        const pass = encoder.beginComputePass();
        pass.writeTimestamp(querySet, next);
        let previous = next;
        next++;
        for (const item of items) {
            pass.setPipeline(item.pipelineInfo.pipeline);
            for (const bg of item.bindGroups) {
                if (bg.dynamicOffsets?.length) {
                    pass.setBindGroup(bg.index, bg.bindGroup, bg.dynamicOffsets);
                } else {
                    pass.setBindGroup(bg.index, bg.bindGroup);
                }
            }
            for (let r = 0; r < repeats; ++r) {
                issueDispatch(pass, replay, item.plan);
            }
            pass.writeTimestamp(querySet, next);
            slots.set(item, { begin: previous, end: next });
            previous = next;
            next++;
        }
        pass.end();
        return slots;
    }

    // split-passes: one pass per item, timed at pass granularity.
    for (const item of items) {
        const begin = next++;
        const end = next++;
        const timestampWrites = { querySet, beginningOfPassWriteIndex: begin, endOfPassWriteIndex: end };
        if (context.kind === "render") {
            const pass = encoder.beginRenderPass({
                colorAttachments: context.attachments.colorAttachments,
                depthStencilAttachment: depthAttachmentFor(context.attachments),
                timestampWrites,
            });
            setRenderState(pass, replay, item, context.attachments.width, context.attachments.height);
            for (let r = 0; r < repeats; ++r) {
                issueDraw(pass, replay, item.plan);
            }
            pass.end();
        } else {
            const pass = encoder.beginComputePass({ timestampWrites });
            pass.setPipeline(item.pipelineInfo.pipeline);
            for (const bg of item.bindGroups) {
                if (bg.dynamicOffsets?.length) {
                    pass.setBindGroup(bg.index, bg.bindGroup, bg.dynamicOffsets);
                } else {
                    pass.setBindGroup(bg.index, bg.bindGroup);
                }
            }
            for (let r = 0; r < repeats; ++r) {
                issueDispatch(pass, replay, item.plan);
            }
            pass.end();
        }
        slots.set(item, { begin, end });
    }
    return slots;
}

export async function readTimestamps(device, querySet, count) {
    const resolve = device.createBuffer({
        size: count * 8,
        usage: BUFFER_QUERY_RESOLVE | BUFFER_COPY_SRC,
    });
    const readback = device.createBuffer({
        size: count * 8,
        usage: BUFFER_COPY_DST | BUFFER_MAP_READ,
    });
    try {
        const encoder = device.createCommandEncoder();
        encoder.resolveQuerySet(querySet, 0, count, resolve, 0);
        encoder.copyBufferToBuffer(resolve, 0, readback, 0, count * 8);
        device.queue.submit([encoder.finish()]);
        await readback.mapAsync(GPUMapMode.READ);
        const values = Array.from(new BigInt64Array(readback.getMappedRange()), Number);
        readback.unmap();
        return values;
    } finally {
        try {
            resolve.destroy();
        } catch (_) { /* ignore */ }
        try {
            readback.destroy();
        } catch (_) { /* ignore */ }
    }
}

/** Run one measurement round and return ms per item (already divided). */
async function measureRound(replay, items, context, method, repeats) {
    // inside-passes needs one timestamp per item plus an opening one;
    // split-passes needs a begin/end pair per item.
    const needed = method === "inside-passes" ? items.length + 1 : items.length * 2;
    if (needed > MAX_QUERIES) {
        return null;
    }

    const querySet = replay.device.createQuerySet({ type: "timestamp", count: needed });
    try {
        const encoder = replay.device.createCommandEncoder();
        const slots = encodeRound(replay, encoder, items, context, querySet, method, repeats);
        replay.device.queue.submit([encoder.finish()]);
        await replay.device.queue.onSubmittedWorkDone();
        const stamps = await readTimestamps(replay.device, querySet, needed);

        const result = new Map();
        for (const [item, slot] of slots) {
            const delta = stamps[slot.end] - stamps[slot.begin];
            // A negative or absurd delta means the query didn't land (disjoint
            // timing, a reset clock); report it as unavailable rather than as 0.
            result.set(item, delta >= 0 ? (delta * NS_TO_MS) / repeats : null);
        }
        return result;
    } finally {
        try {
            querySet.destroy();
        } catch (_) { /* ignore */ }
    }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Measure per-draw / per-dispatch GPU time for a captured frame.
 *
 * @param {Object} params
 * @param {GPUDevice} params.device
 * @param {Object} params.database - the capture object database
 * @param {Object[]} params.commands - the frame's command list
 * @param {Function} params.getTextureFromAttachment
 * @param {boolean} [params.refine=true] - re-measure sub-microsecond draws with
 *   repetition. Costs extra submissions; without it cheap draws read as noise.
 * @param {number} [params.maxItemsPerPass=256] - cap on timed items per pass
 * @param {(done:number,total:number)=>void} [params.onProgress]
 * @returns {Promise<{timings: Map<Object,{ms:number, repeats:number}>,
 *                    method: string, notes: string[], skipped: number,
 *                    refined: number}>}
 *   `timings` is keyed by the original capture command record.
 */
export async function measureDrawTimings({
    device,
    database,
    commands,
    getTextureFromAttachment,
    refine = true,
    maxItemsPerPass = 256,
    onProgress,
}) {
    const support = detectTimingSupport(device);
    if (!support.supported) {
        throw new Error(support.reason);
    }
    const method = support.method;

    const replay = new CaptureReplay(device, database);
    const timings = new Map();
    let skipped = 0;
    let refined = 0;
    let cappedItems = 0;

    if (method === "split-passes") {
        replay.notes.add("Per-draw timing used one render pass per draw, because this device does not expose timestamp queries inside passes. On desktop GPUs an empty pass costs nothing measurable; on a tile-based (mobile) GPU each pass forces a tile flush, so treat those numbers as relative rather than absolute.");
    }
    replay.notes.add("Draws are re-timed in isolation against freshly cleared attachments, so depth contents from earlier passes are absent — draws that the real frame hides behind others will measure more expensive here.");

    try {
        const passes = collectPasses(commands);
        const total = passes.length;
        let done = 0;

        for (const pass of passes) {
            onProgress?.(done++, total);

            // Walk the pass to recover per-draw state and the byte uploads it
            // needs. The stats object is the shape walkPassCommands expects.
            const uploads = [];
            const missing = new Set();
            const stats = { skippedDraws: 0 };
            const plans = walkPassCommands(replay, pass.commands, uploads, missing, stats);
            skipped += stats.skippedDraws;
            for (const note of missing) {
                replay.notes.add(note);
            }
            if (!plans.length) {
                continue;
            }

            let context;
            if (pass.kind === "render") {
                const attachments = buildAttachments(replay, pass, getTextureFromAttachment);
                if (attachments.error) {
                    replay.notes.add(`Pass ${pass.index} was not timed — ${attachments.error}`);
                    skipped += plans.length;
                    continue;
                }
                attachments.formats = attachments.colorAttachments.map((a, i) => {
                    if (!a) {
                        return null;
                    }
                    const texture = getTextureFromAttachment(pass.descriptor.colorAttachments[i]);
                    return texture?.descriptor?.format ?? null;
                });
                attachments.key = attachments.formats.join(",") + `|${attachments.depthStencilAttachment?.format ?? ""}|${attachments.sampleCount}`;
                context = { kind: "render", attachments };
            } else {
                context = { kind: "compute" };
            }

            // Materialize each item's pipeline and bind groups once.
            const items = [];
            for (const plan of plans) {
                if (plan.pipelineId === null || plan.pipelineId === undefined) {
                    skipped++;
                    continue;
                }
                const pipelineInfo = pass.kind === "render"
                    ? await getTimingRenderPipeline(replay, plan.pipelineId, context.attachments)
                    : await getTimingComputePipeline(replay, plan.pipelineId);
                if (pipelineInfo.error) {
                    skipped++;
                    replay.notes.add(`Not timed — ${plan.method}: ${pipelineInfo.error}`);
                    continue;
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
                    for (const vb of plan.vertexBuffers) {
                        if (vb && !replay.getBuffer(vb.bufferId)) {
                            failed = "A vertex buffer could not be re-created.";
                            break;
                        }
                    }
                }
                if (!failed && plan.method.startsWith("drawIndexed") && plan.indexBuffer &&
                    !replay.getBuffer(plan.indexBuffer.bufferId)) {
                    failed = "The index buffer could not be re-created.";
                }
                if (!failed && plan.indirect && !replay.getBuffer(plan.indirect.bufferId)) {
                    failed = "The indirect argument buffer could not be re-created.";
                }
                if (failed) {
                    skipped++;
                    replay.notes.add(`Not timed — ${plan.method}: ${failed}`);
                    continue;
                }
                items.push({ plan, pipelineInfo, bindGroups });
            }

            if (!items.length) {
                continue;
            }
            applyUploads(replay, uploads);

            let timed = items;
            if (items.length > maxItemsPerPass) {
                cappedItems += items.length - maxItemsPerPass;
                timed = items.slice(0, maxItemsPerPass);
            }

            // Round 1: every item once.
            let round;
            try {
                round = await measureRound(replay, timed, context, method, 1);
            } catch (e) {
                replay.notes.add(`Pass ${pass.index} timing failed: ${e.message ?? e}`);
                skipped += timed.length;
                continue;
            }
            if (!round) {
                replay.notes.add(`Pass ${pass.index} has too many draws to time in one query set; it was skipped.`);
                skipped += timed.length;
                continue;
            }
            for (const [item, ms] of round) {
                if (ms === null) {
                    skipped++;
                    continue;
                }
                timings.set(item.plan.command, { ms, repeats: 1 });
            }

            // Round 2: anything too cheap to distinguish from quantization noise
            // gets repeated until the total is comfortably measurable.
            if (refine) {
                const cheap = timed.filter((item) => {
                    const t = timings.get(item.plan.command);
                    return t && t.ms < MIN_RELIABLE_MS;
                });
                if (cheap.length) {
                    // Size the repeat count off the cheapest item so one round
                    // lifts them all above the reliability floor.
                    const cheapest = Math.min(...cheap.map((i) => Math.max(timings.get(i.plan.command).ms, 1e-4)));
                    const repeats = Math.min(MAX_REPEATS, Math.max(2, Math.ceil(MIN_RELIABLE_MS / cheapest)));
                    try {
                        const refinedRound = await measureRound(replay, cheap, context, method, repeats);
                        if (refinedRound) {
                            for (const [item, ms] of refinedRound) {
                                if (ms === null) {
                                    continue;
                                }
                                timings.set(item.plan.command, { ms, repeats });
                                refined++;
                            }
                        }
                    } catch (e) {
                        replay.notes.add(`Refinement pass for pass ${pass.index} failed: ${e.message ?? e}`);
                    }
                }
            }
        }
        onProgress?.(total, total);

        if (cappedItems > 0) {
            replay.notes.add(`${cappedItems} draw(s) beyond the ${maxItemsPerPass}-per-pass limit were not timed.`);
        }
        if (refined > 0) {
            replay.notes.add(`${refined} cheap draw(s) were re-timed with repetition, because a single execution is below the GPU's timestamp granularity.`);
        }

        return { timings, method, notes: Array.from(replay.notes), skipped, refined };
    } finally {
        replay.destroy();
    }
}
