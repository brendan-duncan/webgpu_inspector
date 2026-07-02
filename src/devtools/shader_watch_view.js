import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { TreeWidget } from "./widget/tree_widget.js";
import { PointerData, TypedData, ScalarData, VectorData, MatrixData, TextureData, SamplerData,
    StructInfo, ArrayInfo, ArrayIndex, StringExpr } from "wgsl_reflect/wgsl_reflect.module.js";

// ---------------------------------------------------------------------------
// Value formatting
// ---------------------------------------------------------------------------

// Format a number to ~5 significant digits without trailing zero noise.
// (0.3670309782028198 -> 0.36703). Integers pass through unchanged.
export function formatNumber(n) {
    if (n === null || n === undefined) {
        return "?";
    }
    if (Number.isInteger(n)) {
        return `${n}`;
    }
    return `${parseFloat(n.toPrecision(5))}`;
}

function _formatNumbers(values) {
    return Array.from(values).map(formatNumber).join(", ");
}

// The column count of a matrix type name ("mat4x3f" -> [4 cols, 3 rows]).
function _matrixDims(typeName) {
    const m = /^mat(\d)x(\d)/.exec(typeName);
    return m ? [parseInt(m[1], 10), parseInt(m[2], 10)] : null;
}

function _isMatrixTypeInfo(typeInfo) {
    return !!typeInfo && typeInfo.getTypeName().startsWith("mat");
}

// The flat numeric values of a matrix Data (MatrixData or buffer-backed
// TypedData), or null.
function _matrixValues(data) {
    if (data instanceof MatrixData) {
        return Array.from(data.data);
    }
    if (data instanceof TypedData && data.toArray) {
        const a = data.toArray();
        return Array.isArray(a) ? a : null;
    }
    return null;
}

function _clamp01(v) {
    return v >= 0 && v <= 1;
}

// Produce the display form of a Data value:
//   { text, title, swatch } — text is the short human-friendly value, title is
// the full-precision fallback for hover, swatch is a css color when the value
// looks like a color.
export function formatDataValue(data, exec, context, depth = 0) {
    if (data === null || data === undefined) {
        return { text: "null", title: "null" };
    }

    if (data instanceof PointerData) {
        const inner = formatDataValue(data.reference, exec, context, depth);
        return { text: `&${inner.text}`, title: `&${inner.title}`, swatch: inner.swatch };
    }

    if (data instanceof ScalarData) {
        return { text: formatNumber(data.value), title: `${data.value}` };
    }

    if (data instanceof VectorData) {
        const values = Array.from(data.data);
        const result = { text: _formatNumbers(values), title: values.join(", ") };
        // A float vec3/vec4 with every component in [0, 1] is very likely a
        // color while fragment debugging; show a swatch.
        const tn = data.typeInfo.getTypeName();
        if ((tn === "vec3f" || tn === "vec4f" || tn === "vec3" || tn === "vec4") &&
            values.length >= 3 && values.every(_clamp01)) {
            const c = values.map((v) => Math.round(v * 255));
            result.swatch = `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${values.length > 3 ? values[3] : 1})`;
        }
        return result;
    }

    if (data instanceof TextureData) {
        const desc = data.descriptor ?? {};
        const size = desc.size;
        const dims = Array.isArray(size) ? size.join("×")
            : size ? [size.width, size.height].filter((v) => v !== undefined).join("×")
            : "";
        const text = [desc.format, dims].filter(Boolean).join(" ") || "<texture>";
        return { text, title: text };
    }

    if (data instanceof SamplerData) {
        const desc = data.descriptor ?? {};
        const parts = [];
        for (const key of ["magFilter", "minFilter", "mipmapFilter", "addressModeU", "addressModeV", "compare"]) {
            if (desc[key] !== undefined) {
                parts.push(`${key.replace(/^addressMode/, "address")}: ${desc[key]}`);
            }
        }
        const text = parts.length ? parts.join(", ") : "default sampler";
        return { text, title: text };
    }

    // Matrices: show the columns. (Their default toString is either a wall of
    // 16 full-precision numbers or "[...]" for buffer-backed data.)
    if (data instanceof MatrixData || (data instanceof TypedData && _isMatrixTypeInfo(data.typeInfo))) {
        const values = _matrixValues(data);
        const dims = _matrixDims(data.typeInfo.getTypeName());
        if (values && dims) {
            const [cols, rows] = dims;
            const colStrs = [];
            for (let c = 0; c < cols; ++c) {
                colStrs.push(`[${_formatNumbers(values.slice(c * rows, (c + 1) * rows))}]`);
            }
            return { text: colStrs.join(" "), title: values.join(", ") };
        }
    }

    if (data instanceof TypedData && data.typeInfo instanceof ArrayInfo) {
        const count = data.typeInfo.count ||
            ((data.buffer.byteLength - data.offset) / data.typeInfo.stride);
        return { text: `[${count} elements]`, title: `[${count} elements]` };
    }

    // Structs: an inline preview of the first few members.
    if (data instanceof TypedData && data.typeInfo instanceof StructInfo && exec && depth < 2) {
        const parts = [];
        const members = data.typeInfo.members;
        for (let i = 0; i < members.length && i < 4 && parts.join(", ").length < 50; ++i) {
            let text = "…";
            try {
                const sub = data.getSubData(exec, new StringExpr(members[i].name), context);
                if (sub instanceof TypedData && sub.typeInfo instanceof StructInfo) {
                    text = "{…}";
                } else {
                    const v = formatDataValue(sub, exec, context, depth + 1);
                    text = v.text.includes(",") ? `[${v.text}]` : v.text;
                }
            } catch (e) {
                text = "?";
            }
            parts.push(`${members[i].name}: ${text}`);
        }
        if (parts.length < members.length) {
            parts.push("…");
        }
        const text = `{${parts.join(", ")}}`;
        return { text, title: text };
    }

    const s = data.toString();
    return { text: s, title: s };
}

