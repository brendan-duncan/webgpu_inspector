import { WgslDebug, debugFragmentQuad } from "wgsl_reflect/wgsl_reflect.module.js";
import {
    CaptureReplay,
    applyUploads,
    encodeDraw,
    getVariantPipeline,
    prepareReplayDraw,
    vertexStageBindings,
    walkPassCommands,
} from "./capture_replay.js";
import { buildMeshInput } from "./mesh_input.js";
import { runVsOut } from "./vs_out.js";

/**
 * The shader debugger's check against the GPU: what the CPU interpreter says
 * the debugged vertex or fragment returns, next to what the GPU returns for
 * the same invocation when the draw is replayed on the DevTools device.
 *
 * A mismatch is worth knowing about in both directions: either the shader
 * depends on something the debugger doesn't model (a texture's contents at
 * draw time, derivatives at a triangle edge, float precision), or the
 * interpreter has a bug, and then its stepping can't be trusted either.
 */

/** Relative tolerance for float comparison: interpolation and fma differ in the last bits. */
const TOLERANCE = 1e-3;

function toArray(value) {
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value === "number" || typeof value === "boolean") {
        return [Number(value)];
    }
    if (ArrayBuffer.isView(value) || Array.isArray(value)) {
        return Array.from(value, Number);
    }
    return null;
}

/**
 * The outputs of a shader entry point's return value, keyed so the CPU and GPU
 * sides line up: "position" for @builtin(position), "@location(n)" for the
 * rest, from the entry point's reflected outputs.
 * @returns {Map<string,{name:string, value:number[]}>}
 */
export function outputsByKey(returnValue, entryOutputs) {
    const out = new Map();
    if (returnValue === null || returnValue === undefined) {
        return out;
    }
    const direct = toArray(returnValue);
    if (direct) {
        // A bare return: its one output.
        const o = entryOutputs?.[0];
        const key = !o || o.locationType === "builtin" ? (o?.location === "position" || !o ? "position" : `@builtin(${o.location})`) : `@location(${o.location})`;
        out.set(key, { name: o?.name || key, value: direct });
        return out;
    }
    for (const o of entryOutputs ?? []) {
        const value = toArray(returnValue[o.name]);
        if (!value) {
            continue;
        }
        const key = o.locationType === "builtin" ? (o.location === "position" ? "position" : `@builtin(${o.location})`) : `@location(${o.location})`;
        out.set(key, { name: o.name, value });
    }
    return out;
}

/**
 * Compare CPU and GPU outputs, key by key.
 * @returns {Object[]} { key, name, cpu, gpu, match } per output
 */
export function compareOutputs(cpu, gpu, tolerance = TOLERANCE) {
    const rows = [];
    const keys = new Set([...cpu.keys(), ...gpu.keys()]);
    for (const key of keys) {
        const c = cpu.get(key);
        const g = gpu.get(key);
        let match = null;
        if (c && g) {
            const n = Math.min(c.value.length, g.value.length);
            match = true;
            for (let i = 0; i < n; ++i) {
                const a = c.value[i];
                const b = g.value[i];
                if (Number.isNaN(a) && Number.isNaN(b)) {
                    continue;
                }
                if (Math.abs(a - b) > tolerance * Math.max(1, Math.abs(a), Math.abs(b))) {
                    match = false;
                    break;
                }
            }
        }
        rows.push({ key, name: c?.name ?? g?.name ?? key, cpu: c?.value ?? null, gpu: g?.value ?? null, match });
    }
    return rows;
}

// ---------------------------------------------------------------------------
// Vertex
// ---------------------------------------------------------------------------

/** Run a vertex shader on the CPU interpreter to completion. */
export function cpuVertexOutputs({ code, entry, inputs, bindGroups, constants }) {
    const debug = new WgslDebug(code);
    if (!debug.debugVertex(entry.name, inputs, bindGroups, constants ? { constants } : {})) {
        throw new Error("The vertex shader could not be run on the CPU.");
    }
    let guard = 0;
    while (debug.stepNext() && guard++ < 5_000_000) { /* run to completion */ }
    return outputsByKey(debug.getReturnValue(), entry.outputs);
}

/**
 * The GPU's outputs for one vertex of a draw, from VS Out.
 * @returns {Promise<{outputs: Map, notes: string[]}>}
 */
