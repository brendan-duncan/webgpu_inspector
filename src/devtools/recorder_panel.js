import { Button } from "./widget/button.js";
import { Checkbox } from "./widget/checkbox.js";
import { collapsible } from "./widget/collapsible.js";
import { Div } from "./widget/div.js";
import { Input } from "./widget/input.js";
import { Select } from "./widget/select.js";
import { Span } from "./widget/span.js";
import { Widget } from "./widget/widget.js";
import { Actions, PanelActions } from "../utils/actions.js";
import { RecorderData } from "./recorder_data.js";
import { downloadBinaryRecording, downloadHtmlRecording } from "./recorder_export.js";
import { NumberInput } from "./widget/number_input.js";
import { TextInput } from "./widget/text_input.js";
import { renderCommandList } from "./command_list_view.js";
import { renderArgumentsSection, renderCommandSummary } from "./command_args_view.js";

// Preview modes for the recorder display.
const PreviewMode = {
  SelectedCommand: 0, // replay up to and including the selected command, closing its pass
  FullFrame: 1        // replay the whole frame (selected command's frame, or the Frame input)
};

// Recording modes shown in the Mode dropdown, in display order. All map to the recorder's
// stateful recordMode 2; they differ only in which absolute frame indices get captured.
const RecordModeIndex = {
  Single: 0,    // a single arbitrary frame (default)
  Range: 1,     // contiguous start..end, one file per frame
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

    // Hamburger menu for Save / Load actions, mirroring the Capture panel. Sits to the left of the
    // Record button. The Save items act on the recording currently loaded in the panel (from a live
    // recording or a loaded binary) and stay disabled until one is ready.
    const menuContainer = new Div(recorderBar, { class: "menu-container" });
    const menuButton = new Widget("button", menuContainer, { class: "menu-button", title: "Menu" });
    menuButton.element.innerHTML = "&#9776;";
    const menuDropdown = new Div(menuContainer, { class: "menu-dropdown" });

    this._saveBinaryMenuItem = new Div(menuDropdown, { class: ["menu-item", "disabled"], text: "Save Binary" });
    this._saveBinaryMenuItem.element.addEventListener("click", () => {
      if (this._saveBinaryMenuItem.element.classList.contains("disabled")) {
        return;
      }
      menuDropdown.element.classList.remove("open");
      try {
        downloadBinaryRecording(self._recorderData, self.recordNameInput.value);
      } catch (e) {
        console.error("Failed to save binary recording:", e);
      }
    });

    this._saveHtmlMenuItem = new Div(menuDropdown, { class: ["menu-item", "disabled"], text: "Save HTML" });
    this._saveHtmlMenuItem.element.addEventListener("click", () => {
      if (this._saveHtmlMenuItem.element.classList.contains("disabled")) {
        return;
      }
      menuDropdown.element.classList.remove("open");
      try {
        downloadHtmlRecording(self._recorderData, self.recordNameInput.value);
      } catch (e) {
        console.error("Failed to save HTML recording:", e);
      }
    });

    const loadMenuItem = new Div(menuDropdown, { class: "menu-item", text: "Load Binary" });
    loadMenuItem.element.addEventListener("click", () => {
      menuDropdown.element.classList.remove("open");
      self._loadBinaryRecording();
    });

    menuButton.element.addEventListener("click", (e) => {
      e.stopPropagation();
      menuDropdown.element.classList.toggle("open");
    });
    // Click anywhere else closes the menu.
    document.addEventListener("click", (e) => {
      if (!menuContainer.element.contains(e.target)) {
        menuDropdown.element.classList.remove("open");
      }
    });

    this.recordButton = new Button(recorderBar, { label: "Record", class: "btn btn-success ml-sm", callback: () => {
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
      options: ["Single Frame", "Frame Range", "Multi-Frame", "On Demand"],
      index: RecordModeIndex.Single,
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

    // Output format: HTML (self-contained playback page), Binary (compact .wgpu), or Both.
    new Span(recorderBar, { text: "Format:", class: "text-secondary ml-sm mr-sm" });
    this.formatSelect = new Select(recorderBar, {
      options: ["HTML", "Binary", "Both"],
      index: 0,
      style: "width: 90px;"
    });

    new Span(recorderBar, { text: "Name:", class: "text-secondary ml-sm mr-sm" });
    this.recordNameInput = new Input(recorderBar, { type: "text", value: "webgpu_record" });

    new Div(recorderBar, { class: "control-bar-spacer" });

    new Button(recorderBar, { label: "Help", class: "btn", callback: () => {
      globalThis.open("https://github.com/brendan-duncan/webgpu_inspector/blob/main/docs/record.md", "_blank");
    }});

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

    const output = this.formatSelect.index === 1 ? "binary" : this.formatSelect.index === 2 ? "both" : "html";

    this._recorderData.clear();
    port.postMessage({
      action: PanelActions.InitializeRecorder,
      frames: 1, filename, download, recordMode, recordFrame, continuous, output
    });

    this._recordingStarted = idx === RecordModeIndex.OnDemand;
    this._updateModeUI();
  }

  // Prompt for a binary (.wgpu) recording file and load it into the panel for playback.
  _loadBinaryRecording() {
    const self = this;
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".wgpu,application/octet-stream";
    input.style.display = "none";
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      input.remove();
      if (!file) {
        return;
      }
      file.arrayBuffer().then((buffer) => {
        self._recorderData.loadBinary(buffer);
      }).catch((e) => {
        console.error("Failed to read binary recording:", e);
      });
    });
    document.body.appendChild(input);
    input.click();
  }

  _recordingReady() {
    this.recorderDataPanel.html = "";

    // A recording is now loaded, so it can be saved.
    this._saveBinaryMenuItem.element.classList.remove("disabled");
    this._saveHtmlMenuItem.element.classList.remove("disabled");

    const self = this;

    // Shared across every frame's command list so a single selection highlight is maintained.
    this._selectionState = { lastSelectedCommand: null };
    this._selectedFrameIndex = -1;
    this._selectedCommandIndex = -1;

    const controls = new Div(this.recorderDataPanel, { class: "control-bar", style: "flex: 0 0 auto;" });

    const lastFrame = this._recorderData.frames.length - 1;
    this._frameInputValue = lastFrame;

    new Span(controls, { text: "Frame:", class: "text-secondary ml-sm mr-sm" });
    this._frameInput = new NumberInput(controls, { precision: 0, value: lastFrame, min: 0, max: lastFrame, style: "width: 60px;", onChange: (value) => {
      self._frameInputValue = value;
      // Picking a frame previews that whole frame, so drop any per-command selection.
      self._clearSelection();
      self._runPreview();
    } });

    new Span(controls, { text: "Preview:", class: "text-secondary ml-sm mr-sm" });
    this._previewModeSelect = new Select(controls, {
      options: ["Selected Command", "Full Frame"],
      index: PreviewMode.SelectedCommand,
      style: "width: 150px;",
      onChange: () => { self._runPreview(); }
    });

    // Three columns: preview canvas | command list | command details. A flex row (mirroring the
    // Capture panel's layout) fills the height under the controls bar; each pane scrolls internally.
    const content = new Div(this.recorderDataPanel, { style: "flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden;" });

    const canvasWrap = new Div(content, { style: "flex: 1.3 1 0; min-width: 0; overflow: auto;" });
    const canvas = new Widget("canvas", canvasWrap);
    canvas.element.width = 800;
    canvas.element.height = 600;
    canvas.element.style.maxWidth = "100%";
    this._canvas = canvas;

    const commands = new Div(content, { style: "flex: 1 1 0; min-width: 0; overflow: auto; border-left: 1px solid var(--border-color); border-right: 1px solid var(--border-color);" });
    this._commandInfo = new Div(content, { style: "flex: 1 1 0; min-width: 0; overflow: auto;" });

    const filterArea = new Div(commands, { class: "capture_filterArea" });
    new Span(filterArea, { text: "Filter: ", class: "mr-sm" });
    this.filterEdit = new TextInput(filterArea, { style: "width: 200px;", placeholder: "Filter", onEdit: (value) => {
      self._filterCommands(value);
    } });

    let grp = new collapsible(commands, { label: "Initialize Commands", collapsed: true });
    this._renderFrameCommands(grp.body, this._recorderData.initializeCommands, -1);

    for (let i = 0; i < this._recorderData.frames.length; ++i) {
      if (this._recorderData.frames[i]) {
        grp = new collapsible(commands, { label: `Frame ${i}`, collapsed: true });
        this._renderFrameCommands(grp.body, this._recorderData.frames[i], i);
      }
    }

    this._recorderData.executeCommands(canvas, lastFrame);
  }

  // Render one frame's (or the initialize block's) commands using the shared command-list view.
  // frameIndex is -1 for the initialize commands.
  _renderFrameCommands(parent, commands, frameIndex) {
    if (commands === undefined) {
      return;
    }
    const self = this;
    renderCommandList(parent, commands, {
      getDisplayName: (id, className) => {
        if (id === undefined) {
          return "";
        }
        return className ? `${className}(${id})` : `${id}`;
      },
      onSelectCommand: (command, commandIndex) => {
        self._selectedFrameIndex = frameIndex;
        self._selectedCommandIndex = commandIndex;
        self._showCommandInfo(command);
        self._runPreview();
      },
      supportsRenderBundles: false,
      autoSelectFirst: false
    }, this._selectionState);
  }

  // Clear the current command selection and its highlight.
  _clearSelection() {
    this._selectedFrameIndex = -1;
    this._selectedCommandIndex = -1;
    if (this._selectionState?.lastSelectedCommand) {
      this._selectionState.lastSelectedCommand.classList.remove("capture_command_selected");
      this._selectionState.lastSelectedCommand = null;
    }
  }

  // Replay the recording into the preview canvas according to the current preview mode.
  _runPreview() {
    if (!this._canvas) {
      return;
    }
    const mode = this._previewModeSelect.index;
    const hasSelection = this._selectedCommandIndex >= 0 && this._selectedFrameIndex >= 0;

    if (mode === PreviewMode.SelectedCommand && hasSelection) {
      this._recorderData.executeCommands(this._canvas, this._selectedFrameIndex, this._selectedCommandIndex);
    } else {
      // Full Frame, or Selected Command with nothing selected: replay the whole frame. Use the
      // selected command's frame if one is selected, otherwise the Frame input.
      const frame = hasSelection ? this._selectedFrameIndex : Math.max(0, this._frameInputValue | 0);
      this._recorderData.executeCommands(this._canvas, frame, -1);
    }
  }

  // Show the details for a selected command in the info pane: method, lightweight summary,
  // formatted arguments, and result. Object names aren't resolvable from the replay model, so
  // the arguments fall back to "Object.<id>" references.
  _showCommandInfo(command) {
    const info = this._commandInfo;
    if (!info) {
      return;
    }
    info.html = "";
    new Div(info, { text: command.method, class: "info-box-success pl-xl", style: "line-height: 40px;" });
    renderCommandSummary(info, command, {});
    renderArgumentsSection(info, command.args, command.method, () => null);
    if (command.result !== undefined && command.result !== null) {
      new Div(info, { text: `Result: ${command.result}`, class: "bg-info pl-xl lh-md" });
    }
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
}
