import { Button } from "./widget/button.js";
import { Div } from "./widget/div.js";
import { NumberInput } from "./widget/number_input.js";
import { Select } from "./widget/select.js";
import { Span } from "./widget/span.js";
import {
    assemblePrimitives,
    attributeColors,
    attributePositions,
    buildMeshInput,
    filterPrimitives,
    guessPositionAttribute,
} from "./mesh_input.js";
import { MESH_MODES, MeshPreview } from "./mesh_preview.js";
import { clipStats, runVsOut } from "./vs_out.js";

const PAGE_SIZE = 100;
const COLOR_NONE = "None";
const STAGE_IN = "VS In";
const STAGE_OUT = "VS Out";

function formatNumber(v, format) {
    if (!Number.isFinite(v)) {
        return Number.isNaN(v) ? "—" : String(v);
    }
    if (/^(u|s)int/.test(format)) {
        return String(v);
    }
    const a = Math.abs(v);
    if (a !== 0 && (a < 1e-4 || a >= 1e6)) {
        return v.toExponential(3);
    }
    return String(Number(v.toPrecision(5)));
}

// The eight corners and twelve edges of the clip-space view volume in NDC:
// x and y in [-1, 1], z in [0, 1].
const BOX_CORNERS = [
    [-1, -1, 0], [1, -1, 0], [1, 1, 0], [-1, 1, 0],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];
const BOX_EDGES = [0, 1, 1, 2, 2, 3, 3, 0, 4, 5, 5, 6, 6, 7, 7, 4, 0, 4, 1, 5, 2, 6, 3, 7];

/**
 * The Mesh view for one draw: a 3D preview and a table of every vertex the
 * draw fetches, in draw order. "VS In" shows the vertex shader's inputs,
 * decoded from the captured vertex buffers; "VS Out" runs the vertex shader
 * by GPU replay (vs_out.js) and shows its outputs, with the preview in
 * normalized device coordinates inside the view volume. Selecting a row marks
 * the vertex in the preview; clicking the preview selects the nearest row.
 *
 * @param {Object} options
 * @param {GPUDevice} [options.device] - for the preview and VS Out
 * @param {Object} [options.database] - for VS Out
 * @param {Object[]} [options.passCommands] - the draw's pass, for VS Out
 * @param {Object} options.command - the draw command
 * @param {string} options.label
 * @param {Object} options.pipelineDesc
 * @param {Object[]} [options.shaderInputs]
 * @param {Object[]} options.vertexBufferCommands - setVertexBuffer commands by slot
 * @param {Object} [options.indexBufferCommand]
 * @param {(command:Object)=>void} [options.onShowCommand]
 * @returns {Div}
 */
export function buildMeshView(options) {
    return new MeshView(options).panel;
}