export async function gpuVertexOutputs({ device, database, command, passCommands, pipelineDesc, shaderInputs, vertexBufferCommands, indexBufferCommand, vertexIndex, instance }) {
    const mesh = buildMeshInput({ command, pipelineDesc, shaderInputs, vertexBufferCommands, indexBufferCommand, instance });
    const element = mesh.vertexIndices.indexOf(vertexIndex);
    if (element < 0) {
        throw new Error(`The draw doesn't fetch vertex ${vertexIndex}.`);
    }
    const out = await runVsOut({ device, database, command, passCommands, pipelineDesc, mesh, instance });
    const outputs = new Map();
    out.attributes.forEach((attr, a) => {
        const n = attr.components;
        const value = Array.from(out.values[a].subarray(element * n, element * n + n));
        const key = attr.builtin ? (attr.builtin === "position" ? "position" : `@builtin(${attr.builtin})`) : `@location(${attr.location})`;
        outputs.set(key, { name: attr.name.replace(/ \(@builtin\(.*\)\)$/, ""), value });
    });
    return { outputs, notes: out.warnings };
}

// ---------------------------------------------------------------------------
// Fragment
// ---------------------------------------------------------------------------

/** Run the fragment quad on the CPU interpreter; the picked lane's outputs. */
export function cpuFragmentOutputs({ code, entry, quadInputs, bindGroups, targetLane, constants }) {
    const result = debugFragmentQuad(code, entry.name, quadInputs, bindGroups, constants ? { constants } : {});
    if (result.errors?.length) {
        throw new Error(result.errors[0]);
    }
    return {
        discarded: !!result.discarded[targetLane],
        outputs: outputsByKey(result.outputs[targetLane], entry.outputs),
    };
}

// A 32-bit format with the original target's channel count and sample type,
// so the fragment's output comes back without quantization.
function readableFormat(format) {
    const channels = /^(r8|r16|r32)(?!g)/.test(format) ? 1 : /^(rg8|rg16|rg32)(?!b)/.test(format) ? 2 : 4;
    const kind = /uint$/.test(format) ? "uint" : /sint$/.test(format) ? "sint" : "float";
    const prefix = channels === 1 ? "r32" : channels === 2 ? "rg32" : "rgba32";
    return { format: `${prefix}${kind}`, channels, kind };
}

/**
 * The GPU's fragment outputs at one pixel for one draw: the draw replayed
 * with its real fragment shader into 32-bit targets, scissored to the pixel,
 * with blending off and a fresh depth buffer, so the result is the draw's own
 * front-most fragment there, as the debugger picks it.
 * @returns {Promise<{covered: boolean, outputs: Map, notes: string[]}>}
 */
