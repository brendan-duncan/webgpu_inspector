import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { TreeWidget } from "./widget/tree_widget.js";
import { PointerData, TypedData, StructInfo, ArrayInfo, ArrayIndex, StringExpr } from "../../../node_modules/wgsl_reflect/wgsl_reflect.module.js";

export class ShaderWatchView extends Div {
    constructor(parent, options) {
        super(parent, options);
        this.id = 0;
        this.treeWidgets = [];
    }

    update(exec, context) {
        const previousData = [];
        for (const treeWidget of this.treeWidgets) {
            const data = treeWidget.data;
            previousData.push(data);
        }

        this.treeWidgets.length = 0;
        this.removeAllChildren();
        this.initialize(exec, context);

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
            const row = new Span(null, { class: "watch-row"});
            const name = new Span(row, { class: "watch-row-name"});
            name.textContent = variable.name;

            const type = new Span(row, { class: "watch-row-type"});
            type.textContent = variable.value.typeInfo.getTypeName();

            const value = new Span(row, { class: "watch-row-value"});

            let varData = variable.value;
            value.textContent = varData.toString();

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
        });

        this.treeWidgets.push(new TreeWidget(this, { data }));

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

                const arrayType = new Span(arrayRow, { class: "watch-row-type" });
                arrayType.textContent = varData.typeInfo.format.getTypeName();

                const arrayValue = new Span(arrayRow, { class: "watch-row-value" });
                arrayValue.textContent = subData?.toString() ?? "null";

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

                const arrayType = new Span(arrayRow, { class: "watch-row-type"});
                arrayType.textContent = varData.typeInfo.format.getTypeName();

                const arrayValue = new Span(arrayRow, { class: "watch-row-value"});
                arrayValue.textContent = `[...]`;

                const item = {
                    id: `${parent.id}[${j} - ${j + itemCount - 1}]`,
                    content: arrayRow,
                    index: j,
                    count: itemCount,
                    children: [],
                    collapsable: true,
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
            const count = varData.typeInfo.count;
            this.populateArray(parent, varData, indent, 0, count, exec, context);
        } else if (varData.typeInfo instanceof StructInfo) {
            for (const member of varData.typeInfo.members) {
                const postfix = new StringExpr(`${member.name}`);

                const memberRow = new Span(null, { class: "watch-row"});
                const memberName = new Span(memberRow, { class: "watch-row-name"});
                memberName.textContent = member.name;

                const memberType = new Span(memberRow, { class: "watch-row-type"});
                memberType.textContent = member.type.getTypeName();

                const subData = varData.getSubData(exec, postfix, context);

                const memberValue = new Span(memberRow, { class: "watch-row-value"});
                memberValue.textContent = subData?.toString() ?? "null";

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
