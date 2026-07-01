// Rasterization + interpolation harness for fragment-shader debugging.
//
// Given a picked pixel in a render target and a way to run the vertex shader for
// any vertex, this finds the triangle covering that pixel, and builds the four
// perspective-correct interpolated quad inputs that createFragmentQuadDebugger
// needs (the pixel plus its three 2x2-quad neighbours). This is the inspector's
// stand-in for what the GPU rasterizer does. Pure and framework-free so it can
// be unit tested.

// Assemble a draw into triangles, as lists of vertex indices (the values the
// vertex shader sees as @builtin(vertex_index)).
//
//   topology   - "triangle-list" | "triangle-strip" (point/line topologies yield
//                no triangles)
//   count      - indexCount (indexed) or vertexCount (non-indexed)
//   indexArray - decoded index buffer (Uint16Array/Uint32Array), or null
//   firstIndex - draw firstIndex (indexed) or firstVertex (non-indexed)
//   baseVertex - added to each fetched index (indexed draws only)
export function assembleTriangles(topology, count, indexArray, firstIndex, baseVertex) {
    const v = (k) => {
        if (indexArray) {
            return indexArray[firstIndex + k] + (baseVertex || 0);
        }
        return firstIndex + k;
    };

    const tris = [];
    if (topology === "triangle-strip") {
        for (let k = 0; k + 2 < count; ++k) {
            // Alternate winding so every triangle faces the same way.
            tris.push(k & 1 ? [v(k + 1), v(k), v(k + 2)] : [v(k), v(k + 1), v(k + 2)]);
        }
    } else {
        // triangle-list (default)
        for (let k = 0; k + 2 < count; k += 3) {
            tris.push([v(k), v(k + 1), v(k + 2)]);
        }
    }
    return tris;
}

// Project a clip-space position (vec4) to framebuffer space. Returns the pixel
// coordinate, the interpolatable ndc depth, and 1/w for perspective correction.
// `viewport` ({x, y, width, height}) defaults to the full render target.
export function projectVertex(clip, width, height, viewport) {
    const w = clip[3];
    const invW = w !== 0 ? 1 / w : 0;
    const ndcX = clip[0] * invW;
    const ndcY = clip[1] * invW;
    const ndcZ = clip[2] * invW;
    const vx = viewport?.x ?? 0;
    const vy = viewport?.y ?? 0;
    const vw = viewport?.width ?? width;
    const vh = viewport?.height ?? height;
    return {
        sx: vx + (ndcX * 0.5 + 0.5) * vw,
        sy: vy + (1 - (ndcY * 0.5 + 0.5)) * vh, // framebuffer y is top-down
        ndcZ,
        invW,
        w,
    };
}

function edge(ax, ay, bx, by, cx, cy) {
    return (cx - ax) * (by - ay) - (cy - ay) * (bx - ax);
}

// Signed framebuffer-space area of a projected triangle. With the edge()
// convention here, an NDC-ccw triangle yields a positive area.
export function triangleArea(p0, p1, p2) {
    return edge(p0.sx, p0.sy, p1.sx, p1.sy, p2.sx, p2.sy);
}

// Signed-area barycentric weights of point (px,py) w.r.t. the projected
// triangle. Works for either winding; a point is inside iff all three weights
// are >= 0. Returns null for a degenerate (zero-area) triangle.
export function barycentric(p0, p1, p2, px, py) {
    const area = edge(p0.sx, p0.sy, p1.sx, p1.sy, p2.sx, p2.sy);
    if (Math.abs(area) < 1e-12) {
        return null;
    }
    const b0 = edge(p1.sx, p1.sy, p2.sx, p2.sy, px, py) / area;
    const b1 = edge(p2.sx, p2.sy, p0.sx, p0.sy, px, py) / area;
    const b2 = edge(p0.sx, p0.sy, p1.sx, p1.sy, px, py) / area;
    return [b0, b1, b2];
}

// Perspective-correct interpolation of a per-vertex attribute (scalar or vector)
// across a triangle, given the screen-space barycentric weights and each
// vertex's 1/w.
export function perspectiveInterp(bary, invW, attrs) {
    const denom = bary[0] * invW[0] + bary[1] * invW[1] + bary[2] * invW[2];
    const scale = denom !== 0 ? 1 / denom : 0;
    const weight = (i) => bary[i] * invW[i] * scale;

    if (Array.isArray(attrs[0])) {
        const out = [];
        for (let c = 0; c < attrs[0].length; ++c) {
            out.push(weight(0) * attrs[0][c] + weight(1) * attrs[1][c] + weight(2) * attrs[2][c]);
        }
        return out;
    }
    return weight(0) * attrs[0] + weight(1) * attrs[1] + weight(2) * attrs[2];
}

