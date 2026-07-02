import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { Split } from "./widget/split.js";
import { Img } from "./widget/img.js";
import { collapsible } from "./widget/collapsible.js";
import { WgslDebug, detectRaces, createFragmentQuadDebugger } from "wgsl_reflect/wgsl_reflect.module.js";
import { ShaderWatchView, resolveVariablePath, formatDataValue } from "./shader_watch_view.js";
import { fetchVertexInputs } from "./vertex_fetcher.js";
import { assembleTriangles, buildFragmentQuad } from "./fragment_debug.js";
import { QuadDebuggerAdapter } from "./quad_debugger_adapter.js";
import { buildBindGroups, collectVertexBufferData, decodeIndexArray, makeVertexRunner } from "./stage_debug_utils.js";

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
import { TextInput } from "./widget/text_input.js";

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

    const dbg = view.debugger;
    if (!dbg?.debugger) {
        return null;
    }
    const context = dbg.debugger.context;
    if (!context) {
        return null;
    }
    const exec = dbg.debugger._exec;

    // Resolve the full member/index chain ("material.alphaCutoff",
    // "lights[2].color") so hovering a struct member shows that member's
    // value. Chains with non-literal indices fall back to the root variable.
    let data = resolveVariablePath(exec, context, name);
    if (!data && /[.\[\]]/.test(name)) {
        const match = name.match(/^(\w+)/);
        if (match) {
            name = match[1];
            data = resolveVariablePath(exec, context, name);
        }
    }
    if (!data) {
        return null;
    }

    const formatted = formatDataValue(data, exec, context);
    const tip = `${name}: ${data.typeInfo.getTypeName()} = ${formatted.text}`;

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
        // Which shader stage this debugger drives: "compute" (default),
        // "vertex", or "fragment". Compute uses debugWorkgroup; vertex uses
        // debugVertex. The stepping/watch/callstack surface is identical.
        this.stage = options?.stage ?? "compute";

        this.pipelineState = this.capturePanel._getPipelineState(command);
        const pipelineCmd = this.pipelineState.pipeline;

        const pipeline = database.getObject(pipelineCmd.args[0]?.__id);
        const desc = pipeline.descriptor;
        this.pipelineDesc = desc;

        let moduleId;
        if (this.stage === "vertex") {
            moduleId = desc.vertex?.module?.__id;
        } else if (this.stage === "fragment") {
            moduleId = desc.fragment?.module?.__id;
        } else {
            moduleId = desc.compute?.module?.__id;
        }
        this.module = database.getObject(moduleId);

        const code = this.module.descriptor.code;

        // Initial invocation selection, optionally seeded by the caller (e.g.
        // pixel history's per-fragment Debug buttons).
        this._idX = 0;
        this._idY = 0;
        this._idZ = 0;
        this._vertexIndex = Math.floor(options?.vertexIndex ?? 0);
        this._instanceIndex = Math.floor(options?.instanceIndex ?? 0);
        this._pixelX = Math.floor(options?.pixelX ?? 0);
        this._pixelY = Math.floor(options?.pixelY ?? 0);
        // The primitive (triangle index) to debug; -1 selects the front-most
        // primitive covering the pixel.
        this._primitiveIndex = Math.floor(options?.primitiveIndex ?? -1);

        this.controls = new Div(this, { style: "display: flex; flex-direction: row; margin-top: 5px;" });
        this._buildInvocationPicker(this.controls);

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

        if (this.stage === "compute") {
            this.detectRacesButton = new Button(this.controls, {
                text: "Detect Races",
                title: "Scan the workgroup for data races caused by missing barriers",
                style: "background-color: #777;",
                onClick: () => {
                    this._detectRaces();
                }
            });
        }

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

        this.variables = new collapsible(this.watch, { collapsed: false, label: `Variables` });

        const variableFilterRow = new Div(this.variables.body, { class: "watch-filter" });
        this.variableFilter = new TextInput(variableFilterRow, {
            class: "watch-filter-input",
            placeholder: "Filter variables by name",
            onEdit: (value) => {
                this.watchVariables.setFilter(value);
            }
        });

        this.watchVariables = new ShaderWatchView(this.variables.body);

        this.callstack = new collapsible(this.watch, { collapsed: false, label: `Callstack` });

        if (this.stage === "compute") {
            this.raceDetection = new collapsible(this.watch, { collapsed: false, label: `Race Detection` });
            new Div(this.raceDetection.body, { class: "race-hint", text: "Press “Detect Races” to scan the workgroup for data races." });
        }

        this.debug();
    }

    // Build the stage-specific invocation picker: X/Y/Z thread id for compute,
    // or vertex-index + instance-index for a vertex shader.
    _buildInvocationPicker(controls) {
        const numberStyle = "flex: 0 0 auto; display: inline-block; width: 100px; margin-right: 10px; vertical-align: middle;";
        const labelStyle = "margin-left: 10px; margin-right: 5px; vertical-align: middle; color: #bbb;";

        if (this.stage === "vertex") {
            new Span(controls, { text: "Vertex:", style: labelStyle });
            this.vertexInput = new NumberInput(controls, {
                value: this._vertexIndex, min: 0, step: 1, precision: 0, style: numberStyle,
                onChange: (value) => { this._vertexIndex = value; }
            });
            new Span(controls, { text: "Instance:", style: labelStyle });
            this.instanceInput = new NumberInput(controls, {
                value: this._instanceIndex, min: 0, step: 1, precision: 0, style: numberStyle,
                onChange: (value) => { this._instanceIndex = value; }
            });
        } else if (this.stage === "fragment") {
            new Span(controls, { text: "Pixel X:", style: labelStyle });
            this.pixelXInput = new NumberInput(controls, {
                value: this._pixelX, min: 0, step: 1, precision: 0, style: numberStyle,
                onChange: (value) => { this._pixelX = value; }
            });
            new Span(controls, { text: "Y:", style: labelStyle });
            this.pixelYInput = new NumberInput(controls, {
                value: this._pixelY, min: 0, step: 1, precision: 0, style: numberStyle,
                onChange: (value) => { this._pixelY = value; }
            });
            new Span(controls, { text: "Instance:", style: labelStyle });
            this.instanceInput = new NumberInput(controls, {
                value: this._instanceIndex, min: 0, step: 1, precision: 0, style: numberStyle,
                onChange: (value) => { this._instanceIndex = value; }
            });
            new Span(controls, { text: "Prim:", title: "Primitive (triangle) index to debug; -1 selects the front-most primitive covering the pixel", style: labelStyle });
            this.primitiveInput = new NumberInput(controls, {
                value: this._primitiveIndex, min: -1, step: 1, precision: 0, style: numberStyle,
                onChange: (value) => { this._primitiveIndex = value; }
            });
            this._fragmentStatus = new Span(controls, {
                style: "margin-left: 10px; vertical-align: middle; color: #e8a; align-self: center;"
            });
        } else {
            new Span(controls, { text: "Thread ID:", style: labelStyle });
            this.idXInput = new NumberInput(controls, {
                value: 0, min: 0, precision: 0, step: 1, style: numberStyle,
                onChange: (value) => { this._idX = value; }
            });
            this.idYInput = new NumberInput(controls, {
                value: 0, min: 0, step: 1, precision: 0, style: numberStyle,
                onChange: (value) => { this._idY = value; }
            });
            this.idZInput = new NumberInput(controls, {
                value: 0, min: 0, step: 1, precision: 0, style: numberStyle,
                onChange: (value) => { this._idZ = value; }
            });
        }
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
            this.watchVariables.commitValues();
            this.debugger.run();
            this.update();
        }
    }

    restart() {
        this.debug();
    }

    debug() {
        this.watchVariables?.reset();
        if (this.variableFilter) {
            this.variableFilter.value = "";
        }

        if (this.stage === "vertex") {
            const config = this._buildVertexConfig();
            if (!config) {
                return;
            }
            this.debugger = new WgslDebug(config.code, this.runStateChanged.bind(this));
            this.debugger.debugVertex(config.entryName, config.inputs, config.bindGroups, config.options);
            this.update();
            return;
        }

        if (this.stage === "fragment") {
            const config = this._buildFragmentConfig();
            if (!config) {
                this.debugger = null;
                this._highlightLine(0);
                return;
            }
            const { scheduler, errors } = createFragmentQuadDebugger(
                config.code, config.entryName, config.quadInputs, config.bindGroups, config.targetLane, config.options);
            if (!scheduler) {
                console.error("Fragment debug setup failed:", errors);
                this.debugger = null;
                return;
            }
            this.debugger = new QuadDebuggerAdapter(scheduler, this.runStateChanged.bind(this));
            this.update();
            return;
        }

        const config = this._buildDebugConfig();
        if (!config) {
            return;
        }

        const idx = Math.floor(this._idX);
        const idy = Math.floor(this._idY);
        const idz = Math.floor(this._idZ);

        this.debugger = new WgslDebug(config.code, this.runStateChanged.bind(this));
        this.debugger.debugWorkgroup(config.kernelName, [idx, idy, idz], config.dispatchCount, config.bindGroups, config.options);
        this.update();
    }

    // Gather the shader source, entry point, dispatch dimensions and bound
    // resources needed to run the debugger or the race detector. Returns null
    // if the shader can't be set up (e.g. it has no compute reflection).
    _buildDebugConfig() {
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
            return null;
        }

        let kernel = null;
        if (this.entry) {
            kernel = reflection.entry.compute.find((k) => k.name === this.entry);
        }

        if (!kernel) {
            kernel = reflection.entry.compute[0]
            if (!kernel) {
                return null;
            }
        }

        const kernelName = kernel.name;

        const bindGroups = this._buildBindGroups();

        const pipeline = this.database.getObject(this.pipelineState.pipeline.args[0].__id);
        const constants = pipeline?.descriptor?.compute?.constants;

        const options = {};
        if (constants) {
            options.constants = constants;
        }

        const code = this.module.descriptor.code;

        return { code, kernelName, dispatchCount, bindGroups, options };
    }

    // Build the bound-resource map (buffers, uniforms, textures, samplers) that
    // WgslDebug expects, from the captured bind groups. Shared by every stage.
    _buildBindGroups() {
        return buildBindGroups(this.database, this.pipelineState.bindGroups);
    }

    // Gather the source, entry point, per-invocation vertex inputs and bound
    // resources needed to run debugVertex for the selected vertex/instance.
    _buildVertexConfig() {
        const reflection = this.module?.reflection;
        if (!reflection) {
            return null;
        }

        let entry = null;
        if (this.entry) {
            entry = reflection.entry.vertex.find((e) => e.name === this.entry);
        }
        if (!entry) {
            entry = reflection.entry.vertex[0];
        }
        if (!entry) {
            return null;
        }

        // Collect the captured vertex-buffer data, indexed by slot.
        const vertexBufferData = collectVertexBufferData(this.pipelineState.vertexBuffers);

        const inputs = fetchVertexInputs(
            this.pipelineDesc,
            vertexBufferData,
            Math.floor(this._vertexIndex),
            Math.floor(this._instanceIndex),
            entry.inputs);

        const bindGroups = this._buildBindGroups();

        const constants = this.pipelineDesc?.vertex?.constants;
        const options = {};
        if (constants) {
            options.constants = constants;
        }

        return { code: this.module.descriptor.code, entryName: entry.name, inputs, bindGroups, options };
    }

    // Rasterize the draw at the picked pixel and build the four interpolated quad
    // inputs for createFragmentQuadDebugger. Returns null if the shader can't be
    // set up or no primitive covers the pixel.
    _buildFragmentConfig() {
        const fragReflection = this.module?.reflection;
        if (!fragReflection) {
            return null;
        }
        let fragEntry = this.entry ? fragReflection.entry.fragment.find((e) => e.name === this.entry) : null;
        if (!fragEntry) {
            fragEntry = fragReflection.entry.fragment[0];
        }
        if (!fragEntry) {
            return null;
        }

        // The vertex shader (its own module, or the same combined one) is run to
        // produce clip positions + varyings for interpolation.
        const vertexModule = this.database.getObject(this.pipelineDesc.vertex?.module?.__id);
        const vsReflection = vertexModule?.reflection;
        if (!vsReflection) {
            return null;
        }
        const vsEntryName = this.pipelineDesc.vertex?.entryPoint;
        let vsEntry = vsEntryName ? vsReflection.entry.vertex.find((e) => e.name === vsEntryName) : null;
        if (!vsEntry) {
            vsEntry = vsReflection.entry.vertex[0];
        }
        if (!vsEntry) {
            return null;
        }
        const vsCode = vertexModule.descriptor.code;

        // Assemble the draw into triangles.
        const method = this.command.method;
        const args = this.command.args ?? [];
        const topology = this.pipelineDesc.primitive?.topology ?? "triangle-list";
        const frontFace = this.pipelineDesc.primitive?.frontFace ?? "ccw";

        let triangles;
        if (method === "drawIndexed") {
            const indexArray = this._getIndexArray();
            if (!indexArray) {
                return null;
            }
            triangles = assembleTriangles(topology, args[0], indexArray, args[2] ?? 0, args[3] ?? 0);
        } else if (method === "draw") {
            triangles = assembleTriangles(topology, args[0], null, args[2] ?? 0, 0);
        } else {
            this._fragmentMessage("Indirect draws are not supported for fragment debugging yet.");
            return null;
        }
        if (!triangles.length) {
            return null;
        }

        const size = this._getRenderTargetSize();
        if (!size) {
            return null;
        }

        const bindGroups = this._buildBindGroups();

        // Captured vertex-buffer data by slot.
        const vertexBufferData = collectVertexBufferData(this.pipelineState.vertexBuffers);

        const instance = Math.floor(this._instanceIndex);

        // Reuse one WgslDebug for every VS invocation so the code is parsed once.
        const runVertex = makeVertexRunner({
            code: vsCode,
            entryName: vsEntry.name,
            entryInputs: vsEntry.inputs,
            entryOutputs: vsEntry.outputs,
            pipelineDesc: this.pipelineDesc,
            vertexBufferData,
            bindGroups,
            constants: this.pipelineDesc.vertex?.constants,
        });
        const getVertex = (vertexIndex) => runVertex(vertexIndex, instance);

        const primitive = Math.floor(this._primitiveIndex ?? -1);
        const quad = buildFragmentQuad(
            triangles, getVertex, size.width, size.height,
            Math.floor(this._pixelX), Math.floor(this._pixelY), frontFace, primitive);

        if (!quad) {
            this._fragmentMessage(primitive >= 0
                ? `Primitive ${primitive} does not cover pixel (${Math.floor(this._pixelX)}, ${Math.floor(this._pixelY)}).`
                : `No primitive covers pixel (${Math.floor(this._pixelX)}, ${Math.floor(this._pixelY)}).`);
            return null;
        }
        this._fragmentMessage(null);

        const fsConstants = this.pipelineDesc.fragment?.constants;
        const options = fsConstants ? { constants: fsConstants } : {};

        return {
            code: this.module.descriptor.code,
            entryName: fragEntry.name,
            quadInputs: quad.quadInputs,
            targetLane: quad.targetLane,
            bindGroups,
            options,
        };
    }

    // Decode the bound index buffer into a typed array.
    _getIndexArray() {
        return decodeIndexArray(this.pipelineState.indexBuffer);
    }

    // The dimensions of the draw's first color render target.
    _getRenderTargetSize() {
        const colorAttachments = this.pipelineState.renderPass?.args?.[0]?.colorAttachments;
        if (!colorAttachments || !colorAttachments.length) {
            return null;
        }
        const texture = this.capturePanel._getTextureFromAttachment(colorAttachments[0]);
        if (!texture) {
            return null;
        }
        return { width: texture.width, height: texture.height };
    }

    // Show a transient fragment-setup message (e.g. no coverage) in the picker.
    _fragmentMessage(msg) {
        if (this._fragmentStatus) {
            this._fragmentStatus.element.textContent = msg ?? "";
        }
    }

    // Run the wgsl_reflect data-race detector over the shader and display the
    // results in the Race Detection panel.
    _detectRaces() {
        const body = this.raceDetection.body;
        body.removeAllChildren();
        this.raceDetection.collapsed = false;

        const config = this._buildDebugConfig();
        if (!config) {
            new Div(body, { class: "race-error", text: "Unable to set up the shader for race detection." });
            return;
        }

        new Div(body, { class: "race-status", text: "Detecting data races…" });
        this.detectRacesButton.disabled = true;

        // detectRaces is synchronous and can take a moment, so defer it to let
        // the status message paint first. Only a single workgroup is scanned:
        // the detector reports data races within a workgroup, and races between
        // workgroups are not decidable in WebGPU.
        setTimeout(() => {
            let result = null;
            let error = null;
            try {
                const bindGroups = this._cloneBindGroups(config.bindGroups);
                result = detectRaces(config.code, config.kernelName, [1, 1, 1], bindGroups, config.options);
            } catch (e) {
                error = e;
            }

            this.detectRacesButton.disabled = false;
            body.removeAllChildren();

            if (error !== null) {
                new Div(body, { class: "race-error", text: `Race detection failed: ${error}` });
                return;
            }

            this._showRaceResults(result);
        }, 10);
    }

    // Deep-copy the bound buffers so the race detector, which executes the
    // kernel, cannot corrupt the buffers used by the live debug session.
    _cloneBindGroups(bindGroups) {
        const clone = {};
        for (const group in bindGroups) {
            const src = bindGroups[group];
            const dst = {};
            for (const binding in src) {
                const entry = src[binding];
                if (entry instanceof ArrayBuffer) {
                    dst[binding] = entry.slice(0);
                } else if (ArrayBuffer.isView(entry)) {
                    dst[binding] = new entry.constructor(entry);
                } else {
                    // Texture entries are skipped by the detector; pass as-is.
                    dst[binding] = entry;
                }
            }
            clone[group] = dst;
        }
        return clone;
    }

    _showRaceResults(result) {
        const body = this.raceDetection.body;

        const races = result?.races ?? [];
        const errors = result?.errors ?? [];

        if (races.length === 0 && errors.length === 0) {
            new Div(body, { class: "race-clean", text: "No data races detected in the workgroup." });
            return;
        }

        const raceLabel = races.length === 1 ? "data race" : "data races";
        const issueLabel = errors.length === 1 ? "barrier issue" : "barrier issues";
        new Div(body, {
            class: "race-summary",
            text: `Found ${races.length} ${raceLabel} and ${errors.length} ${issueLabel}.`
        });

        for (const race of races) {
            const row = new Div(body, { class: "race-row" });
            new Span(row, { class: "race-row-message", text: race.message });

            const line = race?.a?.line ?? -1;
            if (line > 0) {
                row.title = `Go to line ${line}`;
                row.addEventListener("click", () => {
                    this._highlightLine(line);
                });
            }
        }

        for (const issue of errors) {
            const row = new Div(body, { class: "race-row race-row-issue" });
            new Span(row, { class: "race-row-message", text: issue });
        }
    }

    stepInto() {
        if (this.debugger) {
            this.watchVariables.commitValues();
            this.debugger.stepInto();
            this.update();
        }
    }

    stepOver() {
        if (this.debugger) {
            this.watchVariables.commitValues();
            this.debugger.stepOver();
            this.update();
        }
    }

    stepOut() {
        if (this.debugger) {
            this.watchVariables.commitValues();
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

        this.watchVariables.update(this.debugger._exec, this.debugger.context);

        this._updateCallstack();
    }

    _updateCallstack() {
        this.callstack.body.removeAllChildren();

        // Collect the active function call frames, innermost first. The
        // debugger's state chain has a separate frame for every nested block
        // (if/for/...), so consecutive frames belonging to the same function
        // are collapsed into a single call frame.
        const frames = [];
        let state = this.debugger.currentState;

        if (state === null) {
            const context = this.debugger.context;
            frames.push({
                name: context.currentFunctionName || "<shader>",
                line: this.debugger.currentCommand?.line ?? -1
            });
        } else {
            let lastName = null;
            while (state !== null) {
                const name = state.context.currentFunctionName || "<shader>";
                if (name !== lastName) {
                    frames.push({ name, state });
                    lastName = name;
                }
                state = state.parent;
            }

            for (let i = 0; i < frames.length; ++i) {
                const frame = frames[i];
                // The innermost frame is at the debugger's current command;
                // caller frames are sitting on the call that descended into
                // the next frame.
                let line = i === 0 ? (this.debugger.currentCommand?.line ?? -1) : -1;
                if (line < 0 && frame.state.getCurrentCommand) {
                    line = frame.state.getCurrentCommand()?.line ?? -1;
                }
                frame.line = line;
            }
        }

        if (frames.length === 0) {
            new Div(this.callstack.body, { class: "callstack-empty", text: "Not running" });
            return;
        }

        frames.forEach((frame, index) => {
            const isActive = index === 0;
            const row = new Div(this.callstack.body, {
                class: isActive ? "callstack-frame callstack-frame-active" : "callstack-frame"
            });

            new Img(row, {
                class: "callstack-frame-icon",
                src: isActive ? "img/debug-stackframe-active.svg" : "img/debug-stackframe.svg"
            });

            new Span(row, { class: "callstack-frame-name", text: frame.name });

            if (frame.line > 0) {
                new Span(row, { class: "callstack-frame-line", text: `line ${frame.line}` });
                row.title = `${frame.name} — line ${frame.line}`;
                // Clicking a frame jumps the editor to that line.
                row.addEventListener("click", () => {
                    this._highlightLine(frame.line);
                });
            } else {
                row.title = frame.name;
            }
        });
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
