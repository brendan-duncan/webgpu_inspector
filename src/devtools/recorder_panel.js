import { Button } from "./widget/button.js";
import { Checkbox } from "./widget/checkbox.js";
import { collapsible } from "./widget/collapsible.js";
import { Div } from "./widget/div.js";
import { Input } from "./widget/input.js";
import { Select } from "./widget/select.js";
import { Span } from "./widget/span.js";
import { Split } from "./widget/split.js";
import { Widget } from "./widget/widget.js";
import { Actions, PanelActions } from "../utils/actions.js";
import { RecorderData } from "./recorder_data.js";
import { NumberInput } from "./widget/number_input.js";
import { TextInput } from "./widget/text_input.js";

// Recording modes shown in the Mode dropdown, in display order. All map to the recorder's
// stateful recordMode 2; they differ only in which absolute frame indices get captured.
const RecordModeIndex = {
  Range: 0,     // contiguous start..end, one file per frame
  Single: 1,    // a single arbitrary frame
  Multi: 2,     // explicit comma-separated list, e.g. "5,10"
  OnDemand: 3   // no preset frames; capture is triggered at runtime via the Capture button
};

export class RecorderPanel {
  constructor(window, parent) {
    this.window = window;

    this._recorderData = new RecorderData(window);
    this._recorderData.onReady.addListener(this._recordingReady, this);
    this._recordingStarted = false;

    const self = this;
    const port = window.port;

    const recorderBar = new Div(parent, { class: "control-bar" });

    this.recordButton = new Button(recorderBar, { label: "Record", class: "btn btn-success", callback: () => {
      self._startRecording();
    }});

    // On-demand only: fires a runtime trigger to capture the next frame. Hidden until an
    // on-demand recording has been started, and whenever a different mode is selected.
    this.captureButton = new Button(recorderBar, { label: "Capture Frame", class: "btn btn-primary ml-sm", callback: () => {
      port.postMessage({ action: PanelActions.RecordFrame });
    }});
    this.captureButton.element.style.display = "none";

    new Span(recorderBar, { text: "Mode:", class: "text-secondary ml-sm mr-sm" });
    this.modeSelect = new Select(recorderBar, {
      options: ["Frame Range", "Single Frame", "Multi-Frame", "On Demand"],
      index: RecordModeIndex.Range,
      style: "width: 120px;",
      onChange: () => { self._updateModeUI(); }
    });

    // Frame Range: contiguous [start..end] inclusive.
    this.rangeGroup = new Span(recorderBar);
    new Span(this.rangeGroup, { text: "Start:", class: "text-secondary ml-sm mr-sm" });
    this.rangeStartInput = new Input(this.rangeGroup, { type: "number", value: 0, style: "width: 60px;" });
    new Span(this.rangeGroup, { text: "End:", class: "text-secondary ml-sm mr-sm" });
    this.rangeEndInput = new Input(this.rangeGroup, { type: "number", value: 10, style: "width: 60px;" });

    // Single Frame: one arbitrary absolute frame index.
    this.singleGroup = new Span(recorderBar);
    new Span(this.singleGroup, { text: "Frame:", class: "text-secondary ml-sm mr-sm" });
    this.singleFrameInput = new Input(this.singleGroup, { type: "number", value: 0, style: "width: 60px;" });

    // Multi-Frame: explicit comma-separated list of absolute frame indices.
    this.multiGroup = new Span(recorderBar);
    new Span(this.multiGroup, { text: "Frames:", class: "text-secondary ml-sm mr-sm" });
    this.multiFramesInput = new Input(this.multiGroup, { type: "text", value: "5,10", style: "width: 100px;" });

    // On Demand: track state and wait for the Capture button. Continuous keeps tracking after
    // a capture so multiple frames can be grabbed in one session.
    this.onDemandGroup = new Span(recorderBar);
    this._continuousCheckbox = new Checkbox(this.onDemandGroup, { label: "Continuous", tooltip: "Keep recording so multiple frames can be captured", checked: true, class: "ml-sm" });

    this._downloadCheckbox = new Checkbox(recorderBar, { label: "Download", tooltip: "Automatically Download Recording", checked: true, class: "ml-sm" });

    new Span(recorderBar, { text: "Name:", class: "text-secondary ml-sm mr-sm" });
    this.recordNameInput = new Input(recorderBar, { type: "text", value: "webgpu_record" });

    this._updateModeUI();

    // Flex column with a fixed height so the command list scrolls inside the split instead of
    // growing the panel past the viewport (which gave the whole devtools page a scrollbar).
    this.recorderDataPanel = new Div(parent, { style: "width: 100%; height: calc(-85px + 100vh); position: relative; display: flex; flex-direction: column; overflow: hidden;" });

    port.addListener((message) => {
      switch (message.action) {
        case Actions.RecordingDataCount: {
          if (message.count === 0) {
            self._recorderData.dataReady = true;
          }
          break;
        }
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

  // Show only the inputs relevant to the selected mode, and reveal the Capture button only for
  // an in-progress on-demand recording.
  _updateModeUI() {
    const idx = this.modeSelect.index;
    const show = (group, visible) => { group.element.style.display = visible ? "inline" : "none"; };
    show(this.rangeGroup, idx === RecordModeIndex.Range);
    show(this.singleGroup, idx === RecordModeIndex.Single);
    show(this.multiGroup, idx === RecordModeIndex.Multi);
    show(this.onDemandGroup, idx === RecordModeIndex.OnDemand);
    this.captureButton.element.style.display =
      (idx === RecordModeIndex.OnDemand && this._recordingStarted) ? "inline-block" : "none";
  }

  // Build the recorder config for the selected mode and (re)load the page with it armed.
  _startRecording() {
    const port = this.window.port;
    const filename = this.recordNameInput.value;
    const download = this._downloadCheckbox.checked;
    const idx = this.modeSelect.index;

    // All modes use stateful recordMode 2; they differ only in recordFrame / continuous.
    const recordMode = 2;
    let recordFrame = ""; // comma-joined string; empty means "wait for a runtime trigger".
    let continuous = false;

    if (idx === RecordModeIndex.Range) {
      const start = parseInt(this.rangeStartInput.value, 10) || 0;
      const end = parseInt(this.rangeEndInput.value, 10) || 0;
      const lo = Math.min(start, end);
      const hi = Math.max(start, end);
      const list = [];
      for (let f = lo; f <= hi; ++f) {
        list.push(f);
      }
      recordFrame = list.join(",");
    } else if (idx === RecordModeIndex.Single) {
      recordFrame = `${parseInt(this.singleFrameInput.value, 10) || 0}`;
    } else if (idx === RecordModeIndex.Multi) {
      // Normalize whitespace; the loader/recorder split on commas.
      recordFrame = this.multiFramesInput.value
        .split(",").map((s) => s.trim()).filter((s) => s !== "").join(",");
    } else if (idx === RecordModeIndex.OnDemand) {
      recordFrame = "";
      continuous = this._continuousCheckbox.checked;
    }

    this._recorderData.clear();
    port.postMessage({
      action: PanelActions.InitializeRecorder,
      frames: 1, filename, download, recordMode, recordFrame, continuous
    });

    this._recordingStarted = idx === RecordModeIndex.OnDemand;
    this._updateModeUI();
  }

  _recordingReady() {
    this.recorderDataPanel.html = "";

    const self = this;

    const controls = new Div(this.recorderDataPanel, { class: "control-bar", style: "flex: 0 0 auto;" });

    const lastFrame = this._recorderData.frames.length - 1;
    new Span(controls, { text: "Frame:", class: "text-secondary ml-sm mr-sm" });
    new NumberInput(controls, { precision: 0, value: lastFrame, min: 0, max: lastFrame, style: "width: 60px;", onChange: (value) => {
      self._recorderData.executeCommands(canvas, value);
    } });

    // Fill the remaining height under the controls bar; the panes scroll internally.
    const split = new Split(this.recorderDataPanel, { direction: Split.Horizontal, position: 800, style: "flex: 1 1 auto; min-height: 0;" });

    const canvas = new Widget("canvas", new Div(split, { style: "overflow: auto;" }));
    canvas.element.width = 800;
    canvas.element.height = 600;

    const commands = new Div(split, { style: "overflow: auto;" });

    split.position = 800;

    const filterArea = new Div(commands, { class: "capture_filterArea" });
    new Span(filterArea, { text: "Filter: ", class: "mr-sm" });
    this.filterEdit = new TextInput(filterArea, { style: "width: 200px;", placeholder: "Filter", onEdit: (value) => {
      self._filterCommands(value);
    } });

    let grp = new collapsible(commands, { label: "Initialize Commands", collapsed: true });
    this._captureFrameResults(grp.body, this._recorderData.initializeCommands, canvas, -1);

    for (let i = 0; i < this._recorderData.frames.length; ++i) {
      if (this._recorderData.frames[i]) {
        grp = new collapsible(commands, { label: `Frame ${i}`, collapsed: true });
        this._captureFrameResults(grp.body, this._recorderData.frames[i], canvas, i);
      }
    }

    this._recorderData.executeCommands(canvas, lastFrame);
  }

  _filterCommands(filter) {
    function filterCommands(commands) {
      for (let commandIndex = 0, numCommands = commands.length; commandIndex < numCommands; ++commandIndex) {
        const command = commands[commandIndex];
        if (!command) {
          break;
        }
        const method = command.method;
        const widget = command.widget;
        if (widget) {
          if (method.includes(filter)) {
            widget.element.style.display = "block";
          } else {
            widget.element.style.display = "none";
          }
        }
      }
    }

    filterCommands(this._recorderData.initializeCommands);
    for (let i = 0; i < this._recorderData.frames.length; ++i) {
      filterCommands(this._recorderData.frames[i]);
    }
  }

  _captureFrameResults(_frameContents, commands, canvas, frameIndex) {
    const self = this;

    if (commands === undefined) {
      return;
    }

    this._passEncoderCommands = new Map();

    const frameContents = new Div(_frameContents, { class: "capture_frame" });

    const debugGroupStack = [frameContents];
    const debugGroupLabelStack = [];
    let debugGroupIndex = 0;

    let currentBlock = new Div(frameContents, { class: "capture_commandBlock" });

    this._lastSelectedCommand = null;

    //const stats = this.statistics;
    //stats.reset();

    const passEncoderMap = new Map();

    // Pass index is based on end, not begin, so we need to prepare the pass index map first.
    let renderPassIndex = 0;
    let computePassIndex = 0;
    for (let commandIndex = 0, numCommands = commands.length; commandIndex < numCommands; ++commandIndex) {
      const command = commands[commandIndex];
      command.id = commandIndex;
      const method = command.method;
      if (method === "beginRenderPass") {
        passEncoderMap.set(command.result, -1);
      } else if (method === "beginComputePass") {
        passEncoderMap.set(command.result, -2);
      } else if (method === "end") {
        const type = passEncoderMap.get(command.object);
        if (type === -1) {
          passEncoderMap.set(command.object, renderPassIndex++);
        } else if (type === -2) {
          passEncoderMap.set(command.object, computePassIndex++);
        }
      }
    }

    let nestedDebugGroup = 0;

    let first = true;
    for (let commandIndex = 0, numCommands = commands.length; commandIndex < numCommands; ++commandIndex) {
      const command = commands[commandIndex];
      if (!command) {
        break;
      }
      const className = command.class;
      const method = command.method;
      const args = command.args;
      const name = `${className ?? "__"}`;

      //stats.updateStats(this.database, command);

      // skip empty debug groups
      if (method === "pushDebugGroup") {
        let index = commandIndex + 1;
        let nextCommand = commands[index];
        let found = false;
        let nestedGroup = 1;
        while (nextCommand) {
          const nextMethod = nextCommand.method;
          if (nextMethod === "pushDebugGroup") {
            nestedGroup++;
          } else if (nextMethod === "popDebugGroup") {
            nestedGroup--;
            if (nestedGroup === 0) {
              break;
            }
          } else {
            found = true;
            break;
          }
          index++;
          nextCommand = commands[index];
        }

        if (!found) {
          commandIndex = index;
          continue;
        }
      }

      let debugGroup = debugGroupStack[debugGroupStack.length - 1];

      if (method === "beginRenderPass") {
        const passIndex = passEncoderMap.get(command.result);

        this._passEncoderCommands.set(command.result, [command]);

        command._passIndex = passIndex;
        if (!currentBlock.children.length) {
          currentBlock.remove();
        }
        currentBlock = new Div(debugGroup, { class: "capture_renderpass" });

        const header = new Div(currentBlock, { id: `RenderPass_${passIndex}`, class: "capture_renderpass_header" });
        const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;"});
        new Span(header, { text: `Render Pass ${passIndex}` });
        const extra = new Span(header, { style: "margin-left: 10px;" });
        const block = new Div(currentBlock, { class: "capture_renderpass_block" });
        header.element.onclick = () => {
          block.element.classList.toggle("collapsed");
          if (block.element.classList.contains("collapsed")) {
            headerIcon.text = "+";
            extra.text = "...";
          } else {
            headerIcon.text = "-";
            extra.text = "";
          }
        };
        currentBlock = block;
        currentBlock._passIndex = passIndex;

        /*for (const attachment of args[0].colorAttachments) {
          const textureView = this._getTextureViewFromAttachment(attachment);
          if (textureView) {
            this.database.capturedObjects.set(textureView.id, textureView);
            const texture = this.database.getTextureFromView(textureView);
            if (texture) {
              this.database.capturedObjects.set(texture.id, texture);
            }
          }
        }

        if (args[0].depthStencilAttachment) {
          const textureView = this._getTextureViewFromAttachment(args[0].depthStencilAttachment);
          if (textureView) {
            this.database.capturedObjects.set(textureView.id, textureView);
            const texture = this.database.getTextureFromView(textureView);
            if (texture) {
              this.database.capturedObjects.set(texture.id, texture);
            }
          }
        }*/
      } else if (method === "beginComputePass") {
        const passIndex = passEncoderMap.get(command.result);

        this._passEncoderCommands.set(command.result, [command]);

        command._passIndex = passIndex;
        if (!currentBlock.children.length) {
          currentBlock.remove();
        }
        currentBlock = new Div(debugGroup, { class: "capture_computepass" });
        const header = new Div(currentBlock, { id: `ComputePass_${passIndex}`, class: "capture_computepass_header" });
        const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;"});
        new Span(header, { text: `Compute Pass ${passIndex}` });
        const extra = new Span(header, { style: "margin-left: 10px;" });
        const block = new Div(currentBlock);
        header.element.onclick = () => {
          block.element.classList.toggle("collapsed");
          if (block.element.classList.contains("collapsed")) {
            headerIcon.text = "+";
            extra.text = "...";
          } else {
            headerIcon.text = "-";
            extra.text = "";
          }
        };
        currentBlock = block;
        currentBlock._passIndex = passIndex;
      } else if (method === "popDebugGroup") {
        debugGroupStack.pop();
        debugGroup = debugGroupStack[debugGroupStack.length - 1];
        if (!currentBlock.children.length) {
          currentBlock.remove();
        }
        currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
      } else if (method !== "pushDebugGroup") {
        const object = command.object;
        const commandArray = this._passEncoderCommands.get(object);
        if (commandArray) {
          commandArray.push(command);
        }

        if (passEncoderMap.has(object)) {
          const passIndex = passEncoderMap.get(object);
          if (currentBlock._passIndex !== passIndex) {
            if (!currentBlock.children.length) {
              currentBlock.remove();
            }
            currentBlock = new Div(debugGroup, { class: "capture_renderpass", style: "margin-top: 5px;" });
            const header = new Div(currentBlock, { id: `RenderPass_${passIndex}`, class: "capture_renderpass_header" });
            const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;"});
            new Span(header, { text: `Render Pass ${passIndex}` });
            const extra = new Span(header, { style: "margin-left: 10px;" });
            const block = new Div(currentBlock, { class: "capture_renderpass_block" });
            header.element.onclick = () => {
              block.element.classList.toggle("collapsed");
              if (block.element.classList.contains("collapsed")) {
                headerIcon.text = "+";
                extra.text = "...";
              } else {
                headerIcon.text = "-";
                extra.text = "";
              }
            };
            currentBlock = block;
            currentBlock._passIndex = passIndex;
          }
        }
      }

      const cmdType = ["capture_command"];
      if (method === "draw" || method === "drawIndexed" || method === "drawIndirect" || method === "drawIndexedIndirect" ||
          method === "dispatchWorkgroups" || method == "dispatchWorkgroupsIndirect") {
        cmdType.push("capture_drawcall");
      }

      const skipCommand = method === "pushDebugGroup" || method === "popDebugGroup";

      if (!skipCommand) {
        const cmd = new Div(currentBlock, { id: `CaptureCommand_${commandIndex}`, class: cmdType });

        if (method === "end") {
          cmd.element.id = `Pass_${currentBlock._passIndex}_end`;
        } else if (method === "beginRenderPass") {
          cmd.element.id = `RenderPass_${currentBlock._passIndex}_begin`;
        }

        command.widget = cmd;

        new Span(cmd, { class: "capture_callnum", text: `${commandIndex}.` });

        const self = this;

        function getName(id, className) {
          if (id === undefined) {
            return "";
          }
          /*const obj = self._getObject(id);
          if (obj) {
            return `${obj.label || obj.name}(${obj.idName})`;
          }*/
          return className ?
              `${className}(${id})` :
              `${id}`;
        }
        
        new Span(cmd, { class: "capture_methodName", text: `${method}` });

        if (method === "createCommandEncoder") {
          new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUCommandEncoder")}` });
        } else if (method === "finish") {
          new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)} => ${getName(command.result, "GPUCommandBuffer")}` });
        } if (method === "getMappedRange") {
          new Span(cmd, { class: "capture_method_args", text: getName(command.object) });
        } else if (method === "unmap") {
          new Span(cmd, { class: "capture_method_args", text: getName(command.object) });
        } else if (method === "copyBufferToBuffer") {
          new Span(cmd, { class: "capture_method_args", text: `src:${getName(args[0]?.__id)} srcOffset:${args[1]} dest:${getName(args[2]?.__id)} destOffset:${args[3]} size:${args[4]}` });
        } else if (method === "clearBuffer") {
          new Span(cmd, { class: "capture_method_args", text: `src:${getName(args[0]?.__id)} offset:${args[1]} size:${args[4]}` });
        } else if (method === "copyBufferToTexture") {
          new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(args[0]?.buffer?.__id)} texture:${getName(args[1]?.texture?.__id)}` });
        } else if (method === "copyTextureToBuffer") {
          new Span(cmd, { class: "capture_method_args", text: `texture:${getName(args[0]?.texture?.__id)} buffer:${getName(args[1]?.buffer?.__id)}` });
        } else if (method === "copyTextureToTexture") {
          new Span(cmd, { class: "capture_method_args", text: `src:${getName(args[0]?.texture?.__id)} dest:${getName(args[1]?.texture?.__id)}` });
        } else if (method === "setViewport") {
          new Span(cmd, { class: "capture_method_args", text: `x:${args[0]} y:${args[1]} w:${args[2]} h:${args[3]} minZ:${args[4]} maxZ:${args[5]}` });
        } else if (method === "setScissorRect") {
          new Span(cmd, { class: "capture_method_args", text: `x:${args[0]} y:${args[1]} w:${args[2]} h:${args[3]}` });
        } else if (method === "setStencilReference") {
          new Span(cmd, { class: "capture_method_args", text: `reference:${args[0]}` });
        } else if (method === "setBindGroup") {
          new Span(cmd, { class: "capture_method_args", text: `index:${args[0]} bindGroup:${getName(args[1]?.__id)}` });
          /*const bg = this._getObject(args[1].__id);
          if (bg) {
            this.database.capturedObjects.set(args[1].__id, bg);
            for (const entry of bg.descriptor.entries) {
              if (entry.resource?.__id) {
                const obj = this._getObject(entry.resource.__id);
                this.database.capturedObjects.set(entry.resource.__id, obj);
                if (obj instanceof TextureView) {
                  const tex = this._getObject(obj.texture?.id ?? obj.texture);
                  if (tex) {
                    this.database.capturedObjects.set(tex.id, tex);
                  }
                }
              } else if (entry.resource?.buffer?.__id) {
                const obj = this._getObject(entry.resource.buffer.__id);
                this.database.capturedObjects.set(entry.resource.buffer.__id, obj);
              }
            }
          }*/
        } else if (method === "__writeData") {
          new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(command.object)} Data:${args[0]}` });
        } else if (method === "writeBuffer") {
          const data = args[2];
          if (data.constructor === String) {
            const s = data.split(" ")[2];
            new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(args[0]?.__id)} offset:${args[1]} data:${s} Bytes` });
          } else {
            new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(args[0]?.__id)} offset:${args[1]} data:${args[2]?.length} Bytes` });
          }
        } else if (method === "setPipeline") {
          new Span(cmd, { class: "capture_method_args", text: `renderPipeline:${getName(args[0]?.__id)}` });
          //this.database.capturedObjects.set(args[0].__id, this._getObject(args[0].__id));
        } else if (method === "setVertexBuffer") {
          new Span(cmd, { class: "capture_method_args", text: `slot:${args[0]} buffer:${getName(args[1]?.__id)} offset:${args[2] ?? 0}` });
          //this.database.capturedObjects.set(args[1].__id, this._getObject(args[1].__id));
        } else if (method === "setIndexBuffer") {
          new Span(cmd, { class: "capture_method_args", text: `buffer:${getName(args[0]?.__id)} indexFormat:${args[1]} offset:${args[2] ?? 0}` });
          //this.database.capturedObjects.set(args[0].__id, this._getObject(args[0].__id));
        } else if (method === "drawIndexed") {
          new Span(cmd, { class: "capture_method_args", text: `indexCount:${args[0]} instanceCount:${args[1] ?? 1} firstIndex:${args[2] ?? 0} baseVertex:${args[3] ?? 0} firstInstance:${args[4] ?? 0}` });
        } else if (method === "draw") {
          new Span(cmd, { class: "capture_method_args", text: `vertexCount:${args[0]} instanceCount:${args[1] ?? 1} firstVertex:${args[2] ?? 0} firstInstance:${args[3] ?? 0}` });
        } else if (method === "drawIndirect") {
          new Span(cmd, { class: "capture_method_args", text: `indirectBuffer:${getName(args[0]?.__id)} offset:${args[1]}` });
        } else if (method === "drawIndexedIndirect") {
          new Span(cmd, { class: "capture_method_args", text: `indirectBuffer:${getName(args[0]?.__id)} offset:${args[1]}` });
        } else if (method === "dispatchWorkgroups") {
          new Span(cmd, { class: "capture_method_args", text: `countX:${args[0]} countY:${args[1] ?? 1} countZ:${args[2] ?? 1}` });
        } else if (method === "dispatchWorkgroupsIndirect") {
          new Span(cmd, { class: "capture_method_args", text: `indirectBuffer:${getName(args[0]?.__id)} offset:${args[1]}` });
        } else if (method === "pushDebugGroup") {
          debugGroupLabelStack.push(args[0]);
          new Span(cmd, { class: "capture_method_args", text: args[0] });
        } else if (method === "popDebugGroup") {
          const label = debugGroupLabelStack.pop();
          new Span(cmd, { class: "capture_method_args", text: label });
        } else if (method === "createView") {
          new Span(cmd, { class: "capture_method_args", text: `${getName(command.object)} => ${getName(command.result, "GPUTextureView")}` });
        } else if (method === "beginRenderPass") {
          new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)} => ${getName(command.result, "GPURenderPassEncoder")}` });
        } else if (method === "beginComputePass") {
          new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)} => ${getName(command.result, "GPUComputePassEncoder")}` });
        } else if (method === "end") {
          new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)}` });
        } else if (method === "createBuffer") {
          new Span(cmd, { class: "capture_method_args", text: `size:${args[0]?.size} usage:${args[0]?.usage} mappedAtCreation:${args[0]?.mappedAtCreation ?? false} => ${getName(command.result, "GPUBuffer")}` });
        } else if (method === "writeTexture") {
          new Span(cmd, { class: "capture_method_args", text: `dest:${getName(args[0]?.texture?.__id)}` });
        } else if (method === "destroy") {
          new Span(cmd, { class: "capture_method_args", text: `${getName(command.object, command.class)}` });
        } else if (method === "getCurrentTexture") {
          new Span(cmd, { class: "capture_method_args", text: `=> ${getName(command.result, "GPUTexture")}` });
        } else if (method === "submit") {
          let buffers = "[";
          for (const buffer of args[0]) {
            if (buffers !== "[") {
              buffers += ", ";
            }
            buffers += `${getName(buffer.__id, "GPUCommandBuffer")}`;
          }
          buffers += "]";
          new Span(cmd, { class: "capture_method_args", text: `=> ${buffers}` });
        }

        cmd.element.onclick = () => {
          if (self._lastSelectedCommand !== cmd) {
            if (self._lastSelectedCommand) {
              self._lastSelectedCommand.classList.remove("capture_command_selected");
            }
            cmd.classList.add("capture_command_selected");
            self._lastSelectedCommand = cmd;
          }
          
          if (frameIndex >= 0) {
            self._recorderData.executeCommands(canvas, frameIndex, commandIndex);
          }
          //self._showCaptureCommandInfo(command, name, commandInfo);
        };

        if (first) {
          // Start off selecting the first command.
          //cmd.element.click();
          first = false;
        }
      }

      if (method === "pushDebugGroup") {
        const colors = [
          ["capture_debugGroup_header1", "capture_debugGroup1"],
          ["capture_debugGroup_header2", "capture_debugGroup2"],
          ["capture_debugGroup_header3", "capture_debugGroup3"],
          ["capture_debugGroup_header4", "capture_debugGroup4"],
          ["capture_debugGroup_header5", "capture_debugGroup5"],
        ];
        const grpIndex = colors[nestedDebugGroup % 5];
        const grpClass = ["capture_debugGroup", grpIndex[1]];
        const hdrClass = ["capture_debugGroup_header", grpIndex[0]];
        nestedDebugGroup++;

        const header = new Div(debugGroup, { id: `DebugGroup_${debugGroupIndex}`, class: hdrClass });
        const headerIcon = new Span(header, { text: `-`, style: "margin-right: 10px; font-size: 12pt;"});
        new Span(header, { text: `${args[0]}` });
        const extra = new Span(header, { style: "margin-left: 10px;" });

        const grp = new Div(debugGroup, { class: grpClass });
        debugGroupStack.push(grp);
        debugGroupIndex++;
        debugGroup = grp;
        header.element.onclick = () => {
          grp.element.classList.toggle("collapsed");
          if (grp.element.classList.contains("collapsed")) {
            headerIcon.text = "+";
            extra.text = "...";
          } else {
            headerIcon.text = "-";
            extra.text = "";
          }
        };
        if (!currentBlock.children.length) {
          currentBlock.remove();
        }
        currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
      }

      if (method == "popDebugGroup") {
        nestedDebugGroup--;
      }

      if (method === "end") {
        if (!currentBlock.children.length) {
          currentBlock.remove();
        }
        currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
      }
    }
  }
}
