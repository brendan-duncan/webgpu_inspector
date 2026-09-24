import {
    CaptureReplay,
    applyUploads,
    encodeDraw,
    getVariantPipeline,
    isDepthStencilFormat,
    prepareReplayDraw,
    walkPassCommands,
} from "./capture_replay.js";

/**
 * Per-draw overlays for a render target: what one draw of the frame covers,
 * how its geometry is laid out, and which of its fragments pass the depth and
 * stencil tests. Each overlay is made by replaying the draw on the DevTools
 * device (see capture_replay.js) with its original vertex stage and a stub
 * fragment stage that writes a flat color:
 *
 *   Highlight Draw    the pixels the draw rasterizes (after culling, viewport,
 *                     scissor and depth clip; no depth test)
 *   Wireframe         the draw's triangle edges, from a line-list index buffer
 *                     built on the CPU from the captured indices
 *   Depth Test        green where a fragment passes the depth test, red where it
 *                     fails. The depth buffer is rebuilt first by replaying
 *                     every earlier draw into it.
 *   Stencil Test      the same for the stencil test
 *   Backface Cull     green front-facing, red back-facing, whatever the cull mode
 *   Viewport/Scissor  the draw's viewport and scissor rectangles (no replay)
 */

export const OVERLAY_NONE = "None";
export const OVERLAY_HIGHLIGHT = "Highlight Draw";
export const OVERLAY_WIREFRAME = "Wireframe";
export const OVERLAY_DEPTH = "Depth Test";
export const OVERLAY_STENCIL = "Stencil Test";
export const OVERLAY_BACKFACE = "Backface Cull";
export const OVERLAY_VIEWPORT = "Viewport / Scissor";

export const OVERLAY_MODES = [OVERLAY_NONE, OVERLAY_HIGHLIGHT, OVERLAY_WIREFRAME, OVERLAY_DEPTH,
    OVERLAY_STENCIL, OVERLAY_BACKFACE, OVERLAY_VIEWPORT];

// Overlay colors, as [r, g, b] bytes; the stub shaders write the same values.
export const OVERLAY_COLORS = {
    pass: [60, 210, 90],
    fail: [235, 60, 60],
    highlight: [255, 60, 230],
    wire: [255, 235, 60],
    viewport: [60, 200, 255],
    scissor: [255, 200, 40],
};

const OVERLAY_FORMAT = "rgba8unorm";
const TEXTURE_COPY_SRC = 0x01;
const TEXTURE_RENDER_ATTACHMENT = 0x10;
const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_INDEX = 0x0010;

const DRAW_METHODS = new Set(["draw", "drawIndexed", "drawIndirect", "drawIndexedIndirect"]);

function wgslColor([r, g, b]) {
    return `vec4f(${(r / 255).toFixed(4)}, ${(g / 255).toFixed(4)}, ${(b / 255).toFixed(4)}, 1.0)`;
}

const STUB_SHADER = `
@fragment fn passMain() -> @location(0) vec4f { return ${wgslColor(OVERLAY_COLORS.pass)}; }
@fragment fn failMain() -> @location(0) vec4f { return ${wgslColor(OVERLAY_COLORS.fail)}; }
@fragment fn highlightMain() -> @location(0) vec4f { return ${wgslColor(OVERLAY_COLORS.highlight)}; }
@fragment fn wireMain() -> @location(0) vec4f { return ${wgslColor(OVERLAY_COLORS.wire)}; }
@fragment fn faceMain(@builtin(front_facing) front : bool) -> @location(0) vec4f {
    return select(${wgslColor(OVERLAY_COLORS.fail)}, ${wgslColor(OVERLAY_COLORS.pass)}, front);
}
`;

// ---------------------------------------------------------------------------
// Draw list
// ---------------------------------------------------------------------------

/**
 * Every draw in the render passes that render to `targetTexture` (as a color
 * or depth-stencil attachment), in command order: what the overlay steps
 * through.
 * @returns {Object[]} { command, begin, passCommands, passIndex, indexInPass, label }
 */
