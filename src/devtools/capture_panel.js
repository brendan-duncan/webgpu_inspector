import { CaptureStatistics } from "./capture_statistics.js";
import { StacktraceViewer } from "./stacktrace_viewer.js";
import {
  Sampler,
  Texture,
  TextureView
} from "./gpu_objects/index.js";
import { Button } from "./widget/button.js";
import { Checkbox } from "./widget/checkbox.js";
import { collapsible } from "./widget/collapsible.js";
import { Dialog } from "./widget/dialog.js";
import { Div } from "./widget/div.js";
import { NumberInput } from "./widget/number_input.js";
import { Span } from "./widget/span.js";
import { TextArea } from "./widget/text_area.js";
import { TextInput } from "./widget/text_input.js";
import { TimelineWidget } from "./widget/timeline.js";
import { Widget } from "./widget/widget.js";
import { TabWidget } from "./widget/tab_widget.js";
import { getFlagString } from "../utils/flags.js";
import { Select } from "./widget/select.js";
import { Actions, PanelActions } from "../utils/actions.js";
import { getFormatFromReflection } from "../utils/reflection_format.js";
import { ResourceType, WgslReflect } from "wgsl_reflect/wgsl_reflect.module.js";
import { CaptureData } from "./capture_data.js";
import { ShaderDebugger } from "./shader_debugger.js";
import { buildCaptureJson, downloadCaptureJson } from "./capture_export.js";
import { importCaptureJson } from "./capture_import.js";
import { putCaptureHandoff } from "../utils/capture_handoff.js";
import { getInspectWorkers } from "../utils/inspector_settings.js";
import { commandArgs, processCommandArgs, renderArgumentsSection, renderCommandSummary } from "./command_args_view.js";
import { renderCommandList } from "./command_list_view.js";

const _inspectButtonStyle = "btn btn-info";

const _statLabelOverrides = {
  apiCalls: "API Calls",
};