class MeshView {
    constructor(options) {
        this.options = options;
        this.instance = 0;
        this.stage = STAGE_IN;
        this.positionIndex = -1;
        this.colorIndex = -1;
        this.selected = -1;
        this.page = 0;
        this.outMesh = null;

        this.panel = new Div(null, { class: "mesh-view" });
        this.panel.onDestroy = () => this.preview?.destroy();

        this.inMesh = this._build();
        this.mesh = this.inMesh;
        this.positionIndex = guessPositionAttribute(this.mesh.attributes);

        const toolbar = new Div(this.panel, { class: "mesh-toolbar" });
        this.summary = new Span(toolbar, { class: "mesh-summary" });
        if (options.device && options.database) {
            new Span(toolbar, { class: "mesh-label", text: "Stage" });
            this.stageSelect = new Select(toolbar, {
                options: [STAGE_IN, STAGE_OUT],
                index: 0,
                style: "width: 80px;",
                onChange: (value) => this._setStage(value),
            });
        }
        const instances = this.mesh.drawArgs?.instanceCount ?? 1;
        if (instances > 1) {
            new Span(toolbar, { class: "mesh-label", text: "Instance" });
            new NumberInput(toolbar, {
                value: 0, min: 0, max: instances - 1, step: 1, precision: 0,
                style: "width: 60px; display: inline-block;",
                onChange: (value) => this._setInstance(Math.round(value)),
            });
            new Span(toolbar, { text: `/ ${instances}` });
        }
        new Span(toolbar, { class: "mesh-label", text: "Position" });
        this.positionSelect = new Select(toolbar, {
            style: "width: 200px;",
            onChange: (value, index) => {
                this.positionIndex = index;
                this._updateGeometry(false);
            },
        });
        new Span(toolbar, { class: "mesh-label", text: "Color" });
        this.colorSelect = new Select(toolbar, {
            style: "width: 200px;",
            onChange: (value, index) => {
                this.colorIndex = index - 1;
                this.preview?.setColors(this._colors());
            },
        });
        this._refreshAttributeSelects();
        new Span(toolbar, { class: "mesh-label", text: "Mode" });
        new Select(toolbar, {
            options: MESH_MODES,
            index: 0,
            style: "width: 150px;",
            onChange: (value) => this.preview?.setMode(value),
        });
        new Button(toolbar, { label: "Reset camera", class: "btn", callback: () => this.preview?.resetCamera() });
        if (options.onShowCommand) {
            new Button(toolbar, { label: "Go to draw", class: "btn", callback: () => options.onShowCommand(options.command) });
        }

        this.notes = new Div(this.panel, { class: "mesh-notes" });

        const content = new Div(this.panel, { class: "mesh-content" });
        const previewPane = new Div(content, { class: "mesh-preview" });
        const tablePane = new Div(content, { class: "mesh-table-pane" });
        this.pager = new Div(tablePane, { class: "mesh-pager" });
        this.table = new Div(tablePane, { class: "mesh-table-scroll" });

        if (options.device) {
            try {
                this.preview = new MeshPreview(previewPane.element, options.device);
                this.preview.onPick = (index) => this._select(index < this.mesh.count ? index : -1, true);
                new Div(previewPane, { class: "mesh-hint", text: "Drag to orbit, right-drag to pan, wheel to zoom, click to pick a vertex." });
            } catch (e) {
                console.error(e);
                new Div(previewPane, { class: "flame-empty", text: `The 3D preview is unavailable: ${e.message ?? e}` });
            }
        } else {
            new Div(previewPane, { class: "flame-empty", text: "The 3D preview needs the DevTools GPU device, which is not available." });
        }

        this._updateGeometry(false);
        this._renderTable();
    }

    _build() {
        const o = this.options;
        return buildMeshInput({
            command: o.command,
            pipelineDesc: o.pipelineDesc,
            shaderInputs: o.shaderInputs,
            vertexBufferCommands: o.vertexBufferCommands,
            indexBufferCommand: o.indexBufferCommand,
            instance: this.instance,
        });
    }

    _refreshAttributeSelects() {
        const names = this.mesh.attributes.map((a) => a.format ? `${a.name} (${a.format})` : a.name);
        const fill = (select, options, index) => {
            select.select.element.innerHTML = "";
            for (const option of options) {
                select.addOption(option);
            }
            select.index = index;
        };
        fill(this.positionSelect, names.length ? names : ["(no attributes)"], Math.max(0, this.positionIndex));
        fill(this.colorSelect, [COLOR_NONE, ...names], this.colorIndex + 1);
    }

    async _setStage(stage) {
        if (stage === this.stage) {
            return;
        }
        if (stage === STAGE_OUT && !this.outMesh) {
            this._showNotes([`Running the vertex shader for ${this.inMesh.count.toLocaleString()} vertices on the GPU…`]);
            try {
                this.outMesh = await this._computeOut();
            } catch (e) {
                console.warn("VS Out failed:", e);
                this.stageSelect.index = 0;
                this._showNotes([`VS Out failed: ${e.message ?? e}`, ...this.inMesh.warnings]);
                return;
            }
        }
        this.stage = stage;
        this.mesh = stage === STAGE_OUT ? this.outMesh : this.inMesh;
        this.positionIndex = stage === STAGE_OUT ? this.mesh.ndcIndex : guessPositionAttribute(this.mesh.attributes);
        this.colorIndex = -1;
        this._refreshAttributeSelects();
        this._updateGeometry(false);
        this._renderTable();
    }

