/**
 * Drive an ablation sweep for one captured draw or dispatch (tier 3b).
 *
 * shader_ablation.js rewrites a shader so its entry point can be stopped short
 * at a run-time cut point; draw_timing.js knows how to replay a draw or a
 * dispatch with timestamp queries. This module joins them: replay one item N+1
 * times with the cut advancing, and difference the results into a per-statement
 * cost.
 *
 * The one piece neither module already had is injecting the ablation uniform's
 * bind group into a replayed item. With an "auto" pipeline layout that is free
 * — the instrumented shader declares the extra group, so the auto layout simply
 * contains it. With an explicit layout the pipeline layout has to be rebuilt
 * with the extra group appended, padding any gap with empty layouts, because
 * bindGroupLayouts is positional.
 */

import {
    CaptureReplay,
    validated,
    walkPassCommands,
    applyUploads,
    getBindGroupForDraw,
    vertexStageBindings,
} from "./capture_replay.js";
import {
    collectPasses,
    buildAttachments,
    depthAttachmentFor,
    readTimestamps,
    setRenderState,
    issueDraw,
    issueDispatch,
    detectTimingSupport,
} from "./draw_timing.js";
import { instrumentForAblation, attributeAblation } from "./shader_ablation.js";

const BUFFER_UNIFORM = 0x0040;
const BUFFER_COPY_DST = 0x0008;
const NS_TO_MS = 1e-6;

/**
 * Vector type a fragment output needs for a given attachment format. Writing a
 * float vector to an integer target is a validation error, so the stub has to
 * match.
 */
function outputTypeForFormat(format) {
    if (!format) {
        return null;
    }
    if (format.endsWith("uint")) {
        return "vec4u";
    }
    if (format.endsWith("sint")) {
        return "vec4i";
    }
    return "vec4f";
}

/**
 * A minimal fragment shader writing zeros to every attachment.
 *
 * Vertex-stage ablation needs this. Cutting a vertex shader short makes it
 * return a degenerate position, which rasterizes nothing — so with the real
 * fragment shader attached, *all* of the fragment cost lands on whichever vertex
 * statement finally produces a valid position, and the attribution is garbage.
 * Substituting a trivial fragment stage removes that feedback: what's left is
 * vertex work plus a small rasterization difference.
 */
function buildStubFragment(formats) {
    const outputs = [];
    formats.forEach((format, i) => {
        if (!format) {
            return;
        }
        const type = outputTypeForFormat(format);
        if (!type) {
            return;
        }
        outputs.push({ location: i, type });
    });
    if (!outputs.length) {
        return null;
    }
    const members = outputs
        .map((o) => `  @location(${o.location}) out${o.location} : ${o.type},`)
        .join("\n");
    const values = outputs.map((o) => `${o.type}()`).join(", ");
    return {
        code:
            `struct WGPUInspectorStubOut {\n${members}\n}\n` +
            `@fragment fn wgpuInspectorStub() -> WGPUInspectorStubOut {\n` +
            `  return WGPUInspectorStubOut(${values});\n}\n`,
        entryPoint: "wgpuInspectorStub",
    };
}

// Aim each measurement at comfortably above the ~1µs timestamp quantum.
const TARGET_MEASUREMENT_MS = 0.05;
const MAX_REPEATS = 512;
// Best-of-N suppresses scheduling noise; the sweep is short enough to afford it.
const SAMPLES_PER_CUT = 3;

const STAGE_VERTEX = 1;
const STAGE_FRAGMENT = 2;
const STAGE_COMPUTE = 4;

/**
 * The bind group indices an explicit pipeline layout occupies. Reflection only
 * sees what the shader reads; the layout may declare more, and the ablation
 * uniform must not collide with any of them.
 */
function occupiedGroups(explicitLayout) {
    const groups = [];
    if (explicitLayout) {
        for (let g = 0; g < explicitLayout.bindGroupLayouts.length; ++g) {
            groups.push(g);
        }
    }
    return groups;
}

/**
 * Extend an explicit pipeline layout with the ablation group.
 *
 * bindGroupLayouts is positional, so any gap between the original groups and
 * the ablation group has to be filled with empty layouts.
 */
