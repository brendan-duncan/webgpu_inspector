import { Div } from "./widget/div.js";

import { EditorView } from "codemirror";
import { keymap, highlightSpecialChars, drawSelection, dropCursor, gutter, GutterMarker,
  crosshairCursor, lineNumbers, highlightActiveLineGutter, Decoration } from "@codemirror/view";
import { EditorState, StateField, StateEffect, RangeSet } from "@codemirror/state";
import { defaultHighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching,
  foldGutter, foldKeymap } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";
import { wgsl } from "../thirdparty/codemirror_lang_wgsl.js";
import { cobalt } from 'thememirror';

const breakpointEffect = StateEffect.define({
    map: (val, mapping) => ({ pos: mapping.mapPos(val.pos), on: val.on })
});

const breakpointState = StateField.define({
    create() { return RangeSet.empty; },
    update(set, transaction) {
      set = set.map(transaction.changes);
      for (let e of transaction.effects) {
        if (e.is(breakpointEffect)) {
          if (e.value.on) {
            set = set.update({add: [breakpointMarker.range(e.value.pos)]});
          } else {
            set = set.update({filter: from => from != e.value.pos});
          }
        }
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
    //toDOM() { return document.createTextNode("🔴") } // TODO: why doesn't this UTF-8 work in devtools?
    toDOM() { return document.createTextNode("*") }
};

const breakpointGutter = [
    breakpointState,
    gutter({
      class: "cm-breakpoint-gutter",
      markers: v => v.state.field(breakpointState),
      initialSpacer: () => breakpointMarker,
      domEventHandlers: {
        mousedown(view, line) {
          toggleBreakpoint(view, line.from)
          return true
        }
      }
    }),
  
    EditorView.baseTheme({
      ".cm-breakpoint-gutter .cm-gutterElement": {
        color: "red",
        paddingLeft: "5px",
        cursor: "default"
      }
    })
];

const addLineHighlight = StateEffect.define({
    map: (val, mapping) => ({ lineNo: mapping.mapPos(val.lineNo) })
});

const lineHighlightField = StateField.define({
    create() {
      return Decoration.none;
    },
    update(lines, tr) {
      lines = lines.map(tr.changes);
      for (let e of tr.effects) {
        if (e.is(addLineHighlight)) {
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
    lineHighlightField,
    lineNumbers(),
    highlightActiveLineGutter(),
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
    constructor(command, data, database, options) {
        super(null, options);
        this._element.classList.add('shader-debugger');

        this.captureData = data;
        this.database = database;
        const args = command.args;
        const id = args[0]?.__id;
        const pipeline = database.getObject(id);
        const desc = pipeline.descriptor;
        const computeId = desc.compute?.module?.__id;
        const computeModule = database.getObject(computeId);

        const code = computeModule.descriptor.code;

        new EditorView({
            doc: code,
            extensions: [
                shaderEditorSetup
            ],
            parent: this.element,
        });
    }
}
