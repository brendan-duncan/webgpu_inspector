// Overdraw engine: a CPU rasterization of every draw in a captured frame that
// targets one render texture, counting per pixel how many fragments were
// rasterized. Where pixel history gathers (one pixel, all draws), this
// scatters (all draws, every covered pixel) — the vertex shader runs once per
// unique vertex per instance on the CPU WGSL interpreter, and each projected
// triangle is rasterized over its screen bounding box into a count buffer.
//
// Counts are rasterized fragments: coverage after viewport, scissor, face
// culling and depth clipping, but before the depth/stencil tests and the
// fragment shader (so `discard` and frag_depth don't reduce them). That is the
// fragment-shading cost of the pixel, which is what an overdraw view measures.
//
// Consumes the pass/draw records built by pixel_history_builder.js
// (buildPixelHistoryPasses). Pure and framework-free so it can be unit tested.
//
// computeOverdraw is a generator so the UI can run it in time slices: it
// yields { progress } (0..1) after each instance of each draw, and returns
// { width, height, counts, maxCount, notes, skippedDraws }.

import { barycentric, projectVertex, triangleArea, clipTriangleToNearW, W_CLIP_EPSILON } from "./fragment_debug.js";

// Rasterize one projected triangle into `counts`, testing pixel centers the
// same way simulateDraw does (signed-area barycentric, no top-left fill rule —
// pixels exactly on a shared edge count for both triangles).
function rasterizeTriangle(p0, p1, p2, draw, counts, width, height) {
    const area = triangleArea(p0, p1, p2);
    if (area === 0) {
        return;
    }
    const frontFacing = draw.frontFace === "cw" ? area < 0 : area > 0;
    if (draw.cullMode === "back" && !frontFacing) {
        return;
    }
    if (draw.cullMode === "front" && frontFacing) {
        return;
    }

    // Pixel range to test: the triangle's (conservative, inclusive) bounds
    // clamped to the target. Viewport and scissor are tested exactly at pixel
    // centers inside the loop — they are half-open rects ([x, x+w)) and can be
    // fractional, so folding them into the integer bbox risks off-by-one.
    const x0 = Math.max(0, Math.floor(Math.min(p0.sx, p1.sx, p2.sx) - 0.5));
    const x1 = Math.min(width - 1, Math.ceil(Math.max(p0.sx, p1.sx, p2.sx) - 0.5));
    const y0 = Math.max(0, Math.floor(Math.min(p0.sy, p1.sy, p2.sy) - 0.5));
    const y1 = Math.min(height - 1, Math.ceil(Math.max(p0.sy, p1.sy, p2.sy) - 0.5));

    const vp = draw.viewport;
    const sc = draw.scissor;

    for (let y = y0; y <= y1; ++y) {
        const cy = y + 0.5;
        if (cy < vp.y || cy >= vp.y + vp.h || (sc && (cy < sc.y || cy >= sc.y + sc.h))) {
            continue;
        }
        const row = y * width;
        for (let x = x0; x <= x1; ++x) {
            const cx = x + 0.5;
            if (cx < vp.x || cx >= vp.x + vp.w || (sc && (cx < sc.x || cx >= sc.x + sc.w))) {
                continue;
            }
            const bary = barycentric(p0, p1, p2, cx, cy);
            if (bary === null || bary[0] < 0 || bary[1] < 0 || bary[2] < 0) {
                continue;
            }
            if (!draw.unclippedDepth) {
                const ndcZ = bary[0] * p0.ndcZ + bary[1] * p1.ndcZ + bary[2] * p2.ndcZ;
                if (ndcZ < 0 || ndcZ > 1) {
                    continue;
                }
            }
            counts[row + x]++;
        }
    }
}

