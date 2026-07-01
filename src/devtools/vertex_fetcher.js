// Decode vertex attributes out of captured vertex-buffer bytes, using a render
// pipeline's vertex layout, into the { <location>: value } shape that
// WgslDebug.debugVertex expects (plus the vertex_index / instance_index
// builtins). This is the inspector-side "vertex fetch" that feeds vertex (and,
// later, fragment) shader debugging from a frame capture.

// half-float (float16) -> float32.
function float16ToFloat32(h) {
    const s = (h & 0x8000) >> 15;
    const e = (h & 0x7c00) >> 10;
    const f = h & 0x03ff;
    if (e === 0) {
        return (s ? -1 : 1) * Math.pow(2, -14) * (f / 1024);
    }
    if (e === 0x1f) {
        return f ? NaN : (s ? -1 : 1) * Infinity;
    }
    return (s ? -1 : 1) * Math.pow(2, e - 15) * (1 + f / 1024);
}

// Read one component of the given base type at byteOffset (little-endian).
function readComponent(dv, base, bits, offset) {
    switch (base) {
        case "float":
            return bits === 32 ? dv.getFloat32(offset, true) : float16ToFloat32(dv.getUint16(offset, true));
        case "uint":
            return bits === 32 ? dv.getUint32(offset, true) : bits === 16 ? dv.getUint16(offset, true) : dv.getUint8(offset);
        case "sint":
            return bits === 32 ? dv.getInt32(offset, true) : bits === 16 ? dv.getInt16(offset, true) : dv.getInt8(offset);
        case "unorm":
            return bits === 16 ? dv.getUint16(offset, true) / 65535 : dv.getUint8(offset) / 255;
        case "snorm":
            return bits === 16 ? Math.max(-1, dv.getInt16(offset, true) / 32767) : Math.max(-1, dv.getInt8(offset) / 127);
    }
    return 0;
}

// Decode a GPUVertexFormat value at byteOffset. Returns a number for scalar
// formats, an array for vector formats, or null if out of range / unsupported.
export function decodeVertexAttribute(dv, byteOffset, format) {
    if (format === "unorm10-10-10-2") {
        if (byteOffset + 4 > dv.byteLength) {
            return null;
        }
        const v = dv.getUint32(byteOffset, true);
        return [
            ((v >> 0) & 0x3ff) / 1023,
            ((v >> 10) & 0x3ff) / 1023,
            ((v >> 20) & 0x3ff) / 1023,
            ((v >> 30) & 0x3) / 3,
        ];
    }

    const m = format.match(/^(uint|sint|unorm|snorm|float)(8|16|32)(?:x(\d))?$/);
    if (!m) {
        return null;
    }
    const base = m[1];
    const bits = parseInt(m[2], 10);
    const count = m[3] ? parseInt(m[3], 10) : 1;
    const byteSize = bits / 8;

    if (byteOffset + count * byteSize > dv.byteLength) {
        return null;
    }

    if (count === 1) {
        return readComponent(dv, base, bits, byteOffset);
    }
    const out = [];
    for (let i = 0; i < count; ++i) {
        out.push(readComponent(dv, base, bits, byteOffset + i * byteSize));
    }
    return out;
}

// Wrap captured buffer data (ArrayBuffer or typed array) as a DataView.
function asDataView(data) {
    if (data instanceof ArrayBuffer) {
        return new DataView(data);
    }
    if (ArrayBuffer.isView(data)) {
        return new DataView(data.buffer, data.byteOffset, data.byteLength);
    }
    return null;
}

// Build the debugVertex `inputs` for a given vertex/instance from a pipeline's
// vertex layout and the captured per-slot vertex-buffer data.
//
//   pipelineDesc    - GPURenderPipelineDescriptor (needs .vertex.buffers)
//   vertexBufferData- array indexed by vertex-buffer slot; each entry is the
//                     captured bytes for that slot, already at its bound offset
//   vertexIndex     - the @builtin(vertex_index) value to debug
//   instanceIndex   - the @builtin(instance_index) value to debug
//
// Attributes on vertex-stepped buffers are fetched at vertexIndex*stride, and on
// instance-stepped buffers at instanceIndex*stride (both relative to the bound
// offset, which the captured data already accounts for).
export function fetchVertexInputs(pipelineDesc, vertexBufferData, vertexIndex, instanceIndex) {
    const inputs = { vertex_index: vertexIndex, instance_index: instanceIndex };

    const buffers = pipelineDesc?.vertex?.buffers ?? [];
    for (let slot = 0; slot < buffers.length; ++slot) {
        const layout = buffers[slot];
        if (!layout) {
            continue;
        }
        const dv = asDataView(vertexBufferData[slot]);
        if (dv === null) {
            continue;
        }
        const stride = layout.arrayStride ?? 0;
        const stepMode = layout.stepMode ?? "vertex";
        const elemIndex = stepMode === "instance" ? instanceIndex : vertexIndex;
        const elemOffset = elemIndex * stride;

        for (const attr of layout.attributes ?? []) {
            const value = decodeVertexAttribute(dv, elemOffset + attr.offset, attr.format);
            if (value !== null) {
                inputs[attr.shaderLocation] = value;
            }
        }
    }

    return inputs;
}
