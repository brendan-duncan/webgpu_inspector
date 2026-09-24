import { decodeVertexAttribute } from "./vertex_fetcher.js";
import { resolveDrawArgs } from "./draw_overlay.js";

/**
 * The vertex shader inputs of one captured draw ("VS In"): every vertex the
 * draw fetches, in draw order, with each vertex attribute decoded from the
 * captured vertex-buffer bytes, plus the primitives they assemble into.
 *
 * This is what the Mesh view's table and 3D preview show. It is free of DOM
 * and WebGPU dependencies so it can be unit tested.
 */

// Past this many vertices the view would stall; the rest are left out.
export const MAX_MESH_VERTICES = 2_000_000;

function asDataView(data) {
    if (!data) {
        return null;
    }
    if (data instanceof ArrayBuffer) {
        return new DataView(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new DataView(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
}

function formatComponents(format) {
    if (format === "unorm10-10-10-2") {
        return 4;
    }
    const m = /x(\d)$/.exec(format ?? "");
    return m ? parseInt(m[1], 10) : 1;
}

/**
 * @param {Object} params
 * @param {Object} params.command - the draw command record
 * @param {Object} params.pipelineDesc - the render pipeline's descriptor
 * @param {Object[]} [params.shaderInputs] - the vertex entry point's reflected inputs (for names)
 * @param {Object[]} params.vertexBufferCommands - setVertexBuffer commands by slot
 * @param {Object} [params.indexBufferCommand] - the setIndexBuffer command
 * @param {number} [params.instance=0] - which instance to fetch instance-stepped attributes for
 * @param {number} [params.maxVertices]
 * @returns {Object} { attributes, count, vertexIndices, values, topology, drawArgs, warnings }
 *   vertexIndices: Int32Array of the vertex index fetched for each element
 *   (-1 for a strip restart); values: one Float64Array per attribute,
 *   count * components long, NaN where the bytes weren't captured.
 */
export function buildMeshInput({ command, pipelineDesc, shaderInputs, vertexBufferCommands, indexBufferCommand, instance = 0, maxVertices = MAX_MESH_VERTICES }) {
    const warnings = [];
    const topology = pipelineDesc?.primitive?.topology ?? "triangle-list";

    const drawArgs = resolveDrawArgs({
        method: command.method,
        args: command.args ?? [],
        command,
        indirect: command.method.endsWith("Indirect") ? { offset: command.args?.[1] ?? 0 } : undefined,
    });
    if (!drawArgs) {
        return { attributes: [], count: 0, vertexIndices: new Int32Array(0), values: [], topology, drawArgs: null,
            warnings: ["The draw's indirect arguments were not captured, so its vertices can't be listed."] };
    }

    const names = new Map();
    for (const input of shaderInputs ?? []) {
        if (input.locationType === "location") {
            names.set(input.location, input.name);
        }
    }

    // Attributes in location order, with the bytes of the buffer that feeds each.
    const attributes = [];
    const buffers = pipelineDesc?.vertex?.buffers ?? [];
    const missingSlots = new Set();
    buffers.forEach((layout, slot) => {
        if (!layout) {
            return;
        }
        const data = vertexBufferCommands?.[slot]?.bufferData?.[slot] ?? null;
        const view = asDataView(data);
        if (!view) {
            missingSlots.add(slot);
        }
        for (const attr of layout.attributes ?? []) {
            attributes.push({
                location: attr.shaderLocation,
                name: names.get(attr.shaderLocation) ?? `location ${attr.shaderLocation}`,
                format: attr.format,
                components: formatComponents(attr.format),
                offset: attr.offset ?? 0,
                slot,
                stride: layout.arrayStride ?? 0,
                stepMode: layout.stepMode ?? "vertex",
                view,
            });
        }
    });
    attributes.sort((a, b) => a.location - b.location);
    for (const slot of missingSlots) {
        warnings.push(`Vertex buffer slot ${slot} has no captured bytes; its attributes show as blank.`);
    }

    let count = drawArgs.count;
    if (count > maxVertices) {
        warnings.push(`The draw fetches ${count.toLocaleString()} vertices; only the first ${maxVertices.toLocaleString()} are shown.`);
        count = maxVertices;
    }

    // Vertex index per element.
    const vertexIndices = new Int32Array(count);
    if (drawArgs.indexed) {
        const view = asDataView(indexBufferCommand?.bufferData?.[0]);
        const format = indexBufferCommand?.args?.[1] ?? "uint32";
        const size = format === "uint16" ? 2 : 4;
        const restart = format === "uint16" ? 0xffff : 0xffffffff;
        const stripped = topology.endsWith("strip");
        const start = (indexBufferCommand?.args?.[2] ?? 0) + drawArgs.first * size;
        let missing = 0;
        for (let i = 0; i < count; ++i) {
            const at = start + i * size;
            if (!view || at + size > view.byteLength) {
                vertexIndices[i] = -2;
                missing++;
                continue;
            }
            const value = size === 2 ? view.getUint16(at, true) : view.getUint32(at, true);
            vertexIndices[i] = stripped && value === restart ? -1 : value + drawArgs.baseVertex;
        }
        if (missing) {
            warnings.push(`${missing.toLocaleString()} indices lie beyond the captured index buffer bytes (see Max Buffer Size).`);
        }
    } else {
        for (let i = 0; i < count; ++i) {
            vertexIndices[i] = drawArgs.first + i;
        }
    }

    // Decode every attribute for every element.
    const instanceIndex = drawArgs.firstInstance + instance;
    const values = attributes.map((attr) => new Float64Array(count * attr.components).fill(NaN));
    let truncated = 0;
    attributes.forEach((attr, a) => {
        const out = values[a];
        const n = attr.components;
        if (!attr.view) {
            return;
        }
        if (attr.stepMode === "instance") {
            const value = decodeVertexAttribute(attr.view, instanceIndex * attr.stride + attr.offset, attr.format);
            for (let i = 0; i < count; ++i) {
                writeValue(out, i * n, n, value);
            }
            if (value === null) {
                truncated++;
            }
            return;
        }
        for (let i = 0; i < count; ++i) {
            const vertex = vertexIndices[i];
            if (vertex < 0) {
                continue;
            }
            const value = decodeVertexAttribute(attr.view, vertex * attr.stride + attr.offset, attr.format);
            if (value === null) {
                truncated++;
                continue;
            }
            writeValue(out, i * n, n, value);
        }
    });
    if (truncated) {
        warnings.push(`${truncated.toLocaleString()} attribute values lie beyond the captured vertex buffer bytes (see Max Buffer Size).`);
    }

    // The captured attribute views aren't needed past decoding.
    for (const attr of attributes) {
        delete attr.view;
    }
    return { attributes, count, vertexIndices, values, topology, drawArgs, warnings };
}

function writeValue(out, base, n, value) {
    if (value === null || value === undefined) {
        return;
    }
    if (Array.isArray(value)) {
        for (let c = 0; c < n; ++c) {
            out[base + c] = value[c] ?? NaN;
        }
    } else {
        out[base] = value;
    }
}

/**
 * The attribute most likely to be the position: a float attribute with 3 or 4
 * components whose name mentions "pos", else the first 3- or 4-component
 * float attribute, else the first attribute with at least 2 components.
 * @returns {number} index into mesh.attributes, or -1
 */
export function guessPositionAttribute(attributes) {
    const isFloat = (a) => /float|norm/.test(a.format);
    let index = attributes.findIndex((a) => isFloat(a) && a.components >= 3 && /pos/i.test(a.name));
    if (index < 0) {
        index = attributes.findIndex((a) => isFloat(a) && a.components >= 3);
    }
    if (index < 0) {
        index = attributes.findIndex((a) => a.components >= 2);
    }
    return index;
}

/**
 * Assemble the draw's elements into primitives, as element (row) indices.
 * Strips are split at restarts; elements whose vertex couldn't be fetched
 * drop the primitives that use them.
 * @returns {{triangles: Uint32Array, lines: Uint32Array}} triangles as a
 *   triangle list, and the edges of every primitive as a line list
 */
export function assemblePrimitives(mesh) {
    const { topology, count, vertexIndices } = mesh;
    const triangles = [];
    const lines = [];
    const ok = (i) => vertexIndices[i] >= 0;

    const addTriangle = (a, b, c) => {
        if (ok(a) && ok(b) && ok(c)) {
            triangles.push(a, b, c);
            lines.push(a, b, b, c, c, a);
        }
    };
    const addLine = (a, b) => {
        if (ok(a) && ok(b)) {
            lines.push(a, b);
        }
    };

    if (topology === "triangle-list") {
        for (let i = 0; i + 2 < count; i += 3) {
            addTriangle(i, i + 1, i + 2);
        }
    } else if (topology === "line-list") {
        for (let i = 0; i + 1 < count; i += 2) {
            addLine(i, i + 1);
        }
    } else if (topology === "triangle-strip" || topology === "line-strip") {
        let start = 0;
        for (let i = 0; i <= count; ++i) {
            if (i < count && vertexIndices[i] !== -1) {
                continue;
            }
            // A run [start, i) between restarts.
            if (topology === "triangle-strip") {
                for (let j = start; j + 2 < i; ++j) {
                    // Alternate winding so every triangle faces the same way.
                    if ((j - start) % 2 === 0) {
                        addTriangle(j, j + 1, j + 2);
                    } else {
                        addTriangle(j + 1, j, j + 2);
                    }
                }
            } else {
                for (let j = start; j + 1 < i; ++j) {
                    addLine(j, j + 1);
                }
            }
            start = i + 1;
        }
    }
    return { triangles: new Uint32Array(triangles), lines: new Uint32Array(lines) };
}

/**
 * Drop primitives that use an element without a usable position.
 * @param {Uint32Array} indices - a triangle or line list of element indices
 * @param {number} arity - 3 for triangles, 2 for lines
 * @param {Uint8Array} valid - from attributePositions
 * @returns {Uint32Array}
 */
export function filterPrimitives(indices, arity, valid) {
    const out = [];
    for (let i = 0; i + arity <= indices.length; i += arity) {
        let ok = true;
        for (let k = 0; k < arity; ++k) {
            if (!valid[indices[i + k]]) {
                ok = false;
                break;
            }
        }
        if (ok) {
            for (let k = 0; k < arity; ++k) {
                out.push(indices[i + k]);
            }
        }
    }
    return new Uint32Array(out);
}

/**
 * Per-element RGB colors for "color by attribute": each component normalized
 * over the draw's range. Scalars use a blue-to-red ramp. NaN values are gray.
 * @returns {Float32Array} count * 3
 */
export function attributeColors(mesh, attributeIndex) {
    const count = mesh.count;
    const colors = new Float32Array(count * 3);
    const attr = mesh.attributes[attributeIndex];
    if (!attr) {
        colors.fill(0.75);
        return colors;
    }
    const n = attr.components;
    const data = mesh.values[attributeIndex];
    const min = new Array(n).fill(Infinity);
    const max = new Array(n).fill(-Infinity);
    for (let i = 0; i < count; ++i) {
        for (let c = 0; c < n; ++c) {
            const v = data[i * n + c];
            if (Number.isFinite(v)) {
                min[c] = Math.min(min[c], v);
                max[c] = Math.max(max[c], v);
            }
        }
    }
    const norm = (v, c) => (max[c] > min[c] ? (v - min[c]) / (max[c] - min[c]) : 0.5);
    for (let i = 0; i < count; ++i) {
        const o = i * 3;
        if (n === 1) {
            const v = data[i];
            if (!Number.isFinite(v)) {
                colors.set([0.5, 0.5, 0.5], o);
                continue;
            }
            const t = norm(v, 0);
            colors[o] = t;
            colors[o + 1] = 0.25 + 0.5 * (1 - Math.abs(t - 0.5) * 2);
            colors[o + 2] = 1 - t;
            continue;
        }
        for (let c = 0; c < 3; ++c) {
            const v = c < n ? data[i * n + c] : NaN;
            colors[o + c] = c < n ? (Number.isFinite(v) ? norm(v, c) : 0.5) : 0;
        }
    }
    return colors;
}

/**
 * The xyz positions of every element from the chosen attribute (a 2-component
 * attribute gets z = 0), and how many are unusable (NaN / infinite).
 * @returns {{positions: Float32Array, valid: Uint8Array, invalid: number, min: number[], max: number[]}}
 */
export function attributePositions(mesh, attributeIndex) {
    const count = mesh.count;
    const positions = new Float32Array(count * 3);
    const valid = new Uint8Array(count);
    const attr = mesh.attributes[attributeIndex];
    const min = [Infinity, Infinity, Infinity];
    const max = [-Infinity, -Infinity, -Infinity];
    let invalid = 0;
    if (!attr) {
        return { positions, valid, invalid: count, min: [0, 0, 0], max: [0, 0, 0] };
    }
    const n = attr.components;
    const data = mesh.values[attributeIndex];
    for (let i = 0; i < count; ++i) {
        let good = mesh.vertexIndices[i] >= 0;
        for (let c = 0; c < 3; ++c) {
            const v = c < n ? data[i * n + c] : 0;
            positions[i * 3 + c] = v;
            if (!Number.isFinite(v)) {
                good = false;
            }
        }
        if (!good) {
            if (mesh.vertexIndices[i] !== -1) {
                invalid++;
            }
            positions.fill(0, i * 3, i * 3 + 3);
            continue;
        }
        valid[i] = 1;
        for (let c = 0; c < 3; ++c) {
            min[c] = Math.min(min[c], positions[i * 3 + c]);
            max[c] = Math.max(max[c], positions[i * 3 + c]);
        }
    }
    if (min[0] === Infinity) {
        return { positions, valid, invalid, min: [0, 0, 0], max: [0, 0, 0] };
    }
    return { positions, valid, invalid, min, max };
}