function _prettifyStatKey(key) {
  if (_statLabelOverrides[key]) {
    return _statLabelOverrides[key];
  }
  const spaced = key.replace(/([a-z])([A-Z])/g, "$1 $2");
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

const _byteStatKeys = new Set(["bufferBytesWritten", "totalBytesWritten"]);

function _formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function _formatStatValue(key, value) {
  if (_byteStatKeys.has(key)) {
    return _formatBytes(value);
  }
  return Number(value).toLocaleString("en-US");
}

// Groupings for the Frame Statistics panel: title -> ordered field list.
const _statSections = [
  ["API Activity", ["apiCalls", "draw", "drawIndirect", "dispatch", "copyCommands"]],
  ["Passes", ["renderPasses", "computePasses", "colorAttachments", "depthStencilAttachments"]],
  ["Pipeline", ["setPipeline", "vertexShaders", "fragmentShaders", "computeShaders"]],
  ["Bindings", ["setBindGroup", "setVertexBuffer", "setIndexBuffer",
                "uniformBuffers", "storageBuffers", "textures", "samplers"]],
  ["Memory", ["writeBuffer", "writeTexture", "bufferBytesWritten", "totalBytesWritten"]],
  ["Geometry", ["totalInstances", "totalVertices", "totalTriangles", "totalLines", "totalPoints"]],
];

/**
 * Panel for displaying captured WebGPU frames and commands.
 * Provides UI for capturing, viewing, and inspecting GPU operations.
 */
export class CapturePanel {
  /**
   * Creates a new CapturePanel.
   * @param {Object} win - The window object containing port and database references.
   * @param {Widget} parent - The parent DOM element to attach the panel to.
   */
  constructor(win, parent) {
    this.window = win;

    const self = this;
    const port = win.port;

    this.statistics = new CaptureStatistics();

    this._captureData = null;
    // The TabWidget is created once and survives every capture. Each capture or
    // imported JSON file adds a new tab. The active and live tabs may differ:
    // active is the one the user is looking at, live is the one currently
    // receiving stream-in data from a running capture.
    this._captureTabs = [];
    this._activeTabState = null;
    this._liveTabState = null;
    // Imported captures are placed in their own ID namespace so they don't
    // collide with live objects in the database. Each import bumps this by 1B.
    this._nextImportIdOffset = 1_000_000_000;

    const _controlBar = new Div(parent, { class: "control-bar" });

    // Hamburger menu for Save / Load actions. Sits to the left of Capture.
    const menuContainer = new Div(_controlBar, { class: "menu-container" });
    const menuButton = new Widget("button", menuContainer, {
      class: "menu-button",
      title: "Menu"
    });
    menuButton.element.innerHTML = "&#9776;";
    const menuDropdown = new Div(menuContainer, { class: "menu-dropdown" });

    this._saveMenuItem = new Div(menuDropdown, { class: ["menu-item", "disabled"], text: "Save Capture" });
    this._saveMenuItem.element.addEventListener("click", () => {
      if (this._saveMenuItem.element.classList.contains("disabled")) {
        return;
      }
      menuDropdown.element.classList.remove("open");
      const state = self._activeTabState;
      if (!state) {
        return;
      }
      try {
        downloadCaptureJson(
          state.frame,
          state.commands,
          self.database,
          state.statistics,
          "__buildVersion"
        );
      } catch (e) {
        console.error("Failed to save capture JSON:", e);
      }
    });

    const loadMenuItem = new Div(menuDropdown, { class: "menu-item", text: "Load Capture" });
    loadMenuItem.element.addEventListener("click", () => {
      menuDropdown.element.classList.remove("open");
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json,application/json";
      input.style.display = "none";
      input.addEventListener("change", () => {
        const file = input.files && input.files[0];
        input.remove();
        if (!file) {
          return;
        }
        file.text().then((text) => {
          self._importCaptureJson(text, file.name);
        }).catch((e) => {
          console.error("Failed to read capture JSON:", e);
        });
      });
      document.body.appendChild(input);
      input.click();
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

    new Button(_controlBar, { label: "Capture", class: "btn btn-success", callback: () => {
      try {
        this._captureData = new CaptureData(this.database);
        this._captureData.captureTimestampsRequested = this.captureTimestamps;
        this._captureData.onCaptureFrameResults.addListener(self._captureFrameResults, self);
        this._captureData.onUpdateCaptureStatus.addListener(self._updateCaptureStatus, self);

        const frame = self.captureMode === 0 ? -1 : self.captureSpecificFrame;
        const maxBufferSize = self.useMaxBufferSize ? self.maxBufferSize : -1;

        // Send the capture request to the backend with the specified frame count and buffer size.
        // A specific-frame capture (frame >= 0) reloads the page to initialize
        // the inspector, so it carries the "Inspect Workers" setting the same
        // way the Inspect panel's Start button does.
        self.port.postMessage({
          action: PanelActions.Capture,
          captureFrameCount: this.captureFrameCount,
          maxBufferSize,
          frame,
          captureStacktraces: self.captureStacktraces,
          captureTimestamps: self.captureTimestamps,
          inspectWorkers: getInspectWorkers(),
        });
      } catch (e) {
        console.error(e.message);
      }
    } });

    this.captureMode = 0;

    new Select(_controlBar, {
      options: ["Immediate", "Specific Frame"],
      class: "mr-sm",
      onChange: (_, index) => {
        self.captureMode = index;
        if (self.captureMode === 0) {
          self.captureFrameEdit.style.display = "none";
        } else {
          self.captureFrameEdit.style.display = "inline-block";
        }
      }
    });

    this.captureSpecificFrame = 0;
    // Cap the width like the Frames input below; NumberInput's root `.dragger` is flex: 1 1 auto
    // and would otherwise stretch this field to fill the toolbar.
    this.captureFrameEdit = new NumberInput(_controlBar, {
      value: this.captureSpecificFrame,
      min: -1,
      step: 1,
      precision: 0,
      class: "mr-sm",
      style: "max-width: 60px;",
      onChange: (value) => {
        self.captureSpecificFrame = Math.max(value, -1);
      }
    });
    if (this.captureMode === 0) {
      this.captureFrameEdit.style.display = "none";
    }

    this.captureFrameCount = 1;
    new Span(_controlBar, { text: "Frames:", class: "text-secondary ml-sm mr-sm" });
    // NumberInput's root `.dragger` is flex: 1 1 auto, which would both stretch
    // these inputs to fill the toolbar and let them shrink small enough that the
    // value text spills out onto the next control. Pin the width and disable
    // grow/shrink so the field is exactly as wide as its longest value.
    new NumberInput(_controlBar, { value: this.captureFrameCount, min: 1, step: 1, precision: 0, class: "mr-sm", style: "max-width: 50px; flex: 0 0 auto;", onChange: (value) => {
      self.captureFrameCount = Math.max(value, 1);
    } });

    this.maxBufferSize = 1 * (1024 * 1024);
    this.useMaxBufferSize = false;
    const useMaxBufferSizeBtn = new Checkbox(_controlBar, { value: this.useMaxBufferSize, title: "Use Max Buffer Size",
      label: "Max Buffer Size (Bytes):", class: "ml-sm" });
    const maxBufferSizeInput = new NumberInput(_controlBar, { value: this.maxBufferSize, min: 1, step: 1, precision: 0,
        class: "mr-sm", style: "width: 100px; flex: 0 0 auto;", onChange: (value) => {
      self.maxBufferSize = Math.max(value, 1);
    } });


    maxBufferSizeInput.disabled = !this.useMaxBufferSize;
    useMaxBufferSizeBtn.input.onChange.addListener((value) => {
      this.useMaxBufferSize = value;
      maxBufferSizeInput.disabled = !value;
    });

    // Stacktraces per recorded command are useful but can dominate the payload size
    // when a frame contains thousands of commands. Off by default; opt in here.
    this.captureStacktraces = false;
    const stacktraceBtn = new Checkbox(_controlBar, { value: this.captureStacktraces,
      title: "Capture Stacktraces", label: "Stacktraces", class: "ml-sm" });
    stacktraceBtn.input.onChange.addListener((value) => {
      this.captureStacktraces = value;
    });

    // Profile Passes injects timestamp queries around each render/compute pass so the
    // panel can report per-pass GPU duration and render a frame timeline. Requires the
    // page's adapter to support the "timestamp-query" feature; the page-side guard in
    // webgpu_inspector.js silently skips the injection when it doesn't.
    this.captureTimestamps = true;
    const timestampsBtn = new Checkbox(_controlBar, { checked: this.captureTimestamps,
      title: "Inject GPU timestamp queries to measure per-pass duration",
      label: "Profile Passes", class: "ml-sm" });
    timestampsBtn.input.onChange.addListener((value) => {
      this.captureTimestamps = value;
    });

    this._captureStatus = new Span(_controlBar, { style: "margin-left: 20px; margin-right: 10px;" });

    new Div(_controlBar, { class: "control-bar-spacer" });

    new Button(_controlBar, { label: "Help", class: "btn", callback: () => {
      window.open("https://github.com/brendan-duncan/webgpu_inspector/blob/main/docs/capture.md", "_blank");
    }});

    this._capturePanel = new Div(parent, { style: "overflow: hidden; white-space: nowrap; flex: 1 1 auto; min-height: 0; display: flex;" });

    this._captureTab = new TabWidget(this._capturePanel, { class: "capture_tabs", displayCloseButton: true, style: "width: 100%;" });
    this._captureTab.onActiveTabChanged.addListener(this._onCaptureTabChanged, this);
    this._captureTab.onTabClosed.addListener(this._onCaptureTabClosed, this);

    this.window.onTextureLoaded.addListener(this._textureLoaded, this);
    this.window.onTextureDataChunkLoaded.addListener(this._textureDataChunkLoaded, this);

    // These mirror the active tab's per-tab state so the existing render loop
    // (which writes through `this._frameImages` etc.) keeps working unchanged.
    // `_onCaptureTabChanged` rewires them whenever the user switches tabs.
    this._frameImages = null;
    this._frameImageList = [];
    this._lastSelectedCommand = null;
    this._gpuTextureMap = new Map();
    this._passEncoderCommands = new Map();

    port.addListener((message) => {
      if (!self._captureData) {
        return;
      }
      switch (message.action) {
        case Actions.CaptureTextureFrames: {
          self._captureData.captureTextureFrames(message);
          self._updateCaptureStatus();
          break;
        }
        case Actions.CaptureFrameResults: {
          self._captureData.captureFrameResults(message);
          break;
        }
        case Actions.CaptureFrameCommands: {
          self._captureData.captureFrameCommands(message);
          break;
        }
        case Actions.CaptureBuffers: {
          self._captureData.captureBuffers(message);
          self._updateCaptureStatus();
          break;
        }
        case Actions.CaptureBufferData: {
          self._captureData.captureBufferData(message);
          break;
        }
      }
    });
  }

  /**
   * Calculates a clamped width for texture preview based on dimensions.
   * @param {Object} texture - The texture object with width and height.
   * @returns {number} The clamped texture width.
   */
  _clampedTextureWidth(texture) {
    return Math.max(Math.min(Math.max(texture.width, texture.height), 256), 64);
  }

  /**
   * Retrieves an object from the database by ID.
   * @param {number} id - The object ID.
   * @returns {Object|null} The retrieved object or null.
   */
  _getObject(id) {
    return this.database.getObject(id);
  }

  /**
   * Creates a collapsible section that persists its collapsed state.
   * @param {HTMLElement} parent - Parent element.
   * @param {Object} object - Object to store GUI state on.
   * @param {string} property - Property name for storing state.
   * @param {string} label - Label for the collapsible.
   * @param {boolean} collapsed - Initial collapsed state.
   * @returns {collapsible} The collapsible widget.
   */
  _getcollapsibleWithState(parent, object, property, label, collapsed) {
    object.__guistate = object.__guistate || {};
    object.__guistate[property] = object.__guistate[property] ?? collapsed;
    const collabsable = new collapsible(parent, { collapsed: true, label: label, collapsed: object.__guistate[property] });
    collabsable.onExpanded.addListener(() => {
      object.__guistate[property] = false;
    });
    collabsable.onCollapsed.addListener(() => {
      object.__guistate[property] = true;
    });
    return collabsable;
  }

  /**
   * Updates the capture status display.
   */
  _updateCaptureStatus() {
    let text = this._captureData?.getCaptureStatus() ?? "";
    this._captureStatus.text = text;
  }

  /**
   * Gets the database from the window object.
   * @returns {Object} The capture database.
   */
  get database() {
    return this.window.database;
  }

  /**
   * Gets the communication port from the window object.
   * @returns {Object} The message port.
   */
  get port() {
    return this.window.port;
  }

  /**
   * Gets the texture utilities from the window object.
   * @returns {Object} The texture utilities.
   */
  get textureUtils() {
    return this.window.textureUtils;
  }

  /**
   * Processes command arguments, converting internal IDs to readable strings.
   * @param {*} object - The object or arguments to process.
   * @returns {*} The processed arguments.
   */
  _processCommandArgs(object) {
    return processCommandArgs(object, (id) => this._getObject(id));
  }

  /**
   * Filters visible commands based on a search filter.
   * @param {string} filter - The filter string to search for.
   * @param {Array} commands - Array of captured commands.
   */
  _filterCommands(filter, commands) {
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

  /**
   * Captures objects from command arguments, tracking them in the database and
   * recording which IDs the active tab is referencing so they can be released
   * when the tab is closed.
   * @param {*} args - Command arguments to process.
   */
  _captureObjectsFromArgs(args) {
    const state = this._activeTabState;
    if (args instanceof Array || args instanceof Object) {
      for (const m in args) {
        const arg = args[m];
        if (arg instanceof Object) {
          if (arg.__id !== undefined) {
            const obj = this._getObject(arg.__id);
            if (obj) {
              this.database.capturedObjects.set(arg.__id, obj);
              obj.incrementReferenceCount();
              if (state) {
                state.capturedObjectIds.add(arg.__id);
              }

              if (obj instanceof TextureView) {
                const texture = this.database.getTextureFromView(obj);
                if (texture) {
                  this.database.capturedObjects.set(texture.id, texture);
                  texture.incrementReferenceCount();
                  if (state) {
                    state.capturedObjectIds.add(texture.id);
                  }
                }
              }
            }
          } else {
            this._captureObjectsFromArgs(arg);
          }
        }
      }
    }
  }

  /**
   * Handles capture frame results and builds the UI to display them.
   * @param {number} frame - The frame number.
   * @param {Array<Command>} commands - Array of commands for the frame.
   */
  _captureFrameResults(frame, commands) {
    this._buildCaptureTab({ frame, commands, source: "live", captureData: this._captureData });
  }

  /**
   * Build a tab to display a captured frame. Used for both live captures and
   * captures loaded from a previously-exported JSON file. After this returns,
   * a new tab has been added to the TabWidget and made active; the existing
   * tabs are left intact.
   * @param {Object} init - Tab seed: { frame, commands, source, captureData?, statistics?, importedObjectIds? }
   */
  _buildCaptureTab(init) {
    const frame = init.frame;
    const commands = init.commands;
    const source = init.source || "live";

    // Per-tab state. Lives for the lifetime of the tab. `_onCaptureTabChanged`
    // will re-point `this.*` mirrors at this state when the tab is activated.
    const state = {
      frame,
      source,
      commands,
      statistics: init.statistics || new CaptureStatistics(),
      frameImages: null,
      frameImageList: [],
      passEncoderCommands: new Map(),
      gpuTextureMap: new Map(),
      commandInfoContents: null,
      captureContents: null,
      lastSelectedCommand: null,
      capturedObjectIds: new Set(),
      importedObjectIds: init.importedObjectIds || new Set(),
      captureData: init.captureData || null
    };

    // Activate the new state immediately so that render-time click handlers
    // (which write `lastSelectedCommand`, `capturedObjectIds`, etc.) target
    // this tab. The tab's content won't be visible to the user until addTab +
    // activeTab assignment at the end of the function.
    this._activeTabState = state;
    this._captureCommands = state.commands;
    this._frameImageList = state.frameImageList;
    this._passEncoderCommands = state.passEncoderCommands;
    this._gpuTextureMap = state.gpuTextureMap;
    this.statistics = state.statistics;
    this._lastSelectedCommand = null;

    if (source === "live") {
      this._liveTabState = state;
    }

    const captureContents = new Div(null, { style: "overflow: hidden; white-space: nowrap; height: 100%; min-height: 0; display: flex;" });
    state.captureContents = captureContents;
    captureContents._captureState = state;

    state.frameImages = new Span(captureContents, { class: "capture_frameImages", style: "flex: 0 0 auto;" });
    state.frameImages.style.display = "none";
    this._frameImages = state.frameImages;

    const _frameContents = new Span(captureContents, { class: "capture_frameContents", style: "flex: 0 0 auto; width: 590px; height: 100%; min-height: 0; display: flex; flex-direction: column; overflow: hidden;" });
    const commandInfo = new Span(captureContents, { class: "capture_commandInfo", style: "flex: 1 1 auto; display: flex;" });
    const commandInfoContents = new Div(commandInfo, { style: "flex: 1 1 auto;" });
    state.commandInfoContents = commandInfoContents;

    const self = this;

    const filterArea = new Div(_frameContents, { class: "capture_filterArea" });
    new Span(filterArea, { text: "Filter: ", style: "margin-right: 5px;" });
    this.filterEdit = new TextInput(filterArea, { style: "width: 200px;", placeholder: "Filter", onEdit: (value) => {
      self._filterCommands(value, commands);
    } });
    state.statsButton = new Button(filterArea, {
      label: "Frame Stats",
      class: "btn capture_filter_stats",
      callback: () => self._inspectStats(commandInfoContents)
    });

    // GPU pass timeline. Stays at 0 height until timestamp data arrives, so captures
    // without "Profile Passes" enabled get no layout shift.
    const timeline = new TimelineWidget(_frameContents);
    state.timeline = timeline;
    const populateTimelineFromCommands = () => {
      const timed = [];
      for (const cmd of commands) {
        if (cmd && cmd.duration !== undefined &&
            (cmd.method === "beginRenderPass" || cmd.method === "beginComputePass")) {
          timed.push(cmd);
        }
      }
      if (!timed.length) {
        return false;
      }
      timed.sort((a, b) => a.startTime - b.startTime);
      timeline.setData({ commands: timed, firstTime: timed[0].startTime });
      return true;
    };
    // Imported captures and late-rebuilt live tabs already have the data on the
    // command records. Scan eagerly so the timeline shows up immediately.
    const hadData = populateTimelineFromCommands();
    if (!hadData && init.captureData?.captureTimestampsRequested) {
      // Show a visible placeholder so the user can tell the timeline is wired up
      // and is just waiting on the async timestamp readback (or knows the adapter
      // didn't grant the feature when the placeholder never gets replaced).
      timeline.showPlaceholder("Profile Passes: waiting for GPU timestamp data...");
    }
    if (init.captureData) {
      // Live captures: timestamp readback finishes asynchronously after the tab is
      // built. Listen for the signal and re-scan when it lands.
      init.captureData.onTimestampDataReady.addListener(() => {
        populateTimelineFromCommands();
      });
    }

    this._lastSelectedCommand = null;
    this.statistics.reset();

    const renderResult = renderCommandList(_frameContents, commands, {
      getDisplayName: (id, className) => {
        if (id === undefined) {
          return "<>";
        }
        const obj = this._getObject(id);
        if (obj?.label) {
          return className ? `${className}("${obj.label}", id:${obj.idName})` : `"${obj.label}"(id:${obj.idName})`;
        } else if (obj?.name) {
          return `${obj.label || obj.name}(id:${obj.idName})`;
        }
        return className ? `${className}(id:${id})` : `id:${id}`;
      },
      onCommandRendered: (command) => {
        this._captureObjectsFromArgs(command.args);
        this.statistics.updateStats(this.database, command);
      },
      onSelectCommand: (command, commandIndex, cmd) => {
        this._lastSelectedCommand = cmd;
        this._showCaptureCommandInfo(command, "", commandInfoContents);
      },
      supportsRenderBundles: true,
      getBundleCommands: (bundleId) => this._getObject(bundleId)?.commands ?? null,
      decoratePassHeaderText: (kind, passIndex, command, baseText) => {
        let text = baseText;
        if (kind === "render" || kind === "compute") {
          const label = command.args?.[0]?.label;
          if (label) {
            text += ` "${label}"`;
          }
          if (command.duration !== undefined) {
            text += ` Duration:${command.duration}ms`;
          }
        }
        return text;
      },
      autoSelectFirst: false
    }, state);

    state.passEncoderCommands = renderResult.passEncoderCommands;
    this._passEncoderCommands = renderResult.passEncoderCommands;

    // Select the first command once passEncoderCommands is in place, so any command-info lookups
    // that consult it (e.g. pipeline state) see the fully populated map.
    renderResult.firstCommandWidget?.element.click();

    // For imported captures, the live texture-streaming path that normally
    // uploads pixel data to GPU and builds left-pane thumbnails never fires.
    // Rebuild both now from the serialized mip data.
    if (source !== "live") {
      this._uploadImportedTextureData(state);
      this._buildImportedRenderPassThumbnails(state);
    }

    // Add the tab and make it the active one. The first tab is auto-activated
    // by addTab (which fires onActiveTabChanged); subsequent tabs need an
    // explicit activeTab assignment to switch focus.
    this._captureTabs.push(state);
    const wasFirst = this._captureTab.numTabs === 0;
    const tabLabel = source === "live" ? `Frame ${frame}` : source;
    const handle = this._captureTab.addTab(tabLabel, captureContents);
    state.tabHandle = handle;
    state.tabLabel = tabLabel;
    this._installCaptureTabContextMenu(handle, state);
    if (!wasFirst) {
      this._captureTab.activeTab = this._captureTab.numTabs - 1;
    }

    this.database.onCapturedObjectsChanged.emit();
  }

  /**
   * Attach a right-click context menu to a capture tab handle, offering to
   * re-open the captured frame in a new tab or in a separate browser window.
   * Both options re-import the capture through the same JSON-based path that
   * "Load Capture" uses, so the source tab is left untouched.
   * @param {TabHandle} handle
   * @param {Object} state - The per-tab state stored on captureContents._captureState.
   */
  _installCaptureTabContextMenu(handle, state) {
    if (!handle || !handle.element) {
      return;
    }
    const self = this;
    handle.element.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      e.stopPropagation();
      self._showCaptureTabContextMenu(e.clientX, e.clientY, state);
    });
  }

  /**
   * Build and display the capture-tab context menu at the given screen coords.
   * The menu is anchored to document.body so it can escape its containing
   * scroll/overflow regions, and is dismissed on any click or Escape.
   */
  _showCaptureTabContextMenu(x, y, state) {
    this._closeCaptureTabContextMenu();

    const self = this;
    const menu = document.createElement("div");
    menu.className = "menu-dropdown capture-tab-context-menu open";
    menu.style.position = "fixed";
    menu.style.top = `${y}px`;
    menu.style.left = `${x}px`;

    const addItem = (label, onClick) => {
      const item = document.createElement("div");
      item.className = "menu-item";
      item.textContent = label;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        self._closeCaptureTabContextMenu();
        try {
          onClick();
        } catch (err) {
          console.error(err);
        }
      });
      menu.appendChild(item);
    };

    addItem("Open in New Tab", () => self._reopenCaptureInNewTab(state));
    addItem("Open in New Window", () => self._reopenCaptureInNewWindow(state));

    document.body.appendChild(menu);
    this._activeContextMenu = menu;

    const dismiss = (e) => {
      if (e && menu.contains(e.target)) {
        return;
      }
      self._closeCaptureTabContextMenu();
    };
    const onKey = (e) => {
      if (e.key === "Escape") {
        self._closeCaptureTabContextMenu();
      }
    };
    this._contextMenuDismiss = dismiss;
    this._contextMenuKey = onKey;
    // The contextmenu event that triggered this method has already passed its
    // capture-phase document listeners, so registering now is safe; the only
    // events that will reach `dismiss` are subsequent user actions.
    document.addEventListener("mousedown", dismiss, true);
    document.addEventListener("contextmenu", dismiss, true);
    document.addEventListener("keydown", onKey);
  }

  _closeCaptureTabContextMenu() {
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

  /**
   * Serialize the given tab's capture state to a JSON string, the same shape
   * "Save Capture" would write to disk.
   */
  _captureStateToJson(state) {
    const data = buildCaptureJson(
      state.frame,
      state.commands,
      this.database,
      state.statistics,
      "__buildVersion"
    );
    return JSON.stringify(data);
  }

  /**
   * Re-import the given capture as a fresh tab within this panel. Uses the
   * same code path as loading a saved JSON file so the new tab is fully
   * independent of the source.
   */
  _reopenCaptureInNewTab(state) {
    let text;
    try {
      text = this._captureStateToJson(state);
    } catch (e) {
      console.error("Failed to serialize capture:", e);
      return;
    }
    const label = state.source === "live"
      ? `Frame ${state.frame} (copy)`
      : `${state.tabLabel || state.source} (copy)`;
    this._importCaptureJson(text, label);
  }

  /**
   * Open the given capture in a separate browser window. The new window loads
   * the same panel HTML; we hand off the JSON through IndexedDB keyed by a
   * hash fragment, because capture payloads with mip data routinely exceed
   * localStorage's ~5MB-per-origin cap.
   */
  async _reopenCaptureInNewWindow(state) {
    let text;
    try {
      text = this._captureStateToJson(state);
    } catch (e) {
      console.error("Failed to serialize capture:", e);
      return;
    }
    const labelSource = state.source === "live"
      ? `frame_${state.frame}`
      : (state.tabLabel || state.source || "capture");
    const safeLabel = labelSource.replace(/[^A-Za-z0-9_.-]+/g, "_") || "capture";
    const key = `webgpu_inspector_pending_capture_${safeLabel}_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    try {
      await putCaptureHandoff(key, text);
    } catch (e) {
      console.error("Failed to stash capture for new window:", e);
      return;
    }
    let panelUrl;
    try {
      panelUrl = chrome.runtime.getURL("/webgpu_inspector_panel.html");
    } catch (e) {
      console.error("chrome.runtime.getURL is unavailable:", e);
      return;
    }
    const url = `${panelUrl}#pendingCapture=${encodeURIComponent(key)}`;
    const newWindow = window.open(url, "_blank", "noopener,width=1280,height=800");
    if (!newWindow) {
      console.error("Failed to open new window (popup blocked?).");
    }
  }

  /**
   * Listener for the capture TabWidget. Mirrors the active tab's state on
   * `this.*` so existing accessors keep working, and refreshes the control bar.
   */
  _onCaptureTabChanged(_index, panel) {
    const state = panel && panel._captureState;
    if (state) {
      this._activeTabState = state;
      this._captureCommands = state.commands;
      this._frameImageList = state.frameImageList;
      this._gpuTextureMap = state.gpuTextureMap;
      this._passEncoderCommands = state.passEncoderCommands;
      this._frameImages = state.frameImages;
      this._lastSelectedCommand = state.lastSelectedCommand;
      this.statistics = state.statistics;
      this._saveMenuItem.element.classList.remove("disabled");
    } else if (panel == null) {
      // All tabs closed.
      this._activeTabState = null;
      this._captureCommands = null;
      this._frameImageList = [];
      this._gpuTextureMap = new Map();
      this._passEncoderCommands = new Map();
      this._frameImages = null;
      this._lastSelectedCommand = null;
      this._saveMenuItem.element.classList.add("disabled");
    }
    // Otherwise the active tab is something like a shader editor; leave the
    // capture-related mirrors pointing at the previous capture tab so when the
    // user returns to it, state is unchanged.
  }

  /**
   * Listener for the capture TabWidget. Releases resources held by the tab.
   */
  _onCaptureTabClosed(panel) {
    const state = panel && panel._captureState;
    if (!state) {
      return;
    }
    const idx = this._captureTabs.indexOf(state);
    if (idx >= 0) {
      this._captureTabs.splice(idx, 1);
    }
    if (state === this._liveTabState) {
      this._liveTabState = null;
      this._captureData = null;
    }
    // Release preview GPU textures.
    if (state.gpuTextureMap) {
      state.gpuTextureMap.forEach((t) => {
        if (t && typeof t.removeReference === "function") {
          t.removeReference();
        }
      });
      state.gpuTextureMap.clear();
    }
    // Decrement reference counts for objects this tab captured. Stale entries
    // in `database.capturedObjects` are harmless — `getObject` checks
    // `allObjects` first — so we don't try to surgically remove them here.
    for (const id of state.capturedObjectIds) {
      const obj = this.database.getObject(id);
      if (obj) {
        obj.decrementReferenceCount();
      }
    }
    // Imported tabs own their objects outright; drop them from the database.
    for (const id of state.importedObjectIds) {
      this.database.capturedObjects.delete(id);
    }

    this.database.onCapturedObjectsChanged.emit();
  }

  /**
   * Load a previously-exported capture JSON file as a new tab.
   * @param {string} text - The file contents.
   * @param {string} filename - The originating filename (used as the tab label).
   */
  _importCaptureJson(text, filename) {
    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      console.error("Capture JSON parse error:", e);
      return;
    }
    let imported;
    try {
      const offset = this._nextImportIdOffset;
      this._nextImportIdOffset += 1_000_000_000;
      imported = importCaptureJson(data, this.database, offset);
    } catch (e) {
      console.error("Failed to load capture JSON:", e);
      return;
    }
    this._buildCaptureTab({
      frame: imported.frame,
      commands: imported.commands,
      statistics: imported.statistics,
      importedObjectIds: imported.importedObjectIds,
      source: filename || "imported"
    });
  }

  /**
   * Extracts the texture view from a render pass attachment.
   * @param {Object} attachment - The attachment object.
   * @returns {Object|null} The texture view or null.
   */
  _getTextureViewFromAttachment(attachment) {
    if (!attachment) {
      return null;
    }
    if (attachment.resolveTarget) {
      return this._getObject(attachment.resolveTarget.__id);
    }
    return this._getObject(attachment.view?.__id);
  }

  /**
   * Gets the texture from a render pass attachment.
   * @param {Object} attachment - The attachment object.
   * @returns {Object|null} The texture or null.
   */
  _getTextureFromAttachment(attachment) {
    if (!attachment) {
      return null;
    }
    if (attachment.resolveTarget) {
      if (attachment.resolveTarget?.__texture?.__id) {
        return this._getObject(attachment.resolveTarget.__texture.__id);
      }
    } else {
      if (attachment.view?.__texture?.__id) {
        return this._getObject(attachment.view.__texture.__id);
      }
    }
    const view = this._getTextureViewFromAttachment(attachment);
    if (!view) {
      return null;
    }

    return this.database.getTextureFromView(view);
  }

  /**
   * Creates a widget for displaying a texture preview.
   * @param {HTMLElement} parent - Parent element.
   * @param {Object} texture - The texture to display.
   * @param {number} passId - Render pass identifier.
   * @param {number} size - Display size for the preview.
   * @param {string} style - CSS style string.
   * @returns {HTMLElement} The created container element.
   */
  _createTextureWidget(parent, texture, passId, size, style) {
    const gpuTexture = this._gpuTextureMap.get(passId) ?? texture.gpuTexture;

    // Only supportting 2d previews for now
    if (texture.dimension !== "2d") {
      return;
    }

    let viewWidth = 0;
    let viewHeight = 0;
    if (size) {
      if (texture.width > texture.height) {
        viewWidth = size;
        viewHeight = Math.round(viewWidth * (texture.height / texture.width));
      } else {
        viewHeight = size;
        viewWidth = Math.round(viewHeight * (texture.width / texture.height));
      }
    }

    const container = new Div(parent);

    const layerRanges = texture.layerRanges;

    const numLayers = texture.depthOrArrayLayers;
    for (let layer = 0; layer < numLayers; ++layer) {
      const canvas = new Widget("canvas", new Div(container), { style });
      canvas.element.width = texture.width;
      canvas.element.height = texture.height;

      if (viewWidth) {
        canvas.element.style.width = `${viewWidth}px`;
        canvas.element.style.height = `${viewHeight}px`;
      }

      const layerView = gpuTexture.object.createView({
        dimension: "2d",
        baseArrayLayer: layer,
        arrayLayerCount: 1
      });

      let display = null;
      if (layerRanges && layer in layerRanges) {
        display = {
          exposure: 1.0,
          channels: 0,
          minRange: layerRanges[layer]?.min ?? 0,
          maxRange: layerRanges[layer]?.max ?? 1
        };
      }

      const context = canvas.element.getContext("webgpu");
      const dstFormat = navigator.gpu.getPreferredCanvasFormat();
      context.configure({ "device": this.window.device, "format": navigator.gpu.getPreferredCanvasFormat() });
      const canvasTexture = context.getCurrentTexture();
      this.textureUtils.blitTexture(layerView, texture.format, 1, canvasTexture.createView(), dstFormat, display);
    }

    return container;
  }

  /**
   * Displays detailed info for beginRenderPass command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   */
  _showCaptureCommandInfo_beginRenderPass(command, commandInfo) {
    const renderPassIndex = command._passIndex;
    const args = command.args;
    const self = this;

    const colorAttachments = args[0]?.colorAttachments;
    for (let i = 0, l = colorAttachments.length; i < l; ++i) {
      const attachment = colorAttachments[i];
      const texture = this._getTextureFromAttachment(attachment);
      if (texture) {
        const format = texture.descriptor.format;
        if (texture.gpuTexture) {
          const colorAttachmentGrp = new collapsible(commandInfo, { label: `Color Attachment ${i}: Texture:${texture.idName} ${format} ${texture.resolutionString}` });
          new Button(colorAttachmentGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
            self.window.inspectObject(texture);
          } });
          const passId = this._getPassId(renderPassIndex, i);
          this._createTextureWidget(colorAttachmentGrp.body, texture, passId, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
        } else {
          const colorAttachmentGrp = new collapsible(commandInfo, { label: `Color Attachment ${i}: ${format} ${texture.resolutionString}` });
          new Button(colorAttachmentGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
            self.window.inspectObject(texture);
          } });
          new Widget("pre", colorAttachmentGrp.body, { text: JSON.stringify(attachment.view.descriptor, undefined, 4) });
          const texDesc = this._processCommandArgs(texture.descriptor);
          if (texDesc.usage) {
            texDesc.usage = getFlagString(texDesc.usage, GPUTextureUsage);
          }
          new Widget("pre", colorAttachmentGrp.body, { text: JSON.stringify(texDesc, undefined, 4) });
        }
      }
    }

    const depthStencilAttachment = args[0]?.depthStencilAttachment;
    if (depthStencilAttachment) {
      const texture = this._getTextureFromAttachment(depthStencilAttachment);
      if (texture) {
        if (texture.gpuTexture) {
          const format = texture.descriptor.format;
          const depthStencilAttachmentGrp = new collapsible(commandInfo, { label: `Depth-Stencil Attachment ${format} ${texture.resolutionString}` });
          new Button(depthStencilAttachmentGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
            self.window.inspectObject(texture);
          } });
          this._createTextureWidget(depthStencilAttachmentGrp.body, texture, -1, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
        } else {
          const depthStencilAttachmentGrp = new collapsible(commandInfo, { label: `Depth-Stencil Attachment: ${texture?.format ?? "<unknown format>"} ${texture.resolutionString}` });
          new Button(depthStencilAttachmentGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
            self.window.inspectObject(texture);
          } });
          new Widget("pre", depthStencilAttachmentGrp.body, { text: JSON.stringify(depthStencilAttachment.view.descriptor, undefined, 4) });
          const texDesc = this._processCommandArgs(texture.descriptor);
          if (texDesc.usage) {
            texDesc.usage = getFlagString(texDesc.usage, GPUTextureUsage);
          }
          new Widget("pre", depthStencilAttachmentGrp.body, { text: JSON.stringify(texDesc, undefined, 4) });
        }
      }
    }
  }

  /**
   * Displays buffer data with type information.
   * @param {HTMLElement} ui - Parent UI element.
   * @param {Object} type - The type information.
   * @param {ArrayBuffer} bufferData - The buffer data.
   * @param {number} offset - Offset into the buffer.
   * @param {number} radix - Radix for number display (10, 16, 8, 2).
   */
  _showBufferDataType(ui, type, bufferData, offset = 0, radix = 10) {
    if (!type) {
      return;
    }

    radix = type.radix || radix;

    function toString(value, radix) {
      if (radix === 16) {
        return `0x${value.toString(16)}`;
      }
      if (radix === 2) {
        return `0b${value.toString(2)}`;
      }
      if (radix === 8) {
        return `0o${value.toString(8)}`;
      }
      return `${value}`;
    }

    const typeName = this._getTypeName(type);

    if (typeName === "uint8x2") {
      const data = new Uint8Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}`});
    } else if (typeName === "uint8x4") {
      const data = new Uint8Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`});
    } else if (typeName === "sint8x2") {
      const data = new Int8Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}`});
    } else if (typeName === "sint8x4") {
      const data = new Int8Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`});
    } else if (typeName === "unorm8x2") {
      const data = new Uint8Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${data[0] / 255.0}, ${data[1] / 255.0}`});
    } else if (typeName === "unorm8x4") {
      const data = new Uint8Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${data[0] / 255.0}, ${data[1] / 255.0}, ${data[2] / 255.0}, ${data[3] / 255.0}`});
    } else if (typeName === "snorm8x2") {
      const data = new Int8Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${data[0] / 128}, ${data[1] / 128}`});
    } else if (typeName === "snorm8x4") {
      const data = new Int8Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${data[0] / 128}, ${data[1] / 128}, ${data[2] / 128}, ${data[3] / 128}`});
    } else if (typeName === "uint16x2") {
      const data = new Uint16Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}`});
    } else if (typeName === "uint16x4") {
      const data = new Uint16Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`});
    } else if (typeName === "sint16x2") {
      const data = new Int16Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}`});
    } else if (typeName === "sint16x4") {
      const data = new Int16Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`});
    } else if (typeName === "unorm16x2") {
      const data = new Uint16Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${data[0] / 65535.0}, ${data[1] / 65535.0}`});
    } else if (typeName === "unorm16x4") {
      const data = new Uint16Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${data[0] / 65535.0}, ${data[1] / 65535.0}, ${data[2] / 65535.0}, ${data[3] / 65535.0}`});
    } else if (typeName === "snorm16x2") {
      const data = new Int16Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${data[0] / 32767.0}, ${data[1] / 32767.0}`});
    } else if (typeName === "snorm16x4") {
      const data = new Int16Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${data[0] / 32767.0}, ${data[1] / 32767.0}, ${data[2] / 32767.0}, ${data[3] / 32767.0}`});
    } else if (typeName === "float16x2") {
      // TODO
    } else if (typeName === "float16x4") {
      // TODO
    } else if (typeName === "unorm10-10-10-2") {
      // TODO
    } else if (typeName === "f32" || typeName === "float32") {
      const data = new Float32Array(bufferData.buffer, offset, 1);
      new Widget("li", ui, { text: `${toString(data[0], radix)}`});
    } else if (typeName === "i32" || typeName === "sint32") {
      const data = new Int32Array(bufferData.buffer, offset, 1);
      new Widget("li", ui, { text: `${toString(data[0], radix)}`});
    } else if (typeName === "u32" || typeName === "uint32") {
      const data = new Uint32Array(bufferData.buffer, offset, 1);
      new Widget("li", ui, { text: `${toString(data[0], radix)}`});
    } else if (typeName === "bool") {
      const data = new Uint32Array(bufferData.buffer, offset, 1);
      new Widget("li", ui, { text: `${data[0] ? "true" : "false"}`});
    } else if (typeName === "vec2i" || typeName === "vec2<i32>" || typeName === "sint32x2") {
      const data = new Int32Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}`});
    } else if (typeName === "vec2u" || typeName === "vec2<u32>" || typeName === "uint32x2") {
      const data = new Uint32Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}`});
    } else if (typeName === "vec2f" || typeName === "vec2<f32>" || typeName === "float32x2") {
      const data = new Float32Array(bufferData.buffer, offset, 2);
      new Widget("li", ui, { text: `${toString(data[0], radix)},${toString(data[1], radix)}`});
    } else if (typeName === "vec3i" || typeName === "vec3<i32>" || typeName === "sint32x3") {
      const data = new Int32Array(bufferData.buffer, offset, 3);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`});
    } else if (typeName === "vec3u" || typeName === "vec3<u32>" || typeName === "uint32x3") {
      const data = new Uint32Array(bufferData.buffer, offset, 3);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`});
    } else if (typeName === "vec3f" || typeName === "vec3<f32>" || typeName === "float32x3") {
      const data = new Float32Array(bufferData.buffer, offset, 3);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`});
    } else if (typeName === "vec4i" || typeName === "vec4<i32>" || typeName === "sint32x4") {
      const data = new Int32Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`});
    } else if (typeName === "vec4u" || typeName === "vec4<u32>" || typeName === "uint32x4") {
      const data = new Uint32Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`});
    } else if (typeName === "vec4f" || typeName === "vec4<f32>" || typeName === "float32x4") {
      const data = new Float32Array(bufferData.buffer, offset, 4);
      new Widget("li", ui, { text: `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`});
    } else if (CapturePanel.matrixTypes[type.name]) {
      const t = CapturePanel.matrixTypes[type.name];
      const rows = t.rows;
      const columns = t.columns;
      const data = new Float32Array(bufferData.buffer, offset, rows * columns);
      for (let r = 0, mi = 0; r < rows; ++r) {
        let text = "";
        for (let c = 0; c < columns; ++c, ++mi) {
          text += `${c == 0 ? "" : " "}${data[mi]}`;
        }
        new Widget("li", ui, { text });
      }
    } else if (type.members) {
      const l2 = new Widget("ul", ui);
      for (const m of type.members) {
        const typeName = this._getTypeName(m.type);
        new Widget("li", l2, { text: `${m.name}: ${typeName}` });
        const l3 = new Widget("ul", l2);
        this._showBufferDataType(l3, m.type, bufferData, offset + m.offset, radix);
      }
    } else if (type.name === "array") {
      let count = type.count ?? 0;
      if (count === 0) {
        // Runtime length array
        count = Math.floor((bufferData.length - offset) / (type.stride || type.format.size));
      }

      const arrayUi = new Div(ui, { class: "capture_array_view" });
      let filter = null;
      if (count > 100) {
        filter = new Div(arrayUi, { class: "capture_array_view_filter" });
      }
      const ul = new Widget("ul", arrayUi);

      if (count) {
        let subOffset = 0;
        let maxCount = 100;

        const self = this;

        function showArrayData(ul, subOffset, maxCount) {
          let stride = type.stride;
          let elementOffset = offset + (subOffset * stride);
          let subCount = Math.min(count - subOffset, maxCount);
          let format = type.format;
          const formatName = self._getTypeName(format);
          for (let i = 0; i < subCount; ++i) {
            let value = null;
            if (formatName === "f32" || formatName === "atomic<f32>") {
              const data = new Float32Array(bufferData.buffer, elementOffset, 1);
              value = toString(data[0], radix);
            } else if (formatName === "i32" || formatName === "atomic<i32>") {
              const data = new Int32Array(bufferData.buffer, elementOffset, 1);
              value = toString(data[0], radix);
            } else if (formatName === "u32" || formatName === "atomic<u32>") {
              const data = new Uint32Array(bufferData.buffer, elementOffset, 1);
              value = toString(data[0], radix);
            } else if (formatName === "bool" || formatName === "atomic<bool>") {
              const data = new Uint32Array(bufferData.buffer, elementOffset, 1);
              value = data[0] ? "true" : "false";
            } else if (formatName === "vec2i" || formatName === "vec2<i32>") {
              const data = new Int32Array(bufferData.buffer, elementOffset, 2);
              value = `${toString(data[0], radix)}, ${data[1]}`;
            } else if (formatName === "vec2u" || formatName === "vec2<u32>") {
              const data = new Uint32Array(bufferData.buffer, elementOffset, 2);
              value = `${toString(data[0], radix)}, ${toString(data[1], radix)}`;
            } else if (formatName === "vec2f" || formatName === "vec2<f32>") {
              const data = new Float32Array(bufferData.buffer, elementOffset, 2);
              value = `${toString(data[0], radix)}, ${toString(data[1], radix)}`;
            } else if (formatName === "vec3i" || formatName === "vec3<i32>") {
              const data = new Int32Array(bufferData.buffer, elementOffset, 3);
              value = `${data[0]}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`;
            } else if (formatName === "vec3u" || formatName === "vec3<u32>") {
              const data = new Uint32Array(bufferData.buffer, elementOffset, 3);
              value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`;
            } else if (formatName === "vec3f" || formatName === "vec3<f32>") {
              const data = new Float32Array(bufferData.buffer, elementOffset, 3);
              value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`;
            } else if (formatName === "vec4i" || formatName === "vec4<i32>") {
              const data = new Int32Array(bufferData.buffer, elementOffset, 4);
              value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`;
            } else if (formatName === "vec4u" || formatName === "vec4<u32>") {
              const data = new Uint32Array(bufferData.buffer, elementOffset, 4);
              value = `${data[0]}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`;
            } else if (formatName === "vec4f" || formatName === "vec4<f32>") {
              const data = new Float32Array(bufferData.buffer, elementOffset, 4);
              value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`;
            }

            if (format.isStruct && format.members?.length === 1) {
              const member = format.members[0];
              if (member.isArray) {
                const arrayFormat = member.format;
                const arrayFormatName = self._getTypeName(arrayFormat);
                if (arrayFormatName === "u32" || arrayFormatName === "atomic<u32>") {
                  if (member.count === 1) {
                    const data = new Uint32Array(bufferData.buffer, elementOffset, 1);
                    value = `${toString(data[0], radix)}`;
                  } else if (member.count === 2) {
                    const data = new Uint32Array(bufferData.buffer, elementOffset, 2);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}`;
                  } else if (member.count === 3) {
                    const data = new Uint32Array(bufferData.buffer, elementOffset, 3);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`;
                  } else if (member.count === 4) {
                    const data = new Uint32Array(bufferData.buffer, elementOffset, 4);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`;
                  }
                } else if (arrayFormatName === "i32" || arrayFormatName === "atomic<i32>") {
                  if (member.count === 1) {
                    const data = new Int32Array(bufferData.buffer, elementOffset, 1);
                    value = `${toString(data[0], radix)}`;
                  } else if (member.count === 2) {
                    const data = new Int32Array(bufferData.buffer, elementOffset, 2);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}`;
                  } else if (member.count === 3) {
                    const data = new Int32Array(bufferData.buffer, elementOffset, 3);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`;
                  } else if (member.count === 4) {
                    const data = new Int32Array(bufferData.buffer, elementOffset, 4);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`;
                  }
                } else if (arrayFormatName === "f32" || arrayFormatName === "atomic<f32>") {
                  if (member.count === 1) {
                    const data = new Float32Array(bufferData.buffer, elementOffset, 1);
                    value = `${toString(data[0], radix)}`;
                  } else if (member.count === 2) {
                    const data = new Float32Array(bufferData.buffer, elementOffset, 2);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}`;
                  } else if (member.count === 3) {
                    const data = new Float32Array(bufferData.buffer, elementOffset, 3);
                    value = `${data[0]}, ${toString(data[1], radix)}, ${toString(data[2], radix)}`;
                  } else if (member.count === 4) {
                    const data = new Float32Array(bufferData.buffer, elementOffset, 4);
                    value = `${toString(data[0], radix)}, ${toString(data[1], radix)}, ${toString(data[2], radix)}, ${toString(data[3], radix)}`;
                  }
                }
              }
            }

            if (value !== null) {
              new Widget("li", ul, { text: `[${i + subOffset}]: ${value}` });
            } else {
              new Widget("li", ul, { text: `[${i + subOffset}]: ${formatName}` });
              const ul2 = new Widget("ul", ul);
              self._showBufferDataType(ul2, format, bufferData, elementOffset);
            }

            elementOffset += stride;
          }
        }

        if (count > 100) {
          new Span(filter, { text: "Offset:" });
          new NumberInput(filter, { value: 0, min: 0, max: count, precision: 0, step: 1, tooltip: "Starting element of the array to display",
            onChange: (value) => {
              try {
                subOffset = Math.max(parseInt(value), 0);
              } catch (e) {
                console.log(e.message);
                subOffset = 0;
              }
              ul.removeAllChildren();
              showArrayData(ul, subOffset, maxCount);
           }, style: "display: inline-block; width: 75px; margin-right: 10px; vertical-align: middle;" });

          new Span(filter, { text: "Count:" });
          new NumberInput(filter, { value: 100, min: 1, max: 1000, precision: 0, step: 1, tooltip: "Number of elements to display",
            onChange: (value) => {
              try {
                maxCount = Math.max(parseInt(value), 1);
              } catch (e) {
                console.log(e.message);
                maxCount = 100;
              }
              ul.removeAllChildren();
              showArrayData(ul, subOffset, maxCount);
            }, style: "display: inline-block; width: 75px; margin-right: 10px; vertical-align: middle;" });
          new Span(filter, { text: `/ ${count}` });
        }

        showArrayData(ul, subOffset, maxCount);
      }
    }
  }

  /**
   * Sets the buffer format using WGSL reflection.
   * @param {Object} type - Type object to set format on.
   * @param {string} typeName - Name of the type.
   * @param {string} format - WGSL format string.
   * @param {boolean} skipStructEncapsulation - Whether to skip struct wrapping.
   * @param {number} radix - Radix for number display.
   */
  _setBufferFormat(type, typeName, format, skipStructEncapsulation = false, radix = 10) {
    try {
      let reflect = new WgslReflect(format);
      if (reflect) {
        for (const struct of reflect.structs) {
          if (struct.name === typeName) {
            type.replacement = struct;
            type.replacement.radix = radix;
            //console.log("REPLACEMENT RADIX", type.replacement.radix);
            return;
          }
        }
        // If structs are defined but none of the names match, use the last one.
        if (reflect.structs.length > 0) {
          type.replacement = reflect.structs[reflect.structs.length - 1];
          type.replacement.radix = radix;
          //console.log("REPLACEMENT RADIX", type.replacement.radix);
          return;

        }
      }
      if (!skipStructEncapsulation) {
        // basic and array types need to be wrapped in a struct for the reflection to work.
        const newTypeName = `_${type.name}`;
        const structFormat = `struct _${type.name} { _: ${format} }`;
        this._setBufferFormat(type, newTypeName, structFormat, true, radix);
      }
    } catch (e) {
    }
  }

  /**
   * Creates a button for editing buffer format.
   * @param {HTMLElement} parentWidget - Parent element.
   * @param {Object} resource - The resource with type information.
   * @param {HTMLElement} bufferDataUI - Element for buffer data display.
   * @param {ArrayBuffer} bufferData - The buffer data.
   */
  _createFormatButton(parentWidget, resource, bufferDataUI, bufferData) {
    function resourceType(resource) {
      return resource.type.replacement || resource.type;
    }

    const self = this;

    new Button(parentWidget, { label: "Format", callback: () => {
      const dialog = new Dialog({
        title: 'Buffer Format',
        width: 300,
        draggable: true,
      });

      const format = getFormatFromReflection(resourceType(resource));

      const nameEdit = new TextArea(dialog.body, {
        value: format,
        style: 'width: 100%; height: 200px;',
      });

      const optionssRow = new Div(dialog.body, { style: "padding-left: 10px; margin-top: 4px;" });
      new Span(optionssRow, { text: "Radix:", style: "margin-right: 5px;" });
      const radixSelect = [ 10, 16, 8, 2 ];
      let radix = resourceType(resource)?.radix || 10;
      new Select(optionssRow, {
        options: [ "Decimal", "Hexadecimal", "Octal", "Binary" ],
        value: radix === 16 ? "Hexadecimal" : radix === 8 ? "Octal" : radix === 2 ? "Binary" : "Decimal",
        onChange: (_, index) => {
          radix = radixSelect[index];
        }
      });

      const buttonRow = new Div(dialog.body, {
        style: 'width: 100%; margin-top: 20px;',
      });

      const self = this;

      new Button(buttonRow, {
        label: 'Apply',
        style: 'margin-left: 15px; auto;',
        callback: function () {
          dialog.close();
          const type = resourceType(resource);
          self._setBufferFormat(resource.type, type.name, nameEdit.value, false, radix);
          bufferDataUI.html = "";
          const newType = resourceType(resource);
          self._showBufferDataType(bufferDataUI, newType, bufferData);
        }
      });

      new Button(buttonRow, {
        label: 'Revert',
        style: 'margin-left: 15px; auto;',
        callback: function () {
          resource.type.replacement = null;
          dialog.close();
          bufferDataUI.html = "";
          self._showBufferDataType(bufferDataUI, resource.type, bufferData);
        }
      });

      new Button(buttonRow, {
        label: 'Cancel',
        style: 'margin-left: 15px; auto;',
        callback: function () {
          dialog.close();
        }
      });
    } });
  }

  /**
   * Shows buffer data information for uniform or storage resources.
   * @param {HTMLElement} parentWidget - Parent element.
   * @param {Object} resource - The resource with type info.
   * @param {ArrayBuffer} bufferData - The buffer data.
   */
  _showBufferDataInfo(parentWidget, resource, bufferData) {
    function resourceType(resource) {
      return resource.type.replacement || resource.type;
    }

    if (resource.resourceType === ResourceType.Uniform) {
      const typeName = this._getTypeName(resource.type);
      new Div(parentWidget, { text: `UNIFORM: ${resource.name}: ${typeName}` });

      const bufferDataUI = new Div(null);
      this._createFormatButton(parentWidget, resource, bufferDataUI, bufferData)
      bufferDataUI.parent = parentWidget;

      this._showBufferDataType(bufferDataUI, resourceType(resource), bufferData);
    } else if (resource.resourceType === ResourceType.Storage) {
      const typeName = this._getTypeName(resource.type);
      new Div(parentWidget, { text: `STORAGE ${resource.access}: ${resource.name}: ${typeName}` });

      const bufferDataUI = new Div(null);
      this._createFormatButton(parentWidget, resource, bufferDataUI, bufferData)
      bufferDataUI.parent = parentWidget;

      this._showBufferDataType(bufferDataUI, resourceType(resource), bufferData);
    }
  }

  /**
   * Finds binding resource information from pipeline state.
   * @param {Object} state - The pipeline state.
   * @param {number} group - Bind group index.
   * @param {number} binding - Binding index.
   * @returns {Object|null} The resource information or null.
   */
  _findBindingResourceFromState(state, group, binding) {
    if (!state) {
      return null;
    }

    const id = state.pipeline?.args[0]?.__id;
    const pipeline = this._getObject(id);

    if (pipeline) {
      const desc = pipeline.descriptor;
      const vertexId = desc.vertex?.module?.__id;
      const fragmentId = desc.fragment?.module?.__id;
      const computeId = desc.compute?.module?.__id;
      if (computeId) {
        const module = this._getObject(computeId);
        if (module?.reflection) {
          let entry = desc.compute.entryPoint ?? "";
          if (!entry) {
            entry = module.reflection.entry.compute[0].name;
          }
          const resource = module.reflection.findResource(group, binding, entry);
          if (resource) {
            return resource;
          }
        }
      } else if (vertexId !== undefined && vertexId === fragmentId) {
        const module = this._getObject(vertexId);
        if (module?.reflection) {
          let entry = desc.vertex?.entryPoint ?? "";
          if (!entry) {
            entry = module.reflection.entry.vertex[0].name;
          }
          let resource = module.reflection.findResource(group, binding, entry);
          if (resource) {
            return resource;
          }

          entry = desc.fragment?.entryPoint ?? "";
          if (!entry) {
            entry = module.reflection.entry.fragment[0].name;
          }
          resource = module.reflection.findResource(group, binding, entry)
        }
      } else {
        const vertexModule = this._getObject(vertexId);
        if (vertexModule?.reflection) {
          let entry = desc.vertex?.entryPoint ?? "";
          if (!entry) {
            entry = vertexModule.reflection.entry.vertex[0].name;
          }
          const resource = vertexModule.reflection.findResource(group, binding, entry);
          if (resource) {
            return resource;
          }
        }

        const fragmentModule = this._getObject(fragmentId);
        if (fragmentModule?.reflection) {
          let entry = desc.fragment?.entryPoint ?? "";
          if (!entry) {
            entry = fragmentModule.reflection.entry.fragment[0].name;
          }
          const resource = fragmentModule.reflection.findResource(group, binding, entry);
          if (resource) {
            return resource;
          }
        }
      }
    }

    return null;
  }

  /**
   * Shows buffer data for a specific binding.
   * @param {HTMLElement} parentWidget - Parent element.
   * @param {number} groupIndex - Bind group index.
   * @param {number} entryIndex - Binding entry index.
   * @param {Object} bindGroup - The bind group.
   * @param {Object} state - Pipeline state.
   * @param {ArrayBuffer} bufferData - The buffer data.
   */
  _showBufferData(parentWidget, groupIndex, entryIndex, bindGroup, state, bufferData) {
    new Div(parentWidget, { text: `Group ${groupIndex} Binding ${entryIndex} Size: ${bufferData.length}` });

    const resource = this._findBindingResourceFromState(state, groupIndex, entryIndex);
    if (resource) {
      this._showBufferDataInfo(parentWidget, resource, bufferData);
    }
  }

  /**
   * Displays info for setBindGroup command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   * @param {number} groupIndex - Bind group index.
   * @param {boolean} skipInputs - Whether to skip input textures.
   * @param {Object} state - Pipeline state.
   * @param {Array} commands - Array of commands.
   */
  _showCaptureCommandInfo_setBindGroup(command, commandInfo, groupIndex, skipInputs, state, commands) {
    const args = command.args;
    const id = args[1]?.__id;
    const bindGroup = this._getObject(id);
    if (!bindGroup) {
      return;
    }

    const self = this;

    const group = args[0];
    const bindGroupGrp = new collapsible(commandInfo, { collapsed: true, label: `BindGroup ${groupIndex ?? ""} ID:${id}` });
    new Button(bindGroupGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
      self.window.inspectObject(bindGroup);
    } });

    const bindGroupDesc = bindGroup.descriptor;
    const newDesc = this._processCommandArgs(bindGroupDesc);
    const descStr = JSON.stringify(newDesc, undefined, 4);
    new Widget("pre", bindGroupGrp.body, { text: descStr });

    function getResourceType(resource) {
      if (resource.__id !== undefined) {
        const obj = self._getObject(resource.__id);
        if (obj) {
          return obj.constructor.className;
        }
      }
      if (resource.buffer) {
        return "Buffer";
      }
      if (resource.__class) {
        return resource.__class;
      }
      return "<unknown resource type>";
    }

    function getResourceId(resource) {
      if (resource.__id !== undefined) {
        const object = self._getObject(resource.__id);
        if (object instanceof TextureView) {
          const texture = self.database.getTextureFromView(object);
          if (texture) {
            return `${texture.label} (ID: ${resource.__id})`;
          }
        }
        return `${object.name} (ID: ${resource.__id})`;
      }
      if (resource.buffer?.__id !== undefined) {
        const buffer = self._getObject(resource.buffer.__id);
        return `${buffer?.name} (ID: ${resource.buffer.__id})`;
      }
      return `<unknown>`;
    }

    function getResourceUsage(resource) {
      if (resource.buffer) {
        const buffer = self._getObject(resource.buffer.__id);
        if (buffer) {
          const usage = buffer.descriptor.usage & GPUBufferUsage.UNIFORM ? "Uniform" :
                buffer.descriptor.usage & GPUBufferUsage.STORAGE ? "Storage" :
                "";
          return usage;
        }
      }
      return "";
    }

    function getBindingAccess(state, group, binding) {
      if (state) {
        const pipelineId = state.pipeline?.args[0]?.__id;
        const pipeline = self._getObject(pipelineId);
        if (pipeline) {
          const desc = pipeline.descriptor;
          const vertexId = desc.vertex?.module?.__id;
          const fragmentId = desc.fragment?.module?.__id;
          const computeId = desc.compute?.module?.__id;
          if (computeId) {
            const module = self._getObject(computeId);
            if (module) {
              const reflection = module.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == group && storage.binding == binding) {
                    return `Access: ${storage.access}`;
                  }
                }
              }
            }
          } else if (vertexId !== undefined && vertexId === fragmentId) {
            const module = self._getObject(vertexId);
            if (module) {
              const reflection = module.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == group && storage.binding == binding) {
                    return `Access: ${storage.access}`;
                  }
                }
              }
            }
          } else {
            const vertexModule = self._getObject(vertexId);
            if (vertexModule) {
              const reflection = vertexModule.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == group && storage.binding == binding) {
                    return `Access: ${storage.access}`;
                  }
                }
              }
            }

            const fragmentModule = self._getObject(fragmentId);
            if (fragmentModule) {
              const reflection = fragmentModule.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == group && storage.binding == binding) {
                    return `Access: ${storage.access}`;
                  }
                }
              }
            }
          }
        }
      }
      return "";
    }

    if (!skipInputs) {
      const inputs = [];
      if (bindGroup?.entries) {
        for (const entry of bindGroup.entries) {
          if (entry.resource?.__id) {
            const resource = this._getObject(entry.resource.__id);
            if (resource instanceof TextureView) {
              const binding = entry.binding;
              inputs.push({textureView: resource, group, binding });
            }
          }
        }
      }

      if (inputs.length) {
        const inputGrp = new collapsible(commandInfo, { collapsed: true, label: "Input Textures" });
        for (const resource of inputs) {
          const texture = this.database.getTextureFromView(resource.textureView);
          if (texture) {
            new Button(inputGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
              self.window.inspectObject(texture);
            } });
            if (texture.gpuTexture) {
              const canvasDiv = new Div(inputGrp.body);
              new Div(canvasDiv, { text: `Group: ${resource.group} Binding: ${resource.binding} Texture: ${texture.idName} ${texture.format} ${texture.resolutionString}` });
              this._createTextureWidget(canvasDiv, texture, -1, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
            } else {
              this.database.requestTextureData(texture);
            }
          }
        }
      }
    }

    const bindGroupCmd = state?.bindGroups[groupIndex];

    for (const entryIndex in bindGroupDesc.entries) {
      const entry = bindGroupDesc.entries[entryIndex];

      const binding = entry.binding;
      const resource = entry.resource;
      const groupLabel = groupIndex !== undefined ? `Group ${groupIndex} ` : "";

      let access = getBindingAccess(state, groupIndex, binding);
      /*if (state) {
        const pipelineId = state.pipeline?.args[0]?.__id;
        const pipeline = this._getObject(pipelineId);
        if (pipeline) {
          const desc = pipeline.descriptor;
          const vertexId = desc.vertex?.module?.__id;
          const fragmentId = desc.fragment?.module?.__id;
          const computeId = desc.compute?.module?.__id;
          if (computeId) {
            const module = this._getObject(computeId);
            if (module) {
              const reflection = module.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == groupIndex && storage.binding == binding) {
                    access = storage.access;
                    break;
                  }
                }
              }F
            }
          } else if (vertexId !== undefined && vertexId === fragmentId) {
            const module = this._getObject(vertexId);
            if (module) {
              const reflection = module.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == groupIndex && storage.binding == binding) {
                    access = storage.access;
                    break;
                  }
                }
              }
            }
          } else {
            const vertexModule = this._getObject(vertexId);
            if (vertexModule) {
              const reflection = vertexModule.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == groupIndex && storage.binding == binding) {
                    access = storage.access;
                    break;
                  }
                }
              }
            }

            const fragmentModule = this._getObject(fragmentId);
            if (fragmentModule) {
              const reflection = fragmentModule.reflection;
              if (reflection) {
                for (const storage of reflection.storage) {
                  if (storage.group == groupIndex && storage.binding == binding) {
                    access = storage.access;
                    break;
                  }
                }
              }
            }
          }
        }
      }*/

      let size = null;
      if (resource.buffer) {
        size = resource.size;
        /*if (bindGroupCmd?.isBufferDataLoaded) {
          if (bindGroupCmd.isBufferDataLoaded[entryIndex]) {
            const bufferData = bindGroupCmd.bufferData[entryIndex];
            if (bufferData) {
              size = bufferData.length;
            }
          }
        }*/
      }

      let label = `${groupLabel}Binding ${binding}: ${getResourceType(resource)} ${getResourceId(resource)} ${getResourceUsage(resource)}`;

      if (access) {
        label += ` ${access}`;
      }

      if (size) {
        label += ` Size: ${size}`;
      }

      if (resource.buffer) {
        const binding = this._findBindingResourceFromState(state, groupIndex, entryIndex);
        if (binding) {
          const typeName = this._getTypeName(binding.type);
          if (typeName) {
            label += ` Type: ${typeName}`;
          }
        }
      }

      const resourceGrp = new collapsible(commandInfo, { collapsed: true, label });
      if (resource.__id !== undefined) {
        const obj = this._getObject(resource.__id);
        if (obj) {
          new Button(resourceGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
            self.window.inspectObject(obj);
          } });

          if (obj instanceof Sampler) {
            new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
            new Widget("pre", resourceGrp.body, { text: JSON.stringify(obj.descriptor, undefined, 4) });
          } else if (obj instanceof TextureView) {
            const texture = this._getObject(obj.texture);

            new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
            new Widget("pre", resourceGrp.body, { text: JSON.stringify(obj.descriptor, undefined, 4) });
            if (texture) {
              new Div(resourceGrp.body, { text: `GPUTexture ID:${texture.idName}` });
              const newDesc = this._processCommandArgs(texture.descriptor);
              if (newDesc.usage) {
                newDesc.usage = getFlagString(newDesc.usage, GPUTextureUsage);
              }
              new Widget("pre", resourceGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });

              if (texture.gpuTexture) {
                const w = Math.max(Math.min(texture.width, texture.height, 256), 64);
                this._createTextureWidget(resourceGrp.body, texture, -1, w, "margin-left: 20px; margin-top: 10px; margin-bottom: 10px;");
              }
            }
          } else {
            new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
            new Widget("pre", resourceGrp.body, { text: JSON.stringify(obj.descriptor, undefined, 4) });
          }
        } else {
          new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
        }
      } else {
        if (resource.buffer) {
          const bufferId = resource.buffer.__id;
          const buffer = this._getObject(bufferId);
          if (buffer) {
            new Button(resourceGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
              self.window.inspectObject(buffer);
            } });
            const bufferDesc = buffer.descriptor;
            const newDesc = this._processCommandArgs(bufferDesc);
            if (newDesc.usage) {
              newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
            }
            new Widget("pre", resourceGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
          } else {
            new Div(resourceGrp.body, { text: `Buffer ID:${bufferId}` });
          }

          const affectedByCommands = [];
          let commandIndex = this._captureCommands.indexOf(command);
          if (commandIndex !== -1) {
            commandIndex--;
            for (; commandIndex >= 0; --commandIndex) {
              const cmd = this._captureCommands[commandIndex];
              if (cmd.method === "writeBuffer") {
                if (cmd.args[0]?.__id === bufferId) {
                  affectedByCommands.push(cmd);
                }
              } else if (cmd.method === "createBuffer") {
                if (cmd.result.__id === bufferId) {
                  affectedByCommands.push(cmd);
                }
              } else if (cmd.method === "dispatchWorkgroups" || cmd.method === "dispatchWorkgroupsIndirect") {
                const cmdState = this._getPipelineState(cmd, commands);
                if (cmdState) {
                  for (const bindGroupCmd of cmdState.bindGroups) {
                    const groupIndex = bindGroupCmd.args[0];
                    const bindGroup = this.database.getObject(bindGroupCmd.args[1]?.__id);
                    if (bindGroup) {
                      const bindGroupDesc = bindGroup.descriptor;
                      for (const entry of bindGroupDesc.entries) {
                        if (entry.resource?.buffer?.__id === bufferId) {
                          const access = getBindingAccess(cmdState, groupIndex, entry.binding);
                          if (access === "write" || access === "read_write") {
                            affectedByCommands.push(cmd);
                          }
                          break;
                        }
                      }
                    }
                  }
                }
              }
            }

            if (affectedByCommands.length) {
              new Div(resourceGrp.body, { text: "Affected by:" });
              const ul = new Widget("ul", resourceGrp.body, { style: "max-height:150px; overflow:auto; scrollbar-width:thin;" });
              for (const cmd of affectedByCommands) {
                const li = new Widget("li", ul, { text: `${cmd.id}: ${cmd.method}` });
                li.element.onclick = () => {
                  cmd.widget.element.click();
                };
              }
            }
          }

          if (bindGroupCmd?.isBufferDataLoaded) {
            if (bindGroupCmd.isBufferDataLoaded[entryIndex]) {
              const bufferData = bindGroupCmd.bufferData[entryIndex];
              if (bufferData) {
                this._showBufferData(resourceGrp.body, groupIndex, binding, bindGroup, state, bufferData);
              }
            }
          }
        } else {
          new Widget("pre", resourceGrp.body, { text: JSON.stringify(resource, undefined, 4) });
        }
      }
    }
  }

  /**
   * Displays info for setPipeline command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   * @param {Object} parentCommand - Parent command for debugging.
   */
  _showCaptureCommandInfo_setPipeline(command, commandInfo, parentCommand) {
    const args = command.args;
    const self = this;
    const id = args[0]?.__id;
    const pipeline = this._getObject(id);

    if (pipeline) {
      const pipelineGrp = new collapsible(commandInfo, { collapsed: true, label: `Pipeline ID:${id}` });
      new Button(pipelineGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
        self.window.inspectObject(pipeline);
      } });
      const desc = pipeline.descriptor;
      const newDesc = this._processCommandArgs(desc);
      const descStr = JSON.stringify(newDesc, undefined, 4);
      new Widget("pre", pipelineGrp.body, { text: descStr });

      const vertexId = desc.vertex?.module?.__id;
      const fragmentId = desc.fragment?.module?.__id;

      if (vertexId !== undefined && vertexId === fragmentId) {
        const module = this._getObject(vertexId);
        if (module) {
          const vertexEntry = desc.vertex?.entryPoint ?? "@vertex";
          const fragmentEntry = desc.fragment?.entryPoint ?? "@fragment";
          const grp = new collapsible(commandInfo, { collapsed: true, label: `Module ID:${vertexId} Vertex: ${vertexEntry} Fragment: ${fragmentEntry}` });
          new Button(grp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
            self.window.inspectObject(module);
          } });
          const code = module.descriptor.code;
          new Widget("pre", grp.body, { text: code });

          this._shaderInfo("Vertex+Fragment", module, commandInfo);
        }
      } else {
        if (vertexId !== undefined) {
          const vertexModule = this._getObject(vertexId);
          if (vertexModule) {
            const vertexEntry = desc.vertex?.entryPoint ?? "@vertex";
            const vertexGrp = new collapsible(commandInfo, { collapsed: true, label: `Vertex Module ID:${vertexId} Entry: ${vertexEntry}` });
            new Button(vertexGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
              self.window.inspectObject(vertexModule);
            } });
            const code = vertexModule.descriptor.code;
            new Widget("pre", vertexGrp.body, { text: code });

            this._shaderInfo("Vertex", vertexModule, commandInfo);
          }
        }

        if (fragmentId !== undefined) {
          const fragmentModule = this._getObject(fragmentId);
          if (fragmentModule) {
            const fragmentEntry = desc.fragment?.entryPoint ?? "@fragment";
            const fragmentGrp = new collapsible(commandInfo, { collapsed: true, label: `Fragment Module ID:${fragmentId} Entry: ${fragmentEntry}` });
            new Button(fragmentGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
              self.window.inspectObject(fragmentModule);
            } });
            const code = fragmentModule.descriptor.code;
            new Widget("pre", fragmentGrp.body, { text: code });

            this._shaderInfo("Fragment", fragmentModule, commandInfo);
          }
        }
      }

      const computeId = desc.compute?.module?.__id;
      if (computeId !== undefined) {
        const computeModule = this._getObject(computeId);
        if (computeModule) {
          const computeEntry = desc.compute?.entryPoint ?? "@compute";
          const computeGrp = new collapsible(commandInfo, { collapsed: true, label: `Compute Module ID:${computeId} Entry: ${computeEntry}` });
          new Button(computeGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
            self.window.inspectObject(computeModule);
          } });
          if (parentCommand) {
            new Button(computeGrp.body, { 
              //children: [ new Img(null, { title: "Debug Shader", src: "img/debug.svg", style: "width: 15px; height: 15px; filter: invert(1);" }) ],
              text: "Debug",
              title: "Debug Shader", style: "background-color: rgb(90, 40, 40);", callback: () => {
                self._debugShader(command, computeEntry, parentCommand);
            } });
          }
          const code = computeModule.descriptor.code;
          new Widget("pre", computeGrp.body, { text: code });

          this._shaderInfo("Compute", computeModule, commandInfo);
        }
      }
    }
  }

  /**
   * Opens shader debugger for a compute shader.
   * @param {Object} command - The command object.
   * @param {string} entry - Entry point name.
   * @param {Object} parentCommand - Parent command.
   */
  _debugShader(command, entry, parentCommand) {
    const args = command.args;
    const id = args[0]?.__id;
    const pipeline = this._getObject(id);
    const desc = pipeline.descriptor;
    const computeId = desc.compute?.module?.__id;
    const editor = new ShaderDebugger(parentCommand, entry, this._captureData, this.database, this, { style: "overflow: clip;" });
    this._captureTab.addTab(`Compute Module ID:${computeId}: ${entry}`, editor);
    this._captureTab.setActivePanel(editor);
  }

  /**
   * Displays info for writeBuffer command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   */
  _showCaptureCommandInfo_writeBuffer(command, commandInfo) {
    const args = command.args;
    const id = args[0]?.__id;
    const buffer = this._getObject(id);

    if (buffer) {
      const bufferGrp = new collapsible(commandInfo, { label: `Buffer ID:${id}` });
      const desc = buffer.descriptor;
      const newDesc = this._processCommandArgs(desc);
      if (newDesc.usage) {
        newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
      }
      new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
    }
  }

  /**
   * Displays info for setIndexBuffer command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   * @param {boolean} collapsed - Initial collapsed state.
   * @param {number} firstIndex - First index value.
   * @param {number} indexCount - Number of indices.
   */
  _showCaptureCommandInfo_setIndexBuffer(command, commandInfo, collapsed, firstIndex, indexCount) {
    const args = command.args;
    const self = this;
    const id = args[0]?.__id;
    const buffer = this._getObject(id);
    if (buffer) {
      const bufferGrp = new collapsible(commandInfo, { collapsed, label: `Index Buffer ID:${id}` });
      new Button(bufferGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
        self.window.inspectObject(buffer);
      } });
      const desc = buffer.descriptor;
      const newDesc = this._processCommandArgs(desc);
      if (newDesc.usage) {
        newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
      }
      new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });

      if (command.isBufferDataLoaded && command.bufferData) {
        const bufferData = command.bufferData[0];
        if (bufferData) {
          const indexArray = args[1] === "uint32" ? new Uint32Array(bufferData.buffer, bufferData.byteOffset, bufferData.byteLength / 4)
              : new Uint16Array(bufferData.buffer, bufferData.byteOffset, bufferData.byteLength / 2);
          const effectiveFirstIndex = firstIndex ?? 0;
          const effectiveIndexCount = indexCount ?? indexArray.length;
          new Div(bufferGrp.body, { text: `Index Buffer: ${buffer.name}[id:${buffer.id}] Format:${indexArray instanceof Uint32Array ? "uint32" : "uint16"} Count:${indexArray.length}` });
          const button = new Button(bufferGrp.body, { label: "Show Data", callback: () => {
            if (button.element.innerText === "Hide Data") {
              button.element.innerText = "Show Data";
              bufferGrp.body.removeChild(bufferGrp.body.lastChild);
              return;
            }
            button.element.innerText = "Hide Data";
            const displayCount = Math.min(effectiveIndexCount, indexArray.length - effectiveFirstIndex);

            let subOffset = 0;
            let maxCount = 100;

            let ol = null;

            function showIndexData(ol, subOffset, maxCount) {
              const startIndex = effectiveFirstIndex + subOffset;
              const count = Math.min(maxCount, displayCount - subOffset);
              for (let i = 0; i < count; ++i) {
                new Widget("div", ol, { text: `[${startIndex + i}]: ${indexArray[startIndex + i]}` });
              }
            }

            if (displayCount > 100) {
              const filter = new Div(bufferGrp.body);
              new Span(filter, { text: "Offset:" });
              new NumberInput(filter, { value: 0, min: 0, max: displayCount, precision: 0, step: 1, tooltip: "Starting element of the array to display",
                onChange: (value) => {
                  try {
                    subOffset = Math.max(parseInt(value), 0);
                  } catch (e) {
                    console.log(e.message);
                    subOffset = 0;
                  }
                  ol.removeAllChildren();
                  showIndexData(ol, subOffset, maxCount);
                }, style: "display: inline-block; width: 75px; margin-right: 10px; vertical-align: middle;" });

              new Span(filter, { text: "Count:" });
              new NumberInput(filter, { value: 100, min: 1, max: 1000, precision: 0, step: 1, tooltip: "Number of elements to display",
                onChange: (value) => {
                  try {
                    maxCount = Math.max(parseInt(value), 1);
                  } catch (e) {
                    console.log(e.message);
                    maxCount = 100;
                  }
                  ol.removeAllChildren();
                  showIndexData(ol, subOffset, maxCount);
                }, style: "display: inline-block; width: 75px; margin-right: 10px; vertical-align: middle;" });
              new Span(filter, { text: `/ ${displayCount}` });
            }

            ol = new Widget("div", bufferGrp.body, { style: "font-size: 10pt; background-color: #112;"});

            showIndexData(ol, subOffset, maxCount);
          } });
        }
      }
    }
  }

  /**
   * Displays info for setVertexBuffer command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   * @param {boolean} collapsed - Initial collapsed state.
   * @param {Object} state - Pipeline state.
   */
  _showCaptureCommandInfo_setVertexBuffer(command, commandInfo, collapsed, state) {
    const args = command.args;
    const self = this;
    const index = args[0];
    const id = args[1]?.__id;
    const buffer = this._getObject(id);

    let inputs = null;
    const pipeline = this._getObject(state?.pipeline?.args[0]?.__id);
    if (pipeline) {
      const desc = pipeline.descriptor;
      const vertexId = desc?.vertex?.module?.__id;
      const vertexShader = this._getObject(vertexId);
      const reflection = vertexShader?.reflection;
      inputs = reflection?.entry.vertex[0]?.inputs;
    }

    if (buffer) {
      const bufferGrp = new collapsible(commandInfo, { collapsed, label: `Vertex Buffer ${index} ID:${id}` });
      new Button(bufferGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
        self.window.inspectObject(buffer);
      } });
      const desc = buffer.descriptor;
      const newDesc = this._processCommandArgs(desc);
      if (newDesc.usage) {
        newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
      }
      new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });

      if (command.isBufferDataLoaded && command.bufferData) {
        const bufferData = command.bufferData[index];
        if (bufferData) {
          const button = new Button(bufferGrp.body, { label: "Show Data", callback: () => {
            if (button.element.innerText === "Hide Data") {
              button.element.innerText = "Show Data";
              bufferGrp.body.removeChild(bufferGrp.body.lastChild);
              return;
            }
            button.element.innerText = "Hide Data";

            let arrayStride = 0;

            const members = [];

            const pipelineBuffers = pipeline?.descriptor?.vertex?.buffers;
            if (pipelineBuffers) {
              const bufferDesc = pipelineBuffers[index];
              if (!bufferDesc) {
                return;
              }
              arrayStride = bufferDesc.arrayStride;
              const attributes = bufferDesc.attributes;
              if (attributes) {
                for (const attr of attributes) {
                  const location = attr.shaderLocation;
                  const offset = attr.offset;
                  const format = attr.format;
                  const type = { name: format };
                  let name = location;

                  if (inputs) {
                    for (const i of inputs) {
                      if (i?.location === location && i.name) {
                        name = i.name;
                        break;
                      }
                    }
                  }

                  members.push({ name, type, offset });
                }
              }
            }

            const type = { name: "array", count: 0, stride: arrayStride, format: {
              isStruct: true,
              name: "",
              members,
              stride: arrayStride
            } };
            self._showBufferDataType(bufferGrp.body, type, bufferData);
          } });
        }
      }
    }
  }

  /**
   * Gets the pipeline state at a given command by looking backwards through the command list.
   * @param {Object} command - The command to get state for.
   * @returns {Object} Pipeline state including pipeline, buffers, bind groups, etc.
   */
  _getPipelineState(command) {
    const commands = command.object?.commands || (this._passEncoderCommands.get(command.object) ?? null);
    if (commands === null) {
      return null;
    }
    const commandIndex = commands.indexOf(command);
    if (commandIndex === -1) {
      return null;
    }

    let pipeline = null;
    let vertexBuffers = [];
    let indexBuffer = null;
    let bindGroups = [];
    let renderPass = null;
    let computePass = null;
    for (let ci = commandIndex - 1; ci >= 0; --ci) {
      const cmd = commands[ci];
      if (cmd.method === "beginRenderPass") {
        renderPass = cmd;
        break;
      }
      if (cmd.method === "beginComputePass") {
        computePass = cmd;
        break;
      }
      if (cmd.method === "setIndexBuffer" && !indexBuffer) {
        indexBuffer = cmd;
      }
      if (cmd.method === "setVertexBuffer") {
        const index = cmd.args[0];
        if (!vertexBuffers[index]) {
          vertexBuffers[index] = cmd;
        }
      }
      if (cmd.method === "setPipeline" && !pipeline) {
        pipeline = cmd;
      }
      if (cmd.method === "setBindGroup") {
        const bindGroupIndex = cmd.args[0];
        if (!bindGroups[bindGroupIndex]) {
          bindGroups[bindGroupIndex] = cmd;
        }
      }
    }

    const pipelineObj = this._getObject(pipeline?.args[0]?.__id);
    const pipelineBuffers = pipelineObj?.descriptor?.vertex?.buffers;
    if (pipelineBuffers) {
      for (let index = 0; index < vertexBuffers.length; ++index) {
        const bufferDesc = pipelineBuffers[index];
        if (!bufferDesc) {
          vertexBuffers.length = index;
          break;
        }
      }
    } else {
      vertexBuffers.length = 0;
    }

    return { renderPass, computePass, pipeline, vertexBuffers, indexBuffer, bindGroups };
  }

  /**
   * Gets the type name from a type object.
   * @param {Object} t - Type object.
   * @returns {string} The type name as a string.
   */
  _getTypeName(t) {
    if (!t) {
      return "";
    }
    if (t.format) {
      if (t.name === "array" && t.count) {
        return `${t.name}<${t.format.name}, ${t.count}>`
      }
      return `${t.name}<${t.format.name}>`
    }
    return t.name;
  }

  /**
   * Adds shader type information to the UI.
   * @param {HTMLElement} ui - Parent UI element.
   * @param {Object} type - Type information.
   */
  _addShaderTypeInfo(ui, type) {
    if (!type) {
      return;
    }
    if (type.members) {
      new Widget("li", ui, { text: `Members:` });
      const l2 = new Widget("ul", ui);
      for (const m of type.members) {
        new Widget("li", l2, { text: `${m.name}: ${this._getTypeName(m.type)}` });
        const l3 = new Widget("ul", l2);
        new Widget("li", l3, { text: `Offset: ${m.offset}` });
        new Widget("li", l3, { text: `Size: ${m.size || "<runtime>"}` });

        this._addShaderTypeInfo(l3, m.type.format);
      }
    } else if (type.name === "array") {
      this._addShaderTypeInfo(type.format);
    }
  }

  /**
   * Displays shader entry function information.
   * @param {HTMLElement} ui - Parent UI element.
   * @param {Object} entry - Entry function info.
   */
  _shaderInfoEntryFunction(ui, entry) {
    new Widget("li", ui, { text: `Entry: ${entry.name}` });
    if (entry.inputs.length) {
      new Widget("li", ui, { text: `Inputs: ${entry.inputs.length}` });
      const l2 = new Widget("ul", ui);
      for (const s of entry.inputs) {
        new Widget("li", l2, { text: `@${s.locationType}(${s.location}) ${s.name}: ${this._getTypeName(s.type)} ${s.interpolation || ""}` });
      }
    }
    if (entry.outputs.length) {
      new Widget("li", ui, { text: `Outputs: ${entry.outputs.length}` });
      const l2 = new Widget("ul", ui);
      for (const s of entry.outputs) {
        new Widget("li", l2, { text: `@${s.locationType}(${s.location}) ${s.name}: ${this._getTypeName(s.type)}` });
      }
    }
  }

  /**
   * Displays shader reflection information including uniforms, storage, textures, and samplers.
   * @param {string} type - Shader type (Vertex, Fragment, Compute).
   * @param {Object} shader - The shader module object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   */
  _shaderInfo(type, shader, commandInfo) {
    const reflect = shader.reflection;
    if (reflect) {
      const grp = new collapsible(commandInfo, { collapsed: true, label: `${type} Shader Info` });

      const grpDiv = new Div(grp.body, { style: "font-size: 10pt;"});

      if (reflect.entry.vertex.length) {
        new Div(grpDiv, { text: `Vertex Entry Functions: ${reflect.entry.vertex.length}` });
        const list = new Widget("ul", grpDiv);
        for (const s of reflect.entry.vertex) {
          this._shaderInfoEntryFunction(list, s);
        }
      }

      if (reflect.entry.fragment.length) {
        new Div(grpDiv, { text: `Fragment Entry Functions: ${reflect.entry.fragment.length}` });
        const list = new Widget("ul", grpDiv);
        for (const s of reflect.entry.fragment) {
          this._shaderInfoEntryFunction(list, s);
        }
      }

      if (reflect.entry.compute.length) {
        new Div(grpDiv, { text: `Compute Entry Functions: ${reflect.entry.compute.length}` });
        const list = new Widget("ul", grpDiv);
        for (const s of reflect.entry.compute) {
          this._shaderInfoEntryFunction(list, s);
        }
      }

      if (reflect.uniforms.length) {
        new Div(grpDiv, { text: `Uniform Buffers: ${reflect.uniforms.length}` });
        const list = new Widget("ul", grpDiv);
        for (const s of reflect.uniforms) {
          new Widget("li", list, { text: `${s.name}: ${this._getTypeName(s.type)}` });
          const l2 = new Widget("ul", list);
          new Widget("li", l2, { text: `Bind Group: ${s.group}` });
          new Widget("li", l2, { text: `Bind Index: ${s.binding}` });
          new Widget("li", l2, { text: `Size: ${s.type.size || "<runtime>"}` });

          this._addShaderTypeInfo(l2, s.type);
        }
      }

      if (reflect.storage.length) {
        new Div(grpDiv, { text: `Storage Buffers: ${reflect.storage.length}` });
        const list = new Widget("ul", grpDiv);
        for (const s of reflect.storage) {
          new Widget("li", list, { text: `${s.name}: ${this._getTypeName(s.type)}` });
          const l2 = new Widget("ul", list);
          new Widget("li", l2, { text: `Bind Group: ${s.group}` });
          new Widget("li", l2, { text: `Bind Index: ${s.binding}` });
          new Widget("li", l2, { text: `Access: ${s.access}` });
          new Widget("li", l2, { text: `Size: ${s.type.size || "<runtime>"}` });

          this._addShaderTypeInfo(l2, s.type);
        }
      }

      if (reflect.textures.length) {
        new Div(grpDiv, { text: `Textures: ${reflect.textures.length}` });
        const list = new Widget("ul", grpDiv);
        for (const s of reflect.textures) {
          new Widget("li", list, { text: `${s.name}: ${this._getTypeName(s.type)}` });
          const l2 = new Widget("ul", list);
          new Widget("li", l2, { text: `Bind Group: ${s.group}` });
          new Widget("li", l2, { text: `Bind Index: ${s.binding}` });
        }
      }

      if (reflect.samplers.length) {
        new Div(grpDiv, { text: `Samplers: ${reflect.samplers.length}` });
        const list = new Widget("ul", grpDiv);
        for (const s of reflect.samplers) {
          new Widget("li", list, { text: `${s.name}: ${this._getTypeName(s.type)}` });
          const l2 = new Widget("ul", list);
          new Widget("li", l2, { text: `Bind Group: ${s.group}` });
          new Widget("li", l2, { text: `Bind Index: ${s.binding}` });
        }
      }
    }
  }

  /**
   * Displays texture outputs for a render pass.
   * @param {Object} state - Pipeline state.
   * @param {HTMLElement} parent - Parent element.
   * @param {boolean} collapsed - Initial collapsed state.
   */
  _showTextureOutputs(state, parent, collapsed) {
    let renderPassIndex = 0;
    const outputs = { color: [], depthStencil: null };
    if (state.renderPass) {
      renderPassIndex = state.renderPass._passIndex;
      const renderPass = state.renderPass.args[0];
      if (renderPass?.colorAttachments) {
        for (const attachment of renderPass.colorAttachments) {
          const texture = this._getTextureFromAttachment(attachment);
          outputs.color.push(texture);
        }
      }
      if (renderPass?.depthStencilAttachment) {
        const texture = this._getTextureFromAttachment(renderPass.depthStencilAttachment);
        outputs.depthStencil = texture;
      }
    }

    if (outputs.color.length || outputs.depthStencil) {
      const self = this;
      const outputGrp = new collapsible(parent, { collapsed, label: "Output Textures" });
      for (let index = 0, l = outputs.color.length; index < l; ++index) {
        const texture = outputs.color[index];
        const passId = this._getPassId(renderPassIndex, index);
        if (texture) {
          new Button(outputGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
            self.window.inspectObject(texture);
          } });
          if (texture.gpuTexture) {
            const canvasDiv = new Div(outputGrp.body);
            new Div(canvasDiv, { text: `Color: ${index} Texture: ${texture.idName} ${texture.format} ${texture.resolutionString}` });
            this._createTextureWidget(canvasDiv, texture, passId, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
          } else {
            new Div(outputGrp.body, { text: `Color: ${index} Texture: ${texture.idName} ${texture.format} ${texture.resolutionString}` });
            this.database.requestTextureData(texture);
          }
        }
      }

      if (outputs.depthStencil) {
        const texture = outputs.depthStencil;
        if (texture) {
          new Button(outputGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
            self.window.inspectObject(texture);
          } });
          if (texture.gpuTexture) {
            const canvasDiv = new Div(outputGrp.body);
            new Div(canvasDiv, { text: `DepthStencil Texture: ${texture.idName} ${texture.format} ${texture.resolutionString}` });
            this._createTextureWidget(canvasDiv, texture, -1, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
          } else {
            new Div(outputGrp.body, { text: `DepthStencil Texture: ${texture.idName} ${texture.format} ${texture.resolutionString}` });
            this.database.requestTextureData(texture);
          }
        }
      }
    }
  }

  /**
   * Displays texture inputs from bind groups.
   * @param {Object} state - Pipeline state.
   * @param {HTMLElement} parent - Parent element.
   */
  _showTextureInputs(state, parent) {
    const inputs = [];
    for (const bindGroupCmd of state.bindGroups) {
      if (!bindGroupCmd?.args) {
        continue;
      }
      const group = bindGroupCmd.args[0];
      const bindGroup = this._getObject(bindGroupCmd.args[1]?.__id);
      if (bindGroup?.entries) {
        for (const entry of bindGroup.entries) {
          if (entry.resource?.__id) {
            const resource = this._getObject(entry.resource.__id);
            if (resource instanceof TextureView) {
              const binding = entry.binding;
              inputs.push({textureView: resource, group, binding });
            }
          }
        }
      }
    }

    if (inputs.length) {
      const self = this;
      const inputGrp = new collapsible(parent, { collapsed: true, label: "Input Textures" });
      for (const resource of inputs) {
        const texture = this.database.getTextureFromView(resource.textureView);
        if (texture) {
          new Button(inputGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
            self.window.inspectObject(texture);
          } });
          if (texture.gpuTexture) {
            const canvasDiv = new Div(inputGrp.body);
            new Div(canvasDiv, { text: `Group: ${resource.group} Binding: ${resource.binding} Texture: ${texture.idName} ${texture.format} ${texture.resolutionString}` });
            this._createTextureWidget(canvasDiv, texture, -1, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
          } else {
            this.database.requestTextureData(texture);
          }
        }
      }
    }
  }

  /**
   * Displays info for end command (end of render/compute pass).
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   */
  _showCaptureCommandInfo_end(command, commandInfo) {
    const state = this._getPipelineState(command);
    this._showTextureOutputs(state, commandInfo, false);
  }

  /**
   * Displays info for draw command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   */
  _showCaptureCommandInfo_draw(command, commandInfo) {
    const state = this._getPipelineState(command);
    if (!state) {
      return;
    }

    this._showTextureOutputs(state, commandInfo, true);
    this._showTextureInputs(state, commandInfo);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo);
    }

    for (const vertexBuffer of state.vertexBuffers) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer, commandInfo, true, state);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  /**
   * Displays info for drawIndexed command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   */
  _showCaptureCommandInfo_drawIndexed(command, commandInfo) {
    const state = this._getPipelineState(command);
    if (!state) {
      return;
    }

    this._showTextureOutputs(state, commandInfo, true);
    this._showTextureInputs(state, commandInfo);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo);
    }
    if (state.indexBuffer) {
      this._showCaptureCommandInfo_setIndexBuffer(state.indexBuffer, commandInfo, true, command.args[2] ?? 0, command.args[0]);
    }
    for (const vertexBuffer of state.vertexBuffers) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer, commandInfo, true, state);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  /**
   * Displays info for indirect buffer commands.
   * @param {Object} command - The command object.
   * @param {Object} indirectBuffer - The indirect buffer.
   * @param {number} indirectOffset - Offset into the indirect buffer.
   * @param {HTMLElement} commandInfo - Element to display info in.
   * @param {boolean} collapsed - Initial collapsed state.
   */
  _showCaptureCommandInfo_indirectBuffer(command, indirectBuffer, indirectOffset, commandInfo, collapsed) {
    const id = indirectBuffer.__id;
    const buffer = this._getObject(id);
    if (buffer) {
      const self = this;
      const bufferGrp = new collapsible(commandInfo, { collapsed, label: `Indirect Buffer ID:${id} ${buffer.label}` });
      new Button(bufferGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
        self.window.inspectObject(buffer);
      } });
      const desc = buffer.descriptor;
      const newDesc = this._processCommandArgs(desc);
      if (newDesc.usage) {
        newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
      }
      new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });

      if (command.isBufferDataLoaded && command.bufferData) {
        const bufferData = command.bufferData[0];
        if (bufferData) {
          const u32Array = new Uint32Array(bufferData.buffer, indirectOffset);
          if (command.method === "dispatchWorkgroupsIndirect") {
            new Div(bufferGrp.body, { text: `Workgroup Count X: ${u32Array[0]}` });
            new Div(bufferGrp.body, { text: `Workgroup Count Y: ${u32Array[1]}` });
            new Div(bufferGrp.body, { text: `Workgroup Count Z: ${u32Array[2]}` });
          } else if (command.method === "drawIndexedIndirect") {
            new Div(bufferGrp.body, { text: `Index Count: ${u32Array[0]}` });
            new Div(bufferGrp.body, { text: `Instance Count: ${u32Array[1]}` });
            new Div(bufferGrp.body, { text: `First Index: ${u32Array[2]}` });
            new Div(bufferGrp.body, { text: `Base Vertex: ${u32Array[3]}` });
            new Div(bufferGrp.body, { text: `First Instance: ${u32Array[4]}` });
          } else if (command.method === "drawIndirect") {
            new Div(bufferGrp.body, { text: `Vertex Count: ${u32Array[0]}` });
            new Div(bufferGrp.body, { text: `Instance Count: ${u32Array[1]}` });
            new Div(bufferGrp.body, { text: `First Index: ${u32Array[2]}` });
            new Div(bufferGrp.body, { text: `First Instance: ${u32Array[3]}` });
          }
        }
      }
    }
  }

  /**
   * Displays info for drawIndirect command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   */
  _showCaptureCommandInfo_drawIndirect(command, commandInfo) {
    const state = this._getPipelineState(command);

    this._showTextureOutputs(state, commandInfo, true);
    this._showTextureInputs(state, commandInfo);

    this._showCaptureCommandInfo_indirectBuffer(command, command.args[0], command.args[1], commandInfo, true);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo);
    }
    for (const vertexBuffer of state.vertexBuffers) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer, commandInfo, true, state);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  /**
   * Displays info for drawIndexedIndirect command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   */
  _showCaptureCommandInfo_drawIndexedIndirect(command, commandInfo) {
    const state = this._getPipelineState(command);

    this._showTextureOutputs(state, commandInfo, true);
    this._showTextureInputs(state, commandInfo);

    this._showCaptureCommandInfo_indirectBuffer(command, command.args[0], command.args[1], commandInfo, true);

    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo);
    }
    if (state.indexBuffer) {
      this._showCaptureCommandInfo_setIndexBuffer(state.indexBuffer, commandInfo, true);
    }
    for (const vertexBuffer of state.vertexBuffers) {
      this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer, commandInfo, true, state);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  /**
   * Displays info for dispatchWorkgroups command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   */
  _showCaptureCommandInfo_dispatchWorkgroups(command, commandInfo) {
    const state = this._getPipelineState(command);
    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo, command);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  /**
   * Displays info for dispatchWorkgroupsIndirect command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   */
  _showCaptureCommandInfo_dispatchWorkgroupsIndirect(command, commandInfo) {
    this._showCaptureCommandInfo_indirectBuffer(command, command.args[0], command.args[1], commandInfo, true, true);

    const state = this._getPipelineState(command);
    if (state.pipeline) {
      this._showCaptureCommandInfo_setPipeline(state.pipeline, commandInfo, command);
    }
    for (const index in state.bindGroups) {
      this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index], commandInfo, index, true, state);
    }
  }

  /**
   * Displays info for createView command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   */
  _showCaptureCommandInfo_createView(command, commandInfo) {
    const texture = this._getObject(command.object);
    if (!texture) {
      return;
    }

    const self = this;
    const inputGrp = new collapsible(commandInfo, { collapsed: false, label: `Texture ${texture.idName} ${texture.format} ${texture.resolutionString}` });
    new Button(inputGrp.body, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
      self.window.inspectObject(texture);
    } });
    if (texture.gpuTexture) {
      const canvasDiv = new Div(inputGrp.body);
      this._createTextureWidget(canvasDiv, texture, -1, this._clampedTextureWidth(texture), "margin-left: 20px; margin-top: 10px;");
    } else {
      this.database.requestTextureData(texture);
    }
  }

  /**
   * Displays info for executeBundles command.
   * @param {Object} command - The command object.
   * @param {HTMLElement} commandInfo - Element to display info in.
   */
  _showCaptureCommandInfo_executeBundles(command, commandInfo) {
    const bundles = command.args[0];
    for (const bundleId of bundles) {
      const bundle = this._getObject(bundleId.__id);
      if (!bundle) {
        continue;
      }
    }
  }

  /**
   * Displays frame statistics in the panel.
   * @param {HTMLElement} commandInfo - Element to display stats in.
   */
  _inspectStats(commandInfo) {
    commandInfo.html = "";

    const root = new Div(commandInfo, { style:
      "padding: 16px; overflow-y: auto; height: 100%; box-sizing: border-box; " +
      "color: var(--fg-primary); font-family: var(--font-family);" });

    new Div(root, { text: "Frame Statistics", style:
      "font-size: 14pt; font-weight: bold; margin-bottom: 12px; color: var(--fg-primary);" });

    // Pass Timings section: only when at least one pass has timestamp data.
    const timed = [];
    for (const cmd of this._captureCommands || []) {
      if (cmd && cmd.duration !== undefined &&
          (cmd.method === "beginRenderPass" || cmd.method === "beginComputePass")) {
        timed.push(cmd);
      }
    }
    if (timed.length) {
      this._renderPassTimingsSection(root, timed);
    }

    const stats = this.statistics;
    for (const [title, keys] of _statSections) {
      let hasData = false;
      for (const k of keys) {
        if (stats[k]) { hasData = true; break; }
      }
      if (!hasData) {
        continue;
      }
      this._renderStatsSection(root, title, keys, stats);
    }
  }

  /**
   * Render a sorted, clickable list of GPU pass durations inside the stats view.
   * Each row's background bar shows that pass's share of total GPU time; click
   * to jump to the pass in the command tree.
   */
  _renderPassTimingsSection(parent, passes) {
    const sorted = [...passes].sort((a, b) => b.duration - a.duration);
    const total = sorted.reduce((s, p) => s + (p.duration || 0), 0);

    const section = new Div(parent, { style: "margin-bottom: 18px;" });
    new Div(section, { text: "Pass Timings", style:
      "font-size: 11pt; font-weight: bold; margin-bottom: 4px; color: var(--fg-primary);" });
    new Div(section, {
      text: `Total GPU: ${total.toFixed(3)} ms across ${sorted.length} passes`,
      style: "font-size: 9pt; color: var(--fg-secondary); margin-bottom: 8px;"
    });

    const list = new Div(section, { style:
      "background: var(--bg-elevated); border-radius: var(--radius-sm); padding: 4px;" });

    for (const cmd of sorted) {
      const isRender = cmd.method === "beginRenderPass";
      const pct = total > 0 ? (cmd.duration / total) * 100 : 0;
      const label = cmd.args?.[0]?.label ||
        (isRender ? `Render Pass ${cmd._passIndex ?? ""}` : `Compute Pass ${cmd._passIndex ?? ""}`);

      const row = document.createElement("div");
      row.style.cssText =
        "position: relative; padding: 6px 10px; margin: 2px 0; border-radius: var(--radius-sm); " +
        "cursor: pointer; display: flex; align-items: center; gap: 10px; overflow: hidden;";

      const bar = document.createElement("div");
      bar.style.cssText =
        `position: absolute; left: 0; top: 0; bottom: 0; width: ${pct}%; ` +
        `background: ${isRender ? "rgba(74, 141, 184, 0.28)" : "rgba(168, 124, 208, 0.28)"}; z-index: 0;`;
      row.appendChild(bar);

      const chip = document.createElement("span");
      chip.style.cssText =
        "display: inline-block; width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; z-index: 1; " +
        `background: ${isRender ? "#4a8db8" : "#a87cd0"};`;
      row.appendChild(chip);

      const lbl = document.createElement("span");
      lbl.style.cssText =
        "z-index: 1; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10pt;";
      lbl.textContent = label;
      row.appendChild(lbl);

      const pctEl = document.createElement("span");
      pctEl.style.cssText =
        "z-index: 1; color: var(--fg-secondary); font-size: 9pt; min-width: 44px; text-align: right;";
      pctEl.textContent = `${pct.toFixed(1)}%`;
      row.appendChild(pctEl);

      const dur = document.createElement("span");
      dur.style.cssText =
        "z-index: 1; font-variant-numeric: tabular-nums; min-width: 80px; text-align: right; font-size: 10pt;";
      dur.textContent = `${cmd.duration.toFixed(3)} ms`;
      row.appendChild(dur);

      row.addEventListener("mouseenter", () => { row.style.background = "var(--bg-hover)"; });
      row.addEventListener("mouseleave", () => { row.style.background = ""; });
      row.addEventListener("click", () => { this._jumpToPass(cmd); });

      list.element.appendChild(row);
    }
  }

  /**
   * Render one grouped section of the stats panel (title + a list of "label: value" rows).
   */
  _renderStatsSection(parent, title, keys, stats) {
    const section = new Div(parent, { style: "margin-bottom: 16px;" });
    new Div(section, { text: title, style:
      "font-size: 11pt; font-weight: bold; margin-bottom: 6px; color: var(--fg-primary);" });

    const list = new Div(section, { style:
      "background: var(--bg-elevated); border-radius: var(--radius-sm); padding: 6px 10px;" });

    for (const k of keys) {
      const v = stats[k];
      if (v == null) { continue; }
      const row = document.createElement("div");
      row.style.cssText =
        "display: flex; justify-content: space-between; align-items: center; " +
        "padding: 4px 0; font-size: 10pt; line-height: 1.4;";
      const lbl = document.createElement("span");
      lbl.style.cssText = "color: var(--fg-primary);";
      lbl.textContent = _prettifyStatKey(k);
      const val = document.createElement("span");
      val.style.cssText = "color: var(--fg-muted); font-variant-numeric: tabular-nums;";
      val.textContent = _formatStatValue(k, v);
      row.appendChild(lbl);
      row.appendChild(val);
      list.element.appendChild(row);
    }
  }

  /**
   * Scroll the command tree to the given pass command, expanding it if collapsed.
   * Shared by the Frame Stats Pass Timings list and the TimelineWidget.
   */
  _jumpToPass(command) {
    const headerSpan = command.header;
    if (!headerSpan?.element) { return; }
    const headerDiv = headerSpan.element.parentElement;
    if (!headerDiv) { return; }
    const block = headerDiv.nextElementSibling;
    if (block && block.classList.contains("collapsed")) {
      headerDiv.click();
    }
    headerDiv.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  /**
   * Displays comprehensive information for a capture command.
   * Routes to specific handlers based on command method.
   * @param {Object} command - The command object.
   * @param {string} name - Command name to display.
   * @param {HTMLElement} commandInfo - Element to display info in.
   * @param {boolean} showHeader - Whether to show the command header.
   */
  _showCaptureCommandInfo(command, name, commandInfo, showHeader = true) {
    commandInfo.html = "";

    const method = command.method;
    const args = command.args;

    if (showHeader) {
      new Div(commandInfo, { text: `${name} ${method}`, class: "info-box-success pl-xl", style: "line-height: 40px;" });
    }

    renderCommandSummary(commandInfo, command, {
      getAttachmentFormat: (attachment) => {
        const texture = this._getTextureFromAttachment(attachment);
        return texture ? `${texture.descriptor.format} ${texture.resolutionString}` : null;
      },
      getDrawTopology: (cmd) => {
        const state = this._getPipelineState(cmd);
        if (!state || !state.pipeline) {
          return null;
        }
        return this._getObject(state.pipeline.args[0]?.__id)?.topology ?? "triangle-list";
      }
    });

    if (command.stacktrace) {
      new StacktraceViewer(this, commandInfo, command, command.stacktrace);
    }

    renderArgumentsSection(commandInfo, args, method, (id) => this._getObject(id));

    if (method === "createRenderPipeline" || method === "createBindGroup" ||
        method === "createBindGroupLayout" || method === "createShaderModule" ||
        method === "createPipelineLayout") {
      const obj = this._getObject(command.result);
      const self = this;
      new Button(commandInfo, { label: "Inspect", class: _inspectButtonStyle, callback: () => {
        self.window.inspectObject(obj);
      } });
    } else if (method == "beginRenderPass") {
      this._showCaptureCommandInfo_beginRenderPass(command, commandInfo);
    } else if (method === "setBindGroup") {
      this._showCaptureCommandInfo_setBindGroup(command, commandInfo, 0, false);
    } else if (method === "setPipeline") {
      this._showCaptureCommandInfo_setPipeline(command, commandInfo);
    } else if (method === "writeBuffer") {
      this._showCaptureCommandInfo_writeBuffer(command, commandInfo);
    } else if (method === "setIndexBuffer") {
      this._showCaptureCommandInfo_setIndexBuffer(command, commandInfo);
    } else if (method === "setVertexBuffer") {
      this._showCaptureCommandInfo_setVertexBuffer(command, commandInfo);
    } else if (method === "drawIndexed") {
      this._showCaptureCommandInfo_drawIndexed(command, commandInfo);
    } else if (method === "draw") {
      this._showCaptureCommandInfo_draw(command, commandInfo);
    } else if (method === "drawIndirect") {
      this._showCaptureCommandInfo_drawIndirect(command, commandInfo);
    } else if (method === "drawIndexedIndirect") {
      this._showCaptureCommandInfo_drawIndexedIndirect(command, commandInfo);
    } else if (method === "dispatchWorkgroups") {
      this._showCaptureCommandInfo_dispatchWorkgroups(command, commandInfo);
    } else if (method === "dispatchWorkgroupsIndirect") {
        this._showCaptureCommandInfo_dispatchWorkgroupsIndirect(command, commandInfo);
    } else if (method === "end") {
      this._showCaptureCommandInfo_end(command, commandInfo);
    } else if (method === "createView") {
      this._showCaptureCommandInfo_createView(command, commandInfo);
    } else if (method === "executeBundles") {
      this._showCaptureCommandInfo_executeBundles(command, commandInfo);
    }
  }

  /**
   * Handles texture data chunk loaded event.
   */
  _textureDataChunkLoaded() {
    if (this._captureData) {
      this._captureData.captureTextureDataChunk();
      this._updateCaptureStatus();
    }
  }

  /**
   * Recursively finds a canvas element within a widget tree.
   * @param {Object} widget - The widget to search.
   * @returns {Object|null} The canvas widget or null.
   */
  _findCanvas(widget) {
    if (widget.element.tagName === "CANVAS") {
      return widget;
    }
    for (const child of widget.children) {
      const canvas = this._findCanvas(child);
      if (canvas) {
        return canvas;
      }
    }
    return null;
  }

  /**
   * Generates a unique ID for a render pass and attachment combination.
   * @param {number} renderPass - Render pass index.
   * @param {number} attachment - Attachment index.
   * @returns {number} Combined pass ID.
   */
  _getPassId(renderPass, attachment) {
    return renderPass * 10 + attachment;
  }

  /**
   * Gets the canvas for a given pass ID.
   * @param {number} passId - The pass ID.
   * @returns {Object|null} The canvas widget or null.
   */
  _getPassIdCanvas(passId) {
    const passFrame = this._frameImageList[passId];
    if (!passFrame) {
      return null;
    }
    return this._findCanvas(passFrame);
  }

  /**
   * Handles texture loaded event, updating the frame image display.
   * @param {Object} texture - The texture that was loaded.
   * @param {number} passId - Render pass identifier.
   */
  _textureLoaded(texture, passId) {
    // Textures stream in for the currently live capture. Route them to the
    // live tab state — which may or may not be the active tab.
    const liveState = this._liveTabState;
    if (!this._captureData || !liveState) {
      return;
    }

    this._captureData.captureTextureLoaded();

    // Only refresh the command-info pane if the active tab is the live one;
    // otherwise we'd churn another tab the user is looking at.
    if (liveState === this._activeTabState && this._lastSelectedCommand) {
      this._lastSelectedCommand.element.click();
    }

    this._updateCaptureStatus();

    if (passId !== -1 && this._addRenderPassThumbnail(liveState, texture, passId)) {
      // Hang on to the texture in the CaptureData so it's available for serialization.
      this._captureData.addRenderPassTexture(passId, texture);
    }
  }

  /**
   * Build (or rebuild) the thumbnail tile for one render-pass attachment in the
   * given tab's state. Returns true if the tile was added.
   * Used by both the live texture-loaded path and the import-time rebuild path.
   * @param {Object} state - Tab state from `_buildCaptureTab`.
   * @param {Object} texture - The Texture with a populated `gpuTexture`.
   * @param {number} passId - encoded as renderPassIndex * 10 + attachmentSlot.
   * @returns {boolean}
   */
  _addRenderPassThumbnail(state, texture, passId) {
    const frameImages = state?.frameImages;
    const frameImageList = state?.frameImageList;
    const gpuTextureMap = state?.gpuTextureMap;
    if (!frameImages || !frameImageList) {
      return false;
    }

    const passIdValue = passId / 10;
    const passIndex = Math.floor(passIdValue);
    const attachment = passId - (passIndex * 10);

    frameImages.style.display = "block";
    let passFrame = null;

    if (passId >= frameImageList.length) {
      passFrame = new Div(frameImages, { class: "capture_pass_texture" });
      frameImageList[passId] = passFrame;
    } else {
      passFrame = new Div(null, { class: "capture_pass_texture" });
      let found = false;
      for (let i = passId - 1; i >= 0; --i) {
        if (frameImageList[i]) {
          frameImages.insertAfter(passFrame, frameImageList[i]);
          found = true;
          break;
        }
      }
      if (!found) {
        frameImages.insertBefore(passFrame, frameImages.children[0]);
      }
      frameImageList[passId] = passFrame;
    }

    new Div(passFrame, { text: `Render Pass ${passIndex} ${`Attachment ${attachment}`}`, class: "text-secondary mb-sm" });
    const textureId = texture.id < 0 ? "CANVAS" : texture.id;
    new Div(passFrame, { text: `${texture.name} ID:${textureId}`, class: "text-secondary mb-md" });
    new Div(passFrame, { text: `${texture.format} ${texture.resolutionString}`, class: "text-secondary mb-md font-sm" });

    // _createTextureWidget needs a live GPUTexture handle to blit from.
    // Imported textures may not have one (no loaded mip data) — show the tile
    // header without the preview rather than blowing up.
    const prevGpuMap = this._gpuTextureMap;
    this._gpuTextureMap = gpuTextureMap;
    try {
      if (texture.gpuTexture) {
        this._createTextureWidget(passFrame, texture, passId, 256);
        gpuTextureMap.set(passId, texture.gpuTexture);
        texture.gpuTexture.addReference();
      }
    } finally {
      this._gpuTextureMap = prevGpuMap;
    }

    passFrame.element.onclick = () => {
      const element = document.getElementById(`RenderPass_${passIndex}`);
      if (element) {
        element.scrollIntoView();
        const beginElement = document.getElementById(`RenderPass_${passIndex}_begin`);
        if (beginElement) {
          beginElement.click();
        }
      }
    };

    return true;
  }

  /**
   * Upload every imported texture's restored mip data to a GPUTexture on the
   * inspector's device. After this runs, `texture.gpuTexture` is populated for
   * any imported Texture that had serialized mip data, so the existing preview
   * widgets (render-pass thumbnails, BindGroup texture previews) can blit from
   * it the same way they do for live captures.
   * @param {Object} state - Tab state from `_buildCaptureTab`.
   */
  _uploadImportedTextureData(state) {
    const inspectorWindow = this.window;
    if (!state || !inspectorWindow?.device) {
      return;
    }
    const ids = state.importedObjectIds;
    if (!ids || ids.size === 0) {
      return;
    }
    for (const id of ids) {
      const obj = this.database.capturedObjects.get(id);
      if (!(obj instanceof Texture)) {
        continue;
      }
      if (obj.gpuTexture || !Array.isArray(obj.imageData)) {
        continue;
      }
      for (let mip = 0; mip < obj.imageData.length; ++mip) {
        if (!(obj.imageData[mip] instanceof Uint8Array)) {
          continue;
        }
        if (Array.isArray(obj.isImageDataLoaded) && obj.isImageDataLoaded[mip] === false) {
          continue;
        }
        try {
          // passId -1: don't try to build a live-style thumbnail; we will
          // walk render-pass attachments separately in _buildImportedRenderPassThumbnails.
          inspectorWindow._createTexture(obj, -1, mip);
        } catch (e) {
          console.error("Failed to upload imported texture data:", e);
        }
      }
    }
  }

  /**
   * Walk an imported tab's commands and build the left-pane render-pass
   * thumbnail tiles. Mirrors the work `_textureLoaded` does as data streams
   * in during a live capture. Assumes `_uploadImportedTextureData` has already
   * populated `texture.gpuTexture` on the imported textures.
   * @param {Object} state - Tab state from `_buildCaptureTab`.
   */
  _buildImportedRenderPassThumbnails(state) {
    if (!state || !Array.isArray(state.commands)) {
      return;
    }

    let renderPassIndex = 0;
    for (const command of state.commands) {
      if (!command || command.method !== "beginRenderPass") {
        continue;
      }
      const desc = command.args?.[0];
      if (!desc) {
        renderPassIndex++;
        continue;
      }

      // Match the live passId layout used by webgpu_inspector.js: each
      // attachment in the captured set gets the next slot (color first, then
      // depth-stencil), with the slot range starting at renderPassIndex * 10.
      let attachmentSlot = 0;
      const attachments = [];
      if (Array.isArray(desc.colorAttachments)) {
        for (const a of desc.colorAttachments) {
          if (a) {
            attachments.push(a);
          }
        }
      }
      if (desc.depthStencilAttachment) {
        attachments.push(desc.depthStencilAttachment);
      }

      for (const attachment of attachments) {
        const texture = this._getTextureFromAttachment(attachment);
        const passId = renderPassIndex * 10 + attachmentSlot++;
        if (texture) {
          this._addRenderPassThumbnail(state, texture, passId);
        }
      }

      renderPassIndex++;
    }
  }
}