export async function gpuFragmentOutputs({ device, database, command, passCommands, pipelineId, pixelX, pixelY, width, height, fragmentEntry }) {
    const replay = new CaptureReplay(device, database);
    const created = [];
    try {
        const uploads = [];
        const missing = new Set();
        const plans = walkPassCommands(replay, passCommands, uploads, missing, { skippedDraws: 0 });
        const plan = plans.find((p) => p.command === command);
        if (!plan) {
            throw new Error("The draw could not be found in its pass.");
        }
        const pipelineObj = database.getObject(pipelineId);
        const desc = pipelineObj?.descriptor;
        const fsModuleObj = database.getObject(desc?.fragment?.module?.__id);
        const fsModule = replay.getShaderModule(desc?.fragment?.module?.__id);
        if (!fsModule) {
            throw new Error("The fragment shader was not captured.");
        }
        const targets = (desc.fragment.targets ?? []).map((t) => (t ? readableFormat(t.format) : null));

        // Both stages' bindings: with an "auto" layout, the bind groups must
        // carry exactly what the vertex and fragment shaders use.
        const vsModuleObj = database.getObject(desc.vertex?.module?.__id);
        const bindings = new Set(vertexStageBindings(vsModuleObj?.reflection, desc.vertex?.entryPoint) ?? []);
        for (const r of fragmentEntry?.resources ?? []) {
            bindings.add(`${r.group}:${r.binding}`);
        }
        const keepStencil = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" };
        const prep = await prepareReplayDraw(replay, plan, (id) => getVariantPipeline(replay, id, {
            key: "gpu-compare",
            label: "debugger check",
            bindings,
            fragment: {
                module: fsModule,
                entryPoint: desc.fragment.entryPoint,
                constants: desc.fragment.constants,
                targets: targets.map((t) => (t ? { format: t.format } : null)),
            },
            depthStencil: (ds) => (ds && ds.format.includes("depth")
                ? { ...ds, stencilFront: keepStencil, stencilBack: keepStencil, stencilWriteMask: 0 }
                : undefined),
        }));
        if (prep.error) {
            throw new Error(prep.error);
        }
        applyUploads(replay, uploads);

        const colorTextures = targets.map((t) => {
            if (!t) {
                return null;
            }
            const texture = device.createTexture({ size: [width, height], format: t.format, usage: 0x10 | 0x01 });
            created.push(texture);
            return texture;
        });
        let depthAttachment;
        const ds = desc.depthStencil;
        if (ds && ds.format.includes("depth")) {
            const depth = device.createTexture({ size: [width, height], format: ds.format, usage: 0x10 });
            created.push(depth);
            const reversed = ds.depthCompare === "greater" || ds.depthCompare === "greater-equal";
            depthAttachment = { view: depth.createView(), depthLoadOp: "clear", depthStoreOp: "discard", depthClearValue: reversed ? 0 : 1 };
            if (ds.format.includes("stencil")) {
                depthAttachment.stencilLoadOp = "clear";
                depthAttachment.stencilStoreOp = "discard";
            }
        }
        const querySet = device.createQuerySet({ type: "occlusion", count: 1 });
        const queryBuffer = device.createBuffer({ size: 8, usage: 0x0200 | 0x0004 });
        created.push(querySet, queryBuffer);

        device.pushErrorScope("validation");
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: colorTextures.map((t) => (t ? { view: t.createView(), loadOp: "clear", storeOp: "store" } : null)),
            depthStencilAttachment: depthAttachment,
            occlusionQuerySet: querySet,
        });
        pass.beginOcclusionQuery(0);
        encodeDraw(pass, replay, { plan, pipelineInfo: prep.pipelineInfo, bindGroups: prep.bindGroups }, width, height, [pixelX, pixelY, 1, 1], null);
        pass.endOcclusionQuery();
        pass.end();
        encoder.resolveQuerySet(querySet, 0, 1, queryBuffer, 0);

        const readbacks = [];
        colorTextures.forEach((texture, i) => {
            if (!texture) {
                return;
            }
            const buffer = device.createBuffer({ size: 256, usage: 0x0008 | 0x0001 });
            created.push(buffer);
            encoder.copyTextureToBuffer({ texture, origin: [pixelX, pixelY] }, { buffer, bytesPerRow: 256 }, [1, 1]);
            readbacks.push({ index: i, buffer });
        });
        const queryReadback = device.createBuffer({ size: 8, usage: 0x0008 | 0x0001 });
        created.push(queryReadback);
        encoder.copyBufferToBuffer(queryBuffer, 0, queryReadback, 0, 8);
        device.queue.submit([encoder.finish()]);
        const error = await device.popErrorScope();
        if (error) {
            throw new Error(`The draw could not be replayed: ${error.message}`);
        }

        await queryReadback.mapAsync(0x0001);
        const samples = new BigUint64Array(queryReadback.getMappedRange())[0];
        queryReadback.unmap();

        const outputs = new Map();
        const names = new Map((fragmentEntry?.outputs ?? []).filter((o) => o.locationType === "location").map((o) => [o.location, o.name]));
        for (const { index, buffer } of readbacks) {
            await buffer.mapAsync(0x0001);
            const range = buffer.getMappedRange();
            const t = targets[index];
            const array = t.kind === "uint" ? new Uint32Array(range, 0, t.channels)
                : t.kind === "sint" ? new Int32Array(range, 0, t.channels)
                : new Float32Array(range, 0, t.channels);
            outputs.set(`@location(${index})`, { name: names.get(index) ?? `@location(${index})`, value: Array.from(array) });
            buffer.unmap();
        }
        const notes = [...missing, ...replay.notes];
        if (replay.placeholderTextures.size) {
            notes.push("Some bound textures replay with placeholder contents (depth or multisampled textures whose data isn't captured in their original format).");
        }
        return { covered: samples > 0n, outputs, notes };
    } finally {
        for (const obj of created) {
            try {
                obj.destroy();
            } catch (_) { /* ignore */ }
        }
        replay.destroy();
    }
}
