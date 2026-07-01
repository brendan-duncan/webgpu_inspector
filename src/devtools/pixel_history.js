// Pixel-history engine: a CPU replay of one pixel through the render passes of
// a captured frame. For every draw in a pass whose primitives cover the picked
// pixel, the fragment's pipeline tests (scissor, cull, depth clip, stencil,
// depth) are evaluated against tracked per-attachment pixel state, the fragment
// shader output is taken from a host-provided runner, and blending/write-mask
// are applied — producing the ordered list of events that built the pixel's
// final value. This is the inspector's stand-in for what a GPU-replay pixel
// history (a la RenderDoc) would measure.
//
// Pure and framework-free so it can be unit tested. Everything that needs the
// capture database or the WGSL interpreter is injected via the pass/draw
// records built by pixel_history_builder.js.
//
// Value knownness: a tracked color is `null` when it can't be known from the
// capture (e.g. loadOp "load" with no earlier pass in the frame writing the
// texture). Unknown values propagate through blending; a write that doesn't
// depend on the destination makes the value known again.

import { barycentric, projectVertex, triangleArea, buildQuadInputs } from "./fragment_debug.js";

// ---------------------------------------------------------------------------
// Pipeline test helpers
// ---------------------------------------------------------------------------

export function compareFunc(func, a, b) {
    switch (func) {
        case "never": return false;
        case "less": return a < b;
        case "equal": return a === b;
        case "less-equal": return a <= b;
        case "greater": return a > b;
        case "not-equal": return a !== b;
        case "greater-equal": return a >= b;
        case "always": return true;
    }
    return true;
}

export function stencilOp(op, value, ref) {
    switch (op) {
        case "zero": return 0;
        case "replace": return ref & 0xff;
        case "invert": return (~value) & 0xff;
        case "increment-clamp": return Math.min(value + 1, 0xff);
        case "decrement-clamp": return Math.max(value - 1, 0);
        case "increment-wrap": return (value + 1) & 0xff;
        case "decrement-wrap": return (value - 1) & 0xff;
        case "keep":
        default: return value;
    }
}

function blendFactor(factor, src, dst, constant, channel) {
    const srcAlpha = src[3];
    const dstAlpha = dst === null ? null : dst[3];
    switch (factor) {
        case "zero": return 0;
        case "one": return 1;
        case "src": return src[channel];
        case "one-minus-src": return 1 - src[channel];
        case "src-alpha": return srcAlpha;
        case "one-minus-src-alpha": return 1 - srcAlpha;
        case "dst": return dst === null ? null : dst[channel];
        case "one-minus-dst": return dst === null ? null : 1 - dst[channel];
        case "dst-alpha": return dstAlpha;
        case "one-minus-dst-alpha": return dstAlpha === null ? null : 1 - dstAlpha;
        case "src-alpha-saturated":
            // (f, f, f, 1) with f = min(srcAlpha, 1 - dstAlpha).
            if (channel === 3) {
                return 1;
            }
            return dstAlpha === null ? null : Math.min(srcAlpha, 1 - dstAlpha);
        case "constant": return constant[channel];
        case "one-minus-constant": return 1 - constant[channel];
    }
    return 1;
}

function blendChannel(operation, src, srcF, dst, dstF) {
    switch (operation ?? "add") {
        case "subtract": return src * srcF - dst * dstF;
        case "reverse-subtract": return dst * dstF - src * srcF;
        case "min": return Math.min(src, dst);
        case "max": return Math.max(src, dst);
        case "add":
        default: return src * srcF + dst * dstF;
    }
}

// Whether a blend component ever reads the destination color.
function blendReadsDst(component) {
    const op = component?.operation ?? "add";
    if (op === "min" || op === "max") {
        return true;
    }
    const dstF = component?.dstFactor ?? "zero";
    if (dstF !== "zero") {
        return true;
    }
    const srcF = component?.srcFactor ?? "one";
    return srcF === "dst" || srcF === "one-minus-dst" || srcF === "dst-alpha" ||
           srcF === "one-minus-dst-alpha" || srcF === "src-alpha-saturated";
}

