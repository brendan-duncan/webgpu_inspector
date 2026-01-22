import { Div } from "./widget/div.js";
import { Widget } from "./widget/widget.js";

export class StacktraceViewer extends Div {
  constructor(panel, parent, object, stacktrace) {
    super(parent);

    const patterns = {
      // JavaScript: functionName (http://url:line:column)
      jsWithParens: /^(.+?)\s+\((https?:\/\/.+?):(\d+):(\d+)\)$/,

      // JavaScript without function name: http://url:line:column
      jsNoFunction: /^(https?:\/\/.+?):(\d+):(\d+)$/,

      // WASM: functionName (http://url:wasm-function[index]:offset)
      wasmWithOffset: /^(.+?)\s+\((https?:\/\/.+?):wasm-function\[(\d+)\]:(0x[0-9a-f]+)\)$/,

      // WASM alternative: functionName (http://url:line:column)
      wasmWithLine: /^(.+?)\s+\((https?:\/\/.+?\.wasm):(\d+):(\d+)\)$/
    };

    const stacktraceGrp = panel._getcollapsibleWithState(this, object, "stacktraceCollapsed", "Stacktrace", true);
    const stacktraceBody = new Widget("ol", stacktraceGrp.body, { class: "inspector-stacktrace" });
    const stacktraceLines = stacktrace.split("\n");
    for (const stackLine of stacktraceLines) {
        const trimmed = stackLine.trim();

        let filePath = null;
        let functionName = null;
        let line = null;
        let column = null;
        let columnStr = null;
        let match = null;

        // Try JavaScript with function name and parentheses
        if ((match = trimmed.match(patterns.jsWithParens))) {
          filePath = match[2];
          functionName = match[1];
          line = Math.max(parseInt(match[3], 10) - 1, 0);
          columnStr = match[4];
          column = parseInt(columnStr, 10) - 1;
        }
        // Try WASM with offset
        else if ((match = trimmed.match(patterns.wasmWithOffset))) {
          filePath = match[2];
          functionName = match[1];
          columnStr = match[4];
          column = parseInt(columnStr, 16); // wasm offset
        }
        // Try WASM with line number
        else if ((match = trimmed.match(patterns.wasmWithLine))) {
          filePath = match[2];
          functionName = match[1];
          line = Math.max(parseInt(match[3], 10) - 1, 0);
          columnStr = match[4];
          column = parseInt(columnStr, 10) - 1;
        }
        // Try JavaScript without function name
        else if ((match = trimmed.match(patterns.jsNoFunction))) {
          filePath = match[1];
          line = Math.max(parseInt(match[2], 10) - 1, 0);
          columnStr = match[3];
          column = parseInt(columnStr, 10) - 1;
        }

        if (filePath === null) {
          new Widget("li", stacktraceBody, { text: stackLine });
          return;
        }

        const lineDiv = new Widget("li", stacktraceBody);

        const title = `${functionName || "<anonymous>"} (${filePath}${line !== null ? `:${line}` : ""}${columnStr !== null ? `:${columnStr}` : ""})`;

        const link = new Widget("a", lineDiv, { text: stackLine, title: title });
        link.addEventListener("click", (evt) => {
          evt.preventDefault();
          if (chrome?.devtools?.panels) {
              chrome.devtools.panels.openResource(filePath, line || 0, column);
          } else {
              window.open(filePath, "_blank");
          }
        });
    }
  }
}
