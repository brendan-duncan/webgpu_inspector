import { Button } from "./widget/button.js";
import { Checkbox } from "./widget/checkbox.js";
import { Div } from "./widget/div.js";
import { Select } from "./widget/select.js";
import { Span } from "./widget/span.js";
import { formatBytes } from "../utils/format.js";
import { baselineId, groupLeaks, groupLiveObjects } from "./allocations.js";

const TYPES = ["All", "Buffer", "Texture", "TextureView", "BindGroup", "Sampler", "ShaderModule",
    "RenderPipeline", "ComputePipeline", "BindGroupLayout", "PipelineLayout", "RenderBundle"];
const MAX_GROUPS = 200;
const MAX_OBJECTS = 100;
const REFRESH_MS = 2000;

/**
 * The Allocations tab of the Inspect panel: live GPU objects grouped by the
 * code that created them, with a baseline for "what has been created since",
 * and the buffers, textures and devices the page let the garbage collector
 * take without calling destroy().
 *
 * @param {Object} params
 * @param {Object} params.database
 * @param {(object:Object)=>void} params.onInspect
 * @returns {Div}
 */
export function buildAllocationsView({ database, onInspect }) {
    return new AllocationsView(database, onInspect).panel;
}

class AllocationsView {
    constructor(database, onInspect) {
        this.database = database;
        this.onInspect = onInspect;
        this.type = null;
        this.baseline = null;
        this.sinceBaseline = false;
        this.expanded = new Set();

        this.panel = new Div(null, { class: "allocations" });
        const toolbar = new Div(this.panel, { class: "allocations-toolbar" });
        new Span(toolbar, { class: "mesh-label", text: "Type" });
        new Select(toolbar, {
            options: TYPES,
            index: 0,
            style: "width: 150px;",
            onChange: (value) => {
                this.type = value === "All" ? null : value;
                this.refresh();
            },
        });
        const mark = new Button(toolbar, {
            label: "Mark Baseline",
            class: "btn",
            title: "Remember the objects alive now; with Since baseline checked, only objects created after this are listed",
            callback: () => {
                this.baseline = baselineId(this.database.allObjects.values());
                this.baselineTime = performance.now();
                this.sinceCheckbox.input.disabled = false;
                if (!this.sinceBaseline) {
                    this.sinceCheckbox.checked = true;
                    this.sinceBaseline = true;
                }
                this.refresh();
            },
        });
        mark.element.style.marginLeft = "10px";
        this.sinceCheckbox = new Checkbox(toolbar, {
            text: "Since baseline",
            checked: false,
            style: "margin-left: 10px;",
            tooltip: "Only objects created after Mark Baseline that are still alive: what a leak keeps adding",
            onChange: (checked) => {
                this.sinceBaseline = checked;
                this.refresh();
            },
        });
        this.sinceCheckbox.input.disabled = true;
        new Button(toolbar, { label: "Refresh", class: "btn", style: "margin-left: 10px;", callback: () => this.refresh() });

        this.summary = new Div(this.panel, { class: "allocations-summary" });
        this.hint = new Div(this.panel, { class: "flame-note allocations-hint" });
        this.liveTable = new Div(this.panel, { class: "allocations-section" });
        this.leakHeading = new Div(this.panel, { class: "render-graph-heading allocations-heading" });
        this.leakNote = new Div(this.panel, { class: "allocations-hint flame-note" });
        this.leakTable = new Div(this.panel, { class: "allocations-section" });

        // Refresh while visible; the view is cheap next to the list it summarizes,
        // but there's no reason to regroup tens of thousands of objects offscreen.
        this._timer = setInterval(() => {
            if (this.panel.element.offsetParent !== null) {
                this.refresh();
            }
        }, REFRESH_MS);
        this.panel.onDestroy = () => clearInterval(this._timer);
        this.refresh();
    }