// ---------------------------------------------------------------------------
// Variable path resolution ("material.alphaCutoff", "lights[2].color.rgb")
// ---------------------------------------------------------------------------

// Parse a dotted/indexed variable path into { root, segments } where segments
// are member names (including swizzles) and literal array indices. Returns
// null if the path has non-literal indices or doesn't parse.
export function parseVariablePath(path) {
    const rootMatch = /^\s*([A-Za-z_]\w*)/.exec(path);
    if (!rootMatch) {
        return null;
    }
    const segments = [];
    let rest = path.slice(rootMatch[0].length);
    while (rest.length) {
        let m = /^\.([A-Za-z_]\w*)/.exec(rest);
        if (m) {
            segments.push({ member: m[1] });
            rest = rest.slice(m[0].length);
            continue;
        }
        m = /^\[\s*(\d+)\s*\]/.exec(rest);
        if (m) {
            segments.push({ index: parseInt(m[1], 10) });
            rest = rest.slice(m[0].length);
            continue;
        }
        return null; // expression index or trailing junk
    }
    return { root: rootMatch[1], segments };
}

// Resolve a variable path against the current execution context. Returns the
// Data value, or null if the root isn't in scope or a segment can't resolve.
export function resolveVariablePath(exec, context, path) {
    const parsed = parseVariablePath(path);
    if (!parsed) {
        return null;
    }
    const v = context.getVariable(parsed.root);
    let data = v?.value ?? null;
    for (const seg of parsed.segments) {
        if (data === null || data === undefined || !data.getSubData) {
            return null;
        }
        try {
            const postfix = seg.member !== undefined ? new StringExpr(seg.member) : new ArrayIndex(seg.index);
            data = data.getSubData(exec, postfix, context);
        } catch (e) {
            return null;
        }
    }
    return data ?? null;
}

// ---------------------------------------------------------------------------
// The Variables panel
// ---------------------------------------------------------------------------

export class ShaderWatchView extends Div {
    constructor(parent, options) {
        super(parent, options);
        this.treeWidgets = [];
        this.filter = "";
        this._exec = null;
        this._context = null;
        // Snapshots of variable values used to highlight values that changed
        // between debugger steps.
        this._previousValues = new Map();
        this._currentValues = new Map();
        this._rowCount = 0;
        // Paths pinned to the Watch section via the context menu. Kept across
        // debug restarts so a pinned member survives pressing Restart.
        this._pinned = new Set();
    }

    // Clear any change-highlighting state and filtering. Called when a new
    // debug session is started.
    reset() {
        this.filter = "";
        this._previousValues = new Map();
        this._currentValues = new Map();
    }

    // Snapshot the currently displayed values as the baseline to compare
    // against. Called right before the debugger advances a step, so the next
    // render can highlight which values changed.
    commitValues() {
        this._previousValues = this._currentValues;
    }