async function extendLayout(replay, explicitLayout, group, ablationBGL) {
    const device = replay.device;
    const bindGroupLayouts = explicitLayout.bindGroupLayouts.slice();
    while (bindGroupLayouts.length < group) {
        bindGroupLayouts.push(device.createBindGroupLayout({ entries: [] }));
    }
    bindGroupLayouts[group] = ablationBGL;
    const built = await validated(replay, "The ablation pipeline layout could not be created", () =>
        device.createPipelineLayout({ bindGroupLayouts }));
    if (!built) {
        return { error: "The pipeline layout could not be extended with the ablation group." };
    }
    return { layout: built, layoutBGLs: bindGroupLayouts };
}

/** Re-create the captured bind groups a plan needs against the ablation pipeline. */
async function buildPlanBindGroups(replay, pipelineInfo, plan) {
    const bindGroups = [];
    for (let g = 0; g < plan.bindGroups.length; ++g) {
        const bgState = plan.bindGroups[g];
        if (!bgState) {
            continue;
        }
        const info = await getBindGroupForDraw(replay, pipelineInfo, plan.pipelineId, g, bgState);
        if (info.error) {
            return { error: `A bind group could not be replayed: ${info.error}` };
        }
        bindGroups.push({ index: g, bindGroup: info.bindGroup, dynamicOffsets: bgState.dynamicOffsets });
    }
    return { bindGroups };
}

/** The uniform buffer holding the cut point, plus its bind group. */
function makeCutResources(replay, gpuPipeline, layout, ablationBGL, instrumented) {
    const device = replay.device;
    const cutBuffer = device.createBuffer({
        label: "ablation cut",
        size: 16,
        usage: BUFFER_UNIFORM | BUFFER_COPY_DST,
    });
    replay._destroyables.push(cutBuffer);
    const bindGroup = device.createBindGroup({
        layout: layout === "auto"
            ? gpuPipeline.getBindGroupLayout(instrumented.group)
            : ablationBGL,
        entries: [{ binding: instrumented.binding, resource: { buffer: cutBuffer } }],
    });
    return { cutBuffer, bindGroup };
}

/**
 * Time one pass, encoded by the caller, with a begin/end timestamp pair.
 * Returns milliseconds per repeat, or null when the query didn't land.
 */
async function timedPass(replay, repeats, encodePass) {
    const device = replay.device;
    const querySet = device.createQuerySet({ type: "timestamp", count: 2 });
    try {
        const encoder = device.createCommandEncoder();
        encodePass(encoder, { querySet, beginningOfPassWriteIndex: 0, endOfPassWriteIndex: 1 }, repeats);
        device.queue.submit([encoder.finish()]);
        await device.queue.onSubmittedWorkDone();
        const stamps = await readTimestamps(device, querySet, 2);
        const delta = stamps[1] - stamps[0];
        return delta >= 0 ? (delta * NS_TO_MS) / repeats : null;
    } finally {
        try {
            querySet.destroy();
        } catch (_) { /* ignore */ }
    }
}

/** Bind everything a compute pass needs, ablation group included. */
function setComputeState(pass, pipeline, bindGroups) {
    pass.setPipeline(pipeline);
    for (const bg of bindGroups) {
        if (bg.dynamicOffsets?.length) {
            pass.setBindGroup(bg.index, bg.bindGroup, bg.dynamicOffsets);
        } else {
            pass.setBindGroup(bg.index, bg.bindGroup);
        }
    }
}

/**
 * Build the instrumented render pipeline for a vertex- or fragment-stage sweep,
 * along with a closure that times one replay of the draw.
 *
 * @returns {Promise<{ok:boolean, reason?:string, instrumented?:Object,
 *                    cutBuffer?:GPUBuffer, timeOnce?:Function, notes?:string[]}>}
 */
