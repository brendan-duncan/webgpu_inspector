import { Signal } from "../utils/signal.js";
import { TextureUtils } from "../utils/texture_utils.js";

async function fetchArrayBuffer(url, type, length) {
  try {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    if (type === "Uint32Array") {
      return new Uint32Array(buffer, 0, buffer.byteLength / 4);
    }
    return new Uint8Array(buffer, 0, buffer.byteLength);
  } catch (e) {
    console.error(`Failed to fetch data: ${e.message}`);
  }
  return new Uint8Array(length);
}

export class RecorderData {
  constructor(window) {
    this.window = window;
    this.data = [];
    // Per-data-blob TypedArray type name ("Uint8Array" / "Uint32Array"), kept in parallel with
    // `data` so a loaded recording can be re-serialized back to a faithful .wgpu / .html.
    this.dataTypes = [];
    this.initializeCommands = [];
    this.frames = [];
    // Canvas size and root-object variable names, recovered when a binary recording is loaded so
    // the recording can be exported again. Defaults match the live-record object ids ("x1" is the
    // navigator.gpu id used by webgpu_recorder; the canvas context is always "context").
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.gpuVar = "x1";
    this.contextVar = "context";
    this._dataCount = 0;
    this._commandCount = 0;
    this.dataReady = false;
    this._commandsReady = false;
    this.onReady = new Signal();

    // Edit model: commands can be disabled (excluded from preview/export) and arguments edited,
    // with undo/redo and a "modified vs. loaded baseline" indicator. onEditChanged fires after any
    // edit, undo, redo, or revert so the panel can refresh the list, preview, and toolbar state.
    this.onEditChanged = new Signal();
    this._history = [];      // Array<{ redo: fn, undo: fn }>
    this._historyIndex = -1; // index of the last-applied edit; -1 means "no edits applied".
    this._touched = new Set(); // commands ever targeted by an edit, for cheap modified detection.

    this._objectMap = new Map();
    this._canvas = null;
    this._context = null;
    this._device = null;
    this._textureUtils = null;
  }

  get ready() {
    return this.dataReady && this._commandsReady;
  }

  // Reset the runtime GPU state used while replaying (object map, device, context, texture utils),
  // without discarding the recorded commands/data. Called before each replay so commands re-create
  // their objects from scratch. Frees the previous replay's GPU resources, but never the panel's
  // shared device/adapter, which replays run on.
  _resetExecutionState() {
    for (const value of this._objectMap.values()) {
      if (value === this.window.device || value === this.window.adapter) {
        continue;
      }
      if (value instanceof GPUTexture || value instanceof GPUBuffer) {
        try {
          value.destroy();
        } catch (e) {
          // Ignore: the resource may already be destroyed by a replayed destroy() command.
        }
      }
    }
    this._objectMap.clear();
    this._context = null;
    this._device = null;
    this._textureUtils = null;
  }

  // Discard everything: runtime state and the recorded commands/data. Used when starting a new
  // recording.
  clear() {
    this._resetExecutionState();
    this.data = [];
    this.dataTypes = [];
    this.initializeCommands = [];
    this.frames = [];
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.gpuVar = "x1";
    this.contextVar = "context";
    this._dataCount = 0;
    this._commandCount = 0;
    this.dataReady = false;
    this._commandsReady = false;
    this._history = [];
    this._historyIndex = -1;
    this._touched = new Set();
  }

  // Invoke callback for every (non-hole) command, in stable order: initialize commands first, then
  // each frame's commands in order. Used by the edit model and exporter.
  forEachCommand(callback) {
    for (const command of this.initializeCommands) {
      if (command) {
        callback(command);
      }
    }
    for (const frame of this.frames) {
      if (!frame) {
        continue;
      }
      for (const command of frame) {
        if (command) {
          callback(command);
        }
      }
    }
  }

  // Snapshot the current command state as the "unmodified" baseline and clear the undo history.
  // Called once a recording has finished loading (live or from a binary), so edits are measured
  // and reverted against the as-loaded recording. Args are never mutated in place (edits replace
  // the args reference), so a reference compare is enough to detect an argument change.
  resetEditHistory() {
    this._history = [];
    this._historyIndex = -1;
    this._touched = new Set();
    this.forEachCommand((command) => {
      command._baselineDisabled = !!command.disabled;
      command._baselineArgs = command.args;
    });
    this._recomputeImplicitDisabled();
    // No signal here: the panel rebuilds its view and refreshes the toolbar explicitly after this.
  }

