import { CaptureReplay, applyUploads, vertexStageBindings, walkPassCommands } from "./capture_replay.js";

/**
 * Vertex shader outputs ("VS Out") of a captured draw, by GPU replay.
 *
 * WebGPU has no transform feedback, so the draw's vertex shader is re-run as a
 * compute shader: the module's WGSL is kept as-is except that the vertex entry
 * point becomes an ordinary function (its @vertex attribute and the IO
 * attributes on its signature are removed), and a generated @compute entry
 * point calls it once per element of the draw. Each invocation reads its
 * vertex inputs from a storage buffer — the inputs mesh_input.js already
 * decoded from the captured vertex buffers, packed per element — and writes
 * every output of the function to another storage buffer.
 *
 * The vertex shader's own resources (uniforms, storage buffers, textures) are
 * materialized by CaptureReplay with the captured bytes, so the shader sees
 * what it saw in the frame.
 */

const BUFFER_MAP_READ = 0x0001;
const BUFFER_COPY_SRC = 0x0004;
const BUFFER_COPY_DST = 0x0008;
const BUFFER_STORAGE = 0x0080;

const WORKGROUP_SIZE = 64;
const MAX_BIND_GROUPS = 4;
const IO_ATTRIBUTES = /@\s*(builtin|location|interpolate|invariant|blend_src)\s*(\([^()]*\))?/g;

/**
 * Parse a WGSL scalar or vector type name into its component type and count.
 * @returns {{scalar:string, components:number}|null} scalar is f32, f16, u32, i32 or bool
 */
export function parseIoType(name) {
    if (!name) {
        return null;
    }
    const scalarOf = (s) => ({ f: "f32", h: "f16", u: "u32", i: "i32", f32: "f32", f16: "f16", u32: "u32", i32: "i32", bool: "bool" })[s] ?? null;
    let m = /^vec([234])([fhui])$/.exec(name);
    if (m) {
        return { scalar: scalarOf(m[2]), components: parseInt(m[1], 10) };
    }
    m = /^vec([234])<\s*(f32|f16|u32|i32|bool)\s*>$/.exec(name);
    if (m) {
        return { scalar: scalarOf(m[2]), components: parseInt(m[1], 10) };
    }
    if (/^(f32|f16|u32|i32|bool)$/.test(name)) {
        return { scalar: name, components: 1 };
    }
    return null;
}

function typeName(type) {
    return type?.getTypeName ? type.getTypeName() : type?.name;
}

function attributeValue(attributes, name) {
    const attr = attributes?.find((a) => a.name === name);
    if (!attr) {
        return undefined;
    }
    return Array.isArray(attr.value) ? attr.value[0] : attr.value;
}

// Index of the matching close paren for the "(" at `open`.
function matchParen(code, open) {
    let depth = 0;
    for (let i = open; i < code.length; ++i) {
        if (code[i] === "(") {
            depth++;
        } else if (code[i] === ")") {
            depth--;
            if (depth === 0) {
                return i;
            }
        }
    }
    return -1;
}

/**
 * Turn a vertex entry point into an ordinary function: remove its @vertex
 * attribute and the IO attributes on its parameters and return type.
 * @returns {string} the rewritten module
 */
export function demoteVertexEntryPoint(code, entryPoint) {
    const fnPattern = new RegExp(`\\bfn\\s+${entryPoint.replace(/[$]/g, "\\$&")}\\s*\\(`, "g");
    const match = fnPattern.exec(code);
    if (!match) {
        throw new Error(`The vertex entry point "${entryPoint}" was not found in the shader source.`);
    }
    const fnStart = match.index;
    const open = code.indexOf("(", fnStart);
    const close = matchParen(code, open);
    const body = code.indexOf("{", close);
    if (close < 0 || body < 0) {
        throw new Error(`The signature of "${entryPoint}" could not be parsed.`);
    }
    // The @vertex attribute is somewhere between the previous declaration and `fn`.
    const before = code.slice(0, fnStart);
    const vertexAt = before.lastIndexOf("@vertex");
    const declEnd = Math.max(before.lastIndexOf("}"), before.lastIndexOf(";"));
    let head = before;
    if (vertexAt > declEnd) {
        head = before.slice(0, vertexAt) + before.slice(vertexAt + "@vertex".length);
    }
    const signature = code.slice(fnStart, body).replace(IO_ATTRIBUTES, "");
    return head + signature + code.slice(body);
}