    // Set the variable name filter and re-render the current state.
    setFilter(filter) {
        this.filter = (filter || "").toLowerCase();
        this.refresh();
    }

    update(exec, context) {
        this._exec = exec;
        this._context = context;
        this._render();
    }

    // Re-render using the last exec/context, without advancing the debugger
    // state. Used when only the filter changed.
    refresh() {
        if (this._context === null || this._context === undefined) {
            return;
        }
        this._render();
    }

    _render() {
        const previousData = [];
        for (const treeWidget of this.treeWidgets) {
            previousData.push(treeWidget.data);
        }

        this.treeWidgets.length = 0;
        this.removeAllChildren();

        this._currentValues = new Map();
        this._rowCount = 0;

        // The context is null once execution has finished (e.g. the fragment
        // quad's target lane stepped past its last statement).
        if (this._context === null || this._context === undefined) {
            new Div(this, { class: "watch-empty", text: "Not running" });
            return;
        }

        this._buildGroups(this._exec, this._context);

        // Restore each group's expansion state from the previous render.
        for (const data of previousData) {
            for (const treeWidget of this.treeWidgets) {
                if (treeWidget.data.id === data.id) {
                    if (data.collapsed) {
                        treeWidget.collapseItem(data.id);
                    } else {
                        treeWidget.expandItem(data.id);
                    }
                    if (!data.collapsed) {
                        this._expandChildren(treeWidget, data);
                    }
                }
            }
        }

        if (this._rowCount === 0) {
            const message = this.filter
                ? `No variables match "${this.filter}"`
                : "No variables in scope";
            new Div(this, { class: "watch-empty", text: message });
        }
    }

    _expandChildren(treeWidget, data) {
        for (const child of data.children) {
            if (!child.collapsed) {
                treeWidget.expandItem(child.id);
                this._expandChildren(treeWidget, child);
            }
        }
    }

    // Build the panel's groups: Watch (pinned), one group per function scope
    // (innermost first), then Globals / Constants / Resources for the module
    // scope.
    _buildGroups(exec, context) {
        if (this._pinned.size) {
            this._buildWatchGroup(exec, context);
        }

        // Collect the context chain; the root (parent-less) context is module
        // scope.
        const chain = [];
        let ctx = context;
        while (ctx) {
            chain.push(ctx);
            ctx = ctx.parent;
        }
        const root = chain.pop();

        let scopeIndex = 0;
        for (const scopeCtx of chain) {
            const group = this._makeGroup(`scope_${scopeIndex}`, scopeCtx.currentFunctionName || "<shader>", false);
            scopeCtx.variables.forEach((variable) => {
                this._addVariable(group, variable, `scope_${scopeIndex}`, exec, scopeCtx, { expandArgs: true });
            });
            this._commitGroup(group);
            scopeIndex++;
        }

        if (!root) {
            return;
        }

        // Module scope: partition into plain globals, constants/overrides, and
        // bound resources (textures/samplers).
        const globals = this._makeGroup("scope_globals", "Globals", false);
        const constants = this._makeGroup("scope_constants", "Constants", true);
        const resources = this._makeGroup("scope_resources", "Resources", true);

        root.variables.forEach((variable) => {
            const nodeType = variable.node?.astNodeType;
            if (variable.value instanceof TextureData || variable.value instanceof SamplerData) {
                this._addVariable(resources, variable, "scope_resources", exec, root, {});
            } else if (nodeType === "const" || nodeType === "override") {
                this._addVariable(constants, variable, "scope_constants", exec, root, { isConst: true });
            } else {
                this._addVariable(globals, variable, "scope_globals", exec, root, {});
            }
        });

        this._commitGroup(globals);
        this._commitGroup(constants);
        this._commitGroup(resources);
    }

    _makeGroup(id, label, collapsed) {
        return {
            id,
            content: label,
            children: [],
            collapsed,
        };
    }

    _commitGroup(group) {
        // When filtering, skip groups with no matching variables so the panel
        // only shows relevant scopes. Empty groups are always skipped.
        if (group.children.length > 0) {
            this.treeWidgets.push(new TreeWidget(this, { data: group }));
        }
    }