// Count the frame's rasterized fragments per pixel of `targetTextureId`.
// `passes` is buildPixelHistoryPasses output; only passes with the target
// attached (color or depth-stencil) contribute.
export function* computeOverdraw(passes, targetTextureId) {
    const targetPasses = passes.filter((pass) =>
        pass.colorAttachments.some((att) => att.textureId === targetTextureId) ||
        pass.depthStencil?.textureId === targetTextureId);

    let width = 0;
    let height = 0;
    for (const pass of targetPasses) {
        width = Math.max(width, pass.width);
        height = Math.max(height, pass.height);
    }

    const counts = new Uint32Array(width * height);
    const notes = new Set();
    let skippedDraws = 0;

    // Progress is reported in instances (the vertex-shader interpreter runs
    // dominate, and they scale with instanceCount).
    let totalUnits = 0;
    for (const pass of targetPasses) {
        for (const draw of pass.draws) {
            totalUnits += draw.error ? 0 : draw.instanceCount;
        }
    }
    let doneUnits = 0;

    for (const pass of targetPasses) {
        for (const draw of pass.draws) {
            if (draw.error) {
                skippedDraws++;
                notes.add(`Not counted — ${draw.command?.method ?? "draw"}: ${draw.error}`);
                continue;
            }
            if (draw.fsOutputs?.some((o) => o.locationType === "builtin" && o.location === "frag_depth")) {
                notes.add("A fragment shader writes frag_depth; overdraw counts fragments before the fragment shader runs.");
            }

            let vsFailed = false;
            for (let instance = 0; instance < draw.instanceCount; ++instance) {
                const instanceIndex = draw.firstInstance + instance;

                // Run the vertex shader once per vertex per instance; project
                // lazily (triangles crossing the w=0 plane are clipped first,
                // matching the GPU rasterizer).
                const vpRect = { x: draw.viewport.x, y: draw.viewport.y, width: draw.viewport.w, height: draw.viewport.h };
                const dataCache = new Map();
                const getData = (vi) => {
                    if (dataCache.has(vi)) {
                        return dataCache.get(vi);
                    }
                    const data = draw.getVertex(vi, instanceIndex);
                    dataCache.set(vi, data);
                    return data;
                };
                const projCache = new Map();
                const project = (vi, data) => {
                    if (projCache.has(vi)) {
                        return projCache.get(vi);
                    }
                    const p = projectVertex(data.position, pass.width, pass.height, vpRect);
                    projCache.set(vi, p);
                    return p;
                };

                for (const tri of draw.triangles) {
                    const d0 = getData(tri[0]);
                    const d1 = getData(tri[1]);
                    const d2 = getData(tri[2]);
                    if (!d0 || !d1 || !d2) {
                        vsFailed = true;
                        continue;
                    }
                    if (d0.position[3] > W_CLIP_EPSILON && d1.position[3] > W_CLIP_EPSILON && d2.position[3] > W_CLIP_EPSILON) {
                        rasterizeTriangle(project(tri[0], d0), project(tri[1], d1), project(tri[2], d2), draw, counts, width, height);
                    } else {
                        for (const part of clipTriangleToNearW(d0, d1, d2)) {
                            rasterizeTriangle(
                                projectVertex(part[0].position, pass.width, pass.height, vpRect),
                                projectVertex(part[1].position, pass.width, pass.height, vpRect),
                                projectVertex(part[2].position, pass.width, pass.height, vpRect),
                                draw, counts, width, height);
                        }
                    }
                }

                doneUnits++;
                yield { progress: totalUnits ? doneUnits / totalUnits : 1 };
            }
            if (vsFailed) {
                notes.add("Some primitives were not counted because their vertex shader could not be evaluated.");
            }
        }
    }

    let maxCount = 0;
    for (let i = 0; i < counts.length; ++i) {
        if (counts[i] > maxCount) {
            maxCount = counts[i];
        }
    }

    return { width, height, counts, maxCount, notes: Array.from(notes), skippedDraws };
}

// Convenience driver for tests and callers that don't need time slicing.
export function computeOverdrawSync(passes, targetTextureId) {
    const it = computeOverdraw(passes, targetTextureId);
    let r = it.next();
    while (!r.done) {
        r = it.next();
    }
    return r.value;
}