export function collectTargetDraws(commands, targetTexture, getTextureFromAttachment) {
    const draws = [];
    let current = null;
    for (const command of commands) {
        if (!command) {
            continue;
        }
        if (command.method === "beginRenderPass") {
            const desc = command.args?.[0] ?? {};
            const attachments = [...(desc.colorAttachments ?? []), desc.depthStencilAttachment].filter(Boolean);
            const isTarget = attachments.some((a) => getTextureFromAttachment(a)?.id === targetTexture.id);
            current = isTarget ? { begin: command, commands: [], draws: 0 } : null;
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
        if (DRAW_METHODS.has(command.method)) {
            const passLabel = current.begin.args?.[0]?.label;
            const passIndex = current.begin._passIndex ?? null;
            draws.push({
                command,
                begin: current.begin,
                passCommands: current.commands,
                passIndex,
                indexInPass: current.draws++,
                label: `${passLabel ? `"${passLabel}"` : `Pass ${passIndex ?? "?"}`} ${command.method} #${current.draws}`,
            });
        }
    }
    return draws;
}

// ---------------------------------------------------------------------------
// Draw arguments and wireframe indices (CPU side, unit tested)
// ---------------------------------------------------------------------------

function dataView(bytes) {
    if (!bytes) {
        return null;
    }
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, bytes.byteLength);
    return new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
}

/**
 * A draw's effective arguments, reading indirect arguments from the captured
 * indirect buffer. Returns null when they aren't available.
 * @param {Object} plan - a draw plan from walkPassCommands
 * @returns {{indexed:boolean, count:number, instanceCount:number, first:number,
 *            baseVertex:number, firstInstance:number}|null}
 */
export function resolveDrawArgs(plan) {
    const args = plan.args ?? [];
    switch (plan.method) {
        case "draw":
            return { indexed: false, count: args[0] ?? 0, instanceCount: args[1] ?? 1, first: args[2] ?? 0, baseVertex: 0, firstInstance: args[3] ?? 0 };
        case "drawIndexed":
            return { indexed: true, count: args[0] ?? 0, instanceCount: args[1] ?? 1, first: args[2] ?? 0, baseVertex: args[3] ?? 0, firstInstance: args[4] ?? 0 };
        case "drawIndirect":
        case "drawIndexedIndirect": {
            const view = dataView(plan.command?.bufferData?.[0]);
            const offset = plan.indirect?.offset ?? args[1] ?? 0;
            const indexed = plan.method === "drawIndexedIndirect";
            if (!view || offset + (indexed ? 20 : 16) > view.byteLength) {
                return null;
            }
            if (indexed) {
                return {
                    indexed,
                    count: view.getUint32(offset, true),
                    instanceCount: view.getUint32(offset + 4, true),
                    first: view.getUint32(offset + 8, true),
                    baseVertex: view.getInt32(offset + 12, true),
                    firstInstance: view.getUint32(offset + 16, true),
                };
            }
            return {
                indexed,
                count: view.getUint32(offset, true),
                instanceCount: view.getUint32(offset + 4, true),
                first: view.getUint32(offset + 8, true),
                baseVertex: 0,
                firstInstance: view.getUint32(offset + 12, true),
            };
        }
    }
    return null;
}

/**
 * Build a line-list index buffer that draws the edges of a draw's primitives.
 * Indices are absolute vertex indices before baseVertex is added (so they can
 * be drawn with drawIndexed(count, instances, 0, baseVertex, firstInstance)).
 *
 * @param {Object} params
 * @param {string} params.topology - the pipeline's primitive topology
 * @param {Object} params.drawArgs - from resolveDrawArgs
 * @param {Uint8Array} [params.indexBytes] - the captured index buffer, for indexed draws
 * @param {number} [params.indexOffset] - byte offset of setIndexBuffer
 * @param {string} [params.indexFormat] - "uint16" | "uint32"
 * @returns {Uint32Array|null} null when the indices aren't available
 */
