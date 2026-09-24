import { getFlagString } from "../utils/flags.js";
import { formatBytes } from "../utils/format.js";

/**
 * Hover text for an entry in the Inspect panel's object list: the details the
 * one-line entry has no room for (a texture's format, size, mips, samples,
 * usage and memory; a buffer's size and usage; a pipeline's shaders and
 * targets; ...), plus where the object was created when stack traces are on.
 *
 * Built when the entry is hovered rather than when it is added, so a page with
 * tens of thousands of objects pays nothing for it. DOM-free so it can be unit
 * tested.
 */

// Literal usage flags so this module loads under node, where the WebGPU
// globals don't exist.
const BUFFER_USAGE = {
    MAP_READ: 0x0001, MAP_WRITE: 0x0002, COPY_SRC: 0x0004, COPY_DST: 0x0008, INDEX: 0x0010,
    VERTEX: 0x0020, UNIFORM: 0x0040, STORAGE: 0x0080, INDIRECT: 0x0100, QUERY_RESOLVE: 0x0200,
};
const TEXTURE_USAGE = {
    COPY_SRC: 0x01, COPY_DST: 0x02, TEXTURE_BINDING: 0x04, STORAGE_BINDING: 0x08, RENDER_ATTACHMENT: 0x10,
};
const SHADER_STAGE = { VERTEX: 0x1, FRAGMENT: 0x2, COMPUTE: 0x4 };

function className(object) {
    return object?.constructor?.className ?? "";
}

function bytes(n) {
    if (!(n >= 0)) {
        return "?";
    }
    return n >= 1024 ? `${formatBytes(n)} (${n.toLocaleString()} bytes)` : `${n} bytes`;
}

function refName(database, ref) {
    const id = ref?.__id ?? ref;
    if (id === undefined || id === null) {
        return "?";
    }
    const object = database?.getObject?.(id);
    const label = object?.label ? ` "${object.label}"` : "";
    return `${className(object) || "Object"} ${object?.idName ?? id}${label}`;
}

function textureLines(texture) {
    const lines = [];
    const d = texture.descriptor ?? {};
    lines.push(`Format: ${texture.format}`);
    const dim = texture.dimension ?? "2d";
    const layers = texture.depthOrArrayLayers ?? 1;
    const size = dim === "3d" ? `${texture.width} x ${texture.height} x ${layers}`
        : layers > 1 ? `${texture.width} x ${texture.height}, ${layers} layers`
        : `${texture.width} x ${texture.height}`;
    lines.push(`Size: ${size} (${dim})`);
    const mips = texture.mipLevelCount ?? 1;
    lines.push(`Mip levels: ${mips}${mips > 1 && texture.getMipSize ? ` (smallest ${texture.getMipSize(mips - 1).slice(0, 2).join(" x ")})` : ""}`);
    if ((texture.sampleCount ?? 1) > 1) {
        lines.push(`Samples: ${texture.sampleCount}`);
    }
    if (d.usage !== undefined) {
        lines.push(`Usage: ${getFlagString(d.usage, TEXTURE_USAGE) || "none"}`);
    }
    if (d.viewFormats?.length) {
        lines.push(`View formats: ${d.viewFormats.join(", ")}`);
    }
    const gpuSize = texture.getGpuSize ? texture.getGpuSize() : -1;
    if (gpuSize >= 0) {
        lines.push(`Memory: ${bytes(gpuSize)} (estimated)`);
    }
    return lines;
}

function pipelineStages(desc) {
    const lines = [];
    for (const [stage, s] of [["Vertex", desc?.vertex], ["Fragment", desc?.fragment], ["Compute", desc?.compute]]) {
        if (s?.module) {
            lines.push(`${stage}: ${s.entryPoint ?? "(default entry point)"} in ShaderModule ${s.module.__id ?? "?"}`);
        }
    }
    return lines;
}

/**
 * @param {Object} object - a devtools GPU object
 * @param {Object} [database] - resolves referenced objects (a view's texture, ...)
 * @returns {string}
 */