  // Methods that must never be disabled (foundational setup): the recording can't replay without
  // them, so the panel locks their checkboxes and they're never implicitly disabled.
  static _protectedMethods = new Set(["requestAdapter", "requestDevice", "__getQueue", "configure"]);

  // Resource-definition commands eligible for reverse-liveness disabling: if the resource they
  // create/populate is no longer consumed by any enabled command, they're implicitly disabled.
  // (Structural commands with results — encoders, passes, command buffers — are intentionally
  // excluded; they're governed by the begin/end and explicit rules instead.)
  static _resourceDefMethods = new Set([
    "createBuffer", "createTexture", "createView", "createSampler",
    "createBindGroup", "createBindGroupLayout", "createPipelineLayout",
    "createShaderModule", "createRenderPipeline", "createComputePipeline",
    "createRenderPipelineAsync", "createComputePipelineAsync", "createQuerySet",
    "writeBuffer", "writeTexture", "__writeTexture",
    "copyBufferToBuffer", "copyBufferToTexture", "copyTextureToBuffer", "copyTextureToTexture"
  ]);

  isProtectedCommand(command) {
    return !!command && RecorderData._protectedMethods.has(command.method);
  }

  // Whether a command is excluded from playback/export: explicitly disabled by the user, or
  // implicitly disabled because something it depends on is disabled.
  isEffectivelyDisabled(command) {
    return !!command && (!!command.disabled || !!command._implicit);
  }

  // True when any command differs from the loaded baseline (disabled state or arguments). Only
  // ever-touched commands can differ, so this stays cheap regardless of recording size.
  get modified() {
    for (const command of this._touched) {
      if (!!command.disabled !== command._baselineDisabled || command.args !== command._baselineArgs) {
        return true;
      }
    }
    return false;
  }

  get canUndo() {
    return this._historyIndex >= 0;
  }

  get canRedo() {
    return this._historyIndex < this._history.length - 1;
  }

  // Apply an edit (its redo() performs the mutation), truncating any redo tail, and record it for
  // undo/redo.
  _pushEdit(op) {
    op.redo();
    this._history.length = this._historyIndex + 1;
    this._history.push(op);
    this._historyIndex = this._history.length - 1;
    this._recomputeImplicitDisabled();
    this.onEditChanged.emit();
  }

  undo() {
    if (!this.canUndo) {
      return;
    }
    this._history[this._historyIndex].undo();
    this._historyIndex--;
    this._recomputeImplicitDisabled();
    this.onEditChanged.emit();
  }

  redo() {
    if (!this.canRedo) {
      return;
    }
    this._historyIndex++;
    this._history[this._historyIndex].redo();
    this._recomputeImplicitDisabled();
    this.onEditChanged.emit();
  }

  // Enable/disable a set of commands as a single undoable edit. No-op if none change state.
  setCommandsDisabled(commands, disabled) {
    disabled = !!disabled;
    const targets = [];
    for (const command of commands) {
      // Protected commands can never be disabled.
      if (command && !this.isProtectedCommand(command) && !!command.disabled !== disabled) {
        targets.push(command);
      }
    }
    if (!targets.length) {
      return;
    }
    for (const command of targets) {
      this._touched.add(command);
    }
    this._pushEdit({
      redo: () => { for (const command of targets) { command.disabled = disabled; } },
      undo: () => { for (const command of targets) { command.disabled = !disabled; } }
    });
  }

  // Replace a command's arguments as a single undoable edit. The caller passes a fresh args value;
  // the previous reference is retained for undo.
  setCommandArgs(command, newArgs) {
    if (!command) {
      return;
    }
    const before = command.args;
    this._touched.add(command);
    this._pushEdit({
      redo: () => { command.args = newArgs; },
      undo: () => { command.args = before; }
    });
  }

