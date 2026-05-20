import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { TreeWidget } from "./widget/tree_widget.js";
//import { PointerData, TypedData, StructInfo, ArrayInfo, ArrayIndex, StringExpr } from "../../../node_modules/wgsl_reflect/wgsl_reflect.module.js";
import { PointerData, TypedData, StructInfo, ArrayInfo, ArrayIndex, StringExpr } from "wgsl_reflect/wgsl_reflect.module.js";

export class ShaderWatchView extends Div {
    constructor(parent, options) {
        super(parent, options);
        this.id = 0;
        this.treeWidgets = [];
        this.filter = "";
        this._exec = null;
        this._context = null;
        // Snapshots of variable values used to highlight values that changed
        // between debugger steps.
        this._previousValues = new Map();
        this._currentValues = new Map();
        this._rowCount = 0;
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
            const data = treeWidget.data;
            previousData.push(data);
        }

        this.treeWidgets.length = 0;
        this.removeAllChildren();

        this._currentValues = new Map();
        this._rowCount = 0;
        this.initialize(this._exec, this._context);

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

    initialize(exec, context) {
        this.id = 0;

        const data = {
            id: `${context.id}`,
            content: context.currentFunctionName,
            children: [],
            collapsed: false
        };

        context.variables.forEach((variable) => {
            const varData = variable.value;
            const valueStr = varData?.toString() ?? "null";

            // Track every variable's value for change detection, even ones
            // hidden by the filter.
            const valueKey = `${context.id}:${variable.name}`;
            this._currentValues.set(valueKey, valueStr);

            if (this.filter && !variable.name.toLowerCase().includes(this.filter)) {
                return;
            }

            const changed = this._previousValues.has(valueKey) &&
                this._previousValues.get(valueKey) !== valueStr;

            const row = new Span(null, { class: "watch-row"});
            const name = new Span(row, { class: "watch-row-name"});
            name.textContent = variable.name;
            name.title = name.textContent;

            const type = new Span(row, { class: "watch-row-type"});
            type.textContent = variable.value.typeInfo.getTypeName();
            type.title = type.textContent;

            const value = new Span(row, { class: "watch-row-value"});
            value.textContent = valueStr;
            value.title = value.textContent;
            if (changed) {
                value.classList.add("watch-row-changed");
            }

            const variableData = {
                id: `${variable.id}`,
                content: row,
                children: [],
                collapsed: true
            };

            if (varData instanceof TypedData || varData instanceof PointerData) {
                this.populateTree(variableData, varData, 1, exec, context);
                if (variableData.children.length > 0) {
                    name.style.minWidth = `calc(200px - 14px)`;
                    name.style.maxWidth = `calc(200px - 14px)`;
                }
            }

            data.children.push(variableData);
            this._rowCount++;
        });

        // When filtering, skip scopes that have no matching variables so the
        // panel only shows relevant call frames.
        if (!this.filter || data.children.length > 0) {
            this.treeWidgets.push(new TreeWidget(this, { data }));
        }

        if (context.parent) {
            this.initialize(exec, context.parent);
        }
    }

