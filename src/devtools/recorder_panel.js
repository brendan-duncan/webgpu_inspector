import { Button } from "./widget/button.js";
import { Div } from "./widget/div.js";
import { Input } from "./widget/input.js";
import { Span } from "./widget/span.js";
import { Widget } from "./widget/widget.js";
import { PanelActions } from "../utils/actions.js";

export class RecorderPanel {
  constructor(window, parent) {
    this.window = window;
    this._recordingData = [];
    
    const self = this;
    const port = window.port;

    const recorderBar = new Div(parent, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 5px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px; width: calc(-60px + 100vw);" });

    this.recordButton = new Button(recorderBar, { label: "Record", style: "background-color: #755;", callback: () => {
      const frames = self.recordFramesInput.value || 1;
      const filename = self.recordNameInput.value;
      self._recordingData.length = 0;
      port.postMessage({ action: PanelActions.InitializeRecorder, frames, filename });
    }});

    new Span(recorderBar, { text: "Frames:", style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });
    this.recordFramesInput = new Input(recorderBar, { id: "record_frames", type: "number", value: 10 });

    new Span(recorderBar, { text: "Name:", style: "margin-left: 20px; margin-right: 10px;  vertical-align: middle;" });
    this.recordNameInput = new Input(recorderBar, { id: "record_frames", type: "text", value: "webgpu_record" });

    this.recorderDataPanel = new Div(parent);

    port.addListener((message) => {
      switch (message.action) {
        case "webgpu_recording": {
          if (message.index !== undefined && message.count !== undefined && message.data !== undefined) {
            self._addRecordingData(message.data, message.index, message.count);
          }
          break;
        }
      }
    });
  }

  _addRecordingData(data, index, count) {
    try {
      index = parseInt(index);
      count = parseInt(count);
    } catch (e) {
      return;
    }

    if (this._recordingData.length == 0) {
      this._recordingData.length = count;
    }

    if (this._recordingData.length != count) {
      console.log("Invalid Recording Chunk count", count, this._recordingData.length);
      return;
    }

    if (index >= count) {
      console.log("Invalid Recording Chunk index", index, count);
      return;
    }

    this._recordingData[index] = data;

    let pending = false;
    let missingIndex = null;
    for (let i = 0; i < count; ++i) {
      if (this._recordingData[i] === undefined) {
        pending = true;
        missingIndex = i;
        break;
      }
    }
    if (pending) {
      return;
    }

    this.recorderDataPanel.html = "";

    // TODO: How to display the recording file?

    const html = this._recordingData.join();
    new Widget("pre", this.recorderDataPanel, { text: html });

    //const nonceData = new Uint8Array(16);
    //const nonce = encodeBase64(crypto.getRandomValues(nonceData));
    //const html = this._recordingData.join().replace("<script>", `<script nonce="${nonce}">`).replace("script-src *", `script-src * 'nonce-${nonce}' strict-dynamic`);

    /*const f = document.createElement("iframe");
    f.sandbox = "allow-scripts";
    //const url = 'data:text/html;charset=utf-8,' + encodeURI(html);
    const url = URL.createObjectURL(new Blob([html], {type: 'text/html'}));
    f.src = url;

    new Widget(f, this.recorderDataPanel, { style: "width: calc(100% - 10px);" });*/

    //f.contentWindow.document.open();
    //f.contentWindow.document.write(html);
    //f.contentWindow.document.close();
  }
}