export function buildWireframeIndices({ topology = "triangle-list", drawArgs, indexBytes, indexOffset = 0, indexFormat = "uint32" }) {
    const count = drawArgs.count;
    let fetch;
    if (drawArgs.indexed) {
        const view = dataView(indexBytes);
        if (!view) {
            return null;
        }
        const size = indexFormat === "uint16" ? 2 : 4;
        const start = indexOffset + drawArgs.first * size;
        if (start + count * size > view.byteLength) {
            return null;
        }
        fetch = size === 2
            ? (i) => view.getUint16(start + i * 2, true)
            : (i) => view.getUint32(start + i * 4, true);
    } else {
        fetch = (i) => drawArgs.first + i;
    }
    const restart = drawArgs.indexed ? (indexFormat === "uint16" ? 0xffff : 0xffffffff) : -1;

    const out = [];
    if (topology === "triangle-list") {
        for (let i = 0; i + 2 < count; i += 3) {
            const a = fetch(i);
            const b = fetch(i + 1);
            const c = fetch(i + 2);
            out.push(a, b, b, c, c, a);
        }
    } else if (topology === "triangle-strip") {
        // Primitive restart splits the strip; each triangle adds two edges.
        let strip = [];
        const flush = () => {
            for (let i = 0; i + 2 < strip.length; ++i) {
                if (i === 0) {
                    out.push(strip[0], strip[1]);
                }
                out.push(strip[i + 1], strip[i + 2], strip[i + 2], strip[i]);
            }
            strip = [];
        };
        for (let i = 0; i < count; ++i) {
            const v = fetch(i);
            if (v === restart) {
                flush();
            } else {
                strip.push(v);
            }
        }
        flush();
    } else if (topology === "line-list") {
        for (let i = 0; i + 1 < count; i += 2) {
            out.push(fetch(i), fetch(i + 1));
        }
    } else if (topology === "line-strip") {
        let previous = null;
        for (let i = 0; i < count; ++i) {
            const v = fetch(i);
            if (v === restart) {
                previous = null;
                continue;
            }
            if (previous !== null) {
                out.push(previous, v);
            }
            previous = v;
        }
    } else {
        // Points have no edges; draw each point as a zero-length line, which
        // rasterizes nothing, so fall back to the points themselves.
        return null;
    }
    return new Uint32Array(out);
}

// ---------------------------------------------------------------------------
// GPU overlay
// ---------------------------------------------------------------------------

function hasDepth(format) {
    return !!format && format.includes("depth");
}

function hasStencil(format) {
    return !!format && format.includes("stencil");
}

const KEEP_STENCIL = { compare: "always", failOp: "keep", depthFailOp: "keep", passOp: "keep" };

/**
 * Renders the per-draw overlays for one render target. Owns a CaptureReplay
 * so pipelines, bind groups and buffers are built once and reused while the
 * user steps through draws; call destroy() when done.
 */
export class DrawOverlayRenderer {
    constructor({ device, database, commands, getTextureFromAttachment }) {
        this.device = device;
        this.database = database;
        this.commands = commands;
        this.getTextureFromAttachment = getTextureFromAttachment;
        this.replay = device ? new CaptureReplay(device, database) : null;
        this._stub = null;
        this._planCache = new Map();
    }

    destroy() {
        this.replay?.destroy();
        this.replay = null;
    }

    _stubModule() {
        if (!this._stub) {
            this._stub = this.device.createShaderModule({ code: STUB_SHADER });
        }
        return this._stub;
    }

    // The draw plans of one captured pass, with the byte uploads the pass
    // needs. Cached per pass: walking is pure and the uploads are the same
    // every time the pass is replayed.
    _passPlans(passBegin, passCommands) {
        let entry = this._planCache.get(passBegin);
        if (!entry) {
            const uploads = [];
            const missing = new Set();
            const stats = { skippedDraws: 0 };
            const plans = walkPassCommands(this.replay, passCommands, uploads, missing, stats);
            entry = { plans, uploads, missing };
            this._planCache.set(passBegin, entry);
        }
        for (const note of entry.missing) {
            this.replay.notes.add(note);
        }
        return entry;
    }

