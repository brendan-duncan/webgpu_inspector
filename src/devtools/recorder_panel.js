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
import { renderEditableArgumentsSection, renderCommandSummary } from "./command_args_view.js";

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
    this._recorderData.onEditChanged.addListener(this._onEditChanged, this);
    this._recordingStarted = false;

    // Command-list multi-selection (set of selected command records) and a render-order list used
    // for shift-range selection. Populated while the recording view is built.
    this._selectedCommands = new Set();
    this._selectAnchorIndex = -1;
    this._renderedCommands = [];
    this._hideDisabled = false;

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
      Promise.resolve(downloadBinaryRecording(self._recorderData, self.recordNameInput.value))
        .catch((e) => { console.error("Failed to save binary recording:", e); });
    });

    this._saveHtmlMenuItem = new Div(menuDropdown, { class: ["menu-item", "disabled"], text: "Save HTML" });
    this._saveHtmlMenuItem.element.addEventListener("click", () => {
      if (this._saveHtmlMenuItem.element.classList.contains("disabled")) {
        return;
      }
      menuDropdown.element.classList.remove("open");
      Promise.resolve(downloadHtmlRecording(self._recorderData, self.recordNameInput.value))
        .catch((e) => { console.error("Failed to save HTML recording:", e); });
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

    // The loaded recording is the baseline for the modified indicator and revert.
    this._recorderData.resetEditHistory();

    // Selection state for the rebuilt command list.
    this._selectionState = { lastSelectedCommand: null };
    this._selectedFrameIndex = -1;
    this._selectedCommandIndex = -1;
    this._selectedCommands.clear();
    this._selectAnchorIndex = -1;
    this._renderedCommands = [];
    this._selectedCommand = null;

    const controls = new Div(this.recorderDataPanel, { class: "control-bar", style: "flex: 0 0 auto;" });

    // Only frames that actually contain commands are shown/previewable. A single-frame capture can
    // leave a trailing empty frame in the array; ignoring it keeps the view (and the default
    // preview) on real content instead of a blank frame.
    const framePopulated = (i) => {
      const f = this._recorderData.frames[i];
      return !!f && f.some((c) => c);
    };
    let lastFrame = 0;
    for (let i = this._recorderData.frames.length - 1; i >= 0; --i) {
      if (framePopulated(i)) {
        lastFrame = i;
        break;
      }
    }
    this._frameInputValue = lastFrame;

    new Span(controls, { text: "Frame:", class: "text-secondary ml-sm mr-sm" });
    // flex:0 0 auto pins the width: .dragger defaults to flex:1 1 auto, which would otherwise let
    // this (the only number field in this bar) grow to fill the row.
    this._frameInput = new NumberInput(controls, { precision: 0, value: lastFrame, min: 0, max: lastFrame, style: "width: 60px; flex: 0 0 auto;", onChange: (value) => {
      self._frameInputValue = value;
      // Picking a frame previews that whole frame, so drop any per-command selection.
      self._clearSelection();
      self._runPreview();
    } });

    new Span(controls, { text: "Preview:", class: "text-secondary ml-sm mr-sm" });
    this._previewModeSelect = new Select(controls, {
      options: ["Selected Command", "Full Frame"],
      index: PreviewMode.FullFrame,
      style: "width: 150px;",
      onChange: () => { self._runPreview(); }
    });

    // Editing toolbar: hide-disabled toggle, undo/redo/revert, and a modified indicator. The
    // commands themselves are disabled via per-row checkboxes / the right-click menu.
    this._hideDisabledCheckbox = new Checkbox(controls, {
      checked: this._hideDisabled,
      label: "Hide Disabled",
      tooltip: "Hide disabled commands in the list",
      class: "ml-md"
    });
    this._hideDisabledCheckbox.input.onChange.addListener((value) => {
      self._hideDisabled = value;
      self._syncCommandStyles();
    });

    this._undoButton = new Button(controls, { label: "Undo", class: "btn ml-sm", callback: () => { self._recorderData.undo(); } });
    this._redoButton = new Button(controls, { label: "Redo", class: "btn ml-sm", callback: () => { self._recorderData.redo(); } });
    this._revertButton = new Button(controls, { label: "Revert", class: "btn ml-sm", callback: () => { self._recorderData.revert(); } });
    this._modifiedIndicator = new Span(controls, { text: "", class: "recorder_modified_indicator ml-sm" });

    // Three columns: preview canvas | command list | command details. A flex row (mirroring the
    // Capture panel's layout) fills the height under the controls bar; each pane scrolls internally.
    const content = new Div(this.recorderDataPanel, { style: "flex: 1 1 auto; min-height: 0; display: flex; overflow: hidden;" });

    const canvasWrap = new Div(content, { style: "flex: 1.3 1 0; min-width: 0; overflow: auto;" });
    const canvas = new Widget("canvas", canvasWrap);
    canvas.element.width = 800;
    canvas.element.height = 600;
    canvas.element.style.maxWidth = "100%";
    this._canvas = canvas;

    const commands = new Div(content, { class: "recorder_command_list", style: "flex: 1 1 0; min-width: 0; overflow: auto; border-left: 1px solid var(--border-color); border-right: 1px solid var(--border-color);" });
    this._commandInfo = new Div(content, { style: "flex: 1 1 0; min-width: 0; overflow: auto;" });

    const filterArea = new Div(commands, { class: "capture_filterArea" });
    new Span(filterArea, { text: "Filter: ", class: "mr-sm" });
    this.filterEdit = new TextInput(filterArea, { style: "width: 200px;", placeholder: "Filter", onEdit: (value) => {
      self._filterCommands(value);
    } });

    let grp = new collapsible(commands, { label: "Initialize Commands", collapsed: true });
    this._renderFrameCommands(grp.body, this._recorderData.initializeCommands, -1);

    let renderedAnyFrame = false;
    for (let i = 0; i < this._recorderData.frames.length; ++i) {
      if (framePopulated(i)) {
        grp = new collapsible(commands, { label: `Frame ${i}`, collapsed: true });
        this._renderFrameCommands(grp.body, this._recorderData.frames[i], i);
        renderedAnyFrame = true;
      }
    }

    // A recording with only initialize commands means the captured animation frame issued no WebGPU
    // commands (e.g. the page renders on demand or had already finished rendering by that frame).
    // Surface that explicitly instead of showing a blank command list + canvas.
    if (!renderedAnyFrame) {
      new Div(commands, { class: "recorder_empty_note", html:
        "No frame was captured.<br><br>" +
        "The recorded animation frame contained no WebGPU commands. The recorder counts every " +
        "<code>requestAnimationFrame</code> from page load, so the requested frame may be one where " +
        "the page wasn't actively rendering (e.g. an on-demand or already-settled scene).<br><br>" +
        "Try recording a lower frame number, or a frame where the page is animating." });
    }

    // Apply any pre-existing disabled styling/visibility and initialize the toolbar state. This
    // also runs the initial preview of the last frame.
    this._syncCommandStyles();
    this._onEditChanged();
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
      // Assign a global render-order index to every command so shift-range selection can span
      // frames and the initialize block. Also remember the command's frame/index for preview.
      onCommandRendered: (command, commandIndex) => {
        command._renderIndex = self._renderedCommands.length;
        command._frameIndex = frameIndex;
        command._commandIndex = commandIndex;
        // Re-rendering reuses the persistent command objects; clear any checkboxes from a prior
        // render so they don't accumulate (a pass command gets one on its row and its header).
        command._toggleCheckboxes = undefined;
        self._renderedCommands.push(command);
      },
      onSelectCommand: (command, commandIndex, widget, e) => {
        self._onCommandClicked(command, frameIndex, commandIndex, e);
      },
      getDisabledState: (command) => !!command.disabled,
      isToggleLocked: (command) => self._recorderData.isProtectedCommand(command),
      onToggleDisabled: (command, commandIndex, enabled) => {
        // If the toggled command is part of the current multi-selection, apply to the whole
        // selection; otherwise just toggle this one.
        const targets = self._selectedCommands.has(command)
          ? [...self._selectedCommands]
          : [command];
        self._recorderData.setCommandsDisabled(targets, !enabled);
      },
      onCommandContextMenu: (command, commandIndex, widget, e) => {
        if (!self._selectedCommands.has(command)) {
          self._setSingleSelection(command);
        }
        self._showCommandContextMenu(e.clientX, e.clientY);
      },
      // Append a pass/bundle's label (if any) to its collapsible group header.
      decoratePassHeaderText: (kind, passIndex, command, baseText) => {
        const label = command.args?.[0]?.label;
        return label ? `${baseText}: ${label}` : baseText;
      },
      multiSelect: true,
      supportsRenderBundles: false,
      autoSelectFirst: false
    }, this._selectionState);
  }

  // Apply a click to the command selection, honoring ctrl/cmd (toggle) and shift (range) modifiers.
  // frameIndex/commandIndex identify the clicked command for the preview; selection highlighting and
  // the inspector both follow.
  _onCommandClicked(command, frameIndex, commandIndex, e) {
    const idx = command._renderIndex;
    if (e && e.shiftKey && this._selectAnchorIndex >= 0) {
      if (!e.ctrlKey && !e.metaKey) {
        this._selectedCommands.clear();
      }
      const lo = Math.min(this._selectAnchorIndex, idx);
      const hi = Math.max(this._selectAnchorIndex, idx);
      for (let k = lo; k <= hi; ++k) {
        const c = this._renderedCommands[k];
        if (c && c.widget) {
          this._selectedCommands.add(c);
        }
      }
    } else if (e && (e.ctrlKey || e.metaKey)) {
      if (this._selectedCommands.has(command)) {
        this._selectedCommands.delete(command);
      } else {
        this._selectedCommands.add(command);
      }
      this._selectAnchorIndex = idx;
    } else {
      this._selectedCommands.clear();
      this._selectedCommands.add(command);
      this._selectAnchorIndex = idx;
    }

    this._syncSelectionStyles();

    this._selectedCommand = command;
    this._selectedFrameIndex = frameIndex;
    this._selectedCommandIndex = commandIndex;
    this._showCommandInfo(command);
    this._runPreview();
  }

  // Replace the selection with a single command (used when right-clicking outside the selection).
  _setSingleSelection(command) {
    this._selectedCommands.clear();
    this._selectedCommands.add(command);
    this._selectAnchorIndex = command._renderIndex;
    this._selectedCommand = command;
    this._selectedFrameIndex = command._frameIndex;
    this._selectedCommandIndex = command._commandIndex;
    this._syncSelectionStyles();
    this._showCommandInfo(command);
  }

  // Reflect the current multi-selection onto the command-row widgets.
  _syncSelectionStyles() {
    for (const command of this._renderedCommands) {
      if (!command.widget) {
        continue;
      }
      if (this._selectedCommands.has(command)) {
        command.widget.classList.add("capture_command_selected");
      } else {
        command.widget.classList.remove("capture_command_selected");
      }
    }
  }

  // Reflect each command's disabled state onto its row (dimmed style + checkbox), and apply the
  // Hide Disabled toggle. Called after edits so the list stays in sync without a full rebuild.
  _syncCommandStyles() {
    for (const command of this._renderedCommands) {
      const widget = command.widget;
      if (!widget) {
        continue;
      }
      const explicit = !!command.disabled;
      const implicit = !!command._implicit && !explicit;
      // Explicitly-disabled rows are dimmed + struck through; implicitly-disabled rows (off because
      // of a dependency) get a distinct lighter style.
      widget.element.classList.toggle("capture_command_disabled", explicit);
      widget.element.classList.toggle("capture_command_implicit_disabled", implicit);
      // A command may have more than one checkbox (its row and, for a pass, its group header).
      if (command._toggleCheckboxes) {
        for (const checkbox of command._toggleCheckboxes) {
          checkbox.checked = !explicit;
          // Indeterminate marks "off because a dependency is disabled" rather than a direct toggle.
          checkbox.indeterminate = implicit;
        }
      }
    }
    this._updateCommandVisibility();
  }

  // Show/hide command rows based on the active text filter and the Hide Disabled toggle. Hide
  // Disabled hides any effectively-disabled row (explicit or implicit).
  _updateCommandVisibility() {
    const filter = this._filter || "";
    for (const command of this._renderedCommands) {
      const widget = command.widget;
      if (!widget) {
        continue;
      }
      const matchesFilter = !filter || command.method.includes(filter);
      const effectivelyDisabled = command.disabled || command._implicit;
      const hidden = !matchesFilter || (effectivelyDisabled && this._hideDisabled);
      widget.element.style.display = hidden ? "none" : "block";
    }
  }

  // Build and show the command-list right-click context menu (bulk enable/disable of the selection).
  _showCommandContextMenu(x, y) {
    this._closeCommandContextMenu();
    const self = this;
    const selected = [...this._selectedCommands];

    const menu = document.createElement("div");
    menu.className = "menu-dropdown open";
    menu.style.position = "fixed";
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;

    const addItem = (label, onClick) => {
      const item = document.createElement("div");
      item.className = "menu-item";
      item.textContent = label;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        self._closeCommandContextMenu();
        try {
          onClick();
        } catch (err) {
          console.error(err);
        }
      });
      menu.appendChild(item);
    };

    const count = selected.length;
    const suffix = count > 1 ? ` (${count})` : "";
    addItem(`Disable${suffix}`, () => self._recorderData.setCommandsDisabled(selected, true));
    addItem(`Enable${suffix}`, () => self._recorderData.setCommandsDisabled(selected, false));

    document.body.appendChild(menu);
    this._activeContextMenu = menu;

    const dismiss = (e) => {
      if (e && menu.contains(e.target)) {
        return;
      }
      self._closeCommandContextMenu();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        self._closeCommandContextMenu();
      }
    };
    this._contextMenuDismiss = dismiss;
    this._contextMenuKey = onKey;
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("contextmenu", dismiss, true);
    document.addEventListener("keydown", onKey);
  }

  _closeCommandContextMenu() {
    if (this._activeContextMenu) {
      this._activeContextMenu.remove();
      this._activeContextMenu = null;
    }
    if (this._contextMenuDismiss) {
      document.removeEventListener("mousedown", this._contextMenuDismiss, true);
      document.removeEventListener("contextmenu", this._contextMenuDismiss, true);
      this._contextMenuDismiss = null;
    }
    if (this._contextMenuKey) {
      document.removeEventListener("keydown", this._contextMenuKey);
      this._contextMenuKey = null;
    }
  }

  // React to any edit / undo / redo / revert: refresh the row styles, toolbar state, modified
  // indicator, the open command inspector, and the preview.
  _onEditChanged() {
    if (this._undoButton) {
      this._undoButton.disabled = !this._recorderData.canUndo;
      this._redoButton.disabled = !this._recorderData.canRedo;
      const modified = this._recorderData.modified;
      this._revertButton.disabled = !modified;
      this._modifiedIndicator.text = modified ? "● Modified" : "";
    }
    this._syncCommandStyles();
    // Keep the inspector fields in sync with undo/redo/revert of the selected command's args.
    if (this._selectedCommand && !this._suppressInfoRefresh) {
      this._showCommandInfo(this._selectedCommand);
    }
    this._runPreview();
  }

  // Clear the current command selection and its highlight.
  _clearSelection() {
    this._selectedFrameIndex = -1;
    this._selectedCommandIndex = -1;
    this._selectedCommand = null;
    this._selectedCommands.clear();
    this._selectAnchorIndex = -1;
    this._syncSelectionStyles();
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

  // Show the details for a selected command in the info pane: method, lightweight summary, and
  // editable arguments. Editing an argument commits through the recorder's edit model (undoable),
  // and result is shown read-only. Object names aren't resolvable from the replay model, so object
  // arguments are edited as raw "{__id}" references in the JSON editor.
  _showCommandInfo(command) {
    const info = this._commandInfo;
    if (!info) {
      return;
    }
    const self = this;
    info.html = "";
    new Div(info, { text: command.method, class: "info-box-success pl-xl", style: "line-height: 40px;" });
    renderCommandSummary(info, command, {});
    renderEditableArgumentsSection(info, command, (argIndex, newValue) => {
      // Replace the edited argument in a fresh args array so undo can restore the prior reference.
      const newArgs = Array.isArray(command.args) ? command.args.slice() : [];
      newArgs[argIndex] = newValue;
      // Don't rebuild this pane in response to our own edit — that would destroy the field the
      // user is tabbing through. undo/redo/revert still refresh it (the flag is only set here).
      self._suppressInfoRefresh = true;
      self._recorderData.setCommandArgs(command, newArgs);
      self._suppressInfoRefresh = false;
    });
    if (command.result !== undefined && command.result !== null) {
      new Div(info, { text: `Result: ${command.result}`, class: "bg-info pl-xl lh-md" });
    }
  }

  _filterCommands(filter) {
    this._filter = filter;
    this._updateCommandVisibility();
  }
}
