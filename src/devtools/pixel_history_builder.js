// Builds the pass/draw records that the pixel-history engine consumes, from a
// captured frame's command list. This is the capture-aware half of pixel
// history: it walks the frame's render passes, reconstructs the encoder state
// for every draw (pipeline, vertex/index buffers, bind groups, viewport,
// scissor, stencil ref, blend constant), and wraps the WGSL interpreter into
// the per-draw vertex/fragment runners.

import { WgslDebug, debugFragmentQuad } from "wgsl_reflect/wgsl_reflect.module.js";
import { assembleTriangles } from "./fragment_debug.js";
import { fetchVertexInputs } from "./vertex_fetcher.js";
import {
    buildBindGroups,
    collectVertexBufferData,
    decodeIndexArray,
    extractVsOutput,
} from "./stage_debug_utils.js";

function normalizeColor(value, fallback) {
    if (value === null || value === undefined) {
        return fallback;
    }
    if (Array.isArray(value)) {
        return [value[0] ?? 0, value[1] ?? 0, value[2] ?? 0, value[3] ?? 0];
    }
    return [value.r ?? 0, value.g ?? 0, value.b ?? 0, value.a ?? 0];
}

// Build one draw record for the engine from the encoder state at a draw call.
function buildDraw(ctx, command, encoderState, pass) {
    const draw = {
        command,
        viewport: encoderState.viewport ?? { x: 0, y: 0, w: pass.width, h: pass.height, minDepth: 0, maxDepth: 1 },
        scissor: encoderState.scissor,
        stencilReference: encoderState.stencilReference,
        blendConstant: encoderState.blendConstant,
        triangles: [],
        instanceCount: 1,
        firstInstance: 0,
        getVertex: null,
        runFragment: null,
        fsOutputs: null,
        error: null,
    };

    const method = command.method;
    if (method === "drawIndirect" || method === "drawIndexedIndirect") {
        draw.error = "Indirect draws are not supported by pixel history.";
        return draw;
    }

    const pipelineCmd = encoderState.pipeline;
    const pipeline = pipelineCmd ? ctx.database.getObject(pipelineCmd.args[0]?.__id) : null;
    const desc = pipeline?.descriptor;
    if (!desc) {
        draw.error = "The draw's render pipeline was not captured.";
        return draw;
    }

    const topology = desc.primitive?.topology ?? "triangle-list";
    if (topology !== "triangle-list" && topology !== "triangle-strip") {
        draw.error = `Topology "${topology}" is not supported by pixel history.`;
        return draw;
    }

    draw.frontFace = desc.primitive?.frontFace ?? "ccw";
    draw.cullMode = desc.primitive?.cullMode ?? "none";
    draw.unclippedDepth = !!desc.primitive?.unclippedDepth;
    draw.depthStencilState = desc.depthStencil ?? null;
    draw.targets = desc.fragment?.targets ?? [];
    if ((desc.multisample?.count ?? 1) > 1) {
        draw.msaa = true;
    }

    // Assemble the draw into triangles.
    const args = command.args ?? [];
    if (method === "drawIndexed") {
        const indexArray = decodeIndexArray(encoderState.indexBuffer);
        if (!indexArray) {
            draw.error = "The draw's index buffer was not captured.";
            return draw;
        }
        draw.triangles = assembleTriangles(topology, args[0], indexArray, args[2] ?? 0, args[3] ?? 0);
        draw.instanceCount = args[1] ?? 1;
        draw.firstInstance = args[4] ?? 0;
    } else {
        draw.triangles = assembleTriangles(topology, args[0], null, args[2] ?? 0, 0);
        draw.instanceCount = args[1] ?? 1;
        draw.firstInstance = args[3] ?? 0;
    }

    // Vertex-shader runner.
    const vertexModule = ctx.database.getObject(desc.vertex?.module?.__id);
    const vsReflection = vertexModule?.reflection;
    const vsEntryName = desc.vertex?.entryPoint;
    let vsEntry = vsEntryName ? vsReflection?.entry.vertex.find((e) => e.name === vsEntryName) : null;
    if (!vsEntry) {
        vsEntry = vsReflection?.entry.vertex[0];
    }
    if (!vsEntry) {
        draw.error = "The draw's vertex shader could not be reflected.";
        return draw;
    }

    const vertexBufferData = collectVertexBufferData(encoderState.vertexBuffers);
    let bindGroups;
    try {
        bindGroups = buildBindGroups(ctx.database, encoderState.bindGroups.filter((bg) => bg));
    } catch (e) {
        draw.error = `The draw's bind groups could not be reconstructed: ${e.message ?? e}`;
        return draw;
    }

    const vsCode = vertexModule.descriptor.code;
    const vsOptions = desc.vertex?.constants ? { constants: desc.vertex.constants } : {};
    let vsDebug = ctx.vsDebugCache.get(vsCode);
    if (!vsDebug) {
        vsDebug = new WgslDebug(vsCode);
        ctx.vsDebugCache.set(vsCode, vsDebug);
    }

    draw.getVertex = (vertexIndex, instanceIndex) => {
        const inputs = fetchVertexInputs(desc, vertexBufferData, vertexIndex, instanceIndex);
        if (!vsDebug.debugVertex(vsEntry.name, inputs, bindGroups, vsOptions)) {
            return null;
        }
        let guard = 0;
        while (vsDebug.stepNext() && guard++ < 1000000) { /* run VS to completion */ }
        return extractVsOutput(vsDebug.getReturnValue(), vsEntry.outputs);
    };

    // Fragment-shader runner (absent for depth-only pipelines).
    const fragmentModule = desc.fragment ? ctx.database.getObject(desc.fragment.module?.__id) : null;
    draw.shaderLabel = fragmentModule?.label || vertexModule?.label || null;
    const fsReflection = fragmentModule?.reflection;
    if (fsReflection) {
        const fsEntryName = desc.fragment.entryPoint;
        let fsEntry = fsEntryName ? fsReflection.entry.fragment.find((e) => e.name === fsEntryName) : null;
        if (!fsEntry) {
            fsEntry = fsReflection.entry.fragment[0];
        }
        if (fsEntry) {
            const fsCode = fragmentModule.descriptor.code;
            const fsConfig = desc.fragment.constants ? { constants: desc.fragment.constants } : {};
            draw.fsOutputs = fsEntry.outputs;
            draw.runFragment = (quadInputs, targetLane) => {
                try {
                    const result = debugFragmentQuad(fsCode, fsEntry.name, quadInputs, bindGroups, fsConfig);
                    if (result.errors?.length) {
                        return { output: null, discarded: false, error: result.errors.join("; ") };
                    }
                    return { output: result.outputs[targetLane], discarded: result.discarded[targetLane] };
                } catch (e) {
                    return { output: null, discarded: false, error: `${e.message ?? e}` };
                }
            };
        }
    }

    return draw;
}