async function prepareRenderAblation(replay, { pass, plan, desc, stage, entryPoint, getTextureFromAttachment }) {
    const device = replay.device;
    if (!desc?.vertex || !desc?.fragment?.module) {
        return { ok: false, reason: "The draw's pipeline was not fully captured (it needs both stages)." };
    }

    // --- instrument the chosen stage --------------------------------------
    const stageDesc = stage === "vertex" ? desc.vertex : desc.fragment;
    const moduleObj = replay.database.getObject(stageDesc.module?.__id);
    const code = moduleObj?.code;
    if (!code) {
        return { ok: false, reason: `The ${stage} shader source was not captured.` };
    }

    const explicitLayout = desc.layout && desc.layout !== "auto"
        ? replay.getPipelineLayout(desc.layout.__id)
        : null;

    const instrumented = instrumentForAblation(code, {
        stage,
        entryPoint: stageDesc.entryPoint ?? entryPoint,
        avoidGroups: occupiedGroups(explicitLayout),
    });
    if (!instrumented.ok) {
        return { ok: false, reason: instrumented.reason };
    }

    const attachments = buildAttachments(replay, pass, getTextureFromAttachment);
    if (attachments.error) {
        return { ok: false, reason: attachments.error };
    }
    attachments.formats = attachments.colorAttachments.map((a, i) => {
        if (!a) {
            return null;
        }
        return getTextureFromAttachment(pass.descriptor.colorAttachments[i])?.descriptor?.format ?? null;
    });

    // --- build the instrumented pipeline ----------------------------------
    const instrumentedModule = await validated(replay, "The instrumented shader failed to compile", () =>
        device.createShaderModule({ code: instrumented.code }));
    if (!instrumentedModule) {
        return { ok: false, reason: "The instrumented shader failed to compile." };
    }

    const otherStageDesc = stage === "vertex" ? desc.fragment : desc.vertex;
    const otherModule = replay.getShaderModule(otherStageDesc.module?.__id);
    if (!otherModule) {
        return { ok: false, reason: "The draw's other shader stage was not captured." };
    }

    // Ablating the vertex stage requires stubbing the fragment stage; see
    // buildStubFragment. Without it, cut vertex shaders emit degenerate
    // triangles and the fragment shader's whole cost is misattributed to a
    // single vertex statement.
    let fragmentModule = stage === "fragment" ? instrumentedModule : otherModule;
    let fragmentEntryPoint = desc.fragment.entryPoint;
    if (stage === "vertex") {
        const stub = buildStubFragment(attachments.formats);
        if (!stub) {
            return {
                ok: false,
                reason: "The pass has no color attachments to write, so a stub fragment stage can't be built for vertex ablation.",
            };
        }
        const stubModule = await validated(replay, "The stub fragment shader failed to compile", () =>
            device.createShaderModule({ code: stub.code }));
        if (!stubModule) {
            return { ok: false, reason: "The stub fragment shader failed to compile." };
        }
        fragmentModule = stubModule;
        fragmentEntryPoint = stub.entryPoint;
        replay.notes.add("The fragment stage was replaced with a trivial shader so that vertex costs aren't contaminated by fragment work. Cutting a vertex shader short makes it emit a degenerate triangle, which would otherwise charge the entire fragment cost to whichever statement produces the position.");
    }

    // The ablation uniform needs a bind group layout wherever it landed.
    const ablationBGL = device.createBindGroupLayout({
        entries: [{
            binding: instrumented.binding,
            visibility: stage === "vertex" ? STAGE_VERTEX : STAGE_FRAGMENT,
            buffer: { type: "uniform" },
        }],
    });

    let layout = "auto";
    let layoutBGLs = null;
    if (explicitLayout) {
        const extended = await extendLayout(replay, explicitLayout, instrumented.group, ablationBGL);
        if (extended.error) {
            return { ok: false, reason: extended.error };
        }
        layout = extended.layout;
        layoutBGLs = extended.layoutBGLs;
    }

    const pipelineDescriptor = {
        label: "ablation",
        layout,
        vertex: {
            module: stage === "vertex" ? instrumentedModule : otherModule,
            entryPoint: desc.vertex.entryPoint,
            buffers: desc.vertex.buffers ?? undefined,
            constants: desc.vertex.constants ?? undefined,
        },
        primitive: { ...(desc.primitive ?? {}) },
        fragment: {
            module: fragmentModule,
            entryPoint: fragmentEntryPoint,
            // Pipeline-overridable constants belong to the original shader;
            // the stub has none.
            constants: stage === "vertex" ? undefined : (desc.fragment.constants ?? undefined),
            targets: attachments.colorAttachments.map((a, i) => a ? {
                format: attachments.formats[i],
                blend: desc.fragment.targets?.[i]?.blend ?? undefined,
                writeMask: desc.fragment.targets?.[i]?.writeMask ?? undefined,
            } : null),
        },
    };
    if (pipelineDescriptor.primitive.unclippedDepth && !device.features.has("depth-clip-control")) {
        delete pipelineDescriptor.primitive.unclippedDepth;
    }
    if (desc.depthStencil && attachments.depthStencilAttachment) {
        pipelineDescriptor.depthStencil = {
            ...desc.depthStencil,
            format: attachments.depthStencilAttachment.format,
        };
    }
    if (attachments.sampleCount > 1) {
        pipelineDescriptor.multisample = { ...(desc.multisample ?? {}), count: attachments.sampleCount };
    }

    const gpuPipeline = await validated(replay, "The ablation pipeline could not be created", () =>
        device.createRenderPipeline(pipelineDescriptor));
    if (!gpuPipeline) {
        return { ok: false, reason: "The ablation pipeline could not be created." };
    }

    // --- bind groups -------------------------------------------------------
    // Which bindings the replayed bind groups may contain. For fragment
    // ablation both real stages are present, so an auto layout holds every
    // binding and nothing may be pruned. For vertex ablation the fragment
    // stage is a stub that reads nothing, so bindings only the original
    // fragment shader used are absent from the auto layout — creating the
    // original bind group against it fails unless those entries are dropped.
    let bindingFilter = null;
    if (stage === "vertex" && layout === "auto") {
        bindingFilter = vertexStageBindings(moduleObj.reflection, stageDesc.entryPoint);
        if (!bindingFilter) {
            return {
                ok: false,
                reason: "Vertex ablation needs shader reflection to know which bindings survive stubbing the fragment stage, and reflection failed.",
            };
        }
    }

    const pipelineInfo = {
        pipeline: gpuPipeline,
        isAuto: layout === "auto",
        layoutBGLs,
        vsBindings: bindingFilter,
    };
    const built = await buildPlanBindGroups(replay, pipelineInfo, plan);
    if (built.error) {
        return { ok: false, reason: built.error };
    }
    for (const vb of plan.vertexBuffers) {
        if (vb && !replay.getBuffer(vb.bufferId)) {
            return { ok: false, reason: "A vertex buffer could not be re-created." };
        }
    }

    const cut = makeCutResources(replay, gpuPipeline, layout, ablationBGL, instrumented);
    const bindGroups = built.bindGroups.concat([
        { index: instrumented.group, bindGroup: cut.bindGroup, dynamicOffsets: null },
    ]);

    const item = { plan, pipelineInfo, bindGroups };
    const timeOnce = (repeats) => timedPass(replay, repeats, (encoder, timestampWrites, n) => {
        const renderPass = encoder.beginRenderPass({
            colorAttachments: attachments.colorAttachments,
            depthStencilAttachment: depthAttachmentFor(attachments),
            timestampWrites,
        });
        // setRenderState binds everything in item.bindGroups, which already
        // includes the ablation group appended above.
        setRenderState(renderPass, replay, item, attachments.width, attachments.height);
        for (let r = 0; r < n; ++r) {
            issueDraw(renderPass, replay, plan);
        }
        renderPass.end();
    });

    return {
        ok: true,
        instrumented,
        cutBuffer: cut.cutBuffer,
        timeOnce,
        notes: ["The draw is replayed in isolation against freshly cleared attachments, so depth contents from earlier passes are absent."],
    };
}