/**
 * Generate the compute shader that runs a vertex entry point per element.
 *
 * @param {Object} params
 * @param {string} params.code - the vertex shader module's WGSL
 * @param {Object} params.entry - the entry point's reflection (FunctionInfo)
 * @param {Object[]} params.declaredBindings - every {group, binding} declared in the module
 * @param {Set<string>} params.usedBindings - "group:binding" the vertex entry point uses
 * @returns {Object} { code, entryPoint, group, inBinding, outBinding, inputs, inStride,
 *   outputs, outStride }. inputs: [{ location, scalar, components, offset }] in the
 *   packed input buffer (after the two builtins); outputs: [{ name, builtin, location,
 *   scalar, components, offset }].
 */
export function buildVsOutShader({ code, entry, declaredBindings, usedBindings }) {
    // Where our two storage buffers go: a group the vertex stage doesn't use,
    // at bindings nothing in the module declares.
    const usedGroups = new Set([...usedBindings].map((k) => parseInt(k.split(":")[0], 10)));
    let group = -1;
    for (let g = 0; g < MAX_BIND_GROUPS; ++g) {
        if (!usedGroups.has(g)) {
            group = g;
            break;
        }
    }
    if (group < 0) {
        group = MAX_BIND_GROUPS - 1;
    }
    let base = 0;
    for (const b of declaredBindings) {
        if (b.group === group) {
            base = Math.max(base, b.binding + 1);
        }
    }
    const inBinding = base;
    const outBinding = base + 1;

    // Inputs by location, packed per element after vertex_index and instance_index.
    const inputs = [];
    let inStride = 2;
    const locations = new Map();
    const addLocation = (location, type) => {
        if (locations.has(location)) {
            return locations.get(location);
        }
        const io = parseIoType(typeName(type));
        if (!io || io.scalar === "bool") {
            throw new Error(`Vertex input @location(${location}) has a type (${typeName(type)}) VS Out can't feed.`);
        }
        const input = { location, ...io, offset: inStride };
        inStride += io.components;
        inputs.push(input);
        locations.set(location, input);
        return input;
    };

    const readExpr = (typeText, io, offset) => {
        const comps = [];
        for (let c = 0; c < io.components; ++c) {
            const word = `_vsIn[_base + ${offset + c}u]`;
            comps.push(io.scalar === "u32" ? word
                : io.scalar === "i32" ? `bitcast<i32>(${word})`
                : io.scalar === "f16" ? `f16(bitcast<f32>(${word}))`
                : `bitcast<f32>(${word})`);
        }
        return io.components === 1 ? comps[0] : `${typeText}(${comps.join(", ")})`;
    };

    const ioExpr = (type, attributes) => {
        const builtin = attributeValue(attributes, "builtin");
        if (builtin === "vertex_index") {
            return "_vsIn[_base]";
        }
        if (builtin === "instance_index") {
            return "_vsIn[_base + 1u]";
        }
        if (builtin !== undefined) {
            throw new Error(`Vertex input @builtin(${builtin}) is not supported by VS Out.`);
        }
        const location = attributeValue(attributes, "location");
        if (location === undefined) {
            throw new Error("A vertex input has neither a @location nor a @builtin attribute.");
        }
        const input = addLocation(parseInt(location, 10), type);
        return readExpr(typeName(type), input, input.offset);
    };

    const args = [];
    for (const arg of entry.arguments ?? []) {
        if (arg.type?.isStruct) {
            const members = arg.type.members.map((m) => {
                if (m.type?.isStruct) {
                    throw new Error("Nested structs in vertex inputs are not supported by VS Out.");
                }
                return ioExpr(m.type, m.attributes);
            });
            args.push(`${typeName(arg.type)}(${members.join(", ")})`);
        } else {
            args.push(ioExpr(arg.type, arg.attributes));
        }
    }

    // Outputs: every scalar or vector member of the return value.
    const outputs = [];
    let outStride = 0;
    const addOutput = (name, access, type, attributes) => {
        const io = parseIoType(typeName(type));
        if (!io) {
            return;
        }
        const builtin = attributeValue(attributes, "builtin");
        const location = attributeValue(attributes, "location");
        outputs.push({
            name,
            access,
            builtin: builtin ?? null,
            location: location !== undefined ? parseInt(location, 10) : null,
            ...io,
            offset: outStride,
        });
        outStride += io.components;
    };
    const ret = entry.returnType;
    if (!ret) {
        throw new Error("The vertex entry point returns nothing.");
    }
    if (ret.isStruct) {
        for (const m of ret.members) {
            addOutput(m.name, `_r.${m.name}`, m.type, m.attributes);
        }
    } else {
        const builtin = (entry.outputs ?? [])[0]?.locationType === "builtin" ? "position" : undefined;
        addOutput("position", "_r", ret, builtin ? [{ name: "builtin", value: builtin }] : null);
    }
    if (!outputs.length) {
        throw new Error("The vertex entry point has no outputs VS Out can read.");
    }

    const writes = [];
    for (const out of outputs) {
        for (let c = 0; c < out.components; ++c) {
            const value = out.components === 1 ? out.access : `${out.access}[${c}]`;
            const word = out.scalar === "u32" ? value
                : out.scalar === "i32" ? `bitcast<u32>(${value})`
                : out.scalar === "bool" ? `select(0u, 1u, ${value})`
                : `bitcast<u32>(f32(${value}))`;
            writes.push(`    _vsOut[_o + ${out.offset + c}u] = ${word};`);
        }
    }

    const generated = `${demoteVertexEntryPoint(code, entry.name)}

// ---- WebGPU Inspector VS Out ----
@group(${group}) @binding(${inBinding}) var<storage, read> _vsIn : array<u32>;
@group(${group}) @binding(${outBinding}) var<storage, read_write> _vsOut : array<u32>;
override _vsOutCount : u32 = 0u;

@compute @workgroup_size(${WORKGROUP_SIZE})
fn _vsOutMain(@builtin(global_invocation_id) _gid : vec3u) {
    let _i = _gid.x;
    if (_i >= _vsOutCount) {
        return;
    }
    let _base = _i * ${inStride}u;
    let _r = ${entry.name}(${args.join(", ")});
    let _o = _i * ${outStride}u;
${writes.join("\n")}
}
`;
    return { code: generated, entryPoint: "_vsOutMain", group, inBinding, outBinding, inputs, inStride, outputs, outStride };
}