    populateArray(parent, varData, indent, startIndex, count, exec, context) {
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

                const arrayRow = new Span(null, { class: "watch-row"});
                const arrayIndex = new Span(arrayRow, { class: "watch-row-name" });
                arrayIndex.textContent = `[${startIndex + i}]`;
                arrayIndex.title = arrayIndex.textContent;

                const arrayType = new Span(arrayRow, { class: "watch-row-type" });
                arrayType.textContent = varData.typeInfo.format.getTypeName();
                arrayType.title = arrayType.textContent;

                const arrayValue = new Span(arrayRow, { class: "watch-row-value" });
                arrayValue.textContent = subData?.toString() ?? "null";
                arrayValue.title = arrayValue.textContent;

                const item = {
                    id: `${parent.id}[${startIndex + i}]`,
                    content: arrayRow,
                    children: [],
                    collapsed: true,
                    index: startIndex + i,
                    count: 1,
                };
                parent.children.push(item);

                this.populateTree(item, subData, indent + 1, exec, context);

                if (item.children.length > 0) {
                    arrayIndex.style.minWidth = `calc(200px - ${indent * 20}px - 14px)`;
                    arrayIndex.style.maxWidth = `calc(200px - ${indent * 20}px - 14px)`;
                } else {
                    arrayIndex.style.minWidth = `calc(200px - ${indent * 20}px)`;
                    arrayIndex.style.maxWidth = `calc(200px - ${indent * 20}px)`;
                }
            }
        } else {
            for (let i = 0; i < count; i += inc) {
                const itemCount = Math.min(inc, count - i);

                let j = i + startIndex;

                const arrayRow = new Span(null, { class: "watch-row"});
                const arrayIndex = new Span(arrayRow, { class: "watch-row-name"});
                arrayIndex.textContent = `[${j} - ${j + itemCount - 1}]`;
                arrayIndex.title = arrayIndex.textContent;

                const arrayType = new Span(arrayRow, { class: "watch-row-type"});
                arrayType.textContent = varData.typeInfo.format.getTypeName();
                arrayType.title = arrayType.textContent;

                const arrayValue = new Span(arrayRow, { class: "watch-row-value"});
                arrayValue.textContent = `[...]`;

                const item = {
                    id: `${parent.id}[${j} - ${j + itemCount - 1}]`,
                    content: arrayRow,
                    index: j,
                    count: itemCount,
                    children: [],
                    collapsible: true,
                    collapsed: true,
                    onCollapseChange: (n, d, s) => {
                        const parent = d;
                        let treeWidget = n.parent;
                        while (treeWidget && !(treeWidget instanceof TreeWidget)) {
                            treeWidget = treeWidget.parent;
                        }
                        if (s === "open") {
                            this.populateArray(parent, varData, indent + 1, d.index, d.count, exec, context);
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

                arrayIndex.style.minWidth = `calc(200px - ${indent * 20}px - 14px)`;
                arrayIndex.style.maxWidth = `calc(200px - ${indent * 20}px - 14px)`;
            }
        }
    }

    populateTree(parent, varData, indent, exec, context) {
        if (varData instanceof PointerData) {
            this.populateTree(parent, varData.reference, indent, exec, context);
        } else if (varData.typeInfo instanceof ArrayInfo) {
            const count = varData.typeInfo.count ||
                    ((varData.buffer.byteLength - varData.offset) / varData.typeInfo.stride);
            this.populateArray(parent, varData, indent, 0, count, exec, context);
        } else if (varData.typeInfo instanceof StructInfo) {
            for (const member of varData.typeInfo.members) {
                const postfix = new StringExpr(`${member.name}`);

                const memberRow = new Span(null, { class: "watch-row"});
                const memberName = new Span(memberRow, { class: "watch-row-name"});
                memberName.textContent = member.name;
                memberName.title = memberName.textContent;

                const memberType = new Span(memberRow, { class: "watch-row-type"});
                memberType.textContent = member.type.getTypeName();
                memberType.title = memberType.textContent;

                const subData = varData.getSubData(exec, postfix, context);

                const memberValue = new Span(memberRow, { class: "watch-row-value"});
                memberValue.textContent = subData?.toString() ?? "null";
                memberValue.title = memberValue.textContent;

                const item = {
                    id: `${parent.id}.${member.name}`,
                    content: memberRow,
                    children: [],
                    collapsed: true,
                    postfix
                };
                parent.children.push(item);

                this.populateTree(item, subData, indent + 1, exec, context);

                if (item.children.length > 0) {
                    memberName.style.minWidth = `calc(200px - ${indent * 20}px - 14px)`;
                    memberName.style.maxWidth = `calc(200px - ${indent * 20}px - 14px)`;
                } else {
                    memberName.style.minWidth = `calc(200px - ${indent * 20}px)`;
                    memberName.style.maxWidth = `calc(200px - ${indent * 20}px)`;
                }
            }
        }
    }
}
