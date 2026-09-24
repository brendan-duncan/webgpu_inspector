import { CaptureReplay, applyUploads, encodeDraw, getVariantPipeline, halfToFloat, prepareReplayDraw, walkPassCommands } from "./capture_replay.js";
import { resolveDrawArgs } from "./draw_overlay.js";
import { collectReplaySteps } from "./frame_replay.js";

/**
 * GPU Bottlenecks: what each render pass spends its GPU time on.
 *
 * Per pass, three numbers carry most of the answer:
 *
 *   rasterized   fragments the rasterizer produced (every covered pixel,
 *                before any test), counted by replaying the pass with a stub
 *                fragment shader that adds 1 per fragment
 *   survived     fragments that passed the pass's depth and stencil tests,
 *                counted the same way with the draws' depth-stencil state
 *   primitives   triangles (or lines, points) the pass's draws submit
 *
 * From them: overdraw (rasterized / target pixels), fragments per primitive
 * (tiny triangles waste rasterizer and quad work), and the rejected fraction
 * (fragments rasterized and then thrown away — free with early depth testing,
 * expensive when the fragment shader discards or writes depth and so has to
 * run first). Combined with the pass's GPU time (Profile Passes), its target
 * formats, sample count and blending, each pass gets a verdict.
 *
 * The statistics and rules are DOM-free; bottleneck_view.js draws them.
 */

const DRAW_METHODS = new Set(["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"]);

const STUB_SHADER = "@fragment fn main() -> @location(0) vec4f { return vec4f(1.0); }";

function formatBytesPerPixel(format) {
    if (!format) {
        return 0;
    }
    if (/32float|32uint|32sint/.test(format)) {
        return (/^rgba/.test(format) ? 16 : /^rg/.test(format) ? 8 : 4);
    }
    if (/16float|16uint|16sint|16unorm|16snorm/.test(format)) {
        return (/^rgba/.test(format) ? 8 : /^rg/.test(format) ? 4 : 2);
    }
    if (/depth32float-stencil8/.test(format)) {
        return 5;
    }
    if (/depth24plus-stencil8|depth32float|depth24plus|rgb10a2|rg11b10|rgb9e5/.test(format)) {
        return 4;
    }
    if (/^rgba8|^bgra8/.test(format)) {
        return 4;
    }
    if (/^rg8/.test(format) || format === "depth16unorm") {
        return 2;
    }
    return 1;
}

function primitivesFor(topology, count) {
    switch (topology) {
        case "triangle-strip":
            return Math.max(0, count - 2);
        case "line-list":
            return Math.floor(count / 2);
        case "line-strip":
            return Math.max(0, count - 1);
        case "point-list":
            return count;
        default:
            return Math.floor(count / 3);
    }
}

// Whether a fragment entry point can defeat early depth testing: discard, or
// writing @builtin(frag_depth).
function lateDepthFeatures(module, entryPoint) {
    const code = module?.code ?? module?.descriptor?.code ?? "";
    const features = [];
    if (/\bdiscard\b/.test(code)) {
        features.push("discard");
    }
    if (/frag_depth/.test(code)) {
        features.push("frag_depth");
    }
    return features;
}

/**
 * Per-pass statistics that come straight from the capture (no GPU).
 * @param {Object[]} commands
 * @param {Object} resolver - { getObject, getTextureFromAttachment }
 * @returns {Object[]} one entry per render or compute pass, in execution order
 */