    async _computeOut() {
        const o = this.options;
        const out = await runVsOut({
            device: o.device,
            database: o.database,
            command: o.command,
            passCommands: o.passCommands,
            pipelineDesc: o.pipelineDesc,
            mesh: this.inMesh,
            instance: this.instance,
        });
        // Add NDC (position / w) as a derived attribute: the preview's position.
        if (out.clipIndex >= 0) {
            const clip = out.values[out.clipIndex];
            const ndc = new Float64Array(out.count * 3);
            for (let i = 0; i < out.count; ++i) {
                const w = clip[i * 4 + 3];
                for (let c = 0; c < 3; ++c) {
                    ndc[i * 3 + c] = w > 0 ? clip[i * 4 + c] / w : NaN;
                }
            }
            out.attributes.push({ name: "NDC (position / w)", format: "", components: 3, location: -1, derived: true });
            out.values.push(ndc);
            out.ndcIndex = out.attributes.length - 1;
        } else {
            out.ndcIndex = -1;
            out.warnings.push("The vertex shader has no @builtin(position) output.");
        }
        return out;
    }

    async _setInstance(instance) {
        if (instance === this.instance) {
            return;
        }
        this.instance = instance;
        this.inMesh = this._build();
        this.outMesh = null;
        if (this.stage === STAGE_OUT) {
            this.stage = STAGE_IN;
            this.mesh = this.inMesh;
            await this._setStage(STAGE_OUT);
            return;
        }
        this.mesh = this.inMesh;
        this._updateGeometry(true);
        this._renderTable();
    }

    _colors() {
        return attributeColors(this.mesh, this.colorIndex);
    }

    _showNotes(notes) {
        this.notes.removeAllChildren();
        for (const note of notes) {
            new Div(this.notes, { class: "flame-note", text: note });
        }
    }

    _updateGeometry(keepCamera) {
        const mesh = this.mesh;
        let { positions, valid, invalid, min, max } = attributePositions(mesh, this.positionIndex);
        const { triangles, lines } = assemblePrimitives(mesh);
        const validTriangles = filterPrimitives(triangles, 3, valid);
        let validLines = filterPrimitives(lines, 2, valid);
        let colors = this._colors();

        const unique = new Set();
        for (const v of mesh.vertexIndices) {
            if (v >= 0) {
                unique.add(v);
            }
        }
        const parts = [
            `${this.stage}: ${mesh.count.toLocaleString()} vertices (${unique.size.toLocaleString()} unique)`,
            mesh.topology,
        ];
        if (validTriangles.length) {
            parts.push(`${(validTriangles.length / 3).toLocaleString()} triangles`);
        } else if (validLines.length) {
            parts.push(`${(validLines.length / 2).toLocaleString()} lines`);
        }
        if (mesh.drawArgs?.instanceCount > 1) {
            parts.push(`${mesh.drawArgs.instanceCount} instances`);
        }
        this.summary.text = parts.join(" · ");

        const notes = [...mesh.warnings];
        if (this.stage === STAGE_OUT) {
            if (mesh.clipIndex >= 0) {
                const s = clipStats(mesh.values[mesh.clipIndex], mesh.vertexIndices, triangles);
                const n = (v) => v.toLocaleString();
                notes.push(`${n(s.outside)} vertices lie outside the view volume, ${n(s.behind)} behind the eye (w ≤ 0), ${n(s.nan)} NaN; ` +
                    `${n(s.culledTriangles)} triangles are entirely off-screen and ${n(s.zeroArea)} have zero area.`);
            }
            if (this.positionIndex === mesh.ndcIndex) {
                notes.push("The preview shows normalized device coordinates (position / w) inside the view volume box; vertices behind the eye are left out.");
            }
            notes.push(`Outputs come from running the vertex shader on the DevTools device over the captured inputs${mesh.drawArgs?.instanceCount > 1 ? ` for instance ${this.instance}` : ""}.`);
        } else {
            if (mesh.attributes.some((a) => a.stepMode === "instance")) {
                notes.push(`Instance-stepped attributes show instance ${this.instance}.`);
            }
            notes.push("Positions are the vertex shader's inputs, before the vertex shader runs.");
        }
        if (invalid) {
            notes.push(`${invalid.toLocaleString()} vertices have no usable position (NaN, infinite, behind the eye, or not captured) and are left out of the preview.`);
        }
        this._showNotes(notes);

        // In NDC, frame the geometry with the view volume.
        if (this.stage === STAGE_OUT && this.positionIndex === mesh.ndcIndex) {
            const base = mesh.count;
            const boxPositions = new Float32Array(positions.length + 24);
            boxPositions.set(positions);
            boxPositions.set(BOX_CORNERS.flat(), positions.length);
            const boxColors = new Float32Array(colors.length + 24);
            boxColors.set(colors);
            boxColors.fill(0.5, colors.length);
            const boxValid = new Uint8Array(valid.length + 8);
            boxValid.set(valid);
            boxValid.fill(1, valid.length);
            const boxLines = new Uint32Array(validLines.length + BOX_EDGES.length);
            boxLines.set(validLines);
            boxLines.set(BOX_EDGES.map((e) => e + base), validLines.length);
            positions = boxPositions;
            colors = boxColors;
            valid = boxValid;
            validLines = boxLines;
            min = [Math.min(min[0], -1), Math.min(min[1], -1), Math.min(min[2], 0)];
            max = [Math.max(max[0], 1), Math.max(max[1], 1), Math.max(max[2], 1)];
        }
        this.preview?.setGeometry({ positions, colors, valid, triangles: validTriangles, lines: validLines, min, max }, keepCamera);
        if (this.selected >= 0 && this.selected < mesh.count) {
            this.preview?.setHighlight(this.selected);
        }
    }