  // Restore every command to the loaded baseline as a single undoable edit.
  revert() {
    const changes = [];
    for (const command of this._touched) {
      if (!!command.disabled !== command._baselineDisabled || command.args !== command._baselineArgs) {
        changes.push({
          command,
          beforeDisabled: command.disabled,
          beforeArgs: command.args,
          afterDisabled: command._baselineDisabled,
          afterArgs: command._baselineArgs
        });
      }
    }
    if (!changes.length) {
      return;
    }
    this._pushEdit({
      redo: () => {
        for (const c of changes) {
          c.command.disabled = c.afterDisabled;
          c.command.args = c.afterArgs;
        }
      },
      undo: () => {
        for (const c of changes) {
          c.command.disabled = c.beforeDisabled;
          c.command.args = c.beforeArgs;
        }
      }
    });
  }

  // -------- Implicit disabling ----------------------------------------------------------------
  //
  // Disabling a command can imply that other commands must also be skipped (and dropped on save):
  //   - Object liveness: if the command that creates an object is disabled, every command that uses
  //     that object is disabled too — and this cascades (a disabled createView kills its view's uses).
  //   - Block containment: disabling either half of a begin/end pair (render/compute pass, debug
  //     group, error scope, render-bundle encoder) disables its partner and everything inside it.
  //   - Draw-state flow: within a pass, disabling a state command (setPipeline / setBindGroup /
  //     setVertexBuffer / setIndexBuffer) disables the draws that rely on that state; disabling a
  //     setPipeline disables its whole group of bindings + draws.
  // These derived flags live on command._implicit; the explicit user flag is command.disabled.

  // The object ids a command references: its target object plus any {__id} markers in its arguments.
  _commandRefs(command) {
    const refs = [];
    if (command.object !== undefined && command.object !== null) {
      refs.push(command.object);
    }
    const walk = (v) => {
      if (!v || typeof v !== "object") {
        return;
      }
      if (Array.isArray(v)) {
        for (const x of v) {
          walk(x);
        }
        return;
      }
      if (v.__id !== undefined && v.__id !== null) {
        refs.push(v.__id);
        return;
      }
      for (const k in v) {
        walk(v[k]);
      }
    };
    walk(command.args);
    return refs;
  }

  // The object ids a command defines or populates (rather than consumes): its created result plus,
  // for writes/copies, the destination resource. Used by reverse-liveness to tell a resource's
  // producers apart from its consumers.
  _commandWrites(command) {
    const writes = new Set();
    if (command.result !== undefined && command.result !== null) {
      writes.add(command.result);
    }
    const args = command.args;
    if (!Array.isArray(args)) {
      return writes;
    }
    const idOf = (v) => (v && v.__id !== undefined && v.__id !== null) ? v.__id : undefined;
    switch (command.method) {
      case "writeBuffer": { const id = idOf(args[0]); if (id !== undefined) { writes.add(id); } break; }
      case "writeTexture": case "__writeTexture": { const id = args[0]?.texture?.__id; if (id != null) { writes.add(id); } break; }
      case "copyBufferToBuffer": { const id = idOf(args[2]); if (id !== undefined) { writes.add(id); } break; }
      case "copyBufferToTexture": { const id = args[1]?.texture?.__id; if (id != null) { writes.add(id); } break; }
      case "copyTextureToBuffer": { const id = args[1]?.buffer?.__id; if (id != null) { writes.add(id); } break; }
      case "copyTextureToTexture": { const id = args[1]?.texture?.__id; if (id != null) { writes.add(id); } break; }
      default: break;
    }
    return writes;
  }

  // Recompute the static dependency structure (object creators, begin/end blocks, draw-state
  // groups) from the current command stream. Cheap and only run on user edits.
  _buildDependencyStructure() {
    const creators = new Map();
    this.forEachCommand((command) => {
      command._refs = this._commandRefs(command);
      command._writes = this._commandWrites(command);
      if (command.result !== undefined && command.result !== null) {
        creators.set(command.result, command);
      }
    });
    this._creators = creators;

    this._blocks = [];
    this._detectBlocksAndGroups(this.initializeCommands);
    for (const frame of this.frames) {
      if (frame) {
        this._detectBlocksAndGroups(frame);
      }
    }
  }