    refresh() {
        const sinceId = this.sinceBaseline && this.baseline !== null ? this.baseline : undefined;
        const live = groupLiveObjects(this.database.allObjects.values(), { type: this.type, sinceId });
        const what = this.type ? `${this.type} objects` : "objects";
        const since = sinceId !== undefined
            ? ` created since the baseline (${((performance.now() - this.baselineTime) / 1000).toFixed(0)} s ago)`
            : "";
        this.summary.text = `${live.count.toLocaleString()} live ${what}${since}, ${formatBytes(live.bytes)} of buffers and textures, from ${live.groups.length.toLocaleString()} creation site${live.groups.length === 1 ? "" : "s"}.`;
        this.hint.text = live.count && live.withStack < live.count
            ? "Objects without a stack trace are grouped by label. Turn on Object Stacktraces (and restart inspection) to group every object by the line of code that created it."
            : "";
        this.hint.element.style.display = this.hint.text ? "" : "none";
        this._renderLive(live.groups);

        const leaks = groupLeaks(this.database.leakedObjects, { type: this.type });
        const leakCount = leaks.reduce((n, g) => n + g.count, 0);
        this.leakHeading.text = `Garbage collected without destroy() (${leakCount.toLocaleString()})`;
        this.leakNote.text = leakCount
            ? "Buffers, textures and devices the page dropped without calling destroy(). The GPU memory is only freed when the garbage collector gets to them, which can be much later."
            : "None so far. Buffers, textures and devices that are garbage collected without destroy() are listed here.";
        this._renderLeaks(leaks);
    }

    _table(parent, headers) {
        parent.removeAllChildren();
        const table = document.createElement("table");
        table.className = "mesh-table allocations-table";
        const head = table.createTHead().insertRow();
        for (const h of headers) {
            const th = document.createElement("th");
            th.textContent = h;
            head.appendChild(th);
        }
        parent.element.appendChild(table);
        return table.createTBody();
    }

    _renderLive(groups) {
        const body = this._table(this.liveTable, ["Type", "Created at", "Live", "Memory"]);
        for (const group of groups.slice(0, MAX_GROUPS)) {
            const row = body.insertRow();
            row.className = "allocations-group";
            const open = this.expanded.has(group.key);
            row.insertCell().textContent = `${open ? "▾" : "▸"} ${group.type}`;
            const site = row.insertCell();
            site.textContent = group.site;
            site.title = group.site;
            row.insertCell().textContent = group.count.toLocaleString();
            row.insertCell().textContent = group.bytes ? formatBytes(group.bytes) : "";
            row.addEventListener("click", () => {
                if (open) {
                    this.expanded.delete(group.key);
                } else {
                    this.expanded.add(group.key);
                }
                this.refresh();
            });
            if (!open) {
                continue;
            }
            for (const object of group.objects.slice(0, MAX_OBJECTS)) {
                const item = body.insertRow();
                item.className = "allocations-object";
                item.insertCell();
                const name = item.insertCell();
                name.colSpan = 3;
                name.textContent = `${object.label ? `"${object.label}" ` : ""}${group.type} ${object.idName ?? object.id}`;
                name.title = "Inspect";
                item.addEventListener("click", () => this.onInspect?.(object));
            }
            if (group.objects.length > MAX_OBJECTS) {
                const more = body.insertRow();
                more.insertCell();
                const cell = more.insertCell();
                cell.colSpan = 3;
                cell.textContent = `… ${group.objects.length - MAX_OBJECTS} more`;
            }
        }
        if (groups.length > MAX_GROUPS) {
            const more = body.insertRow();
            const cell = more.insertCell();
            cell.colSpan = 4;
            cell.textContent = `… ${groups.length - MAX_GROUPS} more creation sites`;
        }
    }

    _renderLeaks(groups) {
        if (!groups.length) {
            this.leakTable.removeAllChildren();
            return;
        }
        const body = this._table(this.leakTable, ["Type", "Created at", "Count", "Memory", "Last"]);
        const now = performance.now();
        for (const group of groups.slice(0, MAX_GROUPS)) {
            const row = body.insertRow();
            row.insertCell().textContent = group.type;
            const site = row.insertCell();
            site.textContent = group.site;
            site.title = group.site;
            row.insertCell().textContent = group.count.toLocaleString();
            row.insertCell().textContent = group.bytes ? formatBytes(group.bytes) : "";
            row.insertCell().textContent = `${((now - group.lastTime) / 1000).toFixed(0)} s ago`;
        }
    }
}
