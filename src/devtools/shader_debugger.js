import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Split } from "./widget/split.js";
import { Img } from "./widget/img.js";
import { Collapsable } from "./widget/collapsable.js";
import { WgslDebug } from "wgsl_reflect/wgsl_reflect.module.js";
import { TextureView } from "./gpu_objects/index.js";
import { ShaderWatchView } from "./shader_watch_view.js";

import { EditorView } from "codemirror";
import { keymap, highlightSpecialChars, drawSelection, dropCursor, gutter, GutterMarker,
  crosshairCursor, lineNumbers, Decoration, hoverTooltip } from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSet } from "@codemirror/state";
import { defaultHighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching,
  foldGutter, foldKeymap } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, openSearchPanel  } from "@codemirror/search";
import { completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";
import { wgsl } from "../thirdparty/codemirror_lang_wgsl.js";
import { cobalt } from 'thememirror';
import { Button } from "./widget/button.js";
import { NumberInput } from "./widget/number_input.js";

const breakpointEffect = StateEffect.define({
    map: (val, mapping) => ({ pos: mapping.mapPos(val.pos), on: val.on })
});

const debugLineHighlightEffect = StateEffect.define({
    map: (val, mapping) => ({ lineNo: mapping.mapPos(val.lineNo) })
});

const breakpointState = StateField.define({
    create() {
        return RangeSet.empty; 
    },
    update(set, transaction) {
      set = set.map(transaction.changes);
      // TODO: include both breakpoint and line highlight effects
      for (let e of transaction.effects) {
        if (e.is(breakpointEffect)) {
          if (e.value.on) {
            set = set.update({add: [breakpointMarker.range(e.value.pos)]});
          } else {
            set = set.update({filter: from => from != e.value.pos});
          }
        }/* else if (e.is(debugLineHighlightEffect)) {
          set = set.update({filter: from => from != e.value.lineNo});
        }*/
      }
      return set;
    }
});

function toggleBreakpoint(view, pos) {
    let breakpoints = view.state.field(breakpointState);
    let hasBreakpoint = false;
    breakpoints.between(pos, pos, () => {hasBreakpoint = true});
    view.dispatch({
      effects: breakpointEffect.of({pos, on: !hasBreakpoint})
    });
}

const breakpointMarker = new class extends GutterMarker {
    toDOM() {
        const el = document.createElement("div");
        el.classList.add("cm-breakpoint-marker");
        return el;
    }
};

const breakpointGutter = [
    breakpointState,
    gutter({
      class: "cm-breakpoint-gutter",
      markers: v => v.state.field(breakpointState),
      initialSpacer: () => breakpointMarker,
      domEventHandlers: {
        mousedown(view, line) {
          const lineNo = view.state.doc.lineAt(line.from).number;
          const dbg = view.debugger;
          dbg.toggleBreakpoint(lineNo);
          toggleBreakpoint(view, line.from)
          return true
        }
      }
    }),

    EditorView.baseTheme({
    ".cm-breakpoint-gutter": {
        cursor: "pointer",
        backgroundColor: "rgb(45, 45, 45)"
      },
      ".cm-breakpoint-gutter .cm-gutterElement": {
        color: "red",
        paddingLeft: "5px",
        cursor: "pointer",
        backgroundColor: "rgb(45, 45, 45)"
      }
    })
];

const debugLineHighlight = StateField.define({
    create() {
      return Decoration.none;
    },
    update(lines, tr) {
      lines = lines.map(tr.changes);
      for (let e of tr.effects) {
        if (e.is(debugLineHighlightEffect)) {
          lines = Decoration.none;
          if (e.value.lineNo > 0) {
            lines = lines.update({ add: [lineHighlightMark.range(e.value.lineNo)] });
          }
        }
      }
      return lines;
    },
    provide: (f) => EditorView.decorations.from(f),
});

const lineHighlightMark = Decoration.line({
    attributes: {style: 'background-color:rgb(64, 73, 14)'},
});

const tooltipHover = hoverTooltip((view, pos, side) => {
    const { from, to, text } = view.state.doc.lineAt(pos)
    let start = pos;
    let end = pos
    while (start > from && /[\w.\[\]]/.test(text[start - from - 1])) {
        start--;
    }
    while (end < to && /\w/.test(text[end - from])) {
        end++;
    }
    if (text[end] === "[") {
        let bracketCount = 1;
        while (end < to && bracketCount > 0) {
            end++;
            if (text[end] === "[") {
                bracketCount++;
            } if (text[end] === "]") {
                bracketCount--;
            }
        }
        end++;
    }
    if (start == pos && side < 0 || end == pos && side > 0) {
      return null;
    }

    let name = text.slice(start - from, end - from);

    if (/[.\[\]]/.test(name)) {
        const fullName = name;
        const match = fullName.match(/^(\w+)/);
        if (match) {
            name = match[1];
            // TODO: build a postfix expression of array indices and field accesses
            // to inspect the individual array elements and struct fields
        }
    }

    const dbg = view.debugger;
    const context = dbg.debugger.context;
    const variable = context.getVariableValue(name);
    if (!variable) {
        return null;
    }

    const tip = `${name}: ${variable.typeInfo.name} = ${variable.toString()}`;

    return {
      pos: start,
      end,
      above: true,
      create(view) {
        const dom = document.createElement("div");
        dom.className = "cm-tooltip";
        dom.textContent = tip;
        return { dom };
      }
    }
  })

const shaderEditorSetup = (() => [
    breakpointGutter,
    debugLineHighlight,
    tooltipHover,
    lineNumbers(),
    //highlightActiveLineGutter(),
    highlightSpecialChars(),
    EditorState.readOnly.of(true),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    //EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
    bracketMatching(),
    closeBrackets(),
    //autocompletion(),
    crosshairCursor(),
    cobalt,
    wgsl(),
    keymap.of([
      indentWithTab,
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap
    ])
])();

export class ShaderDebugger extends Div {
    constructor(command, entry, data, database, capturePanel, options) {
        super(null, options);
        this._element.classList.add('shader-debugger');

        this._hotkeyEvent = this.hotkeyEvent.bind(this);
        document.addEventListener("keydown", this._hotkeyEvent);

        this.capturePanel = capturePanel;
        this.command = command;
        this.captureData = data;
        this.database = database;
        this.entry = entry;

        this.pipelineState = this.capturePanel._getPipelineState(command);
        const computePass = this.pipelineState.pipeline;

        const args = computePass.args;
        const id = args[0]?.__id;
        const pipeline = database.getObject(id);
        const desc = pipeline.descriptor;
        const computeId = desc.compute?.module?.__id;
        this.module = database.getObject(computeId);

        const code = this.module.descriptor.code;

        this._idX = 0;
        this._idY = 0;
        this._idZ = 0;

        this.controls = new Div(this, { style: "display: flex; flex-direction: row; margin-top: 5px;" });
        new Span(this.controls, { text: "Thread ID:", style: "margin-left: 10px; margin-right: 5px; vertical-align: middle; color: #bbb;" });
        this.idXInput = new NumberInput(this.controls, {
            value: 0,
            min: 0,
            precision: 0,
            step: 1,
            style: "flex: 0 0 auto; display: inline-block; width: 100px; margin-right: 10px; vertical-align: middle;",
            onChange: (value) => {
                this._idX = value;
            }
        });
        this.idYInput = new NumberInput(this.controls, {
            value: 0,
            min: 0,
            step: 1,
            precision: 0,
            style: "flex: 0 0 auto; display: inline-block; width: 100px; margin-right: 10px; vertical-align: middle;",
            onChange: (value) => {
                this._idY = value;
            }
        });
        this.idZInput = new NumberInput(this.controls, {
            value: 0,
            min: 0,
            step: 1,
            precision: 0,
            style: "flex: 0 0 auto; display: inline-block; width: 100px; margin-right: 10px; vertical-align: middle;",
            onChange: (value) => {
                this._idZ = value;
            }
        });

        new Button(this.controls, {
            children: [ new Img(null, { title: "Debug Shader (F8)", src: "img/debug.svg", style: "width: 15px; height: 15px; filter: invert(1);" }) ],
            title: "Debug Shader (F8)",
            onClick: () => {
                this.debug();
            }
        });

        new Div(this.controls, { style: "flex-grow: 1;" });

        this.continueButton = new Button(this.controls, {
            children: [new Img(null, { title: "Continue (F5)", src: "img/debug-continue-small.svg", style: "width: 15px; height: 15px; filter: invert(1);" })],
            title: "Continue (F5)",
            style: "background-color: #777;",
            onClick: () => {
                this.pauseContinue();
            }
        });

        new Button(this.controls, {
            children: [new Img(null, { title: "Step Over (F10)", src: "img/debug-step-over.svg", style: "width: 15px; height: 15px; filter: invert(1);" })],
            title: "Step Over (F10)",
            style: "background-color: #777;",
            onClick: () => {
                this.stepOver();
            }
        });
        new Button(this.controls, {
            children: [new Img(null, { title: "Step Into (F11)", src: "img/debug-step-into.svg", style: "width: 15px; height: 15px; filter: invert(1);" })],
            title: "Step Into (F11)",
            style: "background-color: #777;",
            onClick: () => {
                this.stepInto();
            }
        });
        new Button(this.controls, {
            children: [new Img(null, { title: "Step Out (F12)", src: "img/debug-step-out.svg", style: "width: 15px; height: 15px; filter: invert(1);" })],
            title: "Step Out (F12)",
            style: "background-color: #777;",
            onClick: () => {
                this.stepOut();
            }
        });
        new Button(this.controls, {
            children: [new Img(null, { title: "Restart (F7)", src: "img/debug-restart.svg", style: "width: 15px; height: 15px; filter: invert(1);" })],
            title: "Restart (F7)",
            style: "background-color: #777;",
            onClick: () => {
                this.restart();
            }
        });

        new Div(this.controls, { style: "flex-grow: 2;" });

        new Button(this.controls, {
            text: "Help",
            title: "Help",
            style: "background-color: #777;",
            onClick: () => {
                window.open("https://github.com/brendan-duncan/webgpu_inspector/blob/main/docs/shader_debugger.md", "_blank");
            }
        });

        const editorPanel = new Div(this, { style: "height: 100%;" });

        const split = new Split(editorPanel, { direction: Split.Horizontal, position: 0.7 });
        const pane1 = new Span(split, { style: "flex-grow: 1; height: calc(100% - 35px); overflow: auto;" });
        const pane2 = new Span(split, { style: "flex-grow: 1; height: calc(100% - 35px); overflow: auto;" });
        split.updatePosition();

        this.editorView = new EditorView({
            doc: code,
            extensions: [ shaderEditorSetup ],
            parent: pane1.element,
        });
        this.editorView.dom.style.height = "100%";

        this.editorView.debugger = this;

        openSearchPanel(this.editorView);

        this.watch = new Div(pane2, { style: "overflow: auto; background-color: #333; color: #bbb; width: 100%; height: 100%;" });

        this.variables = new Collapsable(this.watch, { collapsed: false, label: `Variables` });;
        this.watchVariables = new ShaderWatchView(this.variables.body);
        //this.globals = new Collapsable(this.watch, { collapsed: false, label: `Globals` });;
        this.callstack = new Collapsable(this.watch, { collapsed: false, label: `Callstack` });;

        this.debug();
    }

    onDestroy() {
        document.removeEventListener("keydown", this._hotkeyEvent);
    }

    hotkeyEvent(e) {
        if (this.display === "none") {
            return;
        }

        if (e.key === "F5") {
            this.pauseContinue();
            e.preventDefault();
        } else if (e.key === "F10") {
            this.stepOver();
            e.preventDefault();
        } else if (e.key === "F11") {
            this.stepInto();
            e.preventDefault();
        } else if (e.key === "F12") {
            this.stepOut();
            e.preventDefault();
        } else if (e.key === "F8") {
            this.debug();
            e.preventDefault();
        } else if (e.key === "F7") {
            this.restart();
            e.preventDefault();
        }
    }

    toggleBreakpoint(lineNo) {
        this.debugger.toggleBreakpoint(lineNo);
    }

    runStateChanged() {
        if (this.debugger.isRunning) {
            this.continueButton.children[0].src = "img/debug-pause.svg";
        } else {
            this.continueButton.children[0].src = "img/debug-continue-small.svg";
        }
        this.update();
    }

    pauseContinue() {
        if (!this.debugger) {
            this.debug();
        }

        if (this.debugger.isRunning) {
            this.debugger.pause();
            this.update();
        } else {
            this.debugger.run();
            this.update();
        }
    }

    restart() {
        this.debug();
    }

    debug() {
        const idx = Math.floor(this._idX);
        const idy = Math.floor(this._idY);
        const idz = Math.floor(this._idZ);

        const dispatchCount = [1, 1, 1];
        const dispatchArg = this.command.args[0];
        if (dispatchArg instanceof Array) {
            dispatchCount[0] = dispatchArg[0];
            if (dispatchArg.length > 1) {
                dispatchCount[1] = dispatchArg[1];
            }
            if (dispatchArg.length > 2) {
                dispatchCount[2] = dispatchArg[2];
            }
        } else {
            dispatchCount[0] = dispatchArg;
        }

        const reflection = this.module?.reflection;
        if (!reflection) {
            return;
        }

        let kernel = null;
        if (this.entry) {
            kernel = reflection.entry.compute.find((k) => k.name === this.entry);
        }

        if (!kernel) {
            kernel = reflection.entry.compute[0]
            if (!kernel) {
                return;
            }
        }

        const kernelName = kernel.name;

        const bindGroups = {};

        this.pipelineState.bindGroups.forEach((bgCmd) => {
            const index = bgCmd.args[0];
            const bg = this.pipelineState.bindGroups[index];

            const bindGroup = {};
            bindGroups[index] = bindGroup;

            const bgObj = this.database.getObject(bgCmd.args[1].__id);

            if (bg.bufferData !== undefined) {
                const bufferData = bg.bufferData;
                let index = 0;
                for (const buffer of bufferData) {
                    if (buffer) {
                        const binding = bgObj.descriptor.entries[index].binding;
                        bindGroup[binding] = buffer;
                    }
                    index++;
                }
            }

            for (const b of bgObj.descriptor.entries) {
                const binding = b.binding;
                if (bindGroup[binding] !== undefined) {
                    continue
                }

                const resource = this.database.getObject(b.resource.__id);
                if (resource instanceof TextureView) {
                    const texture = resource.__texture;
                    const size = [texture.width, texture.height, texture.depthOrArrayLayers];
                    bindGroup[binding] = { texture: texture.imageData, size, view: resource.descriptor, descriptor: texture.descriptor };
                }
            }
        });

        const pipeline = this.database.getObject(this.pipelineState.pipeline.args[0].__id);
        const constants = pipeline?.descriptor?.compute?.constants;

        const options = {};
        if (constants) {
            options.constants = constants;
        }

        const code = this.module.descriptor.code;
        this.debugger = new WgslDebug(code, this.runStateChanged.bind(this));
        this.debugger.debugWorkgroup(kernelName, [idx, idy, idz], dispatchCount, bindGroups, options);
        this.update();
    }

    stepInto() {
        if (this.debugger) {
            this.debugger.stepInto();
            this.update();
        }
    }

    stepOver() {
        if (this.debugger) {
            this.debugger.stepOver();
            this.update();
        }
    }

    stepOut() {
        if (this.debugger) {
            this.debugger.stepOut();
            this.update();
        }
    }

    _createVariableDiv(v, parent) {
        if (!v.value) {
            return;
        }
        const div = new Div(parent);
        const type = v.value.typeInfo;
        let typeName = "x32";
        if (type) {
            typeName = type.name;
            if (type.format) {
                typeName = `${typeName}<${type.format.name}>`;
            }
        }
        new Span(div, { text: v.name, class: "watch-var-name" });
        new Span(div, { text: typeName, class: "watch-var-type" });
        new Span(div, { text: `${v.value}`, class: "watch-var-value" });
    }

    update() {
        if (!this.debugger) {
            return;
        }

        const cmd = this.debugger.currentCommand;
        if (cmd !== null && !this.debugger.isRunning) {
            const line = cmd.line;
            if (line > -1) {
                this._highlightLine(cmd.line);
            } else {
                this._highlightLine(0);
            }
        } else {
            this._highlightLine(0);
        }

        //this.variables.body.removeAllChildren();
        //this.globals.body.removeAllChildren();
        this.callstack.body.removeAllChildren();

        this.watchVariables.update(this.debugger._exec, this.debugger.context);

        let state = this.debugger.currentState;
        if (state === null) {
            const context = this.debugger.context;
            const currentFunctionName = context.currentFunctionName;
            //new Div(this.variables.body, { text: currentFunctionName || "<shader>", style: "font-weight: bold; color: #eee; padding-bottom: 2px;" });

            new Div(this.callstack.body, { text: currentFunctionName || "<shader>", style: "font-weight: bold; color: #eee; padding-bottom: 2px;" });

            /*context.variables.forEach((v, name) => {
                if (!name.startsWith("@")) {
                    this._createVariableDiv(v, this.variables.body);
                }
            });

            context.variables.forEach((v, name) => {
                if (name.startsWith("@")) {
                    this._createVariableDiv(v, this.globals.body);
                }
            });*/
        } else {
            let lastState = state;
            let lastFunctionName = null;
            while (state !== null) {
                const context = state.context;
                const currentFunctionName = context.currentFunctionName || "<shader>";

                //new Div(this.variables.body, { text: currentFunctionName, style: "font-weight: bold; color: #eee; padding-bottom: 2px;" });

                if (currentFunctionName !== lastFunctionName) {
                    new Div(this.callstack.body, { text: currentFunctionName, style: "font-weight: bold; color: #eee; padding-bottom: 2px;" });
                }

                lastFunctionName = currentFunctionName;

                /*context.variables.forEach((v, name) => {
                    if (!name.startsWith("@")) {
                        this._createVariableDiv(v, this.variables.body);
                    }
                });*/

                lastState = state;
                state = state.parent;
            }

            /*if (lastState) {
                const context = lastState.context;
                context.variables.forEach((v, name) => {
                    if (name.startsWith("@")) {
                        this._createVariableDiv(v, this.globals.body);
                    }
                });
            }*/
        }
    }

    _highlightLine(lineNo) {
        if (lineNo > 0) {
            const line = this.editorView.state.doc.line(lineNo);
            const scrollEffect = EditorView.scrollIntoView(line.from, { y: "center" });
            this.editorView.dispatch({ effects: [debugLineHighlightEffect.of({ lineNo: line.from }), scrollEffect] });
        } else {
            this.editorView.dispatch({ effects: debugLineHighlightEffect.of({ lineNo: 0 }) });
        }
    }
}
