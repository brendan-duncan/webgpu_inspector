import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";

const THUMB_WIDTH = 360;

/**
 * The Shader Edit tab: what an edited shader changes in the captured frame.
 * One card per render target the edit could affect, with the target as
 * captured ("Before"), with the edit ("After"), and the changed texels
 * highlighted over the edited result.
 *
 * @param {Object} params
 * @param {Object} params.result - from compileAndReplay
 * @param {string} params.moduleLabel
 * @param {GPUDevice} params.device
 * @param {Object} params.textureUtils - the panel's TextureUtils, for display blits
 * @param {(object:Object)=>void} [params.onInspect]
 * @returns {Div}
 */
export function buildShaderReplayView({ result, moduleLabel, device, textureUtils, onInspect }) {
    const panel = new Div(null, { class: "shader-replay" });
    panel.onDestroy = () => result.dispose();

    const changed = result.results.filter((r) => r.changed > 0);
    const unchanged = result.results.filter((r) => r.changed === 0);
    const skipped = result.results.filter((r) => r.skipped);

    const summary = changed.length
        ? `The edit to ${moduleLabel} changes ${changed.length} of ${result.results.length} render target${result.results.length === 1 ? "" : "s"} it could affect.`
        : `The edit to ${moduleLabel} changes none of the ${result.results.length} render target${result.results.length === 1 ? "" : "s"} it could affect.`;
    new Div(panel, { class: "perf-report-header", text: summary });
    const notes = new Div(panel, { class: "flame-notes" });
    new Div(notes, { class: "flame-note", text: `Both runs replay the frame from the first pass that uses the shader (${result.affectedSteps} step${result.affectedSteps === 1 ? "" : "s"} affected) on the DevTools device, from the same captured starting state, so differences are the edit's effect.` });
    for (const note of result.notes.slice(0, 6)) {
        new Div(notes, { class: "flame-note", text: note });
    }
    if (result.notes.length > 6) {
        new Div(notes, { class: "flame-note", text: `(+${result.notes.length - 6} more — see the DevTools console)` });
        console.info("[webgpu-inspector] compile & replay notes:", result.notes);
    }

    for (const r of changed) {
        const card = new Div(panel, { class: "shader-replay-card" });
        const head = new Div(card, { class: "shader-replay-head" });
        const name = new Span(head, { class: "shader-replay-name dependency_link", text: textureName(r.texture) });
        name.element.onclick = () => onInspect?.(r.texture);
        new Span(head, { class: "shader-replay-detail", text: `${r.texture.format} ${r.texture.resolutionString ?? `${r.texture.width}x${r.texture.height}`}` });
        const pct = (100 * r.changed / r.total);
        new Span(head, { class: "shader-replay-count", text: `${r.changed.toLocaleString()} texels changed (${pct < 0.01 ? "<0.01" : pct.toFixed(2)}%)` });

        const row = new Div(card, { class: "shader-replay-images" });
        const depth = /depth|stencil/.test(r.texture.format);
        if (!depth) {
            imageCell(row, "Before", device, textureUtils, r.before, r.texture);
            imageCell(row, "After", device, textureUtils, r.after, r.texture);
        }
        const diffCell = imageCell(row, depth ? "Changed texels" : "Changed texels (highlighted)", device, textureUtils, depth ? null : r.after, r.texture);
        // The edited image, dimmed, with the changed texels lightened to red over it.
        const under = diffCell.frame.firstChild;
        if (under) {
            under.style.opacity = "0.45";
        }
        const mask = blitCanvas(device, textureUtils, r.mask, "rgba8unorm", r.texture);
        mask.style.position = "absolute";
        mask.style.left = "0";
        mask.style.top = "0";
        mask.style.mixBlendMode = "lighten";
        diffCell.frame.appendChild(mask);
        if (depth) {
            new Div(card, { class: "flame-note", text: "Depth targets show only which texels changed." });
        }
    }

    if (unchanged.length || skipped.length) {
        const list = new Div(panel, { class: "shader-replay-rest" });
        for (const r of unchanged) {
            new Div(list, { text: `${textureName(r.texture)} (${r.texture.format}): unchanged` });
        }
        for (const r of skipped) {
            new Div(list, { text: `${textureName(r.texture)} (${r.texture.format}): not compared — ${r.skipped}` });
        }
    }
    return panel;
}

function textureName(texture) {
    return texture.label ? `"${texture.label}"` : (texture.id < 0 ? "Canvas Texture" : `Texture ${texture.id}`);
}

function imageCell(parent, title, device, textureUtils, gpuTexture, texture) {
    const cell = new Div(parent, { class: "shader-replay-cell" });
    new Div(cell, { class: "shader-replay-caption", text: title });
    const frame = document.createElement("div");
    frame.className = "shader-replay-frame";
    const height = Math.round(THUMB_WIDTH * texture.height / Math.max(1, texture.width));
    frame.style.width = `${THUMB_WIDTH}px`;
    frame.style.height = `${height}px`;
    cell.element.appendChild(frame);
    if (gpuTexture) {
        frame.appendChild(blitCanvas(device, textureUtils, gpuTexture, texture.format, texture));
    }
    return { cell, frame };
}

// Draw mip 0, layer 0 of a texture into a new canvas with the panel's blit.
function blitCanvas(device, textureUtils, gpuTexture, format, texture) {
    const canvas = document.createElement("canvas");
    canvas.width = texture.width;
    canvas.height = texture.height;
    canvas.style.cssText = "width: 100%; height: 100%; display: block; image-rendering: pixelated;";
    try {
        const context = canvas.getContext("webgpu");
        const dstFormat = navigator.gpu.getPreferredCanvasFormat();
        context.configure({ device, format: dstFormat, alphaMode: "opaque" });
        const srcView = gpuTexture.createView({ dimension: "2d", baseMipLevel: 0, mipLevelCount: 1, baseArrayLayer: 0, arrayLayerCount: 1 });
        const display = { exposure: 1, channels: 0, autoRange: false, minRange: 0, maxRange: 1, zoom: 100 };
        const draw = () => textureUtils.blitTexture(srcView, format, 1, context.getCurrentTexture().createView(), dstFormat, display, "2d", 0);
        draw();
        // Redraw on export: a presented WebGPU canvas has nothing to read back.
        canvas.__exportSnapshot = draw;
    } catch (e) {
        console.error("Compile & Replay: could not display a texture:", e);
    }
    return canvas;
}