export function collectPassStats(commands, { getObject, getTextureFromAttachment }) {
    const passes = [];
    for (const step of collectReplaySteps(commands)) {
        if (step.kind === "transfer") {
            continue;
        }
        const begin = step.begin;
        const desc = begin.args?.[0] ?? {};
        const pass = {
            begin,
            kind: step.kind,
            label: desc.label || `${step.kind === "render" ? "Render" : "Compute"} Pass ${begin._passIndex ?? passes.length}`,
            durationMs: typeof begin.duration === "number" ? begin.duration : null,
            commands: step.commands,
            draws: 0,
            dispatches: 0,
            primitives: 0,
            primitivesKnown: true,
            width: 0,
            height: 0,
            sampleCount: 1,
            bytesPerPixel: 0,
            targets: [],
            blending: false,
            lateDepth: new Set(),
        };
        if (step.kind === "render") {
            for (const attachment of [...(desc.colorAttachments ?? []), desc.depthStencilAttachment]) {
                if (!attachment) {
                    continue;
                }
                const texture = getTextureFromAttachment(attachment);
                if (!texture) {
                    continue;
                }
                pass.width = Math.max(pass.width, texture.width ?? 0);
                pass.height = Math.max(pass.height, texture.height ?? 0);
                pass.sampleCount = Math.max(pass.sampleCount, texture.sampleCount ?? 1);
                pass.bytesPerPixel += formatBytesPerPixel(texture.format);
                pass.targets.push(texture.format);
            }
        }
        let pipelineId;
        for (const command of step.commands) {
            if (command.method === "setPipeline") {
                pipelineId = command.args?.[0]?.__id;
                const d = getObject(pipelineId)?.descriptor;
                if (d?.fragment) {
                    if ((d.fragment.targets ?? []).some((t) => t?.blend)) {
                        pass.blending = true;
                    }
                    for (const f of lateDepthFeatures(getObject(d.fragment.module?.__id), d.fragment.entryPoint)) {
                        if (d.depthStencil) {
                            pass.lateDepth.add(f);
                        }
                    }
                }
            } else if (DRAW_METHODS.has(command.method)) {
                pass.draws++;
                const d = getObject(pipelineId)?.descriptor;
                const args = resolveDrawArgs({ method: command.method, args: command.args ?? [], command, indirect: command.method.endsWith("Indirect") ? { offset: command.args?.[1] ?? 0 } : undefined });
                if (!args) {
                    pass.primitivesKnown = false;
                    continue;
                }
                pass.primitives += primitivesFor(d?.primitive?.topology ?? "triangle-list", args.count) * (args.instanceCount ?? 1);
            } else if (command.method === "dispatchWorkgroups" || command.method === "dispatchWorkgroupsIndirect") {
                pass.dispatches++;
            } else if (command.method === "executeBundles") {
                pass.primitivesKnown = false;
            }
        }
        passes.push(pass);
    }
    return passes;
}

/**
 * Count each render pass's rasterized and surviving fragments on the GPU.
 *
 * Occlusion queries can't do it: WebGPU only promises zero versus non-zero.
 * Instead each pass is replayed twice with a stub fragment shader that adds
 * 1.0 per fragment into an r16float target, which is read back and summed:
 * once with no depth test (every rasterized fragment), and once with the
 * draws' own depth-stencil state against depth-stencil textures that carry
 * over between passes, honoring each pass's load and clear ops. The stub
 * never discards, so "survived" is what the depth and stencil tests keep.
 *
 * Fills pass.rasterized and pass.survived (in pixels; MSAA passes replay at
 * one sample per pixel).
 * @returns {Promise<string[]>} notes
 */