    // The Watch group: pinned paths resolved against the current scope.
    _buildWatchGroup(exec, context) {
        const group = this._makeGroup("scope_watch", "Watch", false);
        for (const path of this._pinned) {
            const data = resolveVariablePath(exec, context, path);

            const valueStr = data?.toString() ?? "<not in scope>";
            const valueKey = `watch:${path}`;
            this._currentValues.set(valueKey, valueStr);
            const changed = this._previousValues.has(valueKey) &&
                this._previousValues.get(valueKey) !== valueStr;

            const row = this._makeRow({
                name: path,
                typeName: data ? data.typeInfo.getTypeName() : "",
                data,
                exec,
                context,
                changed,
                unresolved: data === null,
                path,
                pinned: true,
            });

            const item = {
                id: `watch.${path}`,
                content: row,
                children: [],
                collapsed: true,
            };
            if (data instanceof TypedData || data instanceof PointerData ||
                data instanceof MatrixData || (data instanceof TypedData && _isMatrixTypeInfo(data.typeInfo))) {
                this.populateTree(item, data, 1, exec, context, path);
            }
            this._setNameWidth(row, 0, item.children.length > 0);
            group.children.push(item);
            this._rowCount++;
        }
        this._commitGroup(group);
    }

    // Whether a type (or any nested member) has a member name matching the
    // filter, so filtering can match into struct members.
    _typeHasFilterMatch(typeInfo, depth = 0) {
        if (!typeInfo || depth > 4) {
            return false;
        }
        if (typeInfo instanceof StructInfo) {
            for (const member of typeInfo.members) {
                if (member.name.toLowerCase().includes(this.filter)) {
                    return true;
                }
                if (this._typeHasFilterMatch(member.type, depth + 1)) {
                    return true;
                }
            }
        } else if (typeInfo instanceof ArrayInfo) {
            return this._typeHasFilterMatch(typeInfo.format, depth + 1);
        }
        return false;
    }

    _addVariable(group, variable, scopeKey, exec, context, opts) {
        const varData = variable.value;
        const rawStr = varData?.toString() ?? "null";

        // Track every variable's value for change detection, even ones hidden
        // by the filter.
        const valueKey = `${scopeKey}:${variable.name}`;
        this._currentValues.set(valueKey, rawStr);

        let filterInMembers = false;
        if (this.filter && !variable.name.toLowerCase().includes(this.filter)) {
            filterInMembers = this._typeHasFilterMatch(varData?.typeInfo);
            if (!filterInMembers) {
                return;
            }
        }

        const changed = this._previousValues.has(valueKey) &&
            this._previousValues.get(valueKey) !== rawStr;

        const row = this._makeRow({
            name: variable.name,
            typeName: varData?.typeInfo?.getTypeName() ?? "",
            data: varData,
            exec,
            context,
            changed,
            isConst: !!opts.isConst,
            path: variable.name,
        });

        // Entry-point arguments expand a level by default: the inputs are
        // usually the first thing to inspect.
        const isArg = variable.node?.astNodeType === "argument";
        const item = {
            id: `${scopeKey}.${variable.name}`,
            content: row,
            children: [],
            collapsed: !(isArg || filterInMembers),
        };

        if (varData instanceof TypedData || varData instanceof PointerData ||
            varData instanceof MatrixData) {
            this.populateTree(item, varData, 1, exec, context, variable.name);
        }
        this._setNameWidth(row, 0, item.children.length > 0);

        group.children.push(item);
        this._rowCount++;
    }

    // Build one row (name / type / value spans) with formatting, change
    // highlighting, an optional color swatch, and the context menu.
    _makeRow({ name, typeName, data, exec, context, changed, isConst, unresolved, path, pinned }) {
        const row = new Span(null, { class: "watch-row" });
        if (isConst) {
            row.classList.add("watch-row-constant");
        }

        const nameSpan = new Span(row, { class: "watch-row-name" });
        nameSpan.textContent = name;
        nameSpan.title = path ?? name;
        row._nameSpan = nameSpan;

        const typeSpan = new Span(row, { class: "watch-row-type" });
        typeSpan.textContent = typeName;
        typeSpan.title = typeName;

        const formatted = unresolved
            ? { text: "<not in scope>", title: "<not in scope>" }
            : formatDataValue(data, exec, context);

        const valueSpan = new Span(row, { class: "watch-row-value" });
        if (formatted.swatch) {
            const swatch = new Span(valueSpan, { class: "watch-swatch" });
            const fill = document.createElement("span");
            fill.className = "watch-swatch-fill";
            fill.style.backgroundColor = formatted.swatch;
            swatch.element.appendChild(fill);
        }
        const valueText = new Span(valueSpan, { class: "watch-row-value-text" });
        valueText.textContent = formatted.text;
        valueSpan.title = formatted.title;
        if (changed) {
            valueSpan.classList.add("watch-row-changed");
        }

        if (path) {
            row.element.addEventListener("contextmenu", (e) => {
                e.preventDefault();
                e.stopPropagation();
                this._showContextMenu(e, path, data, pinned);
            });
        }

        return row;
    }