  // Pair begin/end blocks and build draw-state groups within one command list (a frame or the
  // initialize block). Populates this._blocks and per-command _groupMembers / _stateDeps.
  _detectBlocksAndGroups(list) {
    const isDraw = (m) => m === "draw" || m === "drawIndexed" || m === "drawIndirect" ||
      m === "drawIndexedIndirect" || m === "dispatchWorkgroups" || m === "dispatchWorkgroupsIndirect";

    const stack = []; // open blocks, innermost last
    const addToOpen = (command) => {
      for (const block of stack) {
        block.members.push(command);
      }
    };
    const closeBlock = (predicate) => {
      for (let i = stack.length - 1; i >= 0; --i) {
        if (predicate(stack[i])) {
          const block = stack[i];
          stack.splice(i, 1);
          return block;
        }
      }
      return null;
    };

    // Draw-state tracking, reset at each pass boundary.
    let inPass = false;
    let currentPipeline = null;
    const activeBindGroups = new Map();
    const activeVertex = new Map();
    let activeIndex = null;
    const resetState = () => {
      currentPipeline = null;
      activeBindGroups.clear();
      activeVertex.clear();
      activeIndex = null;
    };

    for (const command of list) {
      if (!command) {
        continue;
      }
      const m = command.method;
      command._groupMembers = undefined;
      command._stateDeps = undefined;

      if (m === "beginRenderPass" || m === "beginComputePass") {
        addToOpen(command);
        stack.push({ type: "pass", begin: command, end: null, members: [], objectId: command.result });
        inPass = true;
        resetState();
      } else if (m === "createRenderBundleEncoder") {
        addToOpen(command);
        stack.push({ type: "bundle", begin: command, end: null, members: [], objectId: command.result });
      } else if (m === "pushDebugGroup") {
        addToOpen(command);
        stack.push({ type: "debug", begin: command, end: null, members: [] });
      } else if (m === "pushErrorScope") {
        addToOpen(command);
        stack.push({ type: "error", begin: command, end: null, members: [] });
      } else if (m === "end") {
        const block = closeBlock((b) => b.type === "pass" && b.objectId === command.object);
        if (block) {
          block.end = command;
          this._blocks.push(block);
        }
        addToOpen(command);
        inPass = false;
        resetState();
      } else if (m === "finish") {
        const block = closeBlock((b) => b.type === "bundle" && b.objectId === command.object);
        if (block) {
          block.end = command;
          this._blocks.push(block);
        }
        addToOpen(command);
      } else if (m === "popDebugGroup") {
        const block = closeBlock((b) => b.type === "debug");
        if (block) {
          block.end = command;
          this._blocks.push(block);
        }
        addToOpen(command);
      } else if (m === "popErrorScope") {
        const block = closeBlock((b) => b.type === "error");
        if (block) {
          block.end = command;
          this._blocks.push(block);
        }
        addToOpen(command);
      } else {
        addToOpen(command);
        // Draw-state flow within a pass.
        if (inPass) {
          if (m === "setPipeline") {
            currentPipeline = command;
            command._groupMembers = [];
          } else if (m === "setBindGroup") {
            activeBindGroups.set(command.args?.[0], command);
            if (currentPipeline) {
              currentPipeline._groupMembers.push(command);
            }
          } else if (m === "setVertexBuffer") {
            activeVertex.set(command.args?.[0], command);
            if (currentPipeline) {
              currentPipeline._groupMembers.push(command);
            }
          } else if (m === "setIndexBuffer") {
            activeIndex = command;
            if (currentPipeline) {
              currentPipeline._groupMembers.push(command);
            }
          } else if (isDraw(m)) {
            const deps = [];
            if (currentPipeline) {
              deps.push(currentPipeline);
              currentPipeline._groupMembers.push(command);
            }
            for (const c of activeBindGroups.values()) {
              deps.push(c);
            }
            for (const c of activeVertex.values()) {
              deps.push(c);
            }
            if (activeIndex) {
              deps.push(activeIndex);
            }
            command._stateDeps = deps;
          }
        }
      }
    }
  }