export function objectTooltip(object, database) {
    const cls = className(object);
    const lines = [`${object.label ? `"${object.label}" ` : ""}${cls} ${object.idName ?? object.id}`];
    const d = object.descriptor ?? {};

    switch (cls) {
        case "Texture":
            lines.push(...textureLines(object));
            break;
        case "TextureView": {
            const texture = database?.getTextureFromView?.(object);
            const vd = d ?? {};
            const view = [];
            if (vd.format) {
                view.push(`format ${vd.format}`);
            }
            if (vd.dimension) {
                view.push(vd.dimension);
            }
            if (vd.baseMipLevel || vd.mipLevelCount !== undefined) {
                view.push(`mips ${vd.baseMipLevel ?? 0}${vd.mipLevelCount !== undefined ? `–${(vd.baseMipLevel ?? 0) + vd.mipLevelCount - 1}` : "+"}`);
            }
            if (vd.baseArrayLayer || vd.arrayLayerCount !== undefined) {
                view.push(`layers ${vd.baseArrayLayer ?? 0}${vd.arrayLayerCount !== undefined ? `–${(vd.baseArrayLayer ?? 0) + vd.arrayLayerCount - 1}` : "+"}`);
            }
            if (vd.aspect && vd.aspect !== "all") {
                view.push(vd.aspect);
            }
            lines.push(`View: ${view.length ? view.join(", ") : "whole texture"}`);
            if (texture) {
                lines.push(`Texture: ${refName(database, texture.id)}`);
                lines.push(...textureLines(texture).map((l) => `  ${l}`));
            }
            break;
        }
        case "Buffer":
            lines.push(`Size: ${bytes(d.size)}`);
            lines.push(`Usage: ${getFlagString(d.usage ?? 0, BUFFER_USAGE) || "none"}`);
            if (d.mappedAtCreation) {
                lines.push("Mapped at creation");
            }
            break;
        case "Sampler": {
            lines.push(`Filter: mag ${d.magFilter ?? "nearest"}, min ${d.minFilter ?? "nearest"}, mipmap ${d.mipmapFilter ?? "nearest"}`);
            lines.push(`Address: ${d.addressModeU ?? "clamp-to-edge"}, ${d.addressModeV ?? "clamp-to-edge"}, ${d.addressModeW ?? "clamp-to-edge"}`);
            if (d.compare) {
                lines.push(`Compare: ${d.compare}`);
            }
            if ((d.maxAnisotropy ?? 1) > 1) {
                lines.push(`Anisotropy: ${d.maxAnisotropy}`);
            }
            if (d.lodMinClamp !== undefined || d.lodMaxClamp !== undefined) {
                lines.push(`LOD clamp: ${d.lodMinClamp ?? 0}–${d.lodMaxClamp ?? 32}`);
            }
            break;
        }
        case "ShaderModule": {
            const code = object.code ?? d.code ?? "";
            lines.push(`Source: ${code.split("\n").length.toLocaleString()} lines, ${bytes(code.length)}`);
            let entries = null;
            try {
                entries = object.reflection?.entry ?? null;
            } catch (e) {
                entries = null;
            }
            if (entries) {
                for (const stage of ["vertex", "fragment", "compute"]) {
                    const names = (entries[stage] ?? []).map((e) => e.name);
                    if (names.length) {
                        lines.push(`${stage[0].toUpperCase()}${stage.slice(1)} entry points: ${names.join(", ")}`);
                    }
                }
            }
            if (object.replacementCode) {
                lines.push("Edited in the inspector");
            }
            break;
        }
        case "RenderPipeline": {
            lines.push(...pipelineStages(d));
            lines.push(`Topology: ${d.primitive?.topology ?? "triangle-list"}${d.primitive?.cullMode && d.primitive.cullMode !== "none" ? `, cull ${d.primitive.cullMode}` : ""}`);
            const targets = (d.fragment?.targets ?? []).map((t) => (t ? `${t.format}${t.blend ? " (blend)" : ""}` : "none"));
            if (targets.length) {
                lines.push(`Targets: ${targets.join(", ")}`);
            }
            if (d.depthStencil) {
                lines.push(`Depth-stencil: ${d.depthStencil.format}, compare ${d.depthStencil.depthCompare ?? "always"}${d.depthStencil.depthWriteEnabled ? ", write" : ""}`);
            }
            if ((d.multisample?.count ?? 1) > 1) {
                lines.push(`Samples: ${d.multisample.count}`);
            }
            lines.push(`Layout: ${d.layout === "auto" || !d.layout ? "auto" : refName(database, d.layout)}`);
            break;
        }
        case "ComputePipeline":
            lines.push(...pipelineStages(d));
            lines.push(`Layout: ${d.layout === "auto" || !d.layout ? "auto" : refName(database, d.layout)}`);
            break;
        case "BindGroup": {
            lines.push(`Layout: ${refName(database, d.layout)}`);
            for (const entry of (d.entries ?? []).slice(0, 12)) {
                const r = entry.resource;
                const what = r?.buffer ? `${refName(database, r.buffer)}${r.offset ? ` @${r.offset}` : ""}${r.size ? ` (${r.size} bytes)` : ""}` : refName(database, r);
                lines.push(`  ${entry.binding}: ${what}`);
            }
            if ((d.entries?.length ?? 0) > 12) {
                lines.push(`  … ${d.entries.length - 12} more`);
            }
            break;
        }
        case "BindGroupLayout": {
            if (!d.entries) {
                lines.push("From a pipeline's auto layout");
                break;
            }
            for (const entry of d.entries.slice(0, 12)) {
                const kind = entry.buffer ? `buffer (${entry.buffer.type ?? "uniform"}${entry.buffer.hasDynamicOffset ? ", dynamic" : ""})`
                    : entry.texture ? `texture (${entry.texture.sampleType ?? "float"}, ${entry.texture.viewDimension ?? "2d"})`
                    : entry.storageTexture ? `storage texture (${entry.storageTexture.format}, ${entry.storageTexture.access ?? "write-only"})`
                    : entry.sampler ? `sampler (${entry.sampler.type ?? "filtering"})`
                    : entry.externalTexture ? "external texture" : "?";
                lines.push(`  ${entry.binding}: ${kind} — ${getFlagString(entry.visibility ?? 0, SHADER_STAGE)}`);
            }
            if (d.entries.length > 12) {
                lines.push(`  … ${d.entries.length - 12} more`);
            }
            break;
        }
        case "PipelineLayout":
            (d.bindGroupLayouts ?? []).forEach((ref, i) => lines.push(`  Group ${i}: ${refName(database, ref)}`));
            break;
        case "CanvasContext":
            if (d.canvasId) {
                lines.push(`Canvas: #${d.canvasId}`);
            }
            if (d.width && d.height) {
                lines.push(`Size: ${d.width} x ${d.height}`);
            }
            if (d.format) {
                lines.push(`Format: ${d.format}`);
            }
            if (d.alphaMode) {
                lines.push(`Alpha mode: ${d.alphaMode}`);
            }
            if (d.usage !== undefined) {
                lines.push(`Usage: ${getFlagString(d.usage, TEXTURE_USAGE)}`);
            }
            break;
        case "Adapter": {
            const info = d.info ?? d;
            const parts = [info.vendor, info.architecture, info.device, info.description].filter(Boolean);
            if (parts.length) {
                lines.push(parts.join(" · "));
            }
            if (d.features?.length) {
                lines.push(`Features: ${d.features.length}`);
            }
            break;
        }
        case "Device":
            if (d.requiredFeatures?.length) {
                lines.push(`Features: ${d.requiredFeatures.join(", ")}`);
            }
            if (d.requiredLimits && Object.keys(d.requiredLimits).length) {
                lines.push(`Raised limits: ${Object.keys(d.requiredLimits).length}`);
            }
            break;
        case "ValidationError":
            lines.push(object.message ?? "");
            break;
    }

    if (object.isDeleted) {
        lines.push("Destroyed");
    }
    const created = createdAt(object);
    if (created) {
        lines.push(`Created at: ${created}`);
    }
    return lines.join("\n");
}

// The first frame of the object's creation stack trace, if one was recorded.
function createdAt(object) {
    let stack = "";
    try {
        stack = object.stacktrace ?? "";
    } catch (e) {
        stack = "";
    }
    const line = stack.split("\n").map((l) => l.trim()).find((l) => l && !/^Error\b/.test(l));
    return line ? line.replace(/^at\s+/, "") : "";
}