// Build the four interpolated 2x2-quad inputs for a picked pixel from one
// projected triangle. `p` is the three projected vertices (projectVertex plus
// a `data: {position, varyings}` member). The quad is aligned to even
// coordinates; lane order matches the fragment quad scheduler (0=TL,1=TR,
// 2=BL,3=BR). Returns { quadInputs:[4], targetLane } (quadInputs keyed by
// @location index plus the `position`/`front_facing` builtins).
export function buildQuadInputs(p, px, py, frontFacing) {
    const [p0, p1, p2] = p;
    const invW = [p0.invW, p1.invW, p2.invW];

    const baseX = px & ~1;
    const baseY = py & ~1;
    const targetLane = (px - baseX) + (py - baseY) * 2;

    // Every varying location present on the vertices.
    const locations = Object.keys(p0.data.varyings);

    const quadInputs = [];
    for (let ly = 0; ly < 2; ++ly) {
        for (let lx = 0; lx < 2; ++lx) {
            const qcx = baseX + lx + 0.5;
            const qcy = baseY + ly + 0.5;
            const bary = barycentric(p0, p1, p2, qcx, qcy) ?? [1, 0, 0];

            const inputs = {};
            for (const loc of locations) {
                inputs[loc] = perspectiveInterp(bary, invW, [
                    p0.data.varyings[loc], p1.data.varyings[loc], p2.data.varyings[loc],
                ]);
            }
            // @builtin(position): framebuffer x/y, interpolated ndc depth, 1/w.
            const depth = bary[0] * p0.ndcZ + bary[1] * p1.ndcZ + bary[2] * p2.ndcZ;
            const oneOverW = bary[0] * invW[0] + bary[1] * invW[1] + bary[2] * invW[2];
            inputs["position"] = [qcx, qcy, depth, oneOverW];
            inputs["front_facing"] = frontFacing ? 1 : 0;
            inputs["sample_index"] = 0;

            quadInputs.push(inputs);
        }
    }

    return { quadInputs, targetLane };
}

// Build the four interpolated quad inputs for a picked pixel.
//
//   triangles    - output of assembleTriangles
//   getVertex    - (vertexIndex) => { position:[x,y,z,w] clip, varyings:{loc:value} } | null
//   width,height - render-target dimensions
//   px,py        - the picked pixel (integer framebuffer coords)
//   frontFace    - pipeline primitive.frontFace ("ccw" default)
//   primitive    - optional triangle index to debug; -1/undefined selects the
//                  front-most triangle covering the pixel
//
// Returns { quadInputs:[4], targetLane, triangle } (quadInputs are keyed by
// @location index plus the `position`/`front_facing` builtins), or null if no
// triangle covers the pixel.
export function buildFragmentQuad(triangles, getVertex, width, height, px, py, frontFace = "ccw", primitive = -1) {
    const cx = px + 0.5;
    const cy = py + 0.5;

    // Cache projected vertices so each vertex's VS runs at most once.
    const cache = new Map();
    const project = (vi) => {
        if (cache.has(vi)) {
            return cache.get(vi);
        }
        const data = getVertex(vi);
        const p = data ? { ...projectVertex(data.position, width, height), data } : null;
        cache.set(vi, p);
        return p;
    };

    // Find the front-most triangle covering the picked pixel (or the requested
    // primitive, if it covers the pixel).
    let best = null;
    for (let ti = 0; ti < triangles.length; ++ti) {
        if (primitive >= 0 && ti !== primitive) {
            continue;
        }
        const tri = triangles[ti];
        const p0 = project(tri[0]);
        const p1 = project(tri[1]);
        const p2 = project(tri[2]);
        if (!p0 || !p1 || !p2) {
            continue;
        }
        const bary = barycentric(p0, p1, p2, cx, cy);
        if (bary === null) {
            continue;
        }
        if (bary[0] < 0 || bary[1] < 0 || bary[2] < 0) {
            continue; // pixel not inside this triangle
        }
        const depth = bary[0] * p0.ndcZ + bary[1] * p1.ndcZ + bary[2] * p2.ndcZ;
        if (best === null || depth < best.depth) {
            best = { tri, p: [p0, p1, p2], depth };
        }
    }

    if (best === null) {
        return null;
    }

    // front_facing from the triangle's framebuffer winding. With this edge()
    // convention a NDC-ccw triangle yields a positive signed area in framebuffer
    // space, which is front-facing when frontFace is "ccw".
    const area = triangleArea(best.p[0], best.p[1], best.p[2]);
    const frontFacing = frontFace === "ccw" ? area > 0 : area < 0;

    const quad = buildQuadInputs(best.p, px, py, frontFacing);
    return { quadInputs: quad.quadInputs, targetLane: quad.targetLane, triangle: best.tri };
}