/**
 * The compute counterpart. Simpler than the render path: no attachments, no
 * second stage to stub, and the entry point returns void so the injected early
 * return is a bare `return`.
 *
 * @returns {Promise<{ok:boolean, reason?:string, instrumented?:Object,
 *                    cutBuffer?:GPUBuffer, timeOnce?:Function,
 *                    beforeCut?:Function, notes?:string[]}>}
 */
async function prepareComputeAblation(replay, { plan, desc, entryPoint, uploads }) {
    const device = replay.device;
    if (!desc?.compute?.module) {
        return { ok: false, reason: "The dispatch's compute pipeline was not captured." };
    }
    const moduleObj = replay.database.getObject(desc.compute.module?.__id);
    const code = moduleObj?.code;
    if (!code) {
        return { ok: false, reason: "The compute shader source was not captured." };
    }
    if (plan.indirect && !replay.getBuffer(plan.indirect.bufferId)) {
        return { ok: false, reason: "The indirect argument buffer could not be re-created." };
    }

    const explicitLayout = desc.layout && desc.layout !== "auto"
        ? replay.getPipelineLayout(desc.layout.__id)
        : null;

    const instrumented = instrumentForAblation(code, {
        stage: "compute",
        entryPoint: desc.compute.entryPoint ?? entryPoint,
        avoidGroups: occupiedGroups(explicitLayout),
    });
    if (!instrumented.ok) {
        return { ok: false, reason: instrumented.reason };
    }

    const instrumentedModule = await validated(replay, "The instrumented shader failed to compile", () =>
        device.createShaderModule({ code: instrumented.code }));
    if (!instrumentedModule) {
        return { ok: false, reason: "The instrumented shader failed to compile." };
    }

    const ablationBGL = device.createBindGroupLayout({
        entries: [{
            binding: instrumented.binding,
            visibility: STAGE_COMPUTE,
            buffer: { type: "uniform" },
        }],
    });

    let layout = "auto";
    let layoutBGLs = null;
    if (explicitLayout) {
        const extended = await extendLayout(replay, explicitLayout, instrumented.group, ablationBGL);
        if (extended.error) {
            return { ok: false, reason: extended.error };
        }
        layout = extended.layout;
        layoutBGLs = extended.layoutBGLs;
    }

    const gpuPipeline = await validated(replay, "The ablation compute pipeline could not be created", () =>
        device.createComputePipeline({
            label: "ablation",
            layout,
            compute: {
                module: instrumentedModule,
                entryPoint: desc.compute.entryPoint,
                constants: desc.compute.constants ?? undefined,
            },
        }));
    if (!gpuPipeline) {
        return { ok: false, reason: "The ablation compute pipeline could not be created." };
    }

    const pipelineInfo = { pipeline: gpuPipeline, isAuto: layout === "auto", layoutBGLs, vsBindings: null };
    const built = await buildPlanBindGroups(replay, pipelineInfo, plan);
    if (built.error) {
        return { ok: false, reason: built.error };
    }

    const cut = makeCutResources(replay, gpuPipeline, layout, ablationBGL, instrumented);
    const bindGroups = built.bindGroups.concat([
        { index: instrumented.group, bindGroup: cut.bindGroup, dynamicOffsets: null },
    ]);

    const timeOnce = (repeats) => timedPass(replay, repeats, (encoder, timestampWrites, n) => {
        const computePass = encoder.beginComputePass({ timestampWrites });
        setComputeState(computePass, gpuPipeline, bindGroups);
        for (let r = 0; r < n; ++r) {
            issueDispatch(computePass, replay, plan);
        }
        computePass.end();
    });

    const notes = [
        "The dispatch is replayed in isolation, so buffers written by earlier passes in the frame hold their captured contents rather than what those passes would have produced.",
    ];
    if (plan.method === "dispatchWorkgroupsIndirect") {
        notes.push("The workgroup count comes from the captured indirect buffer, so it is whatever those bytes held when the frame was captured.");
    }

    return {
        ok: true,
        instrumented,
        cutBuffer: cut.cutBuffer,
        timeOnce,
        // A compute shader writes to the buffers it reads, so each cut has to
        // start from the captured contents or the sweep measures a moving
        // target — a data-dependent loop would take a different trip count at
        // every cut and the differences would be meaningless.
        beforeCut: () => applyUploads(replay, uploads),
        notes,
    };
}