/**
 * Pack a mesh's decoded inputs (mesh_input.js) into the u32 words the
 * generated shader reads, conforming each to the shader's declared type the
 * way vertex fetch does: missing components default to 0 (1 for w), and
 * floats are stored as f32 bits.
 */
export function packVsInputs(mesh, layout, instanceIndex) {
    const words = new Uint32Array(Math.max(1, mesh.count * layout.inStride));
    const f32 = new Float32Array(words.buffer);
    const i32 = new Int32Array(words.buffer);
    const byLocation = new Map(mesh.attributes.map((a, i) => [a.location, i]));
    for (let i = 0; i < mesh.count; ++i) {
        const base = i * layout.inStride;
        words[base] = Math.max(0, mesh.vertexIndices[i]);
        words[base + 1] = instanceIndex;
        for (const input of layout.inputs) {
            const a = byLocation.get(input.location);
            const attr = a !== undefined ? mesh.attributes[a] : null;
            for (let c = 0; c < input.components; ++c) {
                let v = attr && c < attr.components ? mesh.values[a][i * attr.components + c] : (c === 3 ? 1 : 0);
                if (Number.isNaN(v)) {
                    v = 0;
                }
                const at = base + input.offset + c;
                if (input.scalar === "u32") {
                    words[at] = v >>> 0;
                } else if (input.scalar === "i32") {
                    i32[at] = v | 0;
                } else {
                    f32[at] = v;
                }
            }
        }
    }
    return words;
}