    _select(index, fromPreview) {
        this.selected = index;
        if (index >= 0) {
            this.page = Math.floor(index / PAGE_SIZE);
        }
        if (!fromPreview) {
            this.preview?.setHighlight(index);
        }
        this._renderTable();
        if (index >= 0) {
            this.table.element.querySelector(".mesh-row-selected")?.scrollIntoView({ block: "center" });
        }
    }

    _renderTable() {
        const mesh = this.mesh;
        const pages = Math.max(1, Math.ceil(mesh.count / PAGE_SIZE));
        this.page = Math.max(0, Math.min(pages - 1, this.page));
        const start = this.page * PAGE_SIZE;
        const end = Math.min(mesh.count, start + PAGE_SIZE);

        this.pager.removeAllChildren();
        new Button(this.pager, { label: "‹", class: "btn", callback: () => { this.page--; this._renderTable(); } });
        new Span(this.pager, { text: mesh.count ? `Rows ${start.toLocaleString()}–${(end - 1).toLocaleString()} of ${mesh.count.toLocaleString()}` : "No vertices" });
        new Button(this.pager, { label: "›", class: "btn", callback: () => { this.page++; this._renderTable(); } });

        this.table.removeAllChildren();
        const table = document.createElement("table");
        table.className = "mesh-table";
        const head = table.createTHead().insertRow();
        const th = (text, title) => {
            const cell = document.createElement("th");
            cell.textContent = text;
            if (title) {
                cell.title = title;
            }
            head.appendChild(cell);
        };
        th("#", "Element index in the draw");
        th("VTX", "Vertex index fetched (after baseVertex)");
        for (const attr of mesh.attributes) {
            const title = attr.derived ? "Derived from the position output"
                : attr.slot === -1 ? (attr.builtin ? `@builtin(${attr.builtin})` : `@location(${attr.location})`)
                : `location ${attr.location}, ${attr.format}, slot ${attr.slot}${attr.stepMode === "instance" ? ", per instance" : ""}`;
            th(attr.name, title);
        }
        const body = table.createTBody();
        for (let i = start; i < end; ++i) {
            const row = body.insertRow();
            if (i === this.selected) {
                row.className = "mesh-row-selected";
            }
            row.insertCell().textContent = String(i);
            const vertex = mesh.vertexIndices[i];
            row.insertCell().textContent = vertex === -1 ? "restart" : vertex === -2 ? "?" : String(vertex);
            mesh.attributes.forEach((attr, a) => {
                const n = attr.components;
                const values = [];
                for (let c = 0; c < n; ++c) {
                    values.push(formatNumber(mesh.values[a][i * n + c], attr.format));
                }
                row.insertCell().textContent = values.join(", ");
            });
            row.addEventListener("click", () => this._select(i, false));
        }
        this.table.element.appendChild(table);
    }
}
