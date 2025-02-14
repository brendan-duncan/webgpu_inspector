import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Split } from "./widget/split.js";
import { Img } from "./widget/img.js";
import { Collapsable } from "./widget/collapsable.js";
import { WgslDebug } from "wgsl_reflect/wgsl_debugger.module.js";

import { EditorView } from "codemirror";
import { keymap, highlightSpecialChars, drawSelection, dropCursor, gutter, GutterMarker,
  crosshairCursor, lineNumbers, Decoration } from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSet } from "@codemirror/state";
import { defaultHighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching,
  foldGutter, foldKeymap } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, openSearchPanel  } from "@codemirror/search";
import {  completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
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

const shaderEditorSetup = (() => [
    breakpointGutter,
    debugLineHighlight,
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
    constructor(command, data, database, capturePanel, options) {
        super(null, options);
        this._element.classList.add('shader-debugger');

        this.capturePanel = capturePanel;
        this.command = command;
        this.captureData = data;
        this.database = database;

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
            children: [ new Img(null, { title: "Debug Shader", src: "img/debug.svg", style: "width: 15px; height: 15px; filter: invert(1);" }) ],
            title: "Debug Shader",
            onClick: () => {
                this.debug();
            }
        });

        new Div(this.controls, { style: "flex-grow: 1;" });

        this.continueButton = new Button(this.controls, {
            children: [new Img(null, { title: "Continue", src: "img/debug-continue-small.svg", style: "width: 15px; height: 15px; filter: invert(1);" })],
            title: "Continue",
            style: "background-color: #777;",
            onClick: () => {
                this.pauseContinue();
            }
        });

        new Button(this.controls, {
            children: [new Img(null, { title: "Step Over", src: "img/debug-step-over.svg", style: "width: 15px; height: 15px; filter: invert(1);" })],
            title: "Step Over",
            style: "background-color: #777;",
            onClick: () => {
                this.stepOver();
            }
        });
        new Button(this.controls, {
            children: [new Img(null, { title: "Step Into", src: "img/debug-step-into.svg", style: "width: 15px; height: 15px; filter: invert(1);" })],
            title: "Step Into",
            style: "background-color: #777;",
            onClick: () => {
                this.stepInto();
            }
        });
        new Button(this.controls, {
            children: [new Img(null, { title: "Step Out", src: "img/debug-step-out.svg", style: "width: 15px; height: 15px; filter: invert(1);" })],
            title: "Step Out",
            style: "background-color: #777;",
            onClick: () => {
                this.stepOut();
            }
        });
        new Button(this.controls, {
            children: [new Img(null, { title: "Restart", src: "img/debug-restart.svg", style: "width: 15px; height: 15px; filter: invert(1);" })],
            title: "Restart",
            style: "background-color: #777;",
            onClick: () => {
                this.restart();
            }
        });

        new Div(this.controls, { style: "flex-grow: 2;" });

        const editorPanel = new Div(this, { style: "height: 100%;" });

        const split = new Split(editorPanel, { direction: Split.Horizontal, position: 0.7 });
        const pane1 = new Span(split, { style: "flex-grow: 1; height: calc(100% - 35px); overflow: auto;" });
        const pane2 = new Span(split, { style: "flex-grow: 1; height: calc(100% - 35px); overflow: auto;" });

        this.editorView = new EditorView({
            doc: code,
            extensions: [ shaderEditorSetup ],
            parent: pane1.element,
        });
        this.editorView.dom.style.height = "100%";

        this.editorView.debugger = this;

        openSearchPanel(this.editorView);

        this.watch = new Div(pane2, { style: "overflow: auto; background-color: #333; color: #bbb; height: 100%;" });

        this.variables = new Collapsable(this.watch, { collapsed: false, label: `Variables` });;
        this.globals = new Collapsable(this.watch, { collapsed: false, label: `Globals` });;
        this.callstack = new Collapsable(this.watch, { collapsed: false, label: `Callstack` });;

        this.debug();
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

        const kernel = reflection.entry.compute[0];
        if (!kernel) {
            return;
        }

        const kernelName = kernel.name;

        const bindGroups = {};

        this.pipelineState.bindGroups.forEach((bgCmd) => {
            const index = bgCmd.args[0];
            //const bg = this.database.getObject(bgCmd.args[1].__id);
            const bufferData = this.pipelineState.bindGroups[index].bufferData;
            let binding = 0;
            const bindgroup = {};
            for (const buffer of bufferData) {
                bindgroup[binding++] = buffer;
            }
            bindGroups[index] = bindgroup;
        });

        if (!this.debugger) {
            const code = this.module.descriptor.code;
            this.debugger = new WgslDebug(code, this.runStateChanged.bind(this));
        } else {
            this.debugger.reset();
        }
        this.debugger.debugWorkgroup(kernelName, [idx, idy, idz], dispatchCount, bindGroups);
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
        const div = new Div(parent);
        const type = v.value.typeInfo;
        let typeName = type.name;
        if (type.format) {
            typeName = `${typeName}<${type.format.name}>`;
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

        this.variables.body.removeAllChildren();
        this.globals.body.removeAllChildren();
        this.callstack.body.removeAllChildren();

        let state = this.debugger.currentState;
        if (state === null) {
            const context = this.debugger.context;
            const currentFunctionName = context.currentFunctionName;
            new Div(this.variables.body, { text: currentFunctionName || "<shader>", style: "font-weight: bold; color: #eee; padding-bottom: 2px;" });

            new Div(this.callstack.body, { text: currentFunctionName || "<shader>", style: "font-weight: bold; color: #eee; padding-bottom: 2px;" });

            context.variables.forEach((v, name) => {
                if (!name.startsWith("@")) {
                    this._createVariableDiv(v, this.variables.body);
                }
            });

            context.variables.forEach((v, name) => {
                if (name.startsWith("@")) {
                    this._createVariableDiv(v, this.globals.body);
                }
            });
        } else {
            let lastState = state;
            let lastFunctionName = null;
            while (state !== null) {
                const context = state.context;
                const currentFunctionName = context.currentFunctionName || "<shader>";

                new Div(this.variables.body, { text: currentFunctionName, style: "font-weight: bold; color: #eee; padding-bottom: 2px;" });

                if (currentFunctionName !== lastFunctionName) {
                    new Div(this.callstack.body, { text: currentFunctionName, style: "font-weight: bold; color: #eee; padding-bottom: 2px;" });
                }

                lastFunctionName = currentFunctionName;

                context.variables.forEach((v, name) => {
                    if (!name.startsWith("@")) {
                        this._createVariableDiv(v, this.variables.body);
                    }
                });

                lastState = state;
                state = state.parent;
            }

            if (lastState) {
                const context = lastState.context;
                context.variables.forEach((v, name) => {
                    if (name.startsWith("@")) {
                        this._createVariableDiv(v, this.globals.body);
                    }
                });
            }
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