    _setNameWidth(row, indent, hasChildren) {
        const nameSpan = row._nameSpan;
        if (!nameSpan) {
            return;
        }
        const arrow = hasChildren ? " - 14px" : "";
        nameSpan.style.minWidth = `calc(200px - ${indent * 20}px${arrow})`;
        nameSpan.style.maxWidth = `calc(200px - ${indent * 20}px${arrow})`;
    }

    // ------------------------------------------------------------------------
    // Context menu
    // ------------------------------------------------------------------------

    _showContextMenu(event, path, data, pinned) {
        this._dismissContextMenu();

        const menu = document.createElement("div");
        menu.className = "watch-context-menu";
        this._contextMenu = menu;

        const addItem = (label, action) => {
            const item = document.createElement("div");
            item.className = "watch-context-menu-item";
            item.textContent = label;
            item.addEventListener("click", () => {
                this._dismissContextMenu();
                action();
            });
            menu.appendChild(item);
        };

        addItem("Copy Name", () => {
            navigator.clipboard?.writeText(path);
        });
        addItem("Copy Value", () => {
            navigator.clipboard?.writeText(data?.toString() ?? "null");
        });
        const isPinned = pinned || this._pinned.has(path);
        addItem(isPinned ? "Unpin from Watch" : "Pin to Watch", () => {
            if (isPinned) {
                this._pinned.delete(path);
            } else {
                this._pinned.add(path);
            }
            this.refresh();
        });

        menu.style.left = `${event.clientX}px`;
        menu.style.top = `${event.clientY}px`;
        document.body.appendChild(menu);

        // Keep the menu on screen.
        const rect = menu.getBoundingClientRect();
        if (rect.right > window.innerWidth) {
            menu.style.left = `${Math.max(0, window.innerWidth - rect.width - 4)}px`;
        }
        if (rect.bottom > window.innerHeight) {
            menu.style.top = `${Math.max(0, window.innerHeight - rect.height - 4)}px`;
        }

        this._dismissListener = (e) => {
            if (!menu.contains(e.target)) {
                this._dismissContextMenu();
            }
        };
        this._keyListener = (e) => {
            if (e.key === "Escape") {
                this._dismissContextMenu();
            }
        };
        // Defer so the opening right-click doesn't immediately dismiss.
        setTimeout(() => {
            document.addEventListener("mousedown", this._dismissListener);
            document.addEventListener("keydown", this._keyListener);
        }, 0);
    }

    _dismissContextMenu() {
        if (this._contextMenu) {
            this._contextMenu.remove();
            this._contextMenu = null;
        }
        if (this._dismissListener) {
            document.removeEventListener("mousedown", this._dismissListener);
            this._dismissListener = null;
        }
        if (this._keyListener) {
            document.removeEventListener("keydown", this._keyListener);
            this._keyListener = null;
        }
    }

    onDestroy() {
        this._dismissContextMenu();
    }

    // ------------------------------------------------------------------------
    // Tree population (struct members, array elements, matrix columns)
    // ------------------------------------------------------------------------

