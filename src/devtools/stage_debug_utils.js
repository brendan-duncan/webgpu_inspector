// Shared helpers for driving the WGSL interpreter from captured frame data.
// Used by the ShaderDebugger (interactive stepping) and the pixel-history
// engine (batch per-pixel replay), so the two agree on how bind groups,
// vertex buffers and vertex-shader outputs are reconstructed from a capture.

import { WgslDebug } from "wgsl_reflect/wgsl_reflect.module.js";
import { TextureView, Sampler } from "./gpu_objects/index.js";
import { fetchVertexInputs } from "./vertex_fetcher.js";

// Build the bound-resource map (buffers, uniforms, textures, samplers) that
// WgslDebug expects, from an array of captured setBindGroup commands (indexed
// by bind group slot). Shared by every stage.
//
// Note: bound texture contents come from the capture's texture data, which is
// the texture's most recently captured state — for textures written multiple
// times in a frame this may differ from their contents at the time of the
// draw being debugged.
export function buildBindGroups(database, bindGroupCommands) {
    const bindGroups = {};

    bindGroupCommands.forEach((bgCmd) => {
        const index = bgCmd.args[0];

        const bindGroup = {};
        bindGroups[index] = bindGroup;

        const bgObj = database.getObject(bgCmd.args[1].__id);

        if (bgCmd.bufferData !== undefined) {
            const bufferData = bgCmd.bufferData;
            let entryIndex = 0;
            for (const buffer of bufferData) {
                if (buffer) {
                    const binding = bgObj.descriptor.entries[entryIndex].binding;
                    bindGroup[binding] = buffer;
                }
                entryIndex++;
            }
        }

        for (const b of bgObj.descriptor.entries) {
            const binding = b.binding;
            if (bindGroup[binding] !== undefined) {
                continue;
            }

            const resource = database.getObject(b.resource.__id);
            if (resource instanceof TextureView) {
                const texture = resource.__texture;
                const size = [texture.width, texture.height, texture.depthOrArrayLayers];
                bindGroup[binding] = { texture: texture.imageData, size, view: resource.descriptor, descriptor: texture.descriptor };
            } else if (resource instanceof Sampler) {
                // Sampler: pass its descriptor so compare/filter/address modes
                // are honored by the sampling builtins.
                bindGroup[binding] = { sampler: resource.descriptor };
            }
        }
    });

    return bindGroups;
}

// Collect the captured vertex-buffer data from setVertexBuffer commands,
// indexed by slot.
export function collectVertexBufferData(vertexBufferCommands) {
    const vertexBufferData = [];
    const vbCmds = vertexBufferCommands ?? [];
    for (let slot = 0; slot < vbCmds.length; ++slot) {
        const vbCmd = vbCmds[slot];
        if (vbCmd && vbCmd.bufferData) {
            vertexBufferData[slot] = vbCmd.bufferData[slot];
        }
    }
    return vertexBufferData;
}

// Decode a captured setIndexBuffer command's data into a typed array.
export function decodeIndexArray(indexBufferCommand) {
    const ib = indexBufferCommand;
    if (!ib || !ib.bufferData) {
        return null;
    }
    const data = ib.bufferData[0];
    if (!data) {
        return null;
    }
    const format = ib.args[1]; // "uint16" | "uint32"
    const buf = data instanceof ArrayBuffer ? data : data.buffer;
    const off = data instanceof ArrayBuffer ? 0 : (data.byteOffset ?? 0);
    const len = data.byteLength ?? buf.byteLength;
    return format === "uint16"
        ? new Uint16Array(buf, off, Math.floor(len / 2))
        : new Uint32Array(buf, off, Math.floor(len / 4));
}

// Map a vertex shader's return value (a struct object keyed by member name,
// or a bare @builtin(position) value) to { position, varyings-by-location }.
export function extractVsOutput(out, vsOutputs) {
    if (out === null || out === undefined) {
        return null;
    }
    if (Array.isArray(out)) {
        // A bare return is the @builtin(position) vec4.
        return { position: out, varyings: {} };
    }
    let position = null;
    const varyings = {};
    for (const o of vsOutputs) {
        const val = out[o.name];
        if (val === undefined) {
            continue;
        }
        if (o.locationType === "builtin" && o.location === "position") {
            position = val;
        } else if (o.locationType === "location") {
            varyings[o.location] = val;
        }
    }
    return position ? { position, varyings } : null;
}

// Build a (vertexIndex, instanceIndex) => { position, varyings } runner that
// executes the vertex shader on the CPU interpreter, fetching the vertex
// attributes from the captured vertex buffers. One WgslDebug is reused for
// every invocation so the shader is parsed once.
export function makeVertexRunner({ code, entryName, entryInputs, entryOutputs, pipelineDesc, vertexBufferData, bindGroups, constants }) {
    const options = constants ? { constants } : {};
    const vsDebug = new WgslDebug(code);
    return (vertexIndex, instanceIndex) => {
        const inputs = fetchVertexInputs(pipelineDesc, vertexBufferData, vertexIndex, instanceIndex, entryInputs);
        if (!vsDebug.debugVertex(entryName, inputs, bindGroups, options)) {
            return null;
        }
        let guard = 0;
        while (vsDebug.stepNext() && guard++ < 1000000) { /* run VS to completion */ }
        return extractVsOutput(vsDebug.getReturnValue(), entryOutputs);
    };
}
