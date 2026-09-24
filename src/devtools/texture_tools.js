import { Checkbox } from "./widget/checkbox.js";
import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";

export const HIGHLIGHT_NAN_INF = 1;
export const HIGHLIGHT_BELOW_ZERO = 2;
export const HIGHLIGHT_ABOVE_ONE = 4;

const CHANNEL_COLORS = ["#ff5a5a", "#5ad75a", "#5a9bff", "#cccccc"];
const HISTOGRAM_BINS = 128;

function formatValue(v) {
    if (!Number.isFinite(v)) {
        return String(v);
    }
    const a = Math.abs(v);
    return a !== 0 && (a < 1e-3 || a >= 1e5) ? v.toExponential(3) : String(Number(v.toPrecision(5)));
}

/**
 * Texture viewer extras shared by the Inspect and Capture texture viewers:
 * highlighting of special values (NaN and infinity by default, optionally
 * values below 0 or above 1) drawn by the display blit, a per-channel
 * histogram with counts of special values, and copying the displayed image
 * as a PNG.
 */
export class TextureTools {
    /**
     * @param {Widget} toolbar - where the controls go
     * @param {Object} options
     * @param {Object} options.display - the viewer's display settings (gets a `highlight` bitmask)
     * @param {Object} options.textureUtils
     * @param {(skipMinMax:boolean)=>void} options.rerender - redraw the viewer's image
     * @param {()=>({view:GPUTextureView, format:string, width:number, height:number})|null} options.getSource
     *   the single-mip, single-layer view the histogram reads
     * @param {Widget} options.histogramParent - where the histogram panel goes
     * @param {()=>HTMLCanvasElement|null} [options.getCanvas] - the displayed canvas, for Copy PNG
     * @param {string} [options.fileName] - for the PNG download fallback
     */
    constructor(toolbar, options) {
        this.options = options;
        const display = options.display;
        if (display.highlight === undefined) {
            display.highlight = HIGHLIGHT_NAN_INF;
        }
        const style = "margin-left: 10px; font-size: 9pt; color: #bbb;";
        const flag = (label, bit, tooltip) => new Checkbox(toolbar, {
            text: label,
            checked: (display.highlight & bit) !== 0,
            tooltip,
            style,
            onChange: (checked) => {
                display.highlight = checked ? (display.highlight | bit) : (display.highlight & ~bit);
                options.rerender(true);
            },
        });
        flag("NaN/Inf", HIGHLIGHT_NAN_INF, "Draw NaN in magenta, +Inf in orange and -Inf in cyan");
        flag("< 0", HIGHLIGHT_BELOW_ZERO, "Draw values below 0 in blue");
        flag("> 1", HIGHLIGHT_ABOVE_ONE, "Draw values above 1 in red");
        new Checkbox(toolbar, {
            text: "Histogram",
            checked: false,
            tooltip: "Per-channel histogram of the displayed mip level, with counts of special values",
            style,
            onChange: (checked) => this.setHistogramVisible(checked),
        });
        if (options.getCanvas) {
            this._copyButton = document.createElement("button");
            this._copyButton.className = "btn";
            this._copyButton.textContent = "Copy PNG";
            this._copyButton.title = "Copy the displayed image to the clipboard as a PNG";
            this._copyButton.style.marginLeft = "10px";
            this._copyButton.addEventListener("click", () => this.copyPng());
            toolbar.element.appendChild(this._copyButton);
        }

        this._histogramPanel = new Div(options.histogramParent, { class: "texture-histogram", style: "display: none;" });
        this._histogramCanvas = document.createElement("canvas");
        this._histogramCanvas.className = "texture-histogram-canvas";
        this._histogramPanel.element.appendChild(this._histogramCanvas);
        this._histogramInfo = new Div(this._histogramPanel, { class: "texture-histogram-info" });
        this._histogramVisible = false;
        this._histogramRun = 0;
    }

    setHistogramVisible(visible) {
        this._histogramVisible = visible;
        this._histogramPanel.element.style.display = visible ? "" : "none";
        if (visible) {
            this.refresh();
        }
    }