/**
 * Measure the per-statement GPU cost of one draw's or dispatch's shader stage.
 *
 * @param {Object} params
 * @param {GPUDevice} params.device
 * @param {Object} params.database
 * @param {Object[]} params.commands - the frame's command list
 * @param {Function} params.getTextureFromAttachment
 * @param {Object} params.drawCommand - the capture command record to ablate
 *   (a draw for the vertex/fragment stages, a dispatch for compute)
 * @param {"vertex"|"fragment"|"compute"} [params.stage="fragment"]
 * @param {string} [params.entryPoint]
 * @param {(done:number,total:number)=>void} [params.onProgress]
 * @returns {Promise<{ok:boolean, reason?:string, statements?:Array,
 *                    baselineMs?:number, totalMs?:number, repeats?:number,
 *                    notes:string[]}>}
 */
export async function measureStatementCosts({
    device,
    database,
    commands,
    getTextureFromAttachment,
    drawCommand,
    stage = "fragment",
    entryPoint,
    onProgress,
}) {
    const support = detectTimingSupport(device);
    if (!support.supported) {
        return { ok: false, reason: support.reason, notes: [] };
    }
    if (stage !== "vertex" && stage !== "fragment" && stage !== "compute") {
        return { ok: false, reason: `Ablation supports vertex, fragment and compute stages, not "${stage}".`, notes: [] };
    }
    const isCompute = stage === "compute";
    const noun = isCompute ? "dispatch" : "draw";

    const replay = new CaptureReplay(device, database);
    try {
        // --- locate the item and its pass ---------------------------------
        const pass = collectPasses(commands).find((p) => p.commands.includes(drawCommand));
        if (!pass) {
            return { ok: false, reason: `The ${noun} was not found inside a pass.`, notes: [] };
        }
        if (pass.kind !== (isCompute ? "compute" : "render")) {
            return {
                ok: false,
                reason: isCompute
                    ? "Compute ablation needs a dispatch in a compute pass."
                    : "Only draws in render passes can be ablated.",
                notes: [],
            };
        }

        const uploads = [];
        const missing = new Set();
        const stats = { skippedDraws: 0 };
        const plans = walkPassCommands(replay, pass.commands, uploads, missing, stats);
        const plan = plans.find((p) => p.command === drawCommand);
        if (!plan) {
            return { ok: false, reason: `The ${noun} could not be reconstructed from the capture.`, notes: [] };
        }
        if (plan.pipelineId === null || plan.pipelineId === undefined) {
            return { ok: false, reason: `The ${noun} has no resolvable pipeline.`, notes: [] };
        }

        const desc = replay.database.getObject(plan.pipelineId)?.descriptor;

        const prepared = isCompute
            ? await prepareComputeAblation(replay, { plan, desc, entryPoint, uploads })
            : await prepareRenderAblation(replay, { pass, plan, desc, stage, entryPoint, getTextureFromAttachment });
        if (!prepared.ok) {
            return { ok: false, reason: prepared.reason, notes: Array.from(replay.notes) };
        }
        const { instrumented, cutBuffer, timeOnce, beforeCut } = prepared;

        applyUploads(replay, uploads);

        // --- sweep ----------------------------------------------------------
        async function measureCut(cut, repeats) {
            beforeCut?.();
            device.queue.writeBuffer(cutBuffer, 0, new Uint32Array([cut, 0, 0, 0]));
            // One warm-up so clock ramp-up isn't charged to the first sample.
            await timeOnce(repeats);
            let best = Infinity;
            for (let i = 0; i < SAMPLES_PER_CUT; ++i) {
                beforeCut?.();
                const ms = await timeOnce(repeats);
                if (ms !== null && ms < best) {
                    best = ms;
                }
            }
            return Number.isFinite(best) ? best : null;
        }

        // Probe the uncut shader to size the repeat count: an item costing less
        // than the timestamp quantum has to be repeated or every difference in
        // the sweep is noise.
        const probe = await measureCut(instrumented.fullCut, 1);
        if (probe === null) {
            return { ok: false, reason: `The ${noun} could not be timed.`, notes: Array.from(replay.notes) };
        }
        const repeats = probe >= TARGET_MEASUREMENT_MS
            ? 1
            : Math.min(MAX_REPEATS, Math.max(2, Math.ceil(TARGET_MEASUREMENT_MS / Math.max(probe, 1e-4))));

        const measurements = new Map();
        const total = instrumented.fullCut + 1;
        for (let cut = 0; cut <= instrumented.fullCut; ++cut) {
            onProgress?.(cut, total);
            const ms = await measureCut(cut, repeats);
            if (ms !== null) {
                measurements.set(cut, ms);
            }
        }
        onProgress?.(total, total);

        const attribution = attributeAblation(instrumented.cutPoints, measurements, instrumented.fullCut);
        const notes = Array.from(replay.notes).concat(attribution.notes);
        if (repeats > 1) {
            notes.push(`Each cut point was measured with the ${noun} encoded ${repeats} times and the total divided, because a single execution is below the GPU's timestamp granularity.`);
            if (isCompute) {
                notes.push("Those repeats run back to back without restoring buffer contents between them, so a shader whose cost depends on the data it writes will read differently than it does in the frame.");
            }
        }
        notes.push("Only the entry point's top-level statements are cut points. A statement inside a loop or branch is attributed to the enclosing top-level statement, not measured on its own.");
        notes.push(...(prepared.notes ?? []));

        return {
            ok: true,
            statements: attribution.statements,
            baselineMs: attribution.baselineMs,
            totalMs: attribution.totalMs,
            repeats,
            stage,
            notes,
        };
    } catch (e) {
        return { ok: false, reason: `Ablation failed: ${e.message ?? e}`, notes: Array.from(replay.notes) };
    } finally {
        replay.destroy();
    }
}