  // Recompute command._implicit / command._effectiveDisabled from the explicit disabled flags,
  // iterating the dependency rules to a fixpoint (the marked set only grows, so it converges).
  _recomputeImplicitDisabled() {
    this._buildDependencyStructure();

    this.forEachCommand((command) => { command._implicit = false; });

    const eff = (command) => command.disabled || command._implicit;
    const mark = (command) => {
      if (command && !command._implicit && !command.disabled && !this.isProtectedCommand(command)) {
        command._implicit = true;
        return true;
      }
      return false;
    };

    let changed = true;
    let guard = 0;
    while (changed && guard++ < 1000) {
      changed = false;

      // A) Object liveness: a command that uses an object created by a disabled command is disabled.
      this.forEachCommand((command) => {
        if (eff(command)) {
          return;
        }
        for (const id of command._refs) {
          const creator = this._creators.get(id);
          if (creator && creator !== command && eff(creator)) {
            if (mark(command)) {
              changed = true;
            }
            break;
          }
        }
      });

      // B) Block containment: disabling either half of a begin/end pair disables its partner and
      // every command inside the block.
      for (const block of this._blocks) {
        if (eff(block.begin) || (block.end && eff(block.end))) {
          if (mark(block.begin)) { changed = true; }
          if (block.end && mark(block.end)) { changed = true; }
          for (const member of block.members) {
            if (mark(member)) { changed = true; }
          }
        }
      }

      // C) Draw-state flow: a disabled setPipeline disables its group; a draw is disabled if any
      // state command it depends on is disabled.
      this.forEachCommand((command) => {
        if (command._groupMembers && eff(command)) {
          for (const member of command._groupMembers) {
            if (mark(member)) { changed = true; }
          }
        }
        if (command._stateDeps && !eff(command)) {
          for (const dep of command._stateDeps) {
            if (eff(dep)) {
              if (mark(command)) { changed = true; }
              break;
            }
          }
        }
      });

      // D) Reverse liveness: a resource (buffer/texture/etc.) that no enabled command consumes is
      // dead, so the commands that only create or populate it (createBuffer/writeBuffer/...) are
      // disabled. This cascades upstream — e.g. disabling a setBindGroup can leave a bind group,
      // and in turn its buffers, with no live consumer.
      const live = this._computeLiveObjects(eff);
      this.forEachCommand((command) => {
        if (eff(command) || this.isProtectedCommand(command)) {
          return;
        }
        if (!RecorderData._resourceDefMethods.has(command.method)) {
          return;
        }
        const writes = command._writes;
        if (!writes || writes.size === 0) {
          return;
        }
        let anyLive = false;
        for (const id of writes) {
          if (live.has(id)) {
            anyLive = true;
            break;
          }
        }
        if (!anyLive && mark(command)) {
          changed = true;
        }
      });
    }

    this.forEachCommand((command) => { command._effectiveDisabled = command.disabled || command._implicit; });
  }

  // Compute the set of object ids that are still consumed by an enabled command, by forward
  // reachability from "terminal" commands (draws, dispatches, submit, end, state-setters, ...).
  // A command "keeps" the objects it consumes alive when it is enabled and either has no produced
  // result, or its produced/written object is itself live (i.e. consumed downstream).
  _computeLiveObjects(eff) {
    const live = new Set();
    let changed = true;
    let guard = 0;
    while (changed && guard++ < 1000) {
      changed = false;
      this.forEachCommand((command) => {
        if (eff(command)) {
          return;
        }
        const writes = command._writes;
        let kept;
        if (writes && writes.size > 0) {
          // Producer/writer: only relevant if what it produces is live.
          kept = false;
          for (const id of writes) {
            if (live.has(id)) { kept = true; break; }
          }
        } else {
          // Terminal consumer (draw / dispatch / submit / end / setBindGroup / ...).
          kept = true;
        }
        if (!kept) {
          return;
        }
        for (const id of command._refs) {
          if (writes && writes.has(id)) {
            continue; // defined here, not consumed
          }
          if (!live.has(id)) {
            live.add(id);
            changed = true;
          }
        }
      });
    }
    return live;
  }

  // Canvas dimensions for export/preview. Prefer values recovered from a loaded binary; otherwise
  // recover them from the recording's own __setCanvasSize command (which may sit in the init block
  // or in a frame, depending on when configure() ran); otherwise fall back.
  getCanvasSize() {
    if (this.canvasWidth > 0 && this.canvasHeight > 0) {
      return { width: this.canvasWidth, height: this.canvasHeight };
    }
    const fromCommands = (commands) => {
      for (const command of commands || []) {
        if (command && command.method === "__setCanvasSize" && Array.isArray(command.args)) {
          const width = command.args[0] | 0;
          const height = command.args[1] | 0;
          if (width > 0 && height > 0) {
            return { width, height };
          }
        }
      }
      return null;
    };
    let size = fromCommands(this.initializeCommands);
    for (let f = 0; !size && f < this.frames.length; ++f) {
      size = fromCommands(this.frames[f]);
    }
    return size || { width: 800, height: 600 };
  }

