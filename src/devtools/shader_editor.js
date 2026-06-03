import { EditorView } from "codemirror";
import { keymap, highlightSpecialChars, drawSelection, dropCursor,
  crosshairCursor, lineNumbers, highlightActiveLineGutter } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultHighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching,
  foldGutter, foldKeymap } from "@codemirror/language";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, openSearchPanel } from "@codemirror/search";
import { autocompletion, completionKeymap, closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { lintKeymap } from "@codemirror/lint";
import { wgsl } from "../thirdparty/codemirror_lang_wgsl.js";
import { cobalt } from 'thememirror';
import { Button } from "./widget/button.js";
import { Div } from "./widget/div.js";
import { PanelActions } from "../utils/actions.js";

const shaderEditorSetup = (() => [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  history(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  syntaxHighlighting(defaultHighlightStyle, {fallback: true}),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
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

export class ShaderEditor extends Div {
  constructor(panel, parent, object, onRefresh) {
    super(parent);
    this.panel = panel;

    // Fill the parent vertically as a flex column: the compile row takes its
    // natural height and the editor area fills the rest, so there's no gap at
    // the bottom regardless of the parent's height.
    this.element.style.cssText = "height: 100%; min-height: 0; display: flex; flex-direction: column;";

    const text = object.replacementCode || object.descriptor.code;

    const isModified = object.replacementCode && object.replacementCode !== object.descriptor.code;
    const compileRow = new Div(this, { style: "flex: 0 0 auto;" });
    const compileButton = new Button(compileRow, { label: "Compile", style: "background-color: rgb(200, 150, 51);" });
    const revertButton = isModified ? new Button(compileRow, { label: "Revert", style: "background-color: rgb(200, 150, 51);" }) : null;

    const editorDiv = new Div(this, { class: "shader-editor-cm", style: "flex: 1 1 auto; min-height: 0; overflow: hidden;" });

    const editor = new EditorView({
      doc: text,
      extensions: [ shaderEditorSetup ],
      parent: editorDiv.element,
    });

    // Ctrl/Cmd+F should open the editor's own search panel and focus its Find
    // input rather than triggering the browser's page-find. CodeMirror's
    // searchKeymap only handles this while the view has focus and the keydown
    // can still reach the host page, so intercept it for the whole editor area.
    this.element.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        e.stopPropagation();
        openSearchPanel(editor);
        // openSearchPanel focuses the field when it first opens; refocus
        // explicitly so a repeat Ctrl+F (panel already open) lands there too.
        const field = editorDiv.element.querySelector(".cm-search input");
        if (field) {
          field.focus();
          field.select();
        }
      }
    }, true);

    if (object.__line) {
      const line = editor.state.doc.line(object.__line);
      editor.dispatch({
        selection: { anchor: line.from, head: line.from },
        scrollIntoView: true,
      });
    }

    compileButton.callback = () => {
      const { head } = editor.state.selection.main;
      const line = editor.state.doc.lineAt(head);

      object.__line = line.number;

      const code = editor.state.doc.toString();
      if (code === object.descriptor.code) {
        this._revertShader(object);
        object.replacementCode = null;
        if (onRefresh) {
            onRefresh(object);
        }
      } else {
        this._compileShader(object, code);
        object.replacementCode = code;
        if (onRefresh) {
            onRefresh(object);
        }
      }
    };

    if (revertButton) {
      revertButton.callback = () => {
        const { head } = editor.state.selection.main;
        const line = editor.state.doc.lineAt(head);
        object.__line = line.number;

        this._revertShader(object);
        object.replacementCode = null;
        if (onRefresh) {
            onRefresh(object);
        }
      };
    }
  }

  _revertShader(object) {
    this.panel.port.postMessage({ action: PanelActions.RevertShader, id: object.id });
  }

  _compileShader(object, code) {
    if (code === object.code) {
      return;
    }
    if (object.widget) {
      object.widget.element.classList.remove("error");
      object.widget.tooltip = "";
      for (const child of object.widget.children) {
        child.tooltip = "";
      }
    }
    this.panel.database.removeErrorsForObject(object.id);
    this.panel.port.postMessage({ action: PanelActions.CompileShader, id: object.id, code });
  }
}