    /** Recompute the histogram (e.g. after the mip level changes), if shown. */
    async refresh() {
        if (!this._histogramVisible) {
            return;
        }
        const run = ++this._histogramRun;
        const source = this.options.getSource();
        if (!source) {
            this._histogramInfo.text = "The texture data is not available.";
            return;
        }
        this._histogramInfo.text = "Computing…";
        let result;
        try {
            result = await this.options.textureUtils.computeHistogram(source.view, source.format, source.width, source.height, HISTOGRAM_BINS);
        } catch (e) {
            if (run === this._histogramRun) {
                this._histogramInfo.text = `The histogram could not be computed: ${e.message ?? e}`;
            }
            return;
        }
        if (run !== this._histogramRun) {
            return;
        }
        this._drawHistogram(result);
    }

    _drawHistogram(result) {
        const canvas = this._histogramCanvas;
        const dpr = window.devicePixelRatio || 1;
        const cssWidth = 360;
        const cssHeight = 90;
        canvas.width = cssWidth * dpr;
        canvas.height = cssHeight * dpr;
        canvas.style.width = `${cssWidth}px`;
        canvas.style.height = `${cssHeight}px`;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#1b1b1d";
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Square-root scale: a dominant background value would otherwise
        // flatten every other bin to nothing.
        let peak = 1;
        for (const counts of result.counts) {
            for (const n of counts) {
                peak = Math.max(peak, n);
            }
        }
        const scale = Math.sqrt(peak);
        const single = result.channels === 1;
        ctx.globalCompositeOperation = "lighter";
        result.counts.forEach((counts, c) => {
            ctx.strokeStyle = single ? "#dddddd" : CHANNEL_COLORS[c];
            ctx.fillStyle = single ? "rgba(221,221,221,0.25)" : `${CHANNEL_COLORS[c]}40`;
            ctx.lineWidth = dpr;
            ctx.beginPath();
            ctx.moveTo(0, canvas.height);
            counts.forEach((n, b) => {
                const x = (b + 0.5) / result.bins * canvas.width;
                const y = canvas.height - (Math.sqrt(n) / scale) * (canvas.height - 2 * dpr);
                ctx.lineTo(x, y);
            });
            ctx.lineTo(canvas.width, canvas.height);
            ctx.fill();
            ctx.stroke();
        });
        ctx.globalCompositeOperation = "source-over";

        const names = ["R", "G", "B", "A"];
        const ranges = result.min.map((lo, c) => `${single ? "" : `${names[c]} `}${formatValue(lo)} … ${formatValue(result.max[c])}`);
        const special = [];
        if (result.nan) {
            special.push(`NaN ${result.nan.toLocaleString()}`);
        }
        if (result.posInf) {
            special.push(`+Inf ${result.posInf.toLocaleString()}`);
        }
        if (result.negInf) {
            special.push(`-Inf ${result.negInf.toLocaleString()}`);
        }
        special.push(`< 0: ${result.below0.toLocaleString()}`, `> 1: ${result.above1.toLocaleString()}`);
        this._histogramInfo.removeAllChildren();
        new Div(this._histogramInfo, { text: `Range (each channel's own, finite values): ${ranges.join(" · ")}` });
        const line = new Div(this._histogramInfo);
        new Span(line, { text: `${special.join(" · ")} of ${result.values.toLocaleString()} values`, style: result.nan || result.posInf || result.negInf ? "color: #ff7ad9;" : "" });
    }

    /**
     * Copy the displayed image as a PNG. A WebGPU canvas's drawing buffer is
     * cleared once it is presented, so the image is redrawn first and read
     * back in the same task.
     */
    async copyPng() {
        const canvas = this.options.getCanvas?.();
        if (!canvas) {
            return;
        }
        this.options.rerender(true);
        const blobPromise = new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        const blob = await blobPromise;
        if (!blob) {
            this._flash("Copy failed");
            return;
        }
        try {
            if (!navigator.clipboard?.write || typeof ClipboardItem === "undefined") {
                throw new Error("clipboard unavailable");
            }
            await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
            this._flash("Copied");
        } catch (e) {
            // The DevTools panel may not be allowed to write images to the
            // clipboard; save the file instead.
            const url = URL.createObjectURL(blob);
            const a = document.createElement("a");
            a.href = url;
            a.download = this.options.fileName ?? "texture.png";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            this._flash("Saved PNG");
        }
    }

    _flash(text) {
        if (!this._copyButton) {
            return;
        }
        const previous = "Copy PNG";
        this._copyButton.textContent = text;
        setTimeout(() => {
            this._copyButton.textContent = previous;
        }, 1500);
    }
}