/** Decode the shader's output words into mesh-shaped attributes. */
export function unpackVsOutputs(words, layout, count) {
    const f32 = new Float32Array(words.buffer, words.byteOffset, words.length);
    const i32 = new Int32Array(words.buffer, words.byteOffset, words.length);
    const attributes = [];
    const values = [];
    for (const out of layout.outputs) {
        const data = new Float64Array(count * out.components);
        for (let i = 0; i < count; ++i) {
            for (let c = 0; c < out.components; ++c) {
                const at = i * layout.outStride + out.offset + c;
                data[i * out.components + c] = out.scalar === "u32" || out.scalar === "bool" ? words[at]
                    : out.scalar === "i32" ? i32[at] : f32[at];
            }
        }
        attributes.push({
            name: out.builtin ? `${out.name} (@builtin(${out.builtin}))` : `${out.name}`,
            location: out.location ?? -1,
            builtin: out.builtin,
            format: out.scalar === "u32" ? `uint32x${out.components}` : out.scalar === "i32" ? `sint32x${out.components}` : `float32x${out.components}`,
            components: out.components,
            stepMode: "vertex",
            slot: -1,
        });
        values.push(data);
    }
    return { attributes, values };
}

/**
 * Clip-space statistics for VS Out: vertices outside the view volume, behind
 * the eye (w <= 0) and NaN, triangles entirely outside one clip plane, and
 * triangles with zero screen-space area.
 * @param {Float64Array} clip - count * 4 clip-space positions
 * @param {Int32Array} vertexIndices - from the mesh (negative = no vertex)
 * @param {Uint32Array} triangles - element indices, triangle list
 */
export function clipStats(clip, vertexIndices, triangles) {
    const count = vertexIndices.length;
    let outside = 0;
    let behind = 0;
    let nan = 0;
    const outcode = new Uint8Array(count);
    for (let i = 0; i < count; ++i) {
        if (vertexIndices[i] < 0) {
            continue;
        }
        const x = clip[i * 4];
        const y = clip[i * 4 + 1];
        const z = clip[i * 4 + 2];
        const w = clip[i * 4 + 3];
        if (![x, y, z, w].every(Number.isFinite)) {
            nan++;
            outcode[i] = 0x80;
            continue;
        }
        if (w <= 0) {
            behind++;
        }
        let code = 0;
        if (x < -w) code |= 1;
        if (x > w) code |= 2;
        if (y < -w) code |= 4;
        if (y > w) code |= 8;
        if (z < 0) code |= 16;
        if (z > w) code |= 32;
        outcode[i] = code;
        if (code) {
            outside++;
        }
    }
    let culledTriangles = 0;
    let zeroArea = 0;
    for (let t = 0; t + 2 < triangles.length; t += 3) {
        const a = triangles[t];
        const b = triangles[t + 1];
        const c = triangles[t + 2];
        if ((outcode[a] & 0x80) || (outcode[b] & 0x80) || (outcode[c] & 0x80)) {
            continue;
        }
        if (outcode[a] & outcode[b] & outcode[c] & 0x3f) {
            culledTriangles++;
            continue;
        }
        const wa = clip[a * 4 + 3];
        const wb = clip[b * 4 + 3];
        const wc = clip[c * 4 + 3];
        if (wa <= 0 || wb <= 0 || wc <= 0) {
            continue;
        }
        const ax = clip[a * 4] / wa;
        const ay = clip[a * 4 + 1] / wa;
        const bx = clip[b * 4] / wb;
        const by = clip[b * 4 + 1] / wb;
        const cx = clip[c * 4] / wc;
        const cy = clip[c * 4 + 1] / wc;
        if ((bx - ax) * (cy - ay) - (cx - ax) * (by - ay) === 0) {
            zeroArea++;
        }
    }
    return { outside, behind, nan, culledTriangles, zeroArea };
}

// Every {group, binding} declared in a WGSL module, whichever order the
// attributes are written in.
function declaredBindingsOf(code) {
    const out = [];
    const re = /@group\s*\(\s*(\d+)\s*\)\s*@binding\s*\(\s*(\d+)\s*\)|@binding\s*\(\s*(\d+)\s*\)\s*@group\s*\(\s*(\d+)\s*\)/g;
    let m;
    while ((m = re.exec(code))) {
        out.push(m[1] !== undefined
            ? { group: parseInt(m[1], 10), binding: parseInt(m[2], 10) }
            : { group: parseInt(m[4], 10), binding: parseInt(m[3], 10) });
    }
    return out;
}