// Walk a captured frame's command list and build the render-pass records for
// runPixelHistory. `getTextureFromAttachment` maps a render-pass attachment to
// its Texture object (the capture panel's resolve-target-aware lookup).
//
// Returns { passes, notes } — notes are frame-level caveats (e.g. MSAA).
export function buildPixelHistoryPasses(database, commands, getTextureFromAttachment) {
    const ctx = { database, vsDebugCache: new Map() };
    const passes = [];
    const notes = new Set();

    let pass = null;
    let encoderState = null;
    let renderPassIndex = -1;
    // The debug-group stack at the current point of the command stream, so a
    // pass can report the groups it's nested in.
    const debugGroups = [];

    for (let ci = 0; ci < commands.length; ++ci) {
        const command = commands[ci];
        if (!command) {
            continue;
        }
        const method = command.method;

        if (method === "pushDebugGroup") {
            debugGroups.push(command.args[0]);
            continue;
        }
        if (method === "popDebugGroup") {
            debugGroups.pop();
            continue;
        }

        if (method === "beginRenderPass") {
            renderPassIndex++;
            const passDesc = command.args[0] ?? {};

            const colorAttachments = [];
            let width = 0;
            let height = 0;
            let slot = 0;
            for (const attachment of passDesc.colorAttachments ?? []) {
                const texture = attachment ? getTextureFromAttachment(attachment) : null;
                if (texture) {
                    width = width || texture.width;
                    height = height || texture.height;
                    colorAttachments.push({
                        textureId: texture.id,
                        texture,
                        slot,
                        loadOp: attachment.loadOp ?? "load",
                        storeOp: attachment.storeOp ?? "store",
                        clearValue: normalizeColor(attachment.clearValue, [0, 0, 0, 0]),
                    });
                    if ((texture.descriptor?.sampleCount ?? 1) > 1 || attachment.resolveTarget) {
                        notes.add("A multisampled attachment is simulated at pixel centers with a single sample.");
                    }
                }
                slot++;
            }

            let depthStencil = null;
            const dsAttachment = passDesc.depthStencilAttachment;
            if (dsAttachment) {
                const texture = getTextureFromAttachment(dsAttachment);
                if (texture) {
                    width = width || texture.width;
                    height = height || texture.height;
                    depthStencil = {
                        textureId: texture.id,
                        texture,
                        depthLoadOp: dsAttachment.depthLoadOp ?? "load",
                        depthClearValue: dsAttachment.depthClearValue ?? 1,
                        depthReadOnly: !!dsAttachment.depthReadOnly,
                        stencilLoadOp: dsAttachment.stencilLoadOp ?? "load",
                        stencilClearValue: dsAttachment.stencilClearValue ?? 0,
                        stencilReadOnly: !!dsAttachment.stencilReadOnly,
                    };
                }
            }

            pass = {
                passIndex: command._passIndex ?? renderPassIndex,
                command,
                label: passDesc.label ?? null,
                groups: debugGroups.slice(),
                width,
                height,
                colorAttachments,
                depthStencil,
                draws: [],
            };
            encoderState = {
                pipeline: null,
                vertexBuffers: [],
                indexBuffer: null,
                bindGroups: [],
                viewport: null,
                scissor: null,
                stencilReference: 0,
                blendConstant: [1, 1, 1, 1],
            };
            continue;
        }

        if (!pass) {
            continue;
        }

        switch (method) {
            case "end":
                if (pass.width && pass.height) {
                    passes.push(pass);
                }
                pass = null;
                encoderState = null;
                break;
            case "setPipeline":
                encoderState.pipeline = command;
                break;
            case "setVertexBuffer":
                encoderState.vertexBuffers[command.args[0]] = command;
                break;
            case "setIndexBuffer":
                encoderState.indexBuffer = command;
                break;
            case "setBindGroup":
                encoderState.bindGroups[command.args[0]] = command;
                break;
            case "setViewport":
                encoderState.viewport = {
                    x: command.args[0], y: command.args[1],
                    w: command.args[2], h: command.args[3],
                    minDepth: command.args[4] ?? 0, maxDepth: command.args[5] ?? 1,
                };
                break;
            case "setScissorRect":
                encoderState.scissor = {
                    x: command.args[0], y: command.args[1],
                    w: command.args[2], h: command.args[3],
                };
                break;
            case "setStencilReference":
                encoderState.stencilReference = command.args[0] ?? 0;
                break;
            case "setBlendConstant":
                encoderState.blendConstant = normalizeColor(command.args[0], [1, 1, 1, 1]);
                break;
            case "executeBundles":
                pass.draws.push({
                    command,
                    error: "Render bundles are not supported by pixel history.",
                });
                break;
            case "draw":
            case "drawIndexed":
            case "drawIndirect":
            case "drawIndexedIndirect": {
                const draw = buildDraw(ctx, command, encoderState, pass);
                if (draw.msaa) {
                    notes.add("A multisampled attachment is simulated at pixel centers with a single sample.");
                }
                pass.draws.push(draw);
                break;
            }
        }
    }

    return { passes, notes: Array.from(notes) };
}
