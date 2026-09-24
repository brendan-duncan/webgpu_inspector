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

const PAGE_SIZE = 100;
const COLOR_NONE = "None";

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

/**
 * The Mesh view (VS In) for one draw: a 3D preview of its input geometry and
 * a table of every vertex it fetches, in draw order. Selecting a row marks
 * the vertex in the preview; clicking the preview selects the nearest vertex's
 * row.
 *
 * @param {Object} options
 * @param {GPUDevice} [options.device] - for the 3D preview
 * @param {Object} options.command - the draw command
 * @param {string} options.label - e.g. 'Pass 2 drawIndexed #5'
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
        this.positionIndex = -1;
        this.colorIndex = -1;
        this.selected = -1;
        this.page = 0;

        this.panel = new Div(null, { class: "mesh-view" });
        this.panel.onDestroy = () => this.preview?.destroy();

        this.mesh = this._build();
        this.positionIndex = guessPositionAttribute(this.mesh.attributes);

        const toolbar = new Div(this.panel, { class: "mesh-toolbar" });
        this.summary = new Span(toolbar, { class: "mesh-summary" });
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
        const names = this.mesh.attributes.map((a) => `${a.name} (${a.format})`);
        new Span(toolbar, { class: "mesh-label", text: "Position" });
        new Select(toolbar, {
            options: names.length ? names : ["(no attributes)"],
            index: Math.max(0, this.positionIndex),
            style: "width: 180px;",
            onChange: (value, index) => {
                this.positionIndex = index;
                this._updateGeometry(false);
            },
        });
        new Span(toolbar, { class: "mesh-label", text: "Color" });
        new Select(toolbar, {
            options: [COLOR_NONE, ...names],
            index: 0,
            style: "width: 180px;",
            onChange: (value, index) => {
                this.colorIndex = index - 1;
                this.preview?.setColors(this._colors());
            },
        });
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
                this.preview.onPick = (index) => this._select(index, true);
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

    _setInstance(instance) {
        if (instance === this.instance) {
            return;
        }
        this.instance = instance;
        this.mesh = this._build();
        this._updateGeometry(true);
        this._renderTable();
    }

    _colors() {
        return attributeColors(this.mesh, this.colorIndex);
    }

    _updateGeometry(keepCamera) {
        const mesh = this.mesh;
        const { positions, valid, invalid, min, max } = attributePositions(mesh, this.positionIndex);
        const { triangles, lines } = assemblePrimitives(mesh);
        const validTriangles = filterPrimitives(triangles, 3, valid);
        const validLines = filterPrimitives(lines, 2, valid);

        const unique = new Set();
        for (const v of mesh.vertexIndices) {
            if (v >= 0) {
                unique.add(v);
            }
        }
        const parts = [
            `${mesh.count.toLocaleString()} vertices fetched (${unique.size.toLocaleString()} unique)`,
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

        this.notes.removeAllChildren();
        const notes = [...mesh.warnings];
        if (invalid) {
            notes.push(`${invalid.toLocaleString()} vertices have no usable position (NaN, infinite or not captured) and are left out of the preview.`);
        }
        if (mesh.attributes.some((a) => a.stepMode === "instance")) {
            notes.push(`Instance-stepped attributes show instance ${this.instance}.`);
        }
        notes.push("Positions are the vertex shader's inputs, before the vertex shader runs.");
        for (const note of notes) {
            new Div(this.notes, { class: "flame-note", text: note });
        }

        this.preview?.setGeometry({ positions, colors: this._colors(), valid, triangles: validTriangles, lines: validLines, min, max }, keepCamera);
        if (this.selected >= 0) {
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
            th(attr.name, `location ${attr.location}, ${attr.format}, slot ${attr.slot}${attr.stepMode === "instance" ? ", per instance" : ""}`);
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