/**
 * Run a draw's vertex shader over its decoded inputs on the GPU.
 *
 * @param {Object} params
 * @param {GPUDevice} params.device
 * @param {Object} params.database - the capture's object database
 * @param {Object} params.command - the draw command
 * @param {Object[]} params.passCommands - the commands of the draw's pass
 * @param {Object} params.pipelineDesc - the render pipeline's descriptor
 * @param {Object} params.mesh - VS In from buildMeshInput, for the same instance
 * @param {number} params.instance - the instance mesh was built for
 * @returns {Promise<Object>} a mesh-shaped VS Out: { attributes, values, count,
 *   vertexIndices, topology, drawArgs, warnings, clipIndex }
 */
export async function runVsOut({ device, database, command, passCommands, pipelineDesc, mesh, instance }) {
    if (!device) {
        throw new Error("The DevTools GPU device is not available.");
    }
    const moduleObj = database.getObject(pipelineDesc?.vertex?.module?.__id);
    const code = moduleObj?.code ?? moduleObj?.descriptor?.code;
    if (!code) {
        throw new Error("The draw's vertex shader source was not captured.");
    }
    const reflection = moduleObj.reflection;
    const entries = reflection?.entry?.vertex ?? [];
    const entryPointName = pipelineDesc.vertex.entryPoint;
    const entry = (entryPointName ? entries.find((e) => e.name === entryPointName) : null) ?? entries[0];
    if (!entry) {
        throw new Error("The vertex entry point could not be reflected.");
    }
    if (!mesh.count) {
        throw new Error("The draw fetches no vertices.");
    }

    const usedBindings = vertexStageBindings(reflection, entry.name) ?? new Set();
    const layout = buildVsOutShader({ code, entry, declaredBindings: declaredBindingsOf(code), usedBindings });

    const replay = new CaptureReplay(device, database);
    const created = [];
    const warnings = [...mesh.warnings];
    try {
        // Captured resource contents: walk the pass so every binding's bytes
        // are uploaded as the draw saw them.
        const uploads = [];
        const missing = new Set();
        const plans = walkPassCommands(replay, passCommands ?? [], uploads, missing, { skippedDraws: 0 });
        const plan = plans.find((p) => p.command === command);
        if (!plan) {
            throw new Error("The draw could not be found in its pass.");
        }
        for (const note of missing) {
            warnings.push(note);
        }
        applyUploads(replay, uploads);

        device.pushErrorScope("validation");
        const module = device.createShaderModule({ code: layout.code, label: "VS Out" });
        const info = await module.getCompilationInfo();
        const errors = info.messages.filter((m) => m.type === "error");
        await device.popErrorScope();
        if (errors.length) {
            throw new Error(`The vertex shader could not be converted for replay: ${errors[0].message} (line ${errors[0].lineNum})`);
        }

        const constants = { ...(pipelineDesc.vertex.constants ?? {}), _vsOutCount: mesh.count };
        device.pushErrorScope("validation");
        const pipeline = device.createComputePipeline({
            label: "VS Out",
            layout: "auto",
            compute: { module, entryPoint: layout.entryPoint, constants },
        });
        let error = await device.popErrorScope();
        if (error) {
            throw new Error(`The VS Out pipeline could not be created: ${error.message}`);
        }

        const inWords = packVsInputs(mesh, layout, (mesh.drawArgs?.firstInstance ?? 0) + instance);
        const inBuffer = device.createBuffer({ size: inWords.byteLength, usage: BUFFER_STORAGE | BUFFER_COPY_DST });
        created.push(inBuffer);
        device.queue.writeBuffer(inBuffer, 0, inWords);
        const outBytes = Math.max(4, mesh.count * layout.outStride * 4);
        const outBuffer = device.createBuffer({ size: outBytes, usage: BUFFER_STORAGE | BUFFER_COPY_SRC });
        const readback = device.createBuffer({ size: outBytes, usage: BUFFER_COPY_DST | BUFFER_MAP_READ });
        created.push(outBuffer, readback);

        // Bind groups: the vertex stage's resources per group, plus our buffers.
        const groups = new Set([...usedBindings].map((k) => parseInt(k.split(":")[0], 10)));
        groups.add(layout.group);
        const bindGroups = [];
        for (const g of [...groups].sort((a, b) => a - b)) {
            const entries = [];
            for (const key of usedBindings) {
                const [group, binding] = key.split(":").map((v) => parseInt(v, 10));
                if (group !== g) {
                    continue;
                }
                entries.push({ binding, resource: resolveBinding(replay, database, plan.bindGroups[g], binding) });
            }
            if (g === layout.group) {
                entries.push({ binding: layout.inBinding, resource: { buffer: inBuffer } });
                entries.push({ binding: layout.outBinding, resource: { buffer: outBuffer } });
            }
            device.pushErrorScope("validation");
            const bindGroup = device.createBindGroup({ layout: pipeline.getBindGroupLayout(g), entries });
            error = await device.popErrorScope();
            if (error) {
                throw new Error(`Bind group ${g} could not be re-created for VS Out: ${error.message}`);
            }
            bindGroups.push([g, bindGroup]);
        }
        for (const id of replay.placeholderTextures) {
            const texture = database.getObject(id);
            warnings.push(`Texture ${texture?.label || id} is bound with placeholder contents (its data isn't available in the original format); outputs that sample it may be wrong.`);
        }

        device.pushErrorScope("validation");
        const encoder = device.createCommandEncoder();
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        for (const [g, bindGroup] of bindGroups) {
            pass.setBindGroup(g, bindGroup);
        }
        pass.dispatchWorkgroups(Math.ceil(mesh.count / WORKGROUP_SIZE));
        pass.end();
        encoder.copyBufferToBuffer(outBuffer, 0, readback, 0, outBytes);
        device.queue.submit([encoder.finish()]);
        error = await device.popErrorScope();
        if (error) {
            throw new Error(`VS Out replay failed: ${error.message}`);
        }
        await readback.mapAsync(BUFFER_MAP_READ);
        const words = new Uint32Array(readback.getMappedRange().slice(0));
        readback.unmap();

        const { attributes, values } = unpackVsOutputs(words, layout, mesh.count);
        const clipIndex = attributes.findIndex((a) => a.builtin === "position");
        return {
            attributes,
            values,
            count: mesh.count,
            vertexIndices: mesh.vertexIndices,
            topology: mesh.topology,
            drawArgs: mesh.drawArgs,
            warnings,
            clipIndex,
        };
    } finally {
        for (const buffer of created) {
            try {
                buffer.destroy();
            } catch (_) { /* ignore */ }
        }
        replay.destroy();
    }
}