    populateArray(parent, varData, indent, startIndex, count, exec, context, path) {
        let inc = 1;
        if (count >= 1000000) {
            inc = 100000;
        } else if (count >= 100000) {
            inc = 10000;
        } else if (count >= 10000) {
            inc = 1000;
        } else if (count >= 1000) {
            inc = 100;
        }

        if (inc == 1) {
            for (let i = 0; i < count; ++i) {
                const postfix = new ArrayIndex(startIndex + i);
                const subData = varData.getSubData(exec, postfix, context);
                const elemPath = `${path}[${startIndex + i}]`;

                const row = this._makeRow({
                    name: `[${startIndex + i}]`,
                    typeName: varData.typeInfo.format.getTypeName(),
                    data: subData,
                    exec,
                    context,
                    path: elemPath,
                });

                const item = {
                    id: `${parent.id}[${startIndex + i}]`,
                    content: row,
                    children: [],
                    collapsed: true,
                    index: startIndex + i,
                    count: 1,
                };
                parent.children.push(item);

                this.populateTree(item, subData, indent + 1, exec, context, elemPath);
                this._setNameWidth(row, indent, item.children.length > 0);
            }
        } else {
            for (let i = 0; i < count; i += inc) {
                const itemCount = Math.min(inc, count - i);
                let j = i + startIndex;

                const row = this._makeRow({
                    name: `[${j} - ${j + itemCount - 1}]`,
                    typeName: varData.typeInfo.format.getTypeName(),
                    data: null,
                    exec,
                    context,
                    unresolved: false,
                });
                // Range rows have no single value.
                row.element.querySelector(".watch-row-value").textContent = "[…]";

                const item = {
                    id: `${parent.id}[${j} - ${j + itemCount - 1}]`,
                    content: row,
                    index: j,
                    count: itemCount,
                    children: [],
                    collapsible: true,
                    collapsed: true,
                    onCollapseChange: (n, d, s) => {
                        const parentData = d;
                        let treeWidget = n.parent;
                        while (treeWidget && !(treeWidget instanceof TreeWidget)) {
                            treeWidget = treeWidget.parent;
                        }
                        if (s === "open") {
                            this.populateArray(parentData, varData, indent + 1, d.index, d.count, exec, context, path);
                            if (treeWidget) {
                                for (const c of item.children) {
                                    treeWidget.createAndInsert(c, null, item.id);
                                }
                            }
                        } else {
                            if (treeWidget) {
                                treeWidget.removeItemChildren(n);
                            }
                            item.children.length = 0;
                        }
                    }
                };

                parent.children.push(item);
                this._setNameWidth(row, indent, true);
            }
        }
    }

    populateTree(parent, varData, indent, exec, context, path) {
        if (varData instanceof PointerData) {
            this.populateTree(parent, varData.reference, indent, exec, context, path);
            return;
        }

        // Matrices expand into their column vectors.
        const isMatrix = varData instanceof MatrixData ||
            (varData instanceof TypedData && _isMatrixTypeInfo(varData.typeInfo));
        if (isMatrix) {
            const values = _matrixValues(varData);
            const dims = _matrixDims(varData.typeInfo.getTypeName());
            if (values && dims) {
                const [cols, rows] = dims;
                for (let c = 0; c < cols; ++c) {
                    const col = values.slice(c * rows, (c + 1) * rows);
                    const row = new Span(null, { class: "watch-row" });
                    const nameSpan = new Span(row, { class: "watch-row-name" });
                    nameSpan.textContent = `col ${c}`;
                    row._nameSpan = nameSpan;
                    const typeSpan = new Span(row, { class: "watch-row-type" });
                    typeSpan.textContent = `vec${rows}`;
                    const valueSpan = new Span(row, { class: "watch-row-value" });
                    valueSpan.textContent = _formatNumbers(col);
                    valueSpan.title = col.join(", ");

                    parent.children.push({
                        id: `${parent.id}.col${c}`,
                        content: row,
                        children: [],
                        collapsed: true,
                    });
                    this._setNameWidth(row, indent, false);
                }
            }
            return;
        }

        if (!(varData instanceof TypedData)) {
            return;
        }

        if (varData.typeInfo instanceof ArrayInfo) {
            const count = varData.typeInfo.count ||
                    ((varData.buffer.byteLength - varData.offset) / varData.typeInfo.stride);
            this.populateArray(parent, varData, indent, 0, count, exec, context, path);
        } else if (varData.typeInfo instanceof StructInfo) {
            for (const member of varData.typeInfo.members) {
                const postfix = new StringExpr(`${member.name}`);
                const subData = varData.getSubData(exec, postfix, context);
                const memberPath = `${path}.${member.name}`;

                const memberMatches = this.filter && member.name.toLowerCase().includes(this.filter);
                const subtreeMatches = this.filter && this._typeHasFilterMatch(member.type);

                const row = this._makeRow({
                    name: member.name,
                    typeName: member.type.getTypeName(),
                    data: subData,
                    exec,
                    context,
                    path: memberPath,
                });
                if (memberMatches) {
                    row.classList.add("watch-row-filter-match");
                }

                const item = {
                    id: `${parent.id}.${member.name}`,
                    content: row,
                    children: [],
                    // Auto-expand along paths that lead to a filter match.
                    collapsed: !subtreeMatches,
                    postfix
                };
                parent.children.push(item);

                this.populateTree(item, subData, indent + 1, exec, context, memberPath);
                this._setNameWidth(row, indent, item.children.length > 0);
            }
        }
    }
}