export async function measurePasses(passes, { device, database, getTextureFromAttachment, onProgress }) {
    const notes = new Set();
    const replay = new CaptureReplay(device, database);
    const stub = device.createShaderModule({ code: STUB_SHADER });
    const target = [{ format: "r16float", blend: { color: { srcFactor: "one", dstFactor: "one", operation: "add" }, alpha: { srcFactor: "one", dstFactor: "one", operation: "add" } } }];
    const depthTextures = new Map();   // "textureId:mip:layer" -> GPUTexture
    const created = [];
    const hasDepth = (f) => !!f && f.includes("depth");
    const hasStencil = (f) => !!f && f.includes("stencil");

    const sumCounts = async (texture, width, height) => {
        const bytesPerRow = Math.ceil(width * 2 / 256) * 256;
        const buffer = device.createBuffer({ size: bytesPerRow * height, usage: 0x0008 | 0x0001 });
        try {
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
            device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(0x0001);
            const halves = new Uint16Array(buffer.getMappedRange());
            let total = 0;
            const rowHalves = bytesPerRow / 2;
            for (let y = 0; y < height; ++y) {
                for (let x = 0; x < width; ++x) {
                    const v = halfToFloat(halves[y * rowHalves + x]);
                    if (Number.isFinite(v)) {
                        total += Math.round(v);
                    }
                }
            }
            buffer.unmap();
            return total;
        } finally {
            buffer.destroy();
        }
    };

    try {
        for (let i = 0; i < passes.length; ++i) {
            const pass = passes[i];
            if (pass.kind !== "render" || !pass.width || !pass.height) {
                continue;
            }
            onProgress?.(`Counting fragments… pass ${i + 1} of ${passes.length}`);
            const { width, height } = pass;
            const desc = pass.begin.args?.[0] ?? {};

            // The pass's depth-stencil attachment, as a texture that persists
            // across passes so later passes see what earlier ones wrote.
            let dsAttachment;
            let dsFormat = null;
            if (desc.depthStencilAttachment) {
                const ds = desc.depthStencilAttachment;
                const texture = getTextureFromAttachment(ds);
                const view = database.getObject(ds.view?.__id)?.descriptor ?? {};
                if (texture && (hasDepth(texture.format) || hasStencil(texture.format))) {
                    dsFormat = texture.format;
                    const key = `${texture.id}:${view.baseMipLevel ?? 0}:${view.baseArrayLayer ?? 0}:${width}x${height}`;
                    let gpu = depthTextures.get(key);
                    if (!gpu) {
                        gpu = device.createTexture({ size: [width, height], format: dsFormat, usage: 0x10 });
                        created.push(gpu);
                        depthTextures.set(key, gpu);
                        // Contents from before the frame aren't known; start at the far plane.
                        const init = { view: gpu.createView() };
                        if (hasDepth(dsFormat)) {
                            Object.assign(init, { depthLoadOp: "clear", depthStoreOp: "store", depthClearValue: 1 });
                        }
                        if (hasStencil(dsFormat)) {
                            Object.assign(init, { stencilLoadOp: "clear", stencilStoreOp: "store", stencilClearValue: 0 });
                        }
                        const encoder = device.createCommandEncoder();
                        encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: init }).end();
                        device.queue.submit([encoder.finish()]);
                    }
                    dsAttachment = { view: gpu.createView() };
                    if (hasDepth(dsFormat)) {
                        dsAttachment.depthLoadOp = ds.depthReadOnly ? undefined : (ds.depthLoadOp ?? "load");
                        dsAttachment.depthStoreOp = ds.depthReadOnly ? undefined : "store";
                        dsAttachment.depthReadOnly = !!ds.depthReadOnly;
                        if (ds.depthLoadOp === "clear") {
                            dsAttachment.depthClearValue = ds.depthClearValue ?? 1;
                        }
                    }
                    if (hasStencil(dsFormat)) {
                        dsAttachment.stencilLoadOp = ds.stencilReadOnly ? undefined : (ds.stencilLoadOp ?? "load");
                        dsAttachment.stencilStoreOp = ds.stencilReadOnly ? undefined : "store";
                        dsAttachment.stencilReadOnly = !!ds.stencilReadOnly;
                        if (ds.stencilLoadOp === "clear") {
                            dsAttachment.stencilClearValue = ds.stencilClearValue ?? 0;
                        }
                    }
                    for (const k of Object.keys(dsAttachment)) {
                        if (dsAttachment[k] === undefined) {
                            delete dsAttachment[k];
                        }
                    }
                }
            }

            const uploads = [];
            const missing = new Set();
            const plans = walkPassCommands(replay, pass.commands, uploads, missing, { skippedDraws: 0 });
            const rasterItems = [];
            const testedItems = [];
            for (const plan of plans) {
                if (!DRAW_METHODS.has(plan.method) || plan.pipelineId === null || plan.pipelineId === undefined) {
                    continue;
                }
                const raster = await prepareReplayDraw(replay, plan, (id) => getVariantPipeline(replay, id, {
                    key: "count-raster",
                    label: "raster count",
                    fragment: { module: stub, entryPoint: "main", targets: target },
                }));
                if (!raster.error) {
                    rasterItems.push({ plan, pipelineInfo: raster.pipelineInfo, bindGroups: raster.bindGroups });
                }
                if (dsFormat) {
                    const tested = await prepareReplayDraw(replay, plan, (id) => getVariantPipeline(replay, id, {
                        key: `count-tested:${dsFormat}`,
                        label: "depth-tested count",
                        fragment: { module: stub, entryPoint: "main", targets: target },
                        // A draw without depth-stencil state passes everything.
                        depthStencil: (original) => (original ? { ...original, format: dsFormat } : { format: dsFormat, depthCompare: "always", depthWriteEnabled: false }),
                    }));
                    if (!tested.error) {
                        testedItems.push({ plan, pipelineInfo: tested.pipelineInfo, bindGroups: tested.bindGroups });
                    }
                }
            }
            applyUploads(replay, uploads);
            if (rasterItems.length < pass.draws) {
                notes.add(`${pass.label}: ${pass.draws - rasterItems.length} draw(s) could not be replayed and are missing from its counts.`);
            }

            const counts = [];
            for (const [items, withDepth] of [[rasterItems, false], [dsFormat ? testedItems : null, true]]) {
                if (!items) {
                    continue;
                }
                const countTexture = device.createTexture({ size: [width, height], format: "r16float", usage: 0x10 | 0x01 });
                created.push(countTexture);
                device.pushErrorScope("validation");
                const encoder = device.createCommandEncoder();
                const rp = encoder.beginRenderPass({
                    colorAttachments: [{ view: countTexture.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
                    depthStencilAttachment: withDepth ? dsAttachment : undefined,
                });
                for (const item of items) {
                    encodeDraw(rp, replay, item, width, height, null, null);
                }
                rp.end();
                device.queue.submit([encoder.finish()]);
                const error = await device.popErrorScope();
                if (error) {
                    notes.add(`${pass.label}: fragments could not be counted (${error.message}).`);
                    counts.push(undefined);
                    continue;
                }
                counts.push(await sumCounts(countTexture, width, height));
            }
            pass.rasterized = counts[0];
            // Without a depth-stencil attachment nothing is tested: all survive.
            pass.survived = dsFormat ? counts[1] : counts[0];
        }
    } finally {
        for (const texture of created) {
            try {
                texture.destroy();
            } catch (_) { /* ignore */ }
        }
        replay.destroy();
    }
    notes.add("Survived counts what the depth and stencil tests keep. Fragment-shader discard isn't counted, and depth-stencil contents from before the frame start at the far plane.");
    return [...notes];
}