    /**
     * Render an overlay for one draw.
     * @param {Object} draw - an entry from collectTargetDraws
     * @param {string} mode - one of OVERLAY_MODES
     * @param {number} width
     * @param {number} height
     * @returns {Promise<{pixels:Uint8ClampedArray, notes:string[], summary:string, counts:Object}>}
     *   pixels are RGBA, width*height*4, alpha 0 where the overlay is empty.
     */
    async render(draw, mode, width, height) {
        if (mode === OVERLAY_VIEWPORT) {
            return this._renderViewport(draw, width, height);
        }
        if (!this.replay) {
            throw new Error("The DevTools GPU device is not available.");
        }
        this.replay.notes.clear();
        const notes = [];
        const { plans, uploads } = this._passPlans(draw.begin, draw.passCommands);
        const plan = plans.find((p) => p.command === draw.command);
        if (!plan) {
            throw new Error("The draw could not be found in its pass.");
        }
        if (plan.pipelineId === null || plan.pipelineId === undefined) {
            throw new Error("The draw has no pipeline bound.");
        }
        if (plan.method === "drawIndirect" || plan.method === "drawIndexedIndirect") {
            if (!plan.command.bufferData?.[0]) {
                notes.push("The draw's indirect arguments were not captured; the replay reads zeros.");
            }
        }

        const target = this.device.createTexture({
            label: "draw overlay",
            size: [width, height],
            format: OVERLAY_FORMAT,
            usage: TEXTURE_RENDER_ATTACHMENT | TEXTURE_COPY_SRC,
        });
        const extra = [];
        try {
            let result;
            if (mode === OVERLAY_DEPTH || mode === OVERLAY_STENCIL) {
                result = await this._renderTest(draw, plan, uploads, mode, target, width, height, extra, notes);
            } else {
                result = await this._renderSimple(plan, uploads, mode, target, width, height, extra, notes);
            }
            const pixels = await this._readback(target, width, height);
            const counts = countColors(pixels);
            notes.push(...this.replay.notes);
            return { pixels, notes, counts, summary: summarize(mode, counts, result) };
        } finally {
            target.destroy();
            for (const obj of extra) {
                try {
                    obj.destroy();
                } catch (_) { /* ignore */ }
            }
        }
    }