// Blend `src` (the shader output, [r,g,b,a]) over `dst` (tracked value or null
// for unknown) with the target's blend state and write mask. Returns the new
// destination value: an [r,g,b,a] array with `null` for channels whose value
// can't be known.
//
// writeMask: GPUColorWrite bits (1=R 2=G 4=B 8=A); defaults to all.
export function blendPixel(src, dst, blend, writeMask, blendConstant) {
    const mask = writeMask ?? 0xf;
    const constant = blendConstant ?? [1, 1, 1, 1];
    const out = [null, null, null, null];

    for (let c = 0; c < 4; ++c) {
        if (!(mask & (1 << c))) {
            // Channel not written: keeps its previous (possibly unknown) value.
            out[c] = dst === null ? null : dst[c];
            continue;
        }
        if (!blend) {
            out[c] = src[c];
            continue;
        }
        const component = c === 3 ? (blend.alpha ?? {}) : (blend.color ?? {});
        const needsDst = blendReadsDst(component);
        const dstC = dst === null ? null : dst[c];
        if (needsDst && (dstC === null || dstC === undefined)) {
            out[c] = null;
            continue;
        }
        const srcF = blendFactor(component.srcFactor ?? "one", src, dst ?? [0, 0, 0, 0], constant, c);
        const dstF = blendFactor(component.dstFactor ?? "zero", src, dst ?? [0, 0, 0, 0], constant, c);
        if (srcF === null || (needsDst && dstF === null)) {
            out[c] = null;
            continue;
        }
        out[c] = blendChannel(component.operation, src[c], srcF, dstC ?? 0, dstF);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Fragment-shader output mapping
// ---------------------------------------------------------------------------

// Map a fragment shader's return value (a struct keyed by member name, or a
// bare value for a single output) to { colors: {slot: [r,g,b,a]}, fragDepth }.
// `fsOutputs` is the entry point's reflection outputs.
export function extractFsOutput(out, fsOutputs) {
    const result = { colors: {}, fragDepth: null };
    if (out === null || out === undefined) {
        return result;
    }
    const toColor = (v) => {
        if (typeof v === "number") {
            return [v, 0, 0, 1];
        }
        if (v && (Array.isArray(v) || ArrayBuffer.isView(v))) {
            const a = Array.from(v);
            while (a.length < 4) {
                a.push(a.length === 3 ? 1 : 0);
            }
            return a.slice(0, 4);
        }
        return null;
    };

    const locationOutputs = (fsOutputs ?? []).filter((o) => o.locationType === "location");
    if (typeof out !== "object" || Array.isArray(out) || ArrayBuffer.isView(out)) {
        // A bare return value maps to the single location output.
        const slot = locationOutputs.length ? locationOutputs[0].location : 0;
        result.colors[slot] = toColor(out);
        return result;
    }

    for (const o of fsOutputs ?? []) {
        const val = out[o.name];
        if (val === undefined) {
            continue;
        }
        if (o.locationType === "builtin" && o.location === "frag_depth") {
            result.fragDepth = typeof val === "number" ? val : null;
        } else if (o.locationType === "location") {
            result.colors[o.location] = toColor(val);
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

function within(rect, x, y) {
    return x >= rect.x && y >= rect.y && x < rect.x + rect.w && y < rect.y + rect.h;
}

function makeTextureState() {
    return { color: null, depth: null, stencil: null };
}

// Simulate every draw of one render pass at pixel (x, y), updating `state`
// (Map<textureId, {color, depth, stencil}>) and appending history entries for
// events touching `targetTextureId`.
//
// The pass record and its draw records are documented in
// pixel_history_builder.js (buildPixelHistoryPasses).
function simulatePass(pass, x, y, targetTextureId, state, entries) {
    const getState = (id) => {
        if (!state.has(id)) {
            state.set(id, makeTextureState());
        }
        return state.get(id);
    };

    // --- Pass begin: apply load ops. -------------------------------------
    let targetSlot = -1;
    for (const att of pass.colorAttachments) {
        const ts = getState(att.textureId);
        if (att.loadOp === "clear") {
            ts.color = att.clearValue ? att.clearValue.slice() : [0, 0, 0, 0];
        }
        if (att.textureId === targetTextureId) {
            targetSlot = att.slot;
            entries.push({
                type: att.loadOp === "clear" ? "clear" : "load",
                pass,
                value: ts.color ? ts.color.slice() : null,
            });
        }
    }

    const ds = pass.depthStencil;
    let dsState = null;
    if (ds) {
        dsState = getState(ds.textureId);
        if (ds.depthLoadOp === "clear") {
            dsState.depth = ds.depthClearValue ?? 1;
        }
        if (ds.stencilLoadOp === "clear") {
            dsState.stencil = ds.stencilClearValue ?? 0;
        }
        if (ds.textureId === targetTextureId) {
            entries.push({
                type: ds.depthLoadOp === "clear" ? "clear" : "load",
                pass,
                isDepth: true,
                value: dsState.depth === null ? null : [dsState.depth],
                stencil: dsState.stencil,
            });
        }
    }

    const targetIsDepth = ds && ds.textureId === targetTextureId;
    const targetState = targetSlot >= 0 ? getState(targetTextureId) : (targetIsDepth ? dsState : null);

    // Passes that don't have the target texture attached are simulated only
    // for their side effects on tracked state (e.g. a depth pre-pass feeding a
    // later pass's depth test); their fragments aren't part of the history.
    const emitFragments = targetState !== null;

    // --- Draws. -----------------------------------------------------------
    const cx = x + 0.5;
    const cy = y + 0.5;

    for (const draw of pass.draws) {
        if (draw.error) {
            if (emitFragments) {
                entries.push({ type: "draw-error", pass, draw, message: draw.error });
            }
            continue;
        }

        const viewport = draw.viewport;
        const scissor = draw.scissor;
        const inViewport = within({ x: viewport.x, y: viewport.y, w: viewport.w, h: viewport.h }, cx, cy);
        const inScissor = scissor === null || within(scissor, cx, cy);

        const dsDesc = draw.depthStencilState;
        const hasStencil = !!(ds && dsDesc && (dsDesc.stencilFront || dsDesc.stencilBack));

        for (let instance = 0; instance < draw.instanceCount; ++instance) {
            const instanceIndex = draw.firstInstance + instance;

            // Project each vertex once per instance.
            const cache = new Map();
            const project = (vi) => {
                if (cache.has(vi)) {
                    return cache.get(vi);
                }
                const data = draw.getVertex(vi, instanceIndex);
                const p = data ? { ...projectVertex(data.position, pass.width, pass.height, { x: viewport.x, y: viewport.y, width: viewport.w, height: viewport.h }), data } : null;
                cache.set(vi, p);
                return p;
            };

            for (let ti = 0; ti < draw.triangles.length; ++ti) {
                const tri = draw.triangles[ti];
                const p0 = project(tri[0]);
                const p1 = project(tri[1]);
                const p2 = project(tri[2]);
                if (!p0 || !p1 || !p2) {
                    continue;
                }
                // Primitives crossing the w=0 plane would need clipping, which
                // this software rasterizer doesn't do; skip them.
                if (p0.w <= 0 || p1.w <= 0 || p2.w <= 0) {
                    continue;
                }
                const bary = barycentric(p0, p1, p2, cx, cy);
                if (bary === null || bary[0] < 0 || bary[1] < 0 || bary[2] < 0) {
                    continue; // pixel not covered by this triangle
                }

                const entry = {
                    type: "fragment",
                    pass,
                    draw,
                    instance: instanceIndex,
                    primitive: ti,
                    status: "written",
                };
                if (emitFragments) {
                    entries.push(entry);
                }

                // Viewport / scissor.
                if (!inViewport) {
                    entry.status = "viewport-clipped";
                    continue;
                }
                if (!inScissor) {
                    entry.status = "scissor-failed";
                    continue;
                }

                // Face culling.
                const area = triangleArea(p0, p1, p2);
                if (area === 0) {
                    entry.status = "degenerate";
                    continue;
                }
                const frontFacing = draw.frontFace === "cw" ? area < 0 : area > 0;
                if (draw.cullMode === "back" && !frontFacing) {
                    entry.status = "backface-culled";
                    continue;
                }
                if (draw.cullMode === "front" && frontFacing) {
                    entry.status = "frontface-culled";
                    continue;
                }
                entry.frontFacing = frontFacing;

                // Fragment depth from the interpolated ndc z, mapped through the
                // viewport depth range.
                const ndcZ = bary[0] * p0.ndcZ + bary[1] * p1.ndcZ + bary[2] * p2.ndcZ;
                if (!draw.unclippedDepth && (ndcZ < 0 || ndcZ > 1)) {
                    entry.status = "depth-clipped";
                    continue;
                }
                let fragDepth = viewport.minDepth + ndcZ * (viewport.maxDepth - viewport.minDepth);

                // Run the fragment shader (also needed for frag_depth/discard).
                let fsOut = null;
                if (draw.runFragment) {
                    const quad = buildQuadInputs([p0, p1, p2], x, y, frontFacing);
                    const fsResult = draw.runFragment(quad.quadInputs, quad.targetLane);
                    if (fsResult === null) {
                        entry.fsError = "The fragment shader could not be executed.";
                    } else if (fsResult.error) {
                        entry.fsError = fsResult.error;
                    } else if (fsResult.discarded) {
                        entry.status = "discarded";
                        continue;
                    } else {
                        fsOut = extractFsOutput(fsResult.output, draw.fsOutputs);
                        if (fsOut.fragDepth !== null) {
                            fragDepth = Math.min(Math.max(fsOut.fragDepth, viewport.minDepth), viewport.maxDepth);
                        }
                        entry.shaderOutput = targetSlot >= 0 ? (fsOut.colors[targetSlot] ?? null) : null;
                    }
                }
                entry.fragDepth = fragDepth;

                // Stencil test.
                let stencilPassed = true;
                let stencilUnknown = false;
                let face = null;
                if (hasStencil) {
                    face = (frontFacing ? dsDesc.stencilFront : dsDesc.stencilBack) ?? {};
                    const readMask = dsDesc.stencilReadMask ?? 0xff;
                    const writeMask = dsDesc.stencilWriteMask ?? 0xff;
                    const ref = draw.stencilReference & 0xff;
                    if (dsState.stencil === null) {
                        stencilUnknown = true;
                        entry.stencilUnknown = true;
                    } else {
                        stencilPassed = compareFunc(face.compare ?? "always", ref & readMask, dsState.stencil & readMask);
                    }
                    if (!stencilPassed) {
                        entry.status = "stencil-failed";
                        if (dsState.stencil !== null && !ds.stencilReadOnly) {
                            const newSt = stencilOp(face.failOp ?? "keep", dsState.stencil, ref);
                            dsState.stencil = (dsState.stencil & ~writeMask) | (newSt & writeMask);
                        }
                        continue;
                    }
                }

                // Depth test.
                let depthPassed = true;
                if (ds && dsDesc && (dsDesc.depthCompare ?? "always") !== "always") {
                    if (dsState.depth === null) {
                        entry.depthUnknown = true;
                    } else {
                        depthPassed = compareFunc(dsDesc.depthCompare, fragDepth, dsState.depth);
                    }
                    entry.depthBefore = dsState.depth;
                }

                if (!depthPassed) {
                    entry.status = "depth-failed";
                    if (hasStencil && dsState.stencil !== null && !ds.stencilReadOnly) {
                        const writeMask = dsDesc.stencilWriteMask ?? 0xff;
                        const newSt = stencilOp(face.depthFailOp ?? "keep", dsState.stencil, draw.stencilReference & 0xff);
                        dsState.stencil = (dsState.stencil & ~writeMask) | (newSt & writeMask);
                    }
                    continue;
                }

                // The fragment survived: apply writes.
                if (stencilUnknown) {
                    entry.status = "stencil-unknown";
                } else if (entry.depthUnknown) {
                    entry.status = "depth-unknown";
                }

                if (hasStencil && dsState.stencil !== null && !ds.stencilReadOnly) {
                    const writeMask = dsDesc.stencilWriteMask ?? 0xff;
                    const newSt = stencilOp(face.passOp ?? "keep", dsState.stencil, draw.stencilReference & 0xff);
                    dsState.stencil = (dsState.stencil & ~writeMask) | (newSt & writeMask);
                }

                if (ds && dsDesc?.depthWriteEnabled && !ds.depthReadOnly) {
                    dsState.depth = fragDepth;
                    if (targetIsDepth) {
                        entry.value = [fragDepth];
                    }
                } else if (targetIsDepth && entry.status === "written") {
                    entry.status = "not-written";
                }

                // Color write + blend for every color attachment (only the
                // target attachment's state is tracked).
                if (targetSlot >= 0 && fsOut) {
                    const src = fsOut.colors[targetSlot];
                    const target = (draw.targets ?? [])[targetSlot];
                    const writeMask = target?.writeMask ?? 0xf;
                    if (src && writeMask !== 0) {
                        const ts = getState(targetTextureId);
                        ts.color = blendPixel(src, ts.color, target?.blend ?? null, writeMask, draw.blendConstant);
                        entry.value = ts.color.slice();
                        entry.blended = !!target?.blend;
                    } else {
                        entry.status = "not-written";
                    }
                } else if (targetSlot >= 0 && !draw.runFragment) {
                    entry.status = "not-written";
                }
            }
        }
    }

    // --- Pass end. ----------------------------------------------------------
    if (targetState) {
        entries.push({
            type: "end",
            pass,
            isDepth: targetIsDepth,
            value: targetIsDepth
                ? (targetState.depth === null ? null : [targetState.depth])
                : (targetState.color ? targetState.color.slice() : null),
            stencil: targetIsDepth ? targetState.stencil : undefined,
        });
    }

    return entries;
}

// Determine which passes need simulating: the ones writing the target texture,
// plus (transitively) the ones writing any texture those passes depend on
// (their depth/stencil and other attachments, whose loaded state feeds tests).
export function selectNeededPasses(passes, targetTextureId) {
    const relevant = new Set([targetTextureId]);
    const needed = new Array(passes.length).fill(false);
    for (let i = passes.length - 1; i >= 0; --i) {
        const pass = passes[i];
        const ids = [];
        for (const att of pass.colorAttachments) {
            ids.push(att.textureId);
        }
        if (pass.depthStencil) {
            ids.push(pass.depthStencil.textureId);
        }
        if (ids.some((id) => relevant.has(id))) {
            needed[i] = true;
            for (const id of ids) {
                relevant.add(id);
            }
        }
    }
    return passes.filter((_, i) => needed[i]);
}

// Run the pixel history: simulate the needed render passes of the frame, in
// order, at pixel (x, y), and return the history entries for events touching
// `targetTextureId`.
//
// Returns { entries, finalValue } where entries is the ordered event list and
// finalValue is the tracked value of the target texture at the end of the
// frame ([r,g,b,a] with null for unknown channels, or [depth] for a
// depth-stencil target; null if entirely unknown).
export function runPixelHistory(passes, x, y, targetTextureId) {
    const needed = selectNeededPasses(passes, targetTextureId);
    const state = new Map();
    const entries = [];
    for (const pass of needed) {
        simulatePass(pass, x, y, targetTextureId, state, entries);
    }

    const targetState = state.get(targetTextureId);
    let finalValue = null;
    if (targetState) {
        if (targetState.color) {
            finalValue = targetState.color.slice();
        } else if (targetState.depth !== null) {
            finalValue = [targetState.depth];
        }
    }
    return { entries, finalValue };
}