// One vertex-stage binding's resource for the VS Out bind group, from the
// draw's bound bind group. Dynamic offsets are folded into the offset, since
// the compute pipeline's auto layout has no dynamic bindings.
function resolveBinding(replay, database, bgState, binding) {
    const bgObj = database.getObject(bgState?.bgId);
    const entry = bgObj?.descriptor?.entries?.find((e) => e.binding === binding);
    if (!entry) {
        throw new Error(`Binding ${binding} of the draw's bind group was not captured.`);
    }
    const ref = entry.resource;
    const bufferId = ref?.buffer?.__id ?? (ref?.__class === "GPUBuffer" ? ref.__id : undefined);
    if (bufferId !== undefined) {
        const buffer = replay.getBuffer(bufferId);
        if (!buffer) {
            throw new Error(`The buffer at binding ${binding} could not be re-created.`);
        }
        let offset = ref.offset ?? 0;
        const bglEntries = database.getObject(bgObj.descriptor.layout?.__id)?.descriptor?.entries;
        const dynamicOffsets = bgState.dynamicOffsets ?? [];
        if (bglEntries && dynamicOffsets.length) {
            const dynamic = bglEntries.filter((e) => e.buffer?.hasDynamicOffset).map((e) => e.binding).sort((a, b) => a - b);
            const k = dynamic.indexOf(binding);
            if (k >= 0) {
                offset += dynamicOffsets[k] ?? 0;
            }
        }
        const resource = { buffer, offset };
        if (ref.size) {
            resource.size = ref.size;
        }
        return resource;
    }
    const object = database.getObject(ref?.__id);
    const className = object?.constructor?.className;
    if (className === "TextureView" || object?.texture !== undefined) {
        const texture = database.getTextureFromView(object);
        const gpuTexture = texture ? replay.getTexture(texture.id) : null;
        if (!gpuTexture) {
            throw new Error(`The texture at binding ${binding} was not captured.`);
        }
        return gpuTexture.createView(object.descriptor ?? undefined);
    }
    const sampler = className === "Sampler" ? replay.getSampler(ref?.__id) : null;
    if (!sampler) {
        throw new Error(`The resource at binding ${binding} (${className ?? "unknown"}) is not supported by VS Out.`);
    }
    return sampler;
}