  _checkReady() {
    if (this.ready) {
      this.onReady.emit();
    }
  }

  addData(data, type, index, count) {
    this.dataTypes[index] = type || "Uint8Array";
    if (data === undefined) {
      this.data[index] = new Uint8Array(count);
      this._dataCount++;
      this.dataReady = this._dataCount >= count;
      this._checkReady();
      return;
    }

    fetchArrayBuffer(data, type, 0).then((x) => {
      this.data[index] = x;
      this._dataCount++;
      this.dataReady = this._dataCount >= count;
      this._checkReady();
    });
  }

  // Parse a recorded command's args (a JSON string) in place. requestDevice/requestAdapter reuse
  // the panel's existing adapter/device at replay (see _executeCommand), so their recorded args
  // aren't needed. Never throws — on malformed args it logs and falls back to an empty arg list so
  // the command stays in sequence (a hole would break the replay loop).
  _parseCommandArgs(command) {
    if (command.method === "requestDevice" || command.method === "requestAdapter") {
      command.args = [];
    } else {
      try {
        command.args = JSON.parse(command.args);
      } catch (e) {
        console.error(`Error parsing args for command ${command.method}:`, e.message);
        command.args = [];
      }
    }
    return command;
  }

  addCommand(command, commandIndex, frame, index, count) {
    try {
      this._parseCommandArgs(command);

      if (frame < 0) {
        this.initializeCommands[commandIndex] = command;
      } else {
        if (this.frames[frame] === undefined) {
          this.frames[frame] = [];
        }
        this.frames[frame][commandIndex] = command;
      }

      this._commandCount++;
      this._commandsReady = this._commandCount >= count;
      this._checkReady();
    } catch (e) {
      console.error(`Error adding command: ${command.method}`, e.message);
    }
  }