    // Highlight, wireframe and backface: one draw, no depth-stencil.
    async _renderSimple(plan, uploads, mode, target, width, height, extra, notes) {
        const stub = this._stubModule();
        let entryPoint = "highlightMain";
        let primitive = null;
        let drawOverride = null;
        let result = {};

        if (mode === OVERLAY_BACKFACE) {
            entryPoint = "faceMain";
            primitive = (p) => ({ ...p, cullMode: "none" });
            const desc = this.database.getObject(plan.pipelineId)?.descriptor;
            result.cullMode = desc?.primitive?.cullMode ?? "none";
            result.frontFace = desc?.primitive?.frontFace ?? "ccw";
            if ((desc?.primitive?.topology ?? "triangle-list").startsWith("triangle") === false) {
                notes.push("The draw renders points or lines, which have no facing; everything counts as front-facing.");
            }
        } else if (mode === OVERLAY_WIREFRAME) {
            entryPoint = "wireMain";
            const desc = this.database.getObject(plan.pipelineId)?.descriptor;
            const topology = desc?.primitive?.topology ?? "triangle-list";
            const drawArgs = resolveDrawArgs(plan);
            if (!drawArgs) {
                throw new Error("The draw's indirect arguments were not captured, so its edges can't be built.");
            }
            const indices = buildWireframeIndices({
                topology,
                drawArgs,
                indexBytes: plan.indexBuffer?.command?.bufferData?.[0],
                indexOffset: plan.indexBuffer?.offset ?? 0,
                indexFormat: plan.indexBuffer?.format ?? "uint32",
            });
            if (!indices) {
                if (topology === "point-list") {
                    notes.push("The draw renders points; they are shown as rasterized.");
                } else {
                    throw new Error("The draw's index buffer was not captured, so its edges can't be built.");
                }
            } else if (indices.length) {
                primitive = (p) => ({ ...p, topology: "line-list", stripIndexFormat: undefined, cullMode: "none" });
                const indexBuffer = this.device.createBuffer({
                    size: Math.max(4, indices.byteLength),
                    usage: BUFFER_INDEX | BUFFER_COPY_DST,
                });
                extra.push(indexBuffer);
                this.device.queue.writeBuffer(indexBuffer, 0, indices);
                drawOverride = {
                    indexBuffer,
                    indexCount: indices.length,
                    instanceCount: drawArgs.instanceCount,
                    baseVertex: drawArgs.baseVertex,
                    firstInstance: drawArgs.firstInstance,
                };
                result.edges = indices.length / 2;
            }
        }

        const prep = await prepareReplayDraw(this.replay, plan, (pipelineId) => getVariantPipeline(this.replay, pipelineId, {
            key: `overlay:${mode}`,
            label: mode,
            primitive,
            fragment: { module: stub, entryPoint, targets: [{ format: OVERLAY_FORMAT }] },
        }));
        if (prep.error) {
            throw new Error(prep.error);
        }
        applyUploads(this.replay, uploads);
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
        });
        encodeDraw(pass, this.replay, { plan, pipelineInfo: prep.pipelineInfo, bindGroups: prep.bindGroups }, width, height, null, drawOverride);
        pass.end();
        await this._submit(encoder.finish(), "The draw failed validation during replay");
        return result;
    }

    // Depth or stencil test: rebuild the depth-stencil buffer up to the draw,
    // then draw it twice over it — once with the test forced to pass (red),
    // once with its own test (green on top).
    async _renderTest(draw, plan, uploads, mode, target, width, height, extra, notes) {
        const dsAttachment = draw.begin.args?.[0]?.depthStencilAttachment;
        if (!dsAttachment) {
            throw new Error("This render pass has no depth-stencil attachment, so every fragment passes.");
        }
        const dsTexture = this.getTextureFromAttachment(dsAttachment);
        const format = dsTexture?.format;
        if (!dsTexture || !isDepthStencilFormat(format)) {
            throw new Error("The pass's depth-stencil attachment was not captured.");
        }
        if (mode === OVERLAY_DEPTH && !hasDepth(format)) {
            throw new Error(`The depth-stencil attachment (${format}) has no depth aspect.`);
        }
        if (mode === OVERLAY_STENCIL && !hasStencil(format)) {
            throw new Error(`The depth-stencil attachment (${format}) has no stencil aspect.`);
        }
        const drawDesc = this.database.getObject(plan.pipelineId)?.descriptor;
        const drawDS = drawDesc?.depthStencil;
        if (!drawDS) {
            throw new Error("The draw's pipeline has no depth-stencil state.");
        }

        const dsReplay = this.device.createTexture({
            label: "draw overlay depth-stencil",
            size: [width, height],
            format,
            usage: TEXTURE_RENDER_ATTACHMENT,
        });
        extra.push(dsReplay);
        const dsView = dsReplay.createView();

        await this._rebuildDepthStencil(draw, dsAttachment, dsTexture, dsView, format, drawDS, width, height, notes);

        // The draw itself, twice: forced to pass (red), then its own test (green).
        const stub = this._stubModule();
        const noWrite = { depthWriteEnabled: false, stencilWriteMask: 0 };
        const forced = (ds) => ({
            ...ds,
            ...noWrite,
            depthCompare: hasDepth(format) ? "always" : undefined,
            depthWriteEnabled: hasDepth(format) ? false : undefined,
            stencilFront: KEEP_STENCIL,
            stencilBack: KEEP_STENCIL,
        });
        const tested = mode === OVERLAY_DEPTH
            ? (ds) => ({ ...ds, ...noWrite, stencilFront: KEEP_STENCIL, stencilBack: KEEP_STENCIL })
            : (ds) => ({
                ...ds,
                ...noWrite,
                depthCompare: hasDepth(format) ? "always" : undefined,
                depthWriteEnabled: hasDepth(format) ? false : undefined,
                stencilFront: { ...KEEP_STENCIL, compare: ds.stencilFront?.compare ?? "always" },
                stencilBack: { ...KEEP_STENCIL, compare: ds.stencilBack?.compare ?? "always" },
            });
        const items = [];
        for (const [key, entryPoint, depthStencil] of [["fail", "failMain", forced], ["pass", "passMain", tested]]) {
            const prep = await prepareReplayDraw(this.replay, plan, (pipelineId) => getVariantPipeline(this.replay, pipelineId, {
                key: `overlay:${mode}:${key}`,
                label: `${mode} ${key}`,
                fragment: { module: stub, entryPoint, targets: [{ format: OVERLAY_FORMAT }] },
                depthStencil: (ds) => ({ ...depthStencil(ds ?? {}), format }),
            }));
            if (prep.error) {
                throw new Error(prep.error);
            }
            items.push({ plan, pipelineInfo: prep.pipelineInfo, bindGroups: prep.bindGroups });
        }
        applyUploads(this.replay, uploads);
        const encoder = this.device.createCommandEncoder();
        const pass = encoder.beginRenderPass({
            colorAttachments: [{ view: target.createView(), loadOp: "clear", storeOp: "store", clearValue: [0, 0, 0, 0] }],
            depthStencilAttachment: this._dsAttachment(dsView, format, "load"),
        });
        for (const item of items) {
            encodeDraw(pass, this.replay, item, width, height, null, null);
        }
        pass.end();
        await this._submit(encoder.finish(), "The draw failed validation during replay");

        const result = {};
        if (mode === OVERLAY_DEPTH) {
            result.compare = drawDS.depthCompare ?? "always";
            result.depthWrite = !!drawDS.depthWriteEnabled;
        } else {
            result.compare = drawDS.stencilFront?.compare ?? "always";
            result.reference = plan.stencilReference ?? 0;
        }
        return result;
    }

    _dsAttachment(view, format, loadOp, clear = {}) {
        const attachment = { view };
        if (hasDepth(format)) {
            attachment.depthLoadOp = loadOp;
            attachment.depthStoreOp = "store";
            if (loadOp === "clear") {
                attachment.depthClearValue = clear.depth ?? 1;
            }
        }
        if (hasStencil(format)) {
            attachment.stencilLoadOp = loadOp;
            attachment.stencilStoreOp = "store";
            if (loadOp === "clear") {
                attachment.stencilClearValue = clear.stencil ?? 0;
            }
        }
        return attachment;
    }

    // Replay every draw that wrote the depth-stencil subresource before
    // `draw`, depth-only, honoring each pass's load ops.
    async _rebuildDepthStencil(draw, dsAttachment, dsTexture, dsView, format, drawDS, width, height, notes) {
        const viewKey = (attachment) => {
            const texture = this.getTextureFromAttachment(attachment);
            const view = this.database.getObject(attachment?.view?.__id);
            const desc = view?.descriptor ?? {};
            return texture ? `${texture.id}:${desc.baseMipLevel ?? 0}:${desc.baseArrayLayer ?? 0}` : null;
        };
        const targetKey = viewKey(dsAttachment);

        // The passes that use this depth-stencil subresource, up to the draw's.
        const passes = [];
        let current = null;
        for (const command of this.commands) {
            if (!command) {
                continue;
            }
            if (command.method === "beginRenderPass") {
                const ds = command.args?.[0]?.depthStencilAttachment;
                current = ds && viewKey(ds) === targetKey ? { begin: command, ds, commands: [] } : null;
                if (current) {
                    passes.push(current);
                }
                if (command === draw.begin) {
                    break;
                }
                continue;
            }
            if (current && command.method === "end") {
                current = null;
                continue;
            }
            current?.commands.push(command);
        }
        // The loop stops at the draw's own begin, before collecting its commands.
        const own = passes[passes.length - 1];
        if (own?.begin === draw.begin) {
            own.commands = draw.passCommands;
        }

        // A load with nothing earlier in the frame reads contents from before
        // the capture, which aren't available. Start from the far plane of the
        // draw's own comparison (reversed-Z uses 0).
        const reversed = drawDS.depthCompare === "greater" || drawDS.depthCompare === "greater-equal";
        const farDepth = reversed ? 0 : 1;
        const first = passes[0];
        const loadsUnknown = !first || (hasDepth(format) && first.ds.depthLoadOp === "load") || (hasStencil(format) && first.ds.stencilLoadOp === "load");
        if (loadsUnknown) {
            notes.push(`The depth-stencil buffer holds contents from before the captured frame, which the overlay can't reproduce; it starts from depth ${farDepth} and stencil 0.`);
        }
        await this._clearDS(dsView, format, { depth: farDepth, stencil: 0 });

        let replayed = 0;
        let skipped = 0;
        for (const pass of passes) {
            const ds = pass.ds;
            const clearDepth = hasDepth(format) && ds.depthLoadOp === "clear";
            const clearStencil = hasStencil(format) && ds.stencilLoadOp === "clear";
            if (clearDepth || clearStencil) {
                await this._clearDS(dsView, format, {
                    depth: clearDepth ? (ds.depthClearValue ?? 1) : null,
                    stencil: clearStencil ? (ds.stencilClearValue ?? 0) : null,
                });
            }
            if (ds.depthReadOnly && (ds.stencilReadOnly || !hasStencil(format))) {
                if (pass.begin === draw.begin) {
                    break;
                }
                continue;
            }
            const { plans, uploads } = this._passPlans(pass.begin, pass.commands);
            const items = [];
            for (const plan of plans) {
                if (pass.begin === draw.begin && plan.command === draw.command) {
                    break;
                }
                if (plan.pipelineId === null || plan.pipelineId === undefined) {
                    skipped++;
                    continue;
                }
                const prep = await prepareReplayDraw(this.replay, plan, (pipelineId) => getVariantPipeline(this.replay, pipelineId, {
                    key: "overlay:depth-rebuild",
                    label: "depth rebuild",
                    depthStencil: (original) => (original ? { ...original, format } : undefined),
                }));
                if (prep.error || !prep.pipelineInfo.descriptor?.depthStencil) {
                    skipped++;
                    continue;
                }
                items.push({ plan, pipelineInfo: prep.pipelineInfo, bindGroups: prep.bindGroups });
            }
            applyUploads(this.replay, uploads);
            skipped += await this._submitBisect(items, dsView, format, width, height);
            replayed += items.length;
            if (pass.begin === draw.begin) {
                break;
            }
        }
        if (replayed) {
            notes.push(`Rebuilt the depth-stencil buffer from ${replayed} earlier draw(s). Fragment-shader discard and frag_depth writes are not reproduced, so depth written by alpha-tested or depth-writing shaders may differ.`);
        }
        if (skipped) {
            notes.push(`${skipped} earlier draw(s) could not be replayed into the depth-stencil buffer.`);
        }
    }

    async _clearDS(view, format, clear) {
        const attachment = { view };
        if (hasDepth(format)) {
            const keep = clear.depth === null || clear.depth === undefined;
            attachment.depthLoadOp = keep ? "load" : "clear";
            attachment.depthStoreOp = "store";
            if (!keep) {
                attachment.depthClearValue = clear.depth;
            }
        }
        if (hasStencil(format)) {
            const keep = clear.stencil === null || clear.stencil === undefined;
            attachment.stencilLoadOp = keep ? "load" : "clear";
            attachment.stencilStoreOp = "store";
            if (!keep) {
                attachment.stencilClearValue = clear.stencil;
            }
        }
        const encoder = this.device.createCommandEncoder();
        encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: attachment }).end();
        this.device.queue.submit([encoder.finish()]);
    }

    // Submit depth-only draws, bisecting on validation failure so one bad
    // draw doesn't lose the rest. Returns how many draws were skipped.
    async _submitBisect(items, dsView, format, width, height) {
        if (!items.length) {
            return 0;
        }
        this.device.pushErrorScope("validation");
        try {
            const encoder = this.device.createCommandEncoder();
            const pass = encoder.beginRenderPass({ colorAttachments: [], depthStencilAttachment: this._dsAttachment(dsView, format, "load") });
            for (const item of items) {
                encodeDraw(pass, this.replay, item, width, height, null, null);
            }
            pass.end();
            this.device.queue.submit([encoder.finish()]);
        } catch (e) {
            await this.device.popErrorScope();
            return this._bisect(items, dsView, format, width, height);
        }
        const error = await this.device.popErrorScope();
        return error ? this._bisect(items, dsView, format, width, height) : 0;
    }

    async _bisect(items, dsView, format, width, height) {
        if (items.length === 1) {
            return 1;
        }
        const mid = items.length >> 1;
        return (await this._submitBisect(items.slice(0, mid), dsView, format, width, height)) +
            (await this._submitBisect(items.slice(mid), dsView, format, width, height));
    }

    async _submit(commandBuffer, what) {
        this.device.pushErrorScope("validation");
        this.device.queue.submit([commandBuffer]);
        const error = await this.device.popErrorScope();
        if (error) {
            throw new Error(`${what}: ${error.message}`);
        }
    }

    async _readback(texture, width, height) {
        const bytesPerRow = Math.ceil(width * 4 / 256) * 256;
        const buffer = this.device.createBuffer({ size: bytesPerRow * height, usage: BUFFER_COPY_DST | BUFFER_MAP_READ });
        try {
            const encoder = this.device.createCommandEncoder();
            encoder.copyTextureToBuffer({ texture }, { buffer, bytesPerRow }, [width, height]);
            this.device.queue.submit([encoder.finish()]);
            await buffer.mapAsync(BUFFER_MAP_READ);
            const mapped = new Uint8Array(buffer.getMappedRange());
            const pixels = new Uint8ClampedArray(width * height * 4);
            for (let y = 0; y < height; ++y) {
                pixels.set(mapped.subarray(y * bytesPerRow, y * bytesPerRow + width * 4), y * width * 4);
            }
            buffer.unmap();
            return pixels;
        } finally {
            buffer.destroy();
        }
    }

    // Viewport and scissor outlines, drawn on the CPU from the draw's state.
    _renderViewport(draw, width, height) {
        const pixels = new Uint8ClampedArray(width * height * 4);
        const state = viewportState(draw.passCommands, draw.command);
        const vp = state.viewport ?? [0, 0, width, height, 0, 1];
        const sc = state.scissor ?? [0, 0, width, height];
        // Dim everything the scissor excludes.
        for (let y = 0; y < height; ++y) {
            for (let x = 0; x < width; ++x) {
                if (x < sc[0] || y < sc[1] || x >= sc[0] + sc[2] || y >= sc[1] + sc[3]) {
                    const i = (y * width + x) * 4;
                    pixels[i + 3] = 160;
                }
            }
        }
        const outline = (x0, y0, w, h, [r, g, b], thickness) => {
            const x1 = Math.min(width, Math.round(x0 + w));
            const y1 = Math.min(height, Math.round(y0 + h));
            x0 = Math.max(0, Math.round(x0));
            y0 = Math.max(0, Math.round(y0));
            for (let y = y0; y < y1; ++y) {
                for (let x = x0; x < x1; ++x) {
                    if (x - x0 < thickness || x1 - 1 - x < thickness || y - y0 < thickness || y1 - 1 - y < thickness) {
                        const i = (y * width + x) * 4;
                        pixels[i] = r;
                        pixels[i + 1] = g;
                        pixels[i + 2] = b;
                        pixels[i + 3] = 255;
                    }
                }
            }
        };
        const thickness = Math.max(1, Math.round(Math.min(width, height) / 300));
        outline(vp[0], vp[1], vp[2], vp[3], OVERLAY_COLORS.viewport, thickness);
        outline(sc[0], sc[1], sc[2], sc[3], OVERLAY_COLORS.scissor, thickness);
        const fmt = (a) => a.map((v) => Math.round(v * 100) / 100).join(", ");
        const summary = `Viewport (${fmt(vp.slice(0, 4))}), depth ${vp[4] ?? 0}–${vp[5] ?? 1}${state.viewport ? "" : " (default)"}; ` +
            `scissor (${fmt(sc)})${state.scissor ? "" : " (default)"}.`;
        return { pixels, notes: [], counts: null, summary };
    }
}