/**
 * Matrix type definitions with column and row counts for WGSL matrix types.
 * @type {Object}
 */
CapturePanel.matrixTypes = {
  "mat2x2": { columns: 2, rows: 2 },
  "mat2x2f": { columns: 2, rows: 2 },
  "mat2x3": { columns: 2, rows: 3 },
  "mat2x3f": { columns: 2, rows: 3 },
  "mat2x4": { columns: 2, rows: 4 },
  "mat2x4f": { columns: 2, rows: 4 },

  "mat3x2": { columns: 3, rows: 2 },
  "mat3x2f": { columns: 3, rows: 2 },
  "mat3x3": { columns: 3, rows: 3 },
  "mat3x3f": { columns: 3, rows: 3 },
  "mat3x4": { columns: 3, rows: 4 },
  "mat3x4f": { columns: 3, rows: 4 },

  "mat4x2": { columns: 4, rows: 2 },
  "mat4x2f": { columns: 4, rows: 2 },
  "mat4x3": { columns: 4, rows: 3 },
  "mat4x3f": { columns: 4, rows: 3 },
  "mat4x4": { columns: 4, rows: 4 },
  "mat4x4f": { columns: 4, rows: 4 }
};

/**
 * Mapping of WebGPU command methods to their argument names, used to display command arguments
 * with meaningful names. Now defined in command_args_view.js and shared with the Recorder panel;
 * kept here as an alias for backward compatibility.
 * @type {Object}
 */
CapturePanel._commandArgs = commandArgs;
