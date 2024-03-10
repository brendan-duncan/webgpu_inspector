import { Button } from "./widget/button.js";
import { Collapsable } from "./widget/collapsable.js";
import { Div } from "./widget/div.js";
import { Input } from "./widget/input.js";
import { Span } from "./widget/span.js";
import { Split } from "./widget/split.js";
import { Widget } from "./widget/widget.js";
import { Actions, PanelActions } from "../utils/actions.js";
import { RecorderData } from "./recorder_data.js";
import { NumberInput } from "./widget/number_input.js";

export class RecorderPanel {
  constructor(window, parent) {
    this.window = window;

    this._recorderData = new RecorderData();
    this._recorderData.onReady.addListener(this._recordingReady, this);
    
    const self = this;
    const port = window.port;

    const recorderBar = new Div(parent, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 5px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px;" });

    this.recordButton = new Button(recorderBar, { label: "Record", style: "background-color: #755;", callback: () => {
      const frames = self.recordFramesInput.value || 1;
      const filename = self.recordNameInput.value;
      self._recorderData.clear();
      port.postMessage({ action: PanelActions.InitializeRecorder, frames, filename });
    }});

    new Span(recorderBar, { text: "Frames:", style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });
    this.recordFramesInput = new Input(recorderBar, { id: "record_frames", type: "number", value: 10 });

    new Span(recorderBar, { text: "Name:", style: "margin-left: 20px; margin-right: 10px;  vertical-align: middle;" });
    this.recordNameInput = new Input(recorderBar, { id: "record_frames", type: "text", value: "webgpu_record" });

    this.recorderDataPanel = new Div(parent, { style: "width: 100%; height: calc(-80px + 100vh); position: relative;" });

    port.addListener((message) => {
      switch (message.action) {
        case Actions.RecordingData: {
          const data = message.data;
          const type = message.type;
          const index = message.index;
          const count = message.count;
          self._recorderData.addData(data, type, index, count);
          break;
        }
        case Actions.RecordingCommand: {
          const command = message.command;
          const commandIndex = message.commandIndex;
          const frame = message.frame;
          const index = message.index;
          const count = message.count;
          self._recorderData.addCommand(command, commandIndex, frame, index, count);
          break;
        }
      }
    });
  }

  _recordingReady() {
    this.recorderDataPanel.html = "";

    const self = this;

    const controls = new Div(this.recorderDataPanel, { style: "background-color: #333; padding: 10px; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000;" });

    const lastFrame = this._recorderData.frames.length - 1;
    new Span(controls, { text: "Frame:", style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });
    new NumberInput(controls, { precision: 0, value: lastFrame, min: 0, max: lastFrame, style: "width: 60px; display: inline-block;", onChange: (value) => {
      self._recorderData.executeCommands(canvas, value);
    } });

    const split = new Split(this.recorderDataPanel, { direction: Split.Horizontal, position: 800, style: "height: calc(-118px + 100vh);" });

    const canvas = new Widget("canvas", new Div(split, { style: "overflow: auto;" }));
    canvas.element.width = 800;
    canvas.element.height = 600;

    const commands = new Div(split, { style: "overflow: auto;" });

    split.position = 800;

    let grp = new Collapsable(commands, { label: "Initialize Commands", collapsed: true });
    let ol = new Widget("ol", grp.body);
    for (const command of this._recorderData.initiazeCommands) {
      const result = `${command.result ? `${command.result} = ` : ""}`;
      const async = `${command.async ? command.async + " " : ""}`;
      const text = `${result}${async}${command.object}.${command.method}(${JSON.stringify(command.args)})`;
      new Widget("li", ol, { text });
    }

    for (let i = 0; i < this._recorderData.frames.length; ++i) {
      grp = new Collapsable(commands, { label: `Frame ${i}`, collapsed: true });
      ol = new Widget("ol", grp.body);
      for (const command of this._recorderData.frames[i]) {
        const result = `${command.result ? `${command.result} = ` : ""}`;
        const async = `${command.async ? command.async + " " : ""}`;
        const text = `${result}${async}${command.object}.${command.method}(${JSON.stringify(command.args)})`;
        new Widget("li", ol, { text });
      }
    }

    this._recorderData.executeCommands(canvas, lastFrame);
  }
}