  // Load a binary (.wgpu) recording produced by webgpu_recorder, replacing any current recording.
  // Container layout (see webgpu_recorder._buildBinaryRecording):
  //   "WGPR" | version u32 | headerLen u32 | header(JSON utf8) | rawData
  // header = { canvasWidth, canvasHeight, init:[cmd], frames:[[cmd]], data:[{type,length,offset}] }
  // where each cmd has its args as a JSON string and the data table offsets index into rawData.
  loadBinary(arrayBuffer) {
    this.clear();

    try {
      const u8 = new Uint8Array(arrayBuffer);
      if (u8.length < 12 || u8[0] !== 0x57 || u8[1] !== 0x47 || u8[2] !== 0x50 || u8[3] !== 0x52) {
        console.error("Invalid binary recording: missing WGPR header.");
        return;
      }

      const view = new DataView(arrayBuffer);
      const headerLength = view.getUint32(8, true);
      const dataStart = 12 + headerLength;
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, 12, headerLength)));

      // Preserve the metadata needed to export this recording again.
      this.canvasWidth = header.canvasWidth | 0;
      this.canvasHeight = header.canvasHeight | 0;
      this.gpuVar = header.gpuVar || "x1";
      this.contextVar = header.contextVar || "context";

      // Raw data blobs, sliced into typed arrays matching the recorded type.
      const dataTable = header.data || [];
      for (let i = 0; i < dataTable.length; ++i) {
        const d = dataTable[i];
        this.dataTypes[i] = (d && d.type) || "Uint8Array";
        if (!d || !d.type || !d.length) {
          this.data[i] = new Uint8Array(0);
          continue;
        }
        const slice = arrayBuffer.slice(dataStart + d.offset, dataStart + d.offset + d.length);
        this.data[i] = d.type === "Uint32Array" ? new Uint32Array(slice) : new Uint8Array(slice);
      }

      const init = header.init || [];
      for (let i = 0; i < init.length; ++i) {
        this.initializeCommands[i] = this._parseCommandArgs(init[i]);
      }

      const frames = header.frames || [];
      for (let f = 0; f < frames.length; ++f) {
        this.frames[f] = [];
        const commands = frames[f] || [];
        for (let i = 0; i < commands.length; ++i) {
          this.frames[f][i] = this._parseCommandArgs(commands[i]);
        }
      }

      this.dataReady = true;
      this._commandsReady = true;
      this.onReady.emit();
    } catch (e) {
      console.error(`Failed to load binary recording: ${e.message}`);
    }
  }

  _getObject(id) {
    if (id === "x1") {
      return navigator.gpu;
    }
    if (id === "context") {
      if (!this._context && this._canvas) {
        this._context = this._canvas.element.getContext("webgpu");
      }
      return this._context;
    }
    return this._objectMap.get(id);
  }

  async executeCommands(canvas, frameIndex, commandIndex = -1) {
    // Reset only the runtime GPU state, not the recorded commands/data we're about to replay.
    this._resetExecutionState();

    this._canvas = canvas;
    // Replay onto the panel's shared device so the canvas context, replayed resources, and the
    // preview blit all use one device.
    this._device = this.window.device ?? null;
    this._textureUtils = this.window.textureUtils ?? null;

    let ci = 0;
    for (const command of this.initializeCommands) {
      // Disabled commands (explicit or implicit) are excluded from playback and the saved recording.
      if (command && command._effectiveDisabled) {
        ci++;
        continue;
      }
      await this._executeCommand(command, -1, ci);
      ci++;
    }

    frameIndex = Math.max(0, Math.min(frameIndex, this.frames.length - 1));
    const hasCommandIndex = commandIndex >= 0;

    const commandEncoders = new Set();
    const passes = new Set();
    const commandBuffers = new Set();
    let debugGroups = 0;
    let lastPass = null;

    for (let fi = 0; fi <= frameIndex; ++fi) {
      const frame = this.frames[fi];
      if (!frame) {
        continue;
      }
      ci = 0;
      const hasFrameCommandIndex = hasCommandIndex && fi === frameIndex;
      for (const command of frame) {
        // Disabled commands (explicit or implicit) are excluded from playback and the saved recording.
        if (command && command._effectiveDisabled) {
          ci++;
          continue;
        }
        if (hasFrameCommandIndex && ci > commandIndex) {
          if (passes.size > 0 && command.method === "end") {
            // _executeCommand returns the method's result (end() returns undefined), so resolve
            // the pass encoder from the command's object, not from the return value.
            const passObject = this._getObject(command.object);
            await this._executeCommand(command, fi, ci);
            if (passObject) {
              passes.delete(passObject);
              if (passObject instanceof GPURenderPassEncoder) {
                lastPass = passObject;
              }
            }
          }

          if (commandEncoders.size > 0 && command.method === "finish") {
            const encoderObject = this._getObject(command.object);
            await this._executeCommand(command, fi, ci);
            if (encoderObject) {
              commandEncoders.delete(encoderObject);
            }
            commandBuffers.add(command.result);
          }

          if (command.method === "popDebugGroup" && debugGroups > 0) {
            await this._executeCommand(command, fi, ci);
            debugGroups--;
          }

          if (command.method === "submit") {
            let found = false;
            if (commandBuffers.size > 0) {
              for (const cb of command.args[0]) {
                for (const commandBuffer of commandBuffers) {
                  if (commandBuffer === cb.__id) {
                    found = true;
                    commandBuffers.delete(commandBuffer);
                    break;
                  }
                }
              }
              if (found) {
                await this._executeCommand(command, fi, ci);
              }
            }
          }

          ci++;
          continue;
        }

        const result = await this._executeCommand(command, fi, ci);
        ci++;

        if (fi === frameIndex) {
          if (command.method === "pushDebugGroup") {
            debugGroups++;
          } else if (command.method === "popDebugGroup") {
            debugGroups--;
          } else if (command.method === "createCommandEncoder") {
            commandEncoders.add(result);
          } else if (command.method === "beginRenderPass" || command.method === "beginComputePass") {
            result.__descriptor = command.args[0];
            passes.add(result);
          } else if (command.method === "end") {
            const object = this._getObject(command.object);
            if (object) {
              passes.delete(object);
              // Remember the most recent render pass so it can be previewed even when the
              // selected command is at/after the pass end (e.g. finish or submit).
              if (object instanceof GPURenderPassEncoder) {
                lastPass = object;
              }
            }
          } else if (command.method === "finish") {
            const object = this._getObject(command.object);
            if (object) {
              commandEncoders.delete(object);
            }
          }
        }
      }
    }

    if (lastPass instanceof GPURenderPassEncoder) {
      if (lastPass.__descriptor?.colorAttachments?.length > 0) {
        const colorOutput0 = this._getObject(
          lastPass.__descriptor.colorAttachments[0].resolveTarget?.__id ??
          lastPass.__descriptor.colorAttachments[0].view?.__id);
        const colorOutputTexture = colorOutput0?.texture;
        if (colorOutputTexture && !colorOutputTexture.isCanvasTexture) {
          const canvasTexture = this._context.getCurrentTexture();
          const canvasView = canvasTexture.createView();

          if (!this._textureUtils && this._device) {
            this._textureUtils = new TextureUtils(this._device);
          }

          if (this._textureUtils) {
            this._textureUtils.blitTexture(colorOutput0, colorOutput0.texture.format, 1, canvasView, canvasTexture.format, null);
          }
        }
      }
    }
  }

  _prepareValue(value) {
    if (value && typeof value !== 'string' && value.length !== undefined) {
      return this._prepareArgs(value);
    }
    if (value instanceof Object) {
      if (value.__id !== undefined) {
        return this._getObject(value.__id);
      }
      if (value.__data !== undefined) {
        return this.data[value.__data];
      }
      return this._prepareObject(value);
    }
    return value;
  }

  _prepareObject(obj) {
    const newObj = {};
    for (const key in obj) {
      newObj[key] = this._prepareValue(obj[key]);
    }
    return newObj;
  }

  _prepareArgs(args) {
    return [...args].map(arg => this._prepareValue(arg));
  }

  async _executeCommand(command, frameIndex, commandIndex) {
    if (!command) {
      return null;
    }
    let method = command.method;

    // Reuse the panel's existing adapter/device rather than creating new ones during replay. This
    // keeps the canvas context, replayed resources, and the preview blit all on a single device,
    // and avoids the recorded device-setup commands leaving configure()'s device undefined.
    if (method === "requestAdapter") {
      if (command.result) {
        this._objectMap.set(command.result, this.window.adapter);
      }
      return this.window.adapter;
    }
    if (method === "requestDevice") {
      this._device = this.window.device;
      if (command.result) {
        this._objectMap.set(command.result, this.window.device);
      }
      return this.window.device;
    }

    const object = this._getObject(command.object);
    if (!object) {
      return null;
    }

    if (method === "pushDebugGroup" || method === "popDebugGroup") {
      return null;
    }

    // Never destroy the panel's shared device/adapter during replay.
    if (method === "destroy" && (object === this.window.device || object === this.window.adapter)) {
      return null;
    }

    if (object instanceof GPUDevice) {
      this._device = object;
    }

    if (method === "__writeTexture") {
      method = "writeTexture";
    }

    const args = this._prepareArgs(command.args);
    let result = null;

    if (method === "__setCanvasSize") {
      this._canvas.element.width = args[0];
      this._canvas.element.height = args[1];
      return null;
    }

    if (method === "__writeData") {
      const dataIndex = args[0];
      const data = this.data[dataIndex];
      new Uint8Array(object).set(data);
      return null;
    }

    if (method === "__getQueue") {
      this._objectMap.set(command.result, object.queue);
      return null;
    }

    if (method === "createTexture") {
      args[0].usage |= GPUTextureUsage.TEXTURE_BINDING;
    }

    const isAsync = command.async;
    if (this._device) {
      this._device.pushErrorScope("validation");
    }

    try {
      result = isAsync ? await object[method](...args) : object[method](...args);
    } catch (e) {
      console.error(`EXCEPTION frame:${frameIndex} command:${commandIndex} ${object?.constructor.name} ${method}: ${e.message}`);
    }

    if (this._device) {
      this._device.popErrorScope().then((error) => {
        if (error) {
          console.error(`ERROR frame:${frameIndex} command:${commandIndex} ${object?.constructor.name} ${method}: ${error.message}`);
        }
      }).catch((e) => {
        console.error(`ERROR frame:${frameIndex} command:${commandIndex} ${object?.constructor.name} ${method}: ${e.message}`);
      });
    }

    if (method === "createView") {
      result.texture = object;
    } else if (method === "getCurrentTexture") {
      result.isCanvasTexture = true;
    }

    if (command.result) {
      this._objectMap.set(command.result, result);
    }

    if (result instanceof GPUDevice) {
      this._device = result;
    }

    return result;
  }
}