/** The viewport and scissor in effect for `drawCommand` within its pass. */
export function viewportState(passCommands, drawCommand) {
    let viewport = null;
    let scissor = null;
    for (const command of passCommands) {
        if (command === drawCommand) {
            break;
        }
        if (command.method === "setViewport") {
            viewport = command.args.slice(0, 6);
        } else if (command.method === "setScissorRect") {
            scissor = command.args.slice(0, 4);
        } else if (command.method === "executeBundles") {
            // Bundles don't change viewport/scissor.
        }
    }
    return { viewport, scissor };
}

function countColors(pixels) {
    let pass = 0;
    let fail = 0;
    let covered = 0;
    for (let i = 0; i < pixels.length; i += 4) {
        if (!pixels[i + 3]) {
            continue;
        }
        covered++;
        if (pixels[i + 1] > pixels[i]) {
            pass++;
        } else if (pixels[i] > pixels[i + 1] && pixels[i + 2] < 128) {
            fail++;
        }
    }
    return { pass, fail, covered };
}

function summarize(mode, counts, result) {
    const px = (n) => `${n.toLocaleString()} px`;
    switch (mode) {
        case OVERLAY_HIGHLIGHT:
            return counts.covered ? `The draw covers ${px(counts.covered)}.` : "The draw covers no pixels (culled, off-screen, or zero-area).";
        case OVERLAY_WIREFRAME:
            return result.edges !== undefined ? `${result.edges.toLocaleString()} edges.` : "";
        case OVERLAY_BACKFACE: {
            const culled = result.cullMode === "back" ? "red (back-facing) pixels are culled"
                : result.cullMode === "front" ? "green (front-facing) pixels are culled"
                : "nothing is culled";
            return `Front face ${result.frontFace}, cullMode "${result.cullMode}": ${culled}. ${px(counts.pass)} front-facing, ${px(counts.fail)} back-facing.`;
        }
        case OVERLAY_DEPTH:
            return `depthCompare "${result.compare}"${result.depthWrite ? ", depth write on" : ""}: ${px(counts.pass)} pass, ${px(counts.fail)} fail.`;
        case OVERLAY_STENCIL:
            return `Stencil compare "${result.compare}", reference ${result.reference}: ${px(counts.pass)} pass, ${px(counts.fail)} fail.`;
    }
    return "";
}