const SEVERITY = { high: 3, medium: 2, low: 1, info: 0 };

/**
 * Derived metrics and findings per pass.
 * @param {Object[]} passes - from collectPassStats (+ measurePasses)
 * @returns {{passes: Object[], issues: Object[]}} passes gain { overdraw,
 *   fragsPerPrimitive, rejected, share, verdict, findings }; issues are every
 *   finding, most important first ({ pass, severity, title, message })
 */
export function analyzePasses(passes) {
    const totalMs = passes.reduce((s, p) => s + (p.durationMs ?? 0), 0);
    const issues = [];
    for (const pass of passes) {
        const findings = [];
        pass.share = totalMs > 0 && pass.durationMs !== null ? pass.durationMs / totalMs : null;
        const pixels = pass.width * pass.height;
        pass.overdraw = pass.rasterized !== undefined && pixels ? pass.rasterized / pixels : null;
        pass.fragsPerPrimitive = pass.rasterized !== undefined && pass.primitives ? pass.rasterized / pass.primitives : null;
        pass.rejected = pass.rasterized && pass.survived !== undefined ? Math.max(0, 1 - pass.survived / pass.rasterized) : null;

        const add = (severity, title, message) => findings.push({ pass, severity, title, message });

        if (pass.kind === "compute") {
            if (pass.share !== null && pass.share >= 0.3) {
                add("medium", "Heavy compute", `${pass.label} takes ${(pass.share * 100).toFixed(0)}% of the frame's GPU time in ${pass.dispatches} dispatch(es). The Shader Flame Graph and Measure statements show which lines cost the most.`);
            }
        } else {
            if (pass.fragsPerPrimitive !== null && pass.primitives >= 5000 && pass.fragsPerPrimitive < 4) {
                add("high", "Tiny triangles",
                    `${pass.primitives.toLocaleString()} primitives cover ${pass.fragsPerPrimitive.toFixed(1)} pixels each on average. GPUs shade in 2x2 quads and rasterize at a fixed rate per triangle, so triangles this small waste most of that work. Level of detail, or culling small or distant objects, cuts it.`);
            }
            if (pass.overdraw !== null && pass.overdraw >= 3) {
                add(pass.overdraw >= 6 ? "high" : "medium", "High overdraw",
                    `Each pixel is covered ${pass.overdraw.toFixed(1)} times on average. For opaque geometry, drawing front to back (or a depth prepass) lets the depth test skip hidden fragments before they're shaded${pass.blending ? "; blended layers can't be skipped that way, so reduce their count or area" : ""}.`);
            }
            if (pass.rejected !== null && pass.rejected >= 0.5 && pass.rasterized > pixels * 0.5) {
                if (pass.lateDepth.size) {
                    add("high", "Shaded, then rejected",
                        `${(pass.rejected * 100).toFixed(0)}% of the rasterized fragments fail the depth or stencil test or are discarded, and the pass's fragment shaders use ${[...pass.lateDepth].join(" and ")}, which makes the GPU run the fragment shader before the depth test. Those fragments are fully shaded and then thrown away. Move discard (alpha testing) to its own pass with a depth prepass, or avoid writing frag_depth.`);
                } else {
                    add("low", "Most fragments rejected",
                        `${(pass.rejected * 100).toFixed(0)}% of the rasterized fragments fail the depth or stencil test. With early depth testing that's cheap, but the rasterizer still produces them; sorting opaque draws front to back reduces them further.`);
                }
            }
            const bandwidth = pass.bytesPerPixel * pass.sampleCount;
            if (bandwidth >= 24 || (pass.sampleCount > 1 && pass.bytesPerPixel >= 8)) {
                add("medium", "Heavy render targets",
                    `The pass writes ${pass.bytesPerPixel} bytes per pixel${pass.sampleCount > 1 ? ` at ${pass.sampleCount}x MSAA (${bandwidth} bytes per pixel)` : ""} across ${pass.targets.length} target(s) (${pass.targets.join(", ")}). Memory bandwidth, not shading, often limits passes like this; smaller formats (rgba16float to rg11b10ufloat, fewer G-buffer targets) or fewer samples help.`);
            }
        }
        if (pass.share !== null && pass.share >= 0.4 && !findings.length) {
            add("info", "Largest pass",
                `${pass.label} takes ${(pass.share * 100).toFixed(0)}% of the frame's GPU time, with nothing in the counts that stands out. The Shader Flame Graph shows how that time divides between its shaders.`);
        }
        findings.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity]);
        pass.findings = findings;
        pass.verdict = findings[0]?.title ?? (pass.kind === "render" && pass.rasterized !== undefined ? "Nothing stands out" : "");
        issues.push(...findings);
    }
    // Most important first: severity, then the pass's share of GPU time.
    issues.sort((a, b) => SEVERITY[b.severity] - SEVERITY[a.severity] || (b.pass.share ?? 0) - (a.pass.share ?? 0));
    return { passes, issues };
}
