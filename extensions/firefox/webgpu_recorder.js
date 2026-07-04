var __webgpu_recorder = (function (exports) {
  'use strict';

  const _postMessage = self.postMessage;
  const _dispatchEvent = self.dispatchEvent;
  const _document = self.document;

  function webgpu_recorder_download_data(data, filename) {
    try {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([data], { type: "text/html" }));
      link.download = filename;
      link.click();
    } catch (e) {
    }
  }

  // Download an ArrayBuffer as a binary file (the recorder's .wgpu output).
  function webgpu_recorder_download_binary(data, filename) {
    try {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([data], { type: "application/octet-stream" }));
      link.download = filename;
      link.click();
    } catch (e) {
    }
  }

  class WebGPURecorder {
    // public:
    constructor(options) {
      // If the browser doesn't support WebGPU, there's nothing to do.
      if (!navigator.gpu) {
        return;
      }

      options = options || {};
      this.config = {
        maxFrameCount: Math.max((options.frames ?? 100) - 1, 1),
        exportName: options.export || "WebGPURecord",
        canvasWidth: options.width || 800,
        canvasHeight: options.height || 600,
        removeUnusedResources: !!options.removeUnusedResources,
        messageRecording: !!options.messageRecording,
        download: options.download ?? true,
        compactCommands: !!options.compactCommands,
        recordMode: options.recordMode ?? 0,
        // recordMode 2 (stateful) options:
        // recordFrame: index (0-based) of the rendering frame to capture, or an array of indices.
        // Only frames that submit GPU work count; non-rendering rAF ticks are skipped. null = wait
        // for a runtime trigger.
        recordFrame: options.recordFrame ?? null,
        // continuous: if true, keep tracking state after a capture so further triggers can
        // capture again in the same session. Otherwise recording stops after the first capture.
        continuous: !!options.continuous,
        // output: "html" (default) generates the self-contained HTML; "binary" generates an
        // efficient .wgpu (raw data, no base64) for use with webgpu_player.js; "both" generates each.
        output: options.output ?? "html"
      };

      this.recordSingleFrame = this.config.recordMode === 1;

      // recordMode 2: stateful arbitrary-frame recording. Instead of logging every frame from the
      // start, maintain a live model of all GPU objects (their creation commands + inter-object
      // dependencies) and, when a target frame is reached, read back the current contents of every
      // live resource off the GPU to build the initialize block, then record that single frame.
      this._stateful = this.config.recordMode === 2;
      // The "frame" the user refers to is a frame that actually rendered (submitted GPU work).
      // Non-rendering rAF ticks (idle loops) are not counted, so capturing frame N targets the Nth
      // rendering frame. _renderedFrameCount is how many rendering frames have completed so far.
      this._renderedFrameCount = 0;
      // Whether the current rAF has submitted any GPU work (set on queue.submit).
      this._frameDidRender = false;
      // Whether we are currently between _frameStart and _frameEnd.
      this._inFrame = false;
      // The set of absolute rendering-frame indices still pending capture. recordFrame may be a single
      // number or an array of numbers; runtime triggers (recordFrame/recordNextFrame) add more. Each
      // frame is removed as it is captured.
      this._captureTargetFrames = new Set();
      const _rf = this.config.recordFrame;
      if (Array.isArray(_rf)) {
        for (const f of _rf) {
          if (typeof f === "number") {
            this._captureTargetFrames.add(f);
          }
        }
      } else if (typeof _rf === "number") {
        this._captureTargetFrames.add(_rf);
      }
      // When capturing more than one frame from config, each output file is suffixed with the frame
      // number so the downloads don't collide.
      this._multiCapture = this._captureTargetFrames.size > 1;
      this._baseExportName = this.config.exportName;
      // True only while recording the commands of the target frame itself.
      this._isCapturingFrame = false;
      // Number of frames already captured in the current recording session. Stays 0 until the first
      // frame is captured; used to capture the initial resource state only once when merging multiple
      // frames into a single recording (see _beginFrameCapture / _statefulFrameEnd).
      this._sessionFrameCount = 0;
      // Live object registry: id -> { ref(WeakRef), type, seq, lines, lineObjects, commandObjs,
      //   deps(Set<id>), destroyed, collected }.
      this._objectRegistry = new Map();
      // Ids in creation order; dependencies always precede their dependents.
      this._creationOrder = [];
      // Reverse dependency map: id -> Set<id> of objects that reference it.
      this._dependents = new Map();
      // Monotonic creation sequence counter.
      this._objectSeq = 0;
      // Frees the registry entry for a GPU object once it is garbage collected.
      this._finalizationRegistry = (typeof FinalizationRegistry !== "undefined")
        ? new FinalizationRegistry((id) => this._onObjectCollected(id))
        : null;

      this._objectIndex = 1;

      this._frameIndex = -1;
      this._adapter = null;

      this._initializeObjects = [];
      this._initializeCommands = [];
      this._initializeCommandObjects = [];

      this._currentFrameCommands = null;
      this._frameCommands = [];
      this._currentFrameObjects = null;
      this._frameObjects = [];
      this._currentFrameCommandObjects = null;
      this._frameCommandObjects = [];

      this._frameVariables = {};
      this._frameVariables[-1] = new Set();

      this._arrayCache = [];
      this._totalData = 0;
      
      this._unusedTextures = new Set();
      this._unusedTextureViews = new Map();
      this._unusedBuffers = new Set();
      this._unusedBindGroups = new Set();
      this._dataCacheObjects = [];
      this._frameDataCount = {};
      this._externalImageBufferPromises = [];
      this._labelCounts = new Map();

      this._usedObjectIds = new Set();

      // Variable names (ids) of objects derived from the canvas: the per-frame texture returned by
      // context.getCurrentTexture() and any views created from it. These are transient (a fresh one is
      // obtained every frame) so their creation must never be hoisted into the initialize block in
      // single-frame mode — getCurrentTexture is not a "create*" command and so is not hoisted, which
      // would leave a hoisted createView with an undefined receiver.
      this._canvasObjectIds = new Set();

      this._isRecording = true;

      // Set once the recorder has fully detached from WebGPU (native methods/globals restored, overlay
      // removed). Guards _detach against running twice.
      this._detached = false;
      // Canvases whose getContext we patched, kept as { canvas, getContext } so the original can be
      // restored on detach.
      this._wrappedCanvases = [];

      this._gpuWrapper = new GPUObjectWrapper(this);
      this._gpuWrapper.onPromiseResolve = this._onAsyncResolve.bind(this);
      this._gpuWrapper.onPreCall = this._preMethodCall.bind(this);
      this._gpuWrapper.onPostCall = this._onMethodCall.bind(this);

      this._registerObject(navigator.gpu);
      if (this._stateful) {
        // Seed the registry with the root gpu object so the adapter (and everything below it) has a
        // dependency to attach to. Its assignment line is stored on its own entry.
        const entry = this._statefulCreateEntry(navigator.gpu);
        entry.lines.push(`${this._getObjectVariable(navigator.gpu)} = navigator.gpu;`);
        entry.lineObjects.push(navigator.gpu);
      } else {
        this._recordLine(`${this._getObjectVariable(navigator.gpu)} = navigator.gpu;`, navigator.gpu);
      }

      if (this.recordSingleFrame) {
        this._usedObjectIds.add(navigator.gpu.__id);
      }

      const self = this;

      if (_document?.body) {
        // If the document body is available, create the status elements now,
        // which overlays information about the inspector.
        this._createOverlayElement();
        this._wrapCanvases();
      } else if (_document) {
        // If there is a document but no body yet, wait for the DOMContentLoaded event.
        _document.addEventListener("DOMContentLoaded", () => {
          self._createOverlayElement();

          const iframes = _document.getElementsByTagName("iframe");
          if (iframes.length > 0) {
            for (const iframe of iframes) {
              iframe.addEventListener("load", () => {
                iframe.contentWindow.dispatchEvent(new CustomEvent("__WebGPURecorder", { detail: {
                  __webgpuRecorder: true,
                  __webgpuRecorderPage: true,
                  __webgpuRecorderWorker: !_document,
                  frames: self.config.maxFrameCount,
                  export: self.config.exportName,
                  download: self.config.download,
                  action: "webgpu_recorder_start_recording" } }));
              });
            }
          }

          const canvases = _document.getElementsByTagName("canvas");
          for (const canvas of canvases) {
            self._wrapCanvas(canvas);
          }
        });
      }

      // Capture any dynamically created canvases
      if (_document) {
        const __createElement = document.createElement;
        this._originalCreateElement = __createElement;
        _document.createElement = function (type) {
          const element = __createElement.call(_document, type);
          if (type === "canvas") {
            self._wrapCanvas(element);
          } else if (type === "iframe") {
            element.addEventListener("load", () => {
              element.contentWindow.dispatchEvent(new CustomEvent("__WebGPURecorder", { detail: {
                __webgpuRecorder: true,
                __webgpuRecorderPage: true,
                __webgpuRecorderWorker: !_document,
                frames: self.config.maxFrameCount,
                export: self.config.exportName,
                download: self.config.download,
                action: "webgpu_recorder_start_recording" } }));
            });
          }
          return element;
        };
      }

      // Wrap requestAnimationFrame so it can keep track of per-frame recording and know when
      // the maximum number of frames has been reached.
      //
      // In stateful mode (recordMode 2) the recorder maintains a live model of all GPU objects so an
      // arbitrary frame can be captured at any time; see _statefulFrameStart / _beginFrameCapture.
      const __requestAnimationFrame = requestAnimationFrame;
      this._originalRequestAnimationFrame = __requestAnimationFrame;
      requestAnimationFrame = function (cb) {
        function callback(timestamp) {
          self._frameStart(timestamp);
          const result = cb(timestamp);
          if (result instanceof Promise) {
            Promise.all([result]).then(() => {
              self._frameEnd(timestamp);
            });
          } else {
            self._frameEnd(timestamp);
          }
        }
        return __requestAnimationFrame(callback);
      };

      if (this._stateful) {
        this._installCaptureTriggerListener();
      }
    }

    // Listen for an external request to capture a frame. The message may carry a "frame" property
    // (an absolute rAF index); if omitted, the next frame is captured. Works from both the page
    // (CustomEvent "__WebGPURecorder") and a worker (postMessage).
    _installCaptureTriggerListener() {
      const recorder = this;
      const handle = (message) => {
        if (!message || message.action !== "webgpu_recorder_record_frame") {
          return;
        }
        if (typeof message.frame === "number") {
          recorder.recordFrame(message.frame);
        } else {
          recorder.recordNextFrame();
        }
      };
      if (_document) {
        window.addEventListener("__WebGPURecorder", (event) => handle(event.detail));
      } else {
        // Worker: listen on the global scope without clobbering existing handlers.
        self.addEventListener("message", (event) => handle(event.data));
      }
    }

    getNextId() {
      return this._objectIndex++;
    }

    // private:
    _createOverlayElement() {
      const statusContainer = _document.createElement("div");
      statusContainer.style = "position: absolute; top: 0px; left: 0px; z-index: 1000000; margin-left: 10px; margin-top: 5px; padding-left: 5px; padding-right: 10px; background-color: rgba(0, 0, 1, 0.75); border-radius: 5px; box-shadow: 3px 3px 5px rgba(0, 0, 0, 0.5); color: #fff; font-size: 12pt; display: flex; align-items: center;";
      _document.body.insertBefore(statusContainer, _document.body.firstChild);
      this._statusContainer = statusContainer;

      // Keyframes for the busy spinner shown while the recording is being generated. Inline styles
      // can't declare keyframes, so inject a one-off style element (removed again on detach).
      const style = _document.createElement("style");
      style.textContent = "@keyframes webgpu-recorder-spin { to { transform: rotate(360deg); } }";
      (_document.head || _document.body).appendChild(style);
      this._overlayStyle = style;

      this._recordingStatus = _document.createElement("div");
      statusContainer.appendChild(this._recordingStatus);

      // Text label shown alongside the spinner while generating the recording data; hidden while
      // recording is in progress.
      this._statusLabel = _document.createElement("span");
      this._statusLabel.style = "display: none; margin-left: 6px; white-space: nowrap;";
      statusContainer.appendChild(this._statusLabel);

      this._setOverlayRecording();
    }

    // Green "recording in progress" dot, label hidden.
    _setOverlayRecording() {
      if (!this._recordingStatus) {
        return;
      }
      this._recordingStatus.title = "WebGPU Recorder Running";
      this._recordingStatus.style = "height: 10px; width: 10px; display: inline-block; margin-right: 5px; background-color: #0f0; border-radius: 50%; border: 1px solid #000; box-shadow: inset -4px -4px 4px -3px rgb(255,100,0), 2px 2px 3px rgba(0,0,0,0.8);";
      if (this._statusLabel) {
        this._statusLabel.style.display = "none";
      }
    }

    // Spinning busy indicator with a label, shown while the recording data is generated, streamed to
    // the inspector, and downloaded.
    _setOverlayBusy() {
      if (!this._recordingStatus) {
        return;
      }
      this._recordingStatus.title = "WebGPU Recorder generating recording data";
      this._recordingStatus.style = "height: 12px; width: 12px; display: inline-block; box-sizing: border-box; border: 2px solid rgba(255,255,255,0.35); border-top-color: #fff; border-radius: 50%; animation: webgpu-recorder-spin 0.8s linear infinite;";
      if (this._statusLabel) {
        this._statusLabel.textContent = "Generating recording data…";
        this._statusLabel.style.display = "inline-block";
      }
    }

    // Remove the page overlay entirely (used once the recorder has finished and detached).
    _removeOverlayElement() {
      if (this._statusContainer?.parentNode) {
        this._statusContainer.parentNode.removeChild(this._statusContainer);
      }
      if (this._overlayStyle?.parentNode) {
        this._overlayStyle.parentNode.removeChild(this._overlayStyle);
      }
      this._statusContainer = null;
      this._recordingStatus = null;
      this._statusLabel = null;
      this._overlayStyle = null;
    }

    // Fully detach the recorder from the page once recording is complete: restore the native WebGPU
    // prototype methods and the globals we patched (requestAnimationFrame, document.createElement,
    // per-canvas getContext), then remove the overlay. After this the recorder imposes no further
    // overhead on the page.
    _detach() {
      if (this._detached) {
        return;
      }
      this._detached = true;

      this._gpuWrapper._unwrapGPUTypes();

      if (this._originalRequestAnimationFrame) {
        requestAnimationFrame = this._originalRequestAnimationFrame;
      }
      if (_document && this._originalCreateElement) {
        _document.createElement = this._originalCreateElement;
      }
      for (const { canvas, getContext } of this._wrappedCanvases) {
        canvas.getContext = getContext;
      }
      this._wrappedCanvases.length = 0;

      this._removeOverlayElement();
    }

    _frameStart(timestamp) {
      this._lastFrameTime = timestamp;
      if (!this._isRecording) {
        return;
      }

      if (this._stateful) {
        this._statefulFrameStart(timestamp);
        return;
      }

      this._frameIndex++;
      this._frameVariables[this._frameIndex] = new Set();

      this._currentFrameCommands = [];
      this._currentFrameObjects = [];
      this._currentFrameCommandObjects = [];
    }

    _frameEnd(timestamp) {
      if (!this._isRecording) {
        return;
      }

      if (this._stateful) {
        this._statefulFrameEnd(timestamp);
        return;
      }

      if (this._currentFrameCommands.length === 0) {
        this._currentFrameCommands = null;
        this._currentFrameObjects = null;
        this._currentFrameCommandObjects = null;
        this._frameIndex--;
        return;
      }

      this._frameCommands.push(this._currentFrameCommands);
      this._frameObjects.push(this._currentFrameObjects);
      this._frameCommandObjects.push(this._currentFrameCommandObjects);

      if (this._frameIndex === this.config.maxFrameCount) {
        this.generateOutput();
        this._frameIndex++;
        return;
      }
    }

    // ----- Stateful (recordMode 2) arbitrary-frame capture -----

    // Arm the recorder to capture one or more absolute frame indices (rAF count from page load).
    recordFrame(frameIndex) {
      if (!this._stateful) {
        return;
      }
      if (Array.isArray(frameIndex)) {
        for (const f of frameIndex) {
          if (typeof f === "number") {
            this._captureTargetFrames.add(f);
          }
        }
        if (this._captureTargetFrames.size > 1) {
          this._multiCapture = true;
        }
      } else if (typeof frameIndex === "number") {
        this._captureTargetFrames.add(frameIndex);
      }
    }

    // Arm the recorder to capture whichever rendering frame comes next.
    recordNextFrame() {
      if (!this._stateful) {
        return;
      }
      this._captureTargetFrames.add(this._renderedFrameCount + (this._inFrame ? 1 : 0));
    }

    _statefulFrameStart(timestamp) {
      this._inFrame = true;
      this._frameDidRender = false;
      if (this._exporting) {
        return; // Don't start a new capture while a previous one is still being exported.
      }
      // Speculatively begin capturing when we reach the target rendering-frame index. Whether this
      // rAF actually rendered is only known at frame end; an empty (non-rendering) rAF is discarded
      // and we stay armed for the next one.
      if (!this._isCapturingFrame && this._captureTargetFrames.has(this._renderedFrameCount)) {
        this._captureFrameNumber = this._renderedFrameCount;
        this._beginFrameCapture();
      }
    }

    _statefulFrameEnd(timestamp) {
      this._inFrame = false;

      if (this._isCapturingFrame) {
        if (!this._frameDidRender) {
          // A non-rendering rAF (e.g. an idle loop tick): don't capture an empty frame. Discard the
          // speculative capture and stay armed for the next rendering frame.
          this._discardCapture();
          return;
        }

        this._isCapturingFrame = false;

        this._frameCommands.push(this._currentFrameCommands);
        this._frameObjects.push(this._currentFrameObjects);
        this._frameCommandObjects.push(this._currentFrameCommandObjects);
        this._currentFrameCommands = null;
        this._currentFrameObjects = null;
        this._currentFrameCommandObjects = null;
        // Leave the per-frame state immediately: in continuous/on-demand mode the page keeps rendering
        // during the async export below, before _rearmAfterCapture() runs. Those commands must route to
        // the registry (initialize) path; without resetting _frameIndex here they'd take the frame
        // branch and push onto the now-null _currentFrame* arrays (TypeError: reading 'push' of null).
        this._frameIndex = -1;

        this._captureTargetFrames.delete(this._captureFrameNumber);
        this._renderedFrameCount++;
        this._sessionFrameCount++;

        // Merged multi-frame recording: when more than one frame is being captured, accumulate every
        // captured frame into a single recording and only build/export it after the last one. The
        // initial resource state is snapshotted once (at the first frame), and the captured frames
        // replay in sequence from it.
        if (this._multiCapture && this._captureTargetFrames.size > 0) {
          return;
        }

        // Build the initialize block from the live object registry (reachable objects in creation
        // order) followed by the resource-content readback commands captured at frame start.
        this._flattenStateToInit();

        this._exporting = true;
        this.generateOutput();
        return;
      }

      // Not capturing: only count rAFs that actually rendered toward the target frame index.
      if (this._frameDidRender) {
        this._renderedFrameCount++;
      }
    }

    // Abandon a speculative capture of a non-rendering rAF. The readback copies already submitted for
    // this attempt resolve harmlessly into their (now unreferenced) data slots, which are culled
    // before the recording is saved. The live object registry is untouched, so we stay armed.
    _discardCapture() {
      this._isCapturingFrame = false;
      this._currentFrameCommands = null;
      this._currentFrameObjects = null;
      this._currentFrameCommandObjects = null;
      this._frameIndex = -1;
      // Only drop the snapshotted initial state if this was the state-capturing (first) attempt. In a
      // merged multi-frame session a later non-rendering rAF must not discard the initial state that
      // was already captured with the first frame.
      if (this._sessionFrameCount === 0) {
        this._readbackCommands = null;
        this._readbackObjects = null;
        this._readbackCommandObjects = null;
      }
    }

    // At the start of the target frame (before the app's frame callback runs), snapshot the current
    // contents of every live buffer/texture off the GPU. These become writeBuffer/writeTexture
    // commands in the initialize block, so the captured frame replays against correct state
    // regardless of whether that state came from host writes or earlier GPU passes.
    _beginFrameCapture() {
      // Snapshot the current contents of every live resource only for the first frame of a recording
      // session. When merging multiple frames into one recording, the later frames replay in sequence
      // from this single initial state, so they don't re-snapshot.
      if (this._sessionFrameCount === 0) {
        this._readbackCommands = [];
        this._readbackObjects = [];
        this._readbackCommandObjects = [];

        for (const id of this._creationOrder) {
          const entry = this._objectRegistry.get(id);
          if (!entry || entry.destroyed || entry.collected) {
            continue;
          }
          const obj = entry.ref?.deref();
          if (!obj) {
            continue;
          }
          try {
            if (obj instanceof GPUBuffer) {
              this._readbackBuffer(obj);
            } else if (obj instanceof GPUTexture) {
              this._readbackTexture(obj);
            }
          } catch (e) {
            // A busy/mapped/incompatible resource can't be snapshotted; skip it rather than aborting
            // the whole capture.
            console.warn(`webgpu_recorder: failed to snapshot ${obj.__id}: ${e.message}`);
            if (this._gpuWrapper.skipRecord > 0) {
              this._gpuWrapper.skipRecord = 0;
            }
          }
        }
      }

      this._isCapturingFrame = true;
      // Place this frame in its own slot so a merged multi-frame recording keeps each captured frame
      // (and its per-frame variable scope) distinct.
      this._frameIndex = this._frameCommands.length;
      this._frameVariables[this._frameIndex] = new Set();
      this._currentFrameCommands = [];
      this._currentFrameObjects = [];
      this._currentFrameCommandObjects = [];
    }

    _rearmAfterCapture() {
      // Reset the per-capture output buffers but keep the live object registry so a later trigger
      // can capture another frame.
      this._initializeCommands = [];
      this._initializeObjects = [];
      this._initializeCommandObjects = [];
      this._frameCommands = [];
      this._frameObjects = [];
      this._frameCommandObjects = [];
      this._arrayCache = [];
      this._frameDataCount = {};
      this._dataCacheObjects = [];
      this._externalImageBufferPromises = [];
      this._frameVariables = { [-1]: new Set() };
      this._frameIndex = -1;
      this._usedObjectIds = new Set();
      this._readbackCommands = null;
      this._readbackObjects = null;
      this._readbackCommandObjects = null;
      this._sessionFrameCount = 0;
      // Note: _captureTargetFrames is intentionally preserved (the captured frame was already removed
      // from it); remaining entries are still pending, and runtime triggers may add more.
      this._exporting = false;
    }

    // ----- Stateful registry helpers -----

    // Create (or return the existing) registry entry for a tracked persistent GPU object.
    _statefulCreateEntry(object) {
      const id = object.__id;
      let entry = this._objectRegistry.get(id);
      if (entry) {
        return entry;
      }
      entry = {
        id,
        ref: (typeof WeakRef !== "undefined") ? new WeakRef(object) : { deref: () => object },
        type: object.constructor.name,
        seq: this._objectSeq++,
        lines: [],
        lineObjects: [],
        commandObjs: [],
        deps: new Set(),
        destroyed: false,
        collected: false
      };
      this._objectRegistry.set(id, entry);
      this._creationOrder.push(id);
      if (this._finalizationRegistry) {
        this._finalizationRegistry.register(object, id);
      }
      return entry;
    }

    // The persistent object whose registry entry should receive a command's recorded output, or null
    // if the command is transient (and therefore reconstructed by readback at capture time).
    _statefulRouteObject(method, object, result) {
      if (result && result.__id !== undefined && this._isPersistentObject(result)) {
        return result;
      }
      if (method === "configure" && object) {
        return object; // GPUCanvasContext
      }
      return null;
    }

    _isPersistentObject(obj) {
      if (!obj || typeof obj !== "object") {
        return false;
      }
      for (const t of WebGPURecorder._persistentTypes) {
        if (obj instanceof t) {
          return true;
        }
      }
      return false;
    }

    _isPersistentMethod(method) {
      return WebGPURecorder._persistentMethods.has(method);
    }

    // Collect the ids of every GPU object referenced anywhere within `obj` into `outSet`.
    _collectIds(obj, outSet, visited) {
      if (!obj || typeof obj !== "object") {
        return;
      }
      if (visited.has(obj)) {
        return;
      }
      visited.add(obj);
      if (obj.__id !== undefined) {
        outSet.add(obj.__id);
      }
      for (const key in obj) {
        const value = obj[key];
        if (value && typeof value === "object") {
          this._collectIds(value, outSet, visited);
        }
      }
    }

    // The objects a create command depends on: the receiver (e.g. the device, or the texture for
    // createView) plus every object referenced in its arguments.
    _extractDeps(object, args) {
      const deps = new Set();
      if (object && object.__id !== undefined) {
        deps.add(object.__id);
      }
      const visited = new Set();
      for (const arg of args) {
        this._collectIds(arg, deps, visited);
      }
      return deps;
    }

    _addDeps(entry, newDeps) {
      for (const dep of newDeps) {
        if (dep === entry.id) {
          continue;
        }
        entry.deps.add(dep);
        let set = this._dependents.get(dep);
        if (!set) {
          set = new Set();
          this._dependents.set(dep, set);
        }
        set.add(entry.id);
      }
    }

    _statefulMarkDestroyed(id) {
      const entry = this._objectRegistry.get(id);
      if (entry) {
        entry.destroyed = true;
        this._tryPurge(id);
      }
    }

    _onObjectCollected(id) {
      const entry = this._objectRegistry.get(id);
      if (entry) {
        entry.collected = true;
        this._tryPurge(id);
      }
    }

    // Free a registry entry once its object is destroyed/collected AND nothing live still depends on
    // it. Purging cascades to dependencies that may now be free.
    _tryPurge(id) {
      const entry = this._objectRegistry.get(id);
      if (!entry || (!entry.destroyed && !entry.collected)) {
        return;
      }
      const dependents = this._dependents.get(id);
      if (dependents) {
        for (const depId of dependents) {
          if (this._objectRegistry.has(depId)) {
            return; // A live dependent still needs this object's creation command.
          }
        }
      }

      this._objectRegistry.delete(id);
      this._dependents.delete(id);
      const orderIdx = this._creationOrder.indexOf(id);
      if (orderIdx !== -1) {
        this._creationOrder.splice(orderIdx, 1);
      }
      this._removeVariable(id);

      // This object no longer references its dependencies; some may now be purgeable.
      for (const depId of entry.deps) {
        const set = this._dependents.get(depId);
        if (set) {
          set.delete(id);
        }
        this._tryPurge(depId);
      }
    }

    _statefulDeviceRef() {
      const ref = this._statefulDevice;
      const device = ref?.deref ? ref.deref() : ref;
      return device || null;
    }

    // Snapshot a buffer's current contents by copying it into a mappable staging buffer, then emit a
    // writeBuffer command (filled asynchronously when the map resolves).
    _readbackBuffer(buffer) {
      const size = buffer.size;
      if (!size) {
        return;
      }
      if (!(buffer.usage & GPUBufferUsage.COPY_SRC)) {
        console.warn(`webgpu_recorder: cannot snapshot buffer ${buffer.__id} (no COPY_SRC usage); its contents will be uninitialized in the recording.`);
        return;
      }
      const device = this._statefulDeviceRef();
      if (!device) {
        return;
      }
      const self = this;

      this._gpuWrapper.skipRecord++;
      const staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(buffer, 0, staging, 0, size);
      device.queue.submit([enc.finish()]);
      this._gpuWrapper.skipRecord--;

      const bytes = new Uint8Array(size);
      const cacheIndex = this._getDataCache(bytes, 0, size, null, true);
      const queueVar = this._getObjectVariable(device.queue);
      const bufVar = this._getObjectVariable(buffer);

      this._readbackCommands.push(`${queueVar}.writeBuffer(${bufVar}, 0, ${this._getDataVariable(cacheIndex)});`);
      this._readbackObjects.push(buffer);
      this._readbackCommandObjects.push({ object: queueVar, method: "writeBuffer", result: undefined, args: `[{ "__id": "${bufVar}" }, 0, { "__data": ${cacheIndex} }]`, async: "" });

      const promise = new Promise((resolve) => {
        self._gpuWrapper.skipRecord++;
        staging.mapAsync(GPUMapMode.READ).then(() => {
          self._gpuWrapper.skipRecord++;
          const range = staging.getMappedRange();
          const data = new Uint8Array(range);
          self._replaceDataCache(cacheIndex, data, 0, data.length);
          staging.unmap();
          staging.destroy();
          self._gpuWrapper.skipRecord--;
          resolve();
        });
        self._gpuWrapper.skipRecord--;
      });
      this._externalImageBufferPromises.push(promise);
    }

    // Snapshot a texture's current contents, one mip level at a time, by copying to a staging buffer
    // and emitting writeTexture commands.
    _readbackTexture(texture) {
      const format = texture.format;
      const info = WebGPURecorder._formatInfo[format];
      if (texture.sampleCount > 1 || !info || !info.bytesPerBlock || format.indexOf("depth") !== -1 || format.indexOf("stencil") !== -1) {
        console.warn(`webgpu_recorder: cannot snapshot texture ${texture.__id} (format ${format}, sampleCount ${texture.sampleCount}); its contents will be uninitialized in the recording.`);
        return;
      }
      const device = this._statefulDeviceRef();
      if (!device) {
        return;
      }
      const self = this;
      const { blockWidth, blockHeight, bytesPerBlock } = info;
      const queueVar = this._getObjectVariable(device.queue);
      const texVar = this._getObjectVariable(texture);
      const dim = texture.dimension;
      const arrayLayers = texture.depthOrArrayLayers;

      for (let mip = 0; mip < texture.mipLevelCount; ++mip) {
        const w = Math.max(1, texture.width >> mip);
        const h = Math.max(1, texture.height >> mip);
        const d = (dim === "3d") ? Math.max(1, arrayLayers >> mip) : arrayLayers;
        const widthInBlocks = Math.ceil(w / blockWidth);
        const heightInBlocks = Math.ceil(h / blockHeight);
        const bytesPerRow = (widthInBlocks * bytesPerBlock + 255) & ~0xff;
        const rowsPerImage = heightInBlocks;
        const size = bytesPerRow * rowsPerImage * d;
        if (!size) {
          continue;
        }

        this._gpuWrapper.skipRecord++;
        const staging = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const enc = device.createCommandEncoder();
        enc.copyTextureToBuffer({ texture, mipLevel: mip }, { buffer: staging, bytesPerRow, rowsPerImage }, [w, h, d]);
        device.queue.submit([enc.finish()]);
        this._gpuWrapper.skipRecord--;

        const bytes = new Uint8Array(size);
        const cacheIndex = this._getDataCache(bytes, 0, size, null, true);

        this._readbackCommands.push(`${queueVar}.writeTexture({texture: ${texVar}, mipLevel: ${mip}}, ${this._getDataVariable(cacheIndex)}, {offset: 0, bytesPerRow: ${bytesPerRow}, rowsPerImage: ${rowsPerImage}}, [${w}, ${h}, ${d}]);`);
        this._readbackObjects.push(texture);
        this._readbackCommandObjects.push({ object: queueVar, method: "writeTexture", result: undefined, args: `[{ "texture": { "__id": "${texVar}" }, "mipLevel": ${mip} }, { "__data": ${cacheIndex} }, { "offset": 0, "bytesPerRow": ${bytesPerRow}, "rowsPerImage": ${rowsPerImage} }, [${w}, ${h}, ${d}]]`, async: "" });

        const promise = new Promise((resolve) => {
          self._gpuWrapper.skipRecord++;
          staging.mapAsync(GPUMapMode.READ).then(() => {
            self._gpuWrapper.skipRecord++;
            const range = staging.getMappedRange();
            const data = new Uint8Array(range);
            self._replaceDataCache(cacheIndex, data, 0, data.length);
            staging.unmap();
            staging.destroy();
            self._gpuWrapper.skipRecord--;
            resolve();
          });
          self._gpuWrapper.skipRecord--;
        });
        this._externalImageBufferPromises.push(promise);
      }
    }

    // Build the initialize command block: the creation commands of every live object reachable from
    // the captured frame (in creation order), followed by the resource-content readback commands.
    _flattenStateToInit() {
      const reachable = new Set();
      const stack = [...this._usedObjectIds];
      const device = this._statefulDeviceRef();
      if (device) {
        stack.push(device.__id, device.queue.__id);
      }
      while (stack.length) {
        const id = stack.pop();
        if (reachable.has(id)) {
          continue;
        }
        const entry = this._objectRegistry.get(id);
        if (!entry) {
          continue; // transient object (e.g. an encoder created within the captured frame)
        }
        reachable.add(id);
        for (const dep of entry.deps) {
          if (!reachable.has(dep)) {
            stack.push(dep);
          }
        }
      }

      const initCommands = [];
      const initObjects = [];
      const initCommandObjects = [];
      const declared = new Set();
      for (const id of this._creationOrder) {
        if (!reachable.has(id)) {
          continue;
        }
        const entry = this._objectRegistry.get(id);
        if (!entry) {
          continue;
        }
        if (entry.type !== "GPUCanvasContext") {
          declared.add(id); // The canvas context uses the fixed variable name "context".
        }
        for (let i = 0; i < entry.lines.length; ++i) {
          initCommands.push(entry.lines[i]);
          initObjects.push(entry.lineObjects[i]);
        }
        for (const co of entry.commandObjs) {
          initCommandObjects.push(co);
        }
      }

      // Append resource-content readback for the reachable resources only.
      const readbackCount = this._readbackCommands ? this._readbackCommands.length : 0;
      for (let i = 0; i < readbackCount; ++i) {
        const obj = this._readbackObjects[i];
        if (obj && obj.__id !== undefined && !reachable.has(obj.__id)) {
          continue;
        }
        initCommands.push(this._readbackCommands[i]);
        initObjects.push(this._readbackObjects[i]);
        initCommandObjects.push(this._readbackCommandObjects[i]);
      }

      this._initializeCommands = initCommands;
      this._initializeObjects = initObjects;
      this._initializeCommandObjects = initCommandObjects;
      // Keep any variable names already promoted to the initialize scope (e.g. a resource created
      // during one captured frame and reused in a later one in a merged multi-frame recording), so
      // the generated HTML still declares them, in addition to the live registry objects.
      const promoted = this._frameVariables[-1];
      if (promoted) {
        for (const name of promoted) {
          declared.add(name);
        }
      }
      this._frameVariables[-1] = declared;
    }

    _removeUnusedCommands(objects, commands, unusedObjects, removeValue) {
      const l = objects.length;
      for (let i = l - 1; i >= 0; --i) {
        const object = objects[i];
        if (!object) {
          continue;
        }
        if (unusedObjects.has(object.__id)) {
          commands[i] = removeValue;
        }
      }
    }

    _removeUnusedCommandObjects(commandObjects, unusedObjects) {
      for (let i = commandObjects.length - 1; i >= 0; --i) {
        const cmd = commandObjects[i];
        if (!cmd) {
          continue;
        }
        // Check if the command's object or result is in the unused set
        const cmdObjectId = cmd.object;
        const cmdResultId = cmd.result;
        if (unusedObjects.has(cmdObjectId) || unusedObjects.has(cmdResultId)) {
          commandObjects[i] = null;
          continue;
        }
        // A creation command whose result is still used (cmdResultId not unused, per the check above)
        // must be kept regardless of its args: the object it builds is needed, so every resource in
        // its descriptor is needed too. The string-command pass (_removeUnusedCommands) only keys off
        // each line's own object, never its args; without this guard the binary pass would strip a
        // createBindGroup/createView whenever its descriptor referenced any object that lingered in an
        // unused set, leaving setBindGroup pointing at a bind group that was never created.
        if (this._isCreationCommandObject(cmd)) {
          continue;
        }
        // Check if any referenced objects in args are unused
        try {
          const args = JSON.parse(cmd.args);
          if (this._containsUnusedObjectId(args, unusedObjects)) {
            commandObjects[i] = null;
          }
        } catch (e) {
          // If args can't be parsed, keep the command
        }
      }
    }

    _containsUnusedObjectId(obj, unusedObjects) {
      if (!obj || typeof obj !== "object") {
        return false;
      }
      if (Array.isArray(obj)) {
        for (const item of obj) {
          if (this._containsUnusedObjectId(item, unusedObjects)) {
            return true;
          }
        }
        return false;
      }
      if (obj.__id !== undefined && unusedObjects.has(obj.__id)) {
        return true;
      }
      for (const key in obj) {
        if (this._containsUnusedObjectId(obj[key], unusedObjects)) {
          return true;
        }
      }
      return false;
    }

    _filterFrameCommands(frameIndex) {
      const commands = this._frameCommands[frameIndex];
      const objects = this._frameObjects[frameIndex];
      const newCommands = [];
      const newObjects = [];
      for (let i = 0; i < commands.length; ++i) {
        const cmd = commands[i];
        const obj = objects[i];
        if (!cmd || cmd === "\n") {
          continue;
        }
        if (this._commandUsesUsedObject(cmd)) {
          newCommands.push(cmd);
          newObjects.push(obj);
        }
      }
      this._frameCommands[frameIndex] = newCommands;
      this._frameObjects[frameIndex] = newObjects;
    }

    _filterFrameCommandObjects(frameIndex) {
      const commandObjects = this._frameCommandObjects[frameIndex];
      const newCommandObjects = [];
      for (let i = 0; i < commandObjects.length; ++i) {
        const cmd = commandObjects[i];
        if (!cmd) {
          continue;
        }
        // Check if any object id in the command is in the used objects set
        if (this._commandObjectUsesUsedObject(cmd)) {
          newCommandObjects.push(cmd);
        }
      }
      this._frameCommandObjects[frameIndex] = newCommandObjects;
    }

    _commandObjectUsesUsedObject(cmd) {
      if (!cmd) return false;
      // Check if the command's object is in the used set
      if (cmd.object && this._usedObjectIds.has(cmd.object)) {
        return true;
      }
      // Check if the created result is in the used set
      if (cmd.result && cmd.result !== "undefined" && this._usedObjectIds.has(cmd.result)) {
        return true;
      }
      // Check if any object referenced in args is in the used set
      try {
        const args = JSON.parse(cmd.args);
        if (this._containsUsedObjectId(args, this._usedObjectIds)) {
          return true;
        }
      } catch (e) {
        // If args can't be parsed, keep the command
        return true;
      }
      return false;
    }

    _containsUsedObjectId(obj, usedObjects) {
      if (!obj || typeof obj !== "object") {
        return false;
      }
      if (Array.isArray(obj)) {
        for (const item of obj) {
          if (this._containsUsedObjectId(item, usedObjects)) {
            return true;
          }
        }
        return false;
      }
      if (obj.__id !== undefined && usedObjects.has(obj.__id)) {
        return true;
      }
      for (const key in obj) {
        if (this._containsUsedObjectId(obj[key], usedObjects)) {
          return true;
        }
      }
      return false;
    }

    _commandUsesUsedObject(cmd) {
      if (!cmd) return false;
      if (cmd.indexOf("setCanvasSize") !== -1) {
        return true;
      }
      const idRegex = /x[a-zA-Z0-9_]+/g;
      let match;
      while ((match = idRegex.exec(cmd)) !== null) {
        if (this._usedObjectIds.has(match[0])) {
          return true;
        }
      }
      return false;
    }

    // True if a command object creates a persistent GPU object (createBuffer, createTexture,
    // createBindGroup, etc.). This is the command-object analogue of the `cmd.indexOf("create") &&
    // cmd.indexOf("=")` test used on the string commands: a creation command names a "create*" method
    // and assigns the result to a variable.
    _isCreationCommandObject(cmdObj) {
      return !!cmdObj && typeof cmdObj.method === "string" &&
        cmdObj.method.indexOf("create") !== -1 &&
        !!cmdObj.result && cmdObj.result !== "undefined";
    }

    // True if a string command assigns its result to a canvas-derived variable (the per-frame
    // getCurrentTexture texture or a view of it). Such creations are transient and must not be hoisted
    // into the initialize block. The assignment form is `${resultVar} = ...`.
    _isCanvasDerivedLine(cmd) {
      if (this._canvasObjectIds.size === 0) {
        return false;
      }
      const eq = cmd.indexOf("=");
      if (eq === -1) {
        return false;
      }
      const resultVar = cmd.slice(0, eq).trim();
      return this._canvasObjectIds.has(resultVar);
    }

    _filterInitializeCommands() {
      const navigatorGpuId = navigator.gpu.__id;

      // The string commands and command objects are not index-aligned (see the note in
      // generateOutput), so each list is filtered independently with the test appropriate to its
      // representation rather than paired by index.
      const newCommands = [];
      const newObjects = [];
      for (let i = 0; i < this._initializeCommands.length; ++i) {
        const cmd = this._initializeCommands[i];
        const obj = this._initializeObjects[i];
        if (!cmd || cmd === "\n") {
          continue;
        }
        // Always keep GPU object creation commands (createBuffer, createTexture, createBindGroup, etc.)
        // These are needed for the frame to execute, regardless of _usedObjectIds
        if (cmd.indexOf("create") !== -1 && cmd.indexOf("=") !== -1) {
          newCommands.push(cmd);
          newObjects.push(obj);
        } else if (this.recordSingleFrame && navigatorGpuId && cmd.indexOf(navigatorGpuId) !== -1) {
          newCommands.push(cmd);
          newObjects.push(obj);
        } else if (this._commandUsesUsedObject(cmd)) {
          newCommands.push(cmd);
          newObjects.push(obj);
        }
      }
      this._initializeCommands = newCommands;
      this._initializeObjects = newObjects;

      const newCommandObjects = [];
      for (let i = 0; i < this._initializeCommandObjects.length; ++i) {
        const cmdObj = this._initializeCommandObjects[i];
        if (!cmdObj) {
          continue;
        }
        // Always keep object creation commands, mirroring the string-command branch above.
        if (this._isCreationCommandObject(cmdObj)) {
          newCommandObjects.push(cmdObj);
        } else if (this._commandObjectUsesUsedObject(cmdObj)) {
          // Covers both the navigator.gpu special case (its id is in _usedObjectIds in single-frame
          // mode) and any command referencing a used object.
          newCommandObjects.push(cmdObj);
        }
      }
      this._initializeCommandObjects = newCommandObjects;
    }


    _reorderFrameCommands(frameIndex) {
      const frameCommands = this._frameCommands[frameIndex].filter((cmd) => cmd && cmd !== "\n");
      const cmdObjects = this._frameCommandObjects[frameIndex];
      const numCommands = frameCommands.length;

      let queue = null;
      for (let i = 0; i < numCommands; i++) {
        const cmd = frameCommands[i];
        if (cmd.indexOf(".submit(") !== -1) {
          queue = cmdObjects[i].object;
          break;
        }
      }
      if (!queue) {
        queue = "xQueue7"; // Fallback to the first queue object.
      }

      const commandEncoders = [];
      for (let i = 0; i < numCommands; i++) {
        const cmd = frameCommands[i];
        if (cmd.indexOf("createCommandEncoder") !== -1) {
          const encoder = cmdObjects[i].result;
          let cmds = [cmd];
          commandEncoders.push({cmd, encoder, commands: cmds});
          _addCommandEncoderCommands(i + 1, encoder, cmds);

          for (const cmd2 of cmds) {
            if (cmd2.indexOf(".finish()") !== -1) {
              for (let j = 0; j < numCommands; j++) {
                if (cmd2 === frameCommands[j]) {
                  const result = cmdObjects[j]?.result;
                  cmds.push(`${queue}.submit([${result}]);`);
                  break;
                }
              }
              break;
            }
          }
        }
      }

      const encoderCommands = [];
      for (let i = 0; i < commandEncoders.length; i++) {
        const ce = commandEncoders[i];
        encoderCommands.push(...ce.commands);
        encoderCommands.push("\n");
      }

      const reorderedCommands = [];
      for (let i = 0; i < numCommands; i++) {
        const cmd = frameCommands[i];
        if (cmd.indexOf("submit") === -1 && encoderCommands.indexOf(cmd) === -1) {
          reorderedCommands.push(cmd);
        }
      }
      reorderedCommands.push("\n");
      reorderedCommands.push(...encoderCommands);

      this._frameCommands[frameIndex] = reorderedCommands;
    }

    generateOutput() {
      const unusedObjects = new Set();
      // In continuous stateful mode, or while more target frames are still pending, keep recording so
      // the live object registry stays current for the next capture; otherwise stop after this output.
      if (!(this._stateful && (this.config.continuous || this._captureTargetFrames.size > 0))) {
        this._isRecording = false;
      }

      // Show a spinning busy indicator while the recording data is generated, streamed to the
      // inspector, and downloaded.
      this._setOverlayBusy();

      if (this.recordSingleFrame) {
        const lastFrameIndex = this._frameCommands.length - 1;
        // Collect GPU object creation commands from all frames and move to initialize block.
        // The string commands (_frameCommands, consumed by the HTML output) and the command objects
        // (_frameCommandObjects, consumed by the binary/message output) are NOT index-aligned: a
        // single recorded command can emit several string lines (the "\n" pass separators, the
        // requiredFeatures/requiredLimits blocks, the empty submit line, setCanvasSize) but only one
        // command object. So each representation must be scanned independently with its own creation
        // test, never paired by index, otherwise the binary output collects the wrong objects (e.g. a
        // setBindGroup instead of the createBindGroup, leaving the bind group's creation missing).
        for (let fi = 0; fi <= lastFrameIndex; fi++) {
          const commands = this._frameCommands[fi] || [];
          const objects = this._frameObjects[fi] || [];
          for (let i = 0; i < commands.length; ++i) {
            const cmd = commands[i];
            if (!cmd || cmd === "\n") {
              continue;
            }
            // Check if this is a GPU object creation command (contains "create")
            if (cmd.indexOf("create") !== -1 && cmd.indexOf("=") !== -1 && !this._isCanvasDerivedLine(cmd)) {
              this._initializeCommands.push(cmd);
              this._initializeObjects.push(objects[i] || null);
            }
          }
          const commandObjs = this._frameCommandObjects[fi] || [];
          for (let i = 0; i < commandObjs.length; ++i) {
            const cmdObj = commandObjs[i];
            if (this._isCreationCommandObject(cmdObj) && !this._canvasObjectIds.has(cmdObj.result)) {
              this._initializeCommandObjects.push(cmdObj);
            }
          }
        }
        // Now keep only the last frame
        this._frameCommands = [this._frameCommands[lastFrameIndex]];
        this._frameObjects = [this._frameObjects[lastFrameIndex]];
        this._frameCommandObjects = [this._frameCommandObjects[lastFrameIndex]];
        this._filterInitializeCommands();
        // Also filter frame commands for single-frame mode
        if (this._usedObjectIds.size > 0) {
          this._filterFrameCommands(0);
          this._filterFrameCommandObjects(0);
        }
      }

      if (this.config.removeUnusedResources) {
        for (const object of this._unusedTextures) {
          unusedObjects.add(object);
        }
        for (const [key, value] of this._unusedTextureViews) {
          unusedObjects.add(key);
        }
        for (const object of this._unusedBuffers) {
          unusedObjects.add(object);
        }
        for (const object of this._unusedBindGroups) {
          unusedObjects.add(object);
        }

        this._removeUnusedCommands(this._initializeObjects, this._initializeCommands, unusedObjects, "");
        // Also filter command objects by unused resources
        this._removeUnusedCommandObjects(this._initializeCommandObjects, unusedObjects);
        for (let i = 0; i < this._frameCommandObjects.length; ++i) {
          this._removeUnusedCommandObjects(this._frameCommandObjects[i], unusedObjects);
        }
      }

      this._initializeCommands = this._initializeCommands.filter((cmd) => !!cmd);

      const wantHtml = this.config.output === "html" || this.config.output === "both";
      const wantBinary = this.config.output === "binary" || this.config.output === "both";

      const self = this;
      Promise.all(this._externalImageBufferPromises).then(async () => {
        self._externalImageBufferPromises.length = 0;

        // Build unified binary data once (consolidates all data handling)
        const binaryData = self._buildUnifiedBinaryData();
        const exportName = self.config.exportName || "WebGpuRecord";

        // Download binary if needed
        if (wantBinary) {
          self._downloadBinary(self._serializeBinaryContainer(binaryData), exportName + ".wgpu");
        }

        // Stream the recording to any connected viewer (e.g. the inspector's recorder panel). This is
        // independent of the output format, so a binary-only recording still updates the viewer.
        if (self.config.messageRecording) {
          await self._sendRecordingMessages(binaryData);
        }

        // Generate and download HTML if needed
        if (wantHtml) {
          const html = await self._generateHtmlFromBinaryData(binaryData);
          self._downloadFile(html, exportName + ".html");
        }

        self._afterStatefulOutput();

        // If recording is fully finished (not continuous stateful mode and no pending target frames),
        // detach from WebGPU entirely so no further overhead is imposed on the page and remove the
        // overlay. Otherwise the recorder stays attached for the next capture.
        if (!self._isRecording) {
          self._detach();
        }
      });
    }

    // After an output is produced: in stateful mode, re-arm for the next pending/triggered capture
    // (keeping the live registry), or clear the exporting flag.
    _afterStatefulOutput() {
      if (!this._stateful) {
        return;
      }
      if (this.config.continuous || this._captureTargetFrames.size > 0) {
        this._rearmAfterCapture();
        this._setOverlayRecording();
      } else {
        this._exporting = false;
      }
    }

    // Download an ArrayBuffer as a .wgpu file (page) or post it to the main thread (worker).
    _downloadBinary(buffer, filename) {
      if (!this.config.download) {
        return;
      }
      if (_document) {
        webgpu_recorder_download_binary(buffer, filename);
      } else {
        _postMessage({ type: "webgpu_record_download_binary", data: buffer, filename }, [buffer]);
      }
    }



    async _encodeDataUrl(a, type = "application/octet-stream") {
      const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
      return await new Promise((resolve, reject) => {
        const reader = Object.assign(new FileReader(), {
          onload: () => resolve(reader.result),
          onerror: () => reject(reader.error),
        });
        reader.readAsDataURL(new File([bytes], "", { type }));
      });
    }

    _dispatchEvent(message) {
      message.__webgpuRecorder = true;
      message.__webgpuRecorderPage = true;
      message.__webgpuRecorderWorker = !_document;
      if (_document) {
        _dispatchEvent(new CustomEvent("__WebGPURecorder", { detail: message }));
      } else {
        _postMessage(message);
      }
    }

    _downloadFile(data, filename) {
      if (this.config.download) {
        if (_document) {
          webgpu_recorder_download_data(data, filename);
        } else {
          _postMessage({ type: "webgpu_record_download", data, filename });
        }
      }
    }

    // Stream the recording (commands + data) to a connected viewer via the messageRecording channel.
    // Driven from the unified binary data so it runs for any output format, including binary-only.
    // Each referenced data slot is sent as its own data-URL slice, matching the per-blob layout the
    // viewer reconstructs when loading a .wgpu file.
    async _sendRecordingMessages(binaryData) {
      this._encodedData = [];
      for (let i = 0; i < binaryData.dataTable.length; ++i) {
        const entry = binaryData.dataTable[i];
        if (!entry || entry.type === "" || !entry.length) {
          continue;
        }
        const slice = binaryData.rawDataBlob.subarray(entry.offset, entry.offset + entry.length);
        this._encodedData[i] = await this._encodeDataUrl(slice);
      }

      this._initializeCommandObjects = this._initializeCommandObjects.filter((value) => !!value);
      let count = this._initializeCommandObjects.length;
      for (let i = 0; i < this._frameCommandObjects.length; ++i) {
        this._frameCommandObjects[i] = this._frameCommandObjects[i].filter((value) => !!value);
        count += this._frameCommandObjects[i].length;
      }

      this._dispatchEvent({ action: "webgpu_record_data_count", count: this._arrayCache.length });

      let index = 0;
      let frame = -1;
      const action = "webgpu_record_command";
      for (let i = 0; i < this._initializeCommandObjects.length; ++i) {
        const command = this._initializeCommandObjects[i];
        this._dispatchEvent({ action, command, commandIndex: i, frame, index, count });
        index++;
      }

      for (frame = 0; frame < this._frameCommandObjects.length; ++frame) {
        const commands = this._frameCommandObjects[frame];
        for (let j = 0; j < commands.length; ++j) {
          const command = commands[j];
          this._dispatchEvent({ action, command, commandIndex: j, frame, index, count });
          index++;
        }
      }

      {
        const dataCount = this._arrayCache.length;
        const dataAction = "webgpu_record_data";
        for (let i = 0; i < dataCount; ++i) {
          const a = this._arrayCache[i];
          this._dispatchEvent({ action: dataAction, data: this._encodedData[i], type: a.type, size: a.length, index: i, count: dataCount });
        }
      }

      this._encodedData.length = 0;
    }

    _collectObjectIds(obj, visited = new Set()) {
      if (!obj || typeof obj !== "object") {
        return;
      }
      if (visited.has(obj)) {
        return;
      }
      visited.add(obj);
      if (obj.__id) {
        this._usedObjectIds.add(obj.__id);
      }
      for (const key in obj) {
        const value = obj[key];
        if (value && typeof value === "object") {
          this._collectObjectIds(value, visited);
        }
      }
    }

    _wrapCanvas(c) {
      if (c.__id) {
        return;
      }
      this._registerObject(c);
      let self = this;
      let __getContext = c.getContext;
      this._wrappedCanvases.push({ canvas: c, getContext: __getContext });
      c.getContext = function (a1, a2) {
        let ret = __getContext.call(c, a1, a2);
        if (a1 === "webgpu") {
          if (ret) {
            self._wrapContext(ret);
          }
        }
        return ret;
      };
    }

    _wrapCanvases() {
      if (_document) {
        const canvases = _document.getElementsByTagName("canvas");
        for (let i = 0; i < canvases.length; ++i) {
          const c = canvases[i];
          this._wrapCanvas(c);
        }
      }
    }

    _registerObject(object) {
      const label = `x${object?.label?.replace(/\W/g, "_") ?? ''}${object.constructor.name.replace(/^GPU/, "")}`;
      const count = this._labelCounts.get(label) ?? 0;
      this._labelCounts.set(label, count + 1);
      const id = `${label}${count > 0 ? count : ""}`;
      object.__id = id;
      object.__frame = this._frameIndex;
    }

    _isFrameVariable(frame, name) {
      return this._frameVariables[frame] && this._frameVariables[frame].has(name);
    }

    _removeVariable(name) {
      for (const f in this._frameVariables) {
        const fs = this._frameVariables[f];
        fs.delete(name);
      }
    }

    _addVariable(frame, name) {
      this._frameVariables[frame].add(name);
    }

    _getVariableDeclarations(frame) {
      const s = this._frameVariables[frame];
      if (!s.size) {
        return "";
      }
      return `let ${[...s].join(",")};`;
    }

    _getObjectVariable(object) {
      if (!object) {
        return undefined;
      }

      if (object instanceof GPUCanvasContext) {
        return "context";
      }

      if (object.__id === undefined) {
        this._registerObject(object);
      }

      const name = `${(object.__id || 0)}`;

      if (this._frameIndex != object.__frame) {
        if (!this._isFrameVariable(-1, name)) {
          this._removeVariable(name);
          this._addVariable(-1, name);
        }
      } else {
        this._addVariable(this._frameIndex, name);
      }

      return name;
    }

    _wrapContext(ctx) {
      const line = `${this._getObjectVariable(ctx)} = canvas.getContext("webgpu");`;
      if (this._stateful) {
        // Track the canvas context as a persistent object so it (and its configure state) is
        // reconstructed when an arbitrary frame is captured. _getObjectVariable returns the fixed
        // name "context" for a context without assigning it an id, so register it explicitly to key
        // the registry entry.
        if (ctx.__id === undefined) {
          this._registerObject(ctx);
        }
        const entry = this._statefulCreateEntry(ctx);
        if (entry.lines.length === 0) {
          entry.lines.push(line);
          entry.lineObjects.push(null);
        }
        return;
      }
      this._recordLine(line, null);
    }

    _onAsyncResolve(object, method, args, id, result) {
      if (!this._isRecording) {
        return;
      }
      if (method === "requestDevice") {
        const adapter = object;
        if (adapter.__id === undefined) {
          this._recordCommand(true, navigator.gpu, "requestAdapter", adapter, []);
        }
        result.queue.__device = result; // Add a reference to the device on the queue object.
        if (this._stateful) {
          // Remember a device so resource contents can be read back at capture time.
          this._statefulDevice = (typeof WeakRef !== "undefined") ? new WeakRef(result) : result;
        }
      }

      // In stateful mode before the captured frame, only persistent object/state commands are
      // tracked; transient commands are reconstructed by readback at capture time.
      if (this._stateful && !this._isCapturingFrame && !this._isPersistentMethod(method)) {
        return;
      }

      this._recordCommand(true, object, method, result, args);
    }

    _preMethodCall(object, method, args) {
      if (!this._isRecording) {
        return;
      }
      // We can"t track every change made to a mappedRange buffer since that all happens 
      // outside the scope of what WebGPU is in control of. So we keep track of all the
      // mapped buffer ranges, and when unmap is called, we record the content of their data
      // so that they have their correct data for the unmap.
      // In stateful mode, host writes and per-frame transient commands made before the captured
      // frame are not logged: the resource-content readback at capture time reconstructs the data,
      // and per-frame state is re-established by the captured frame itself.
      const statefulPreCapture = this._stateful && !this._isCapturingFrame;

      if (method === "unmap") {
        if (object.__mappedRanges) {
          if (!statefulPreCapture) {
            for (const buffer of object.__mappedRanges) {
              // Make a copy of the mappedRange buffer data as it is when unmap
              // is called.
              const cacheIndex = this._getDataCache(buffer, 0, buffer.byteLength, buffer);
              // Set the mappedRange buffer data in the recording to what is in the buffer
              // at the time unmap is called.
              this._recordLine(`new Uint8Array(${this._getObjectVariable(buffer)}).set(${this._getDataVariable(cacheIndex)});`, object);
              this._recordCommand("", buffer, "__writeData", null, [cacheIndex], true);
            }
          }
          delete object.__mappedRanges;
        }
      } else if (method === "getCurrentTexture") {
        if (!statefulPreCapture) {
          this._recordLine(`setCanvasSize(${this._getObjectVariable(object)}.canvas, ${object.canvas.width}, ${object.canvas.height})`, object);
          this._recordCommand("", object, "__setCanvasSize", null, [object.canvas.width, object.canvas.height], true);
        }
      } else if (method === "createTexture") {
        args[0].usage |= GPUTextureUsage.COPY_SRC;
        // For stateful capture, also add COPY_DST so writeTexture can initialize texture contents
        if (this._stateful) {
          args[0].usage |= GPUTextureUsage.COPY_DST;
        }
      } else if (method === "createBuffer") {
        // For stateful capture, force COPY_SRC so the buffer's contents can be read back at capture
        // time. MAP_READ may only be combined with COPY_DST, so those buffers can't be made readable
        // this way (MAP_READ staging buffers never hold persistent render state worth reconstructing).
        if (this._stateful) {
          const usage = args[0]?.usage ?? 0;
          if (!(usage & GPUBufferUsage.MAP_READ)) {
            args[0].usage = usage | GPUBufferUsage.COPY_SRC;
          }
        }
      }
    }

    _onMethodCall(object, method, args, result) {
      if (!this._isRecording) {
        return;
      }

      // A frame "counts" only if it submitted GPU work; this lets stateful capture skip empty
      // (non-rendering) rAF ticks when choosing which frame to capture.
      if (this._stateful && method === "submit") {
        this._frameDidRender = true;
      }

      if (method === "destroy") {
        this._unusedBuffers.delete(object.__id);
        this._unusedTextures.delete(object.__id);
        this._unusedBindGroups.delete(object.__id);
        if (this._stateful && object.__id !== undefined) {
          this._statefulMarkDestroyed(object.__id);
        }
      }

      // In stateful mode before the captured frame, only persistent object/state commands update the
      // registry; transient and data-write commands are reconstructed by readback at capture time.
      if (this._stateful && !this._isCapturingFrame) {
        if (this._isPersistentMethod(method)) {
          this._recordCommand(false, object, method, result, args);
        }
        return;
      }

      if (method === "copyExternalImageToTexture") {
        const queue = object;

        // copyExternalImageToTexture uses ImageBitmap (or canvas or offscreenCanvas) as
        // its source, which we can"t record. Convert copyExternalImageToTexture to
        // writeTexture, and record the bytes from the ImageBitmap. To do that, we need
        // to inject a `createBuffer`, `copyTextureToBuffer`, `mapAsync` to record the bytes from the texture.
        // This means the data in the data cache will be pending the async map resolve. Make a slot for the data
        // in the data cache, and fill it in when the map resolves. Keep track of all pending promises
        // and resolve them before generating the recording data.
        // The reason we can't just draw the ImageBitmap to a canvas and then copy that to a texture is because
        // that would only work for RGBA8 textures, and ImageBitmap can be 16-bit or other formats.
        const texture = args[1]["texture"];
        const format = texture.format;
        const formatInfo = WebGPURecorder._formatInfo[format];
        const bytesPerPixel = formatInfo ? formatInfo.bytesPerBlock : 4;
        const width = args[0].source.width;
        const bytesPerRow = (width * bytesPerPixel + 255) & ~0xff;
        const rowsPerImage = args[0].source.height;
        const size = bytesPerRow * rowsPerImage;
        const copySize = args[2];

        this._gpuWrapper.skipRecord++;

        const device = queue.__device;
        const buffer = device.createBuffer({ size, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });

        const commandEncoder = device.createCommandEncoder();
        commandEncoder.copyTextureToBuffer({ texture: args[1].texture }, { buffer, bytesPerRow, rowsPerImage }, copySize);
        queue.submit([commandEncoder.finish()]);

        this._gpuWrapper.skipRecord--;

        let cacheIndex = -1;
        try {
          const bytes = new Uint8Array(size);
          cacheIndex = this._getDataCache(bytes, 0, size, texture, false);
          const textureSize = Array.isArray(copySize) ? this._stringifyArray(copySize) : this._stringifyObject(method, copySize);
          this._recordLine(`${this._getObjectVariable(queue)}.writeTexture(${this._stringifyObject(method, args[1])}, ${this._getDataVariable(cacheIndex)}, {bytesPerRow:${bytesPerRow}}, ${textureSize});`, object);
          this._recordCommand(false, queue, "__writeTexture", null, [args[1], { __data: cacheIndex }, { bytesPerRow }, copySize], true);
        } catch (e) {
          console.error(e.message);
        }

        const self = this;
        const promise = new Promise((resolve) => {
          self._gpuWrapper.skipRecord++;
          buffer.mapAsync(GPUMapMode.READ).then(() => {
            self._gpuWrapper.skipRecord++;
            const range = buffer.getMappedRange();
            const bufferData = new Uint8Array(range);
            self._replaceDataCache(cacheIndex, bufferData, 0, bufferData.length);
            buffer.unmap();
            self._gpuWrapper.skipRecord--;
            resolve();
          });
          this._gpuWrapper.skipRecord--;
        });
        this._externalImageBufferPromises.push(promise);
      } else {
        this._recordCommand(false, object, method, result, args);
      }

      if (method === "getMappedRange") {
        // Keep track of the mapped ranges for the buffer object. The recording will set their
        // data when unmap is called.
        if (!object.__mappedRanges) {
          object.__mappedRanges = [];
        }
        object.__mappedRanges.push(result);
      } else if (method === "submit") {
        // just to give the file some structure
        this._recordLine("", null);
      }
    }

    _stringifyObject(method, object, toJson) {
      let s = "";
      let first = true;
      for (const key in object) {
        let value = object[key];
        if (key.startsWith("_")) {
          continue;
        }
        if (value instanceof Function) {
          continue;
        }
        if (value === undefined) {
          continue;
        }
        if (!first) {
          s += ",";
        }
        first = false;
        s += `"${key}":`;
        if (method === "requestDevice" && this._adapter) {
          if (key === "requiredFeatures") {
            s += "requiredFeatures";
            continue;
          } else if (key === "requiredLimits") {
            s += "requiredLimits";
            continue;
          }
        }
        if (method === "createBindGroup") {
          if (key === "resource") {
            if (this._unusedTextureViews.has(value.__id)) {
              const texture = this._unusedTextureViews.get(value.__id);
              this._unusedTextures.delete(texture);
              this._unusedTextureViews.delete(value.__id);
            }
            this._unusedBuffers.delete(value.__id);
            this._unusedTextures.delete(value.__id);
          } else if (key === "buffer") {
            const buffer = value;
            if (this._unusedBuffers.has(buffer.__id)) {
              this._unusedBuffers.delete(buffer.__id);
            }
          }
        } else if (method === "beginRenderPass") {
          if (key === "colorAttachments") {
            for (const desc of value) {
              if (desc["view"]) {
                const view = desc["view"];
                if (this._unusedTextureViews.has(view.__id)) {
                  const texture = this._unusedTextureViews.get(view.__id);
                  this._unusedTextures.delete(texture);
                  this._unusedTextureViews.delete(view.__id);
                }
                if (this._unusedTextures.has(view.__id)) {
                  this._unusedTextures.delete(view.__id);
                }
              }
              if (desc["resolveTarget"]) {
                const view = desc["resolveTarget"];
                if (this._unusedTextureViews.has(view.__id)) {
                  const texture = this._unusedTextureViews.get(view.__id);
                  this._unusedTextures.delete(texture);
                  this._unusedTextureViews.delete(view.__id);
                }
                if (this._unusedTextures.has(view.__id)) {
                  this._unusedTextures.delete(view.__id);
                }
              }
            }
          } else if (key === "depthStencilAttachment") {
            if (value["view"]) {
              const view = value["view"];
              if (this._unusedTextureViews.has(view.__id)) {
                const texture = this._unusedTextureViews.get(view.__id);
                this._unusedTextures.delete(texture);
                this._unusedTextureViews.delete(view.__id);
              }
              if (this._unusedTextures.has(view.__id)) {
                this._unusedTextures.delete(view.__id);
              }
            }
          }
        }
        if (value === null) {
          s += "null";
        } else if (typeof (value) === "string") {
          if (!toJson && method === "createShaderModule") {
            const escaped = value.replaceAll('`', '\\`');
            s += `\`${escaped}\``;
          } else {
            s += JSON.stringify(value);
          }
        } else if (value.__id !== undefined) {
          if (toJson) {
            s += `{ "__id":"${this._getObjectVariable(value)}" }`;
          } else {
            s += this._getObjectVariable(value);
          }
        } else if (value.__data !== undefined) {
          if (toJson) {
            s += `{ "__data": ${value.__data} }`;
          } else {
            s += this._getDataVariable(value.__data);
          }
        } else if (Array.isArray(value)) {
          s += this._stringifyArray(value, toJson);
        } else if (typeof (value) === "object") {
          s += this._stringifyObject(method, value, toJson);
        } else {
          s += `${value}`;
        }
      }
      s = `{${s}}`;
      return s;
    }

    _stringifyArray(a, toJson) {
      let s = "[";
      s += this._stringifyArgs("", a, toJson);
      s += "]";
      return s;
    }

    _heapAccessShiftForWebGPUHeap(heap) {
      if (!heap.BYTES_PER_ELEMENT) {
        return 0;
      }
      return 31 - Math.clz32(heap.BYTES_PER_ELEMENT);
    }

    _replaceDataCache(index, heap, offset, length) {
      const byteOffset = (heap.byteOffset ?? 0) + ((offset ?? 0) << this._heapAccessShiftForWebGPUHeap(heap));
      const byteLength = length === undefined ? heap.byteLength : (length << this._heapAccessShiftForWebGPUHeap(heap));

      this._totalData += byteLength;
      const view = new Uint8Array(heap.buffer ?? heap, byteOffset, byteLength);

      const arrayCopy = Uint8Array.from(view);
      
      const cache = this._arrayCache[index];
      cache.length = byteLength;
      cache.type = heap.constructor === ArrayBuffer ? "Uint8Array" : heap.constructor.name,
      cache.array = arrayCopy;
    }

    _compareCacheData(a, b) {
      if (a.length !== b.length) {
        return false;
      }

      if (a.length === 0) {
        return true;
      }

      if ((a.length & 3) === 0) {
        const a32 = new Uint32Array(a.buffer, a.byteOffset, a.length / 4);
        const b32 = new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
        for (let i = 0, l = a32.length; i < l; ++i) {
          if (a32[i] !== b32[i]) {
            return false;
          }
        }
        return true;
      }

      for (let i = 0, l = a.length; i < l; ++i) {
        if (a[i] != b[i]) {
          return false;
        }
      }
      return true;
    }

    _getDataVariable(index) {
      const cache = this._arrayCache[index];
      if (!cache) {
        return "null";
      }
      if (cache.frame < 0) {
        return `D_F_1_${cache.index}`;
      }
      return `D_F${cache.frame}_${cache.index}`;
    }

    _getDataCache(heap, offset, length, object, skipCompare) {
      let cacheIndex = -1;
      const frameIndex = this._frameIndex ?? -1;

      if (!skipCompare) {
        const byteOffset = (heap.byteOffset ?? 0) + ((offset ?? 0) << this._heapAccessShiftForWebGPUHeap(heap));
        const byteLength = length === undefined ? heap.byteLength : (length << this._heapAccessShiftForWebGPUHeap(heap));

        this._totalData += byteLength;
        const view = new Uint8Array(heap.buffer ?? heap, byteOffset, byteLength);

        for (let ai = 0; ai < this._arrayCache.length; ++ai) {
          const c = this._arrayCache[ai];
          if (this._compareCacheData(c.array, view)) {
            cacheIndex = ai;
            break;
          }
        }

        if (cacheIndex === -1) {
          this._frameDataCount[frameIndex] = (this._frameDataCount[frameIndex] || 0) + 1;

          cacheIndex = this._arrayCache.length;
          const arrayCopy = Uint8Array.from(view);
          const cache = {
            frame: frameIndex,
            index: this._frameDataCount[frameIndex],
            length: byteLength,
            type: heap.constructor === ArrayBuffer ? "Uint8Array" : heap.constructor.name,
            array: arrayCopy
          };
          this._arrayCache.push(cache);
        }
      } else {
        this._frameDataCount[frameIndex] = (this._frameDataCount[frameIndex] || 0) + 1;

        cacheIndex = this._arrayCache.length;
        const array = heap;
        this._arrayCache.push({
          frame: frameIndex,
          index: this._frameDataCount[frameIndex],
          length,
          type: heap.constructor === ArrayBuffer ? "Uint8Array" : heap.constructor.name,
          array
        });
      }

      if (object) {
        if (!this._dataCacheObjects[cacheIndex]) {
          this._dataCacheObjects[cacheIndex] = [];
        }
        this._dataCacheObjects[cacheIndex].push(object);
      }

      return cacheIndex;
    }

    _processArgs(method, args) {
      args = [...args];

      // In order to capture buffer data, we need to know the offset and size of the data,
      // which are arguments of specific methods. So we need to special case those methods to
      // properly capture the buffer data passed to them.
      if (method === "writeBuffer") {
        const buffer = args[2];
        const offset = args[3];
        const size = args[4];
        const cacheIndex = this._getDataCache(buffer, offset, size, buffer);
        args[2] = { __data: cacheIndex };
        args[3] = 0;
      } else if (method === "writeTexture") {
        const texture = args[0].texture;
        const buffer = args[1];
        const bytesPerRow = args[2].bytesPerRow;
        const width = args[3].width || args[3][0];
        const formatInfo = WebGPURecorder._formatInfo[texture.format] || { blockWidth: 1, blockHeight: 1, bytesPerBlock: 4 };
        const { blockWidth, blockHeight, bytesPerBlock } = formatInfo;
        const widthInBlocks = width / blockWidth;
        const rows = args[2].rowsPerImage || (args[3].height || args[3][1] || 1) / blockHeight;
        const layers = args[3].depthOrArrayLayers || args[3][2] || 1;
        const totalRows = rows * layers;
        const size = totalRows > 0
          ? bytesPerRow * (totalRows - 1) + widthInBlocks * bytesPerBlock
          : 0;
        const offset = args[2].offset;
        // offset is in bytes but source can be any TypedArray
        // getDataCache assumes offset is in TypedArray.BYTES_PER_ELEMENT size
        // so view the data as bytes.
        const cacheIndex = this._getDataCache(new Uint8Array(buffer.buffer || buffer, buffer.byteOffset, buffer.byteLength), offset, size, texture);
        args[1] = { __data: cacheIndex };
        args[2] = { offset: 0, bytesPerRow: args[2].bytesPerRow, rowsPerImage: args[2].rowsPerImage };
      } else if (method === "setBindGroup") {
        if (args.length === 5) {
          const buffer = args[2];
          const offset = args[3];
          const size = args[4];
          const offsets = this._getDataCache(buffer, offset, size, buffer);
          args[2] = { __data: offsets };
          args.length = 3;
        } else if (args.length === 3 && args[2]?.length) {
          const buffer = args[2];
          const offsets = this._getDataCache(buffer, 0, buffer.length, buffer);
          args[2] = { __data: offsets };
          args.length = 3;
        }
        const bindGroup = args[1];
        if (bindGroup && bindGroup.__id && this._unusedBindGroups.has(bindGroup.__id)) {
          this._unusedBindGroups.delete(bindGroup.__id);
        }
      } else if (method === "createBindGroup") {
        if (args[0]["entries"]) {
          const entries = args[0]["entries"];
          for (const entry of entries) {
            const value = entry["resource"];
            if (value && value.__id) {
              if (this._unusedTextureViews.has(value.__id)) {
                const texture = this._unusedTextureViews.get(value.__id);
                this._unusedTextures.delete(texture);
                // The view is now used by this bind group; drop it from the unused-view map so its
                // id isn't collected into unusedObjects (which would make removeUnusedResources strip
                // the createView/createBindGroup command objects from the binary recording, leaving
                // setBindGroup referencing a bind group that was never created). Mirrors the
                // beginRenderPass branch below.
                this._unusedTextureViews.delete(value.__id);
              }
              this._unusedTextures.delete(value.__id);
              this._unusedBuffers.delete(value.__id);
            } else if (value && value["buffer"]) {
              const buffer = value["buffer"];
              if (this._unusedBuffers.has(buffer.__id)) {
                this._unusedBuffers.delete(buffer.__id);
              }
            }
          }
        }
      } else if (method === "copyBufferToTexture") {
        const buffer = args[0].buffer;
        this._unusedBuffers.delete(buffer.__id);
        const texture = args[1].texture;
        this._unusedTextures.delete(texture.__id);
      } else if (method === "copyTextureToBuffer") {
        const texture = args[0].texture;
        this._unusedTextures.delete(texture.__id);
        const buffer = args[1].buffer;
        this._unusedBuffers.delete(buffer.__id);
      } else if (method === "copyBufferToBuffer") {
        this._unusedBuffers.delete(args[0].__id);
        this._unusedBuffers.delete(args[2].__id);
      } else if (method === "setVertexBuffer") {
        const buffer = args[1];
        this._unusedBuffers.delete(buffer.__id);
      } else if (method === "setIndexBuffer") {
        const buffer = args[0];
        this._unusedBuffers.delete(buffer.__id);
      } else if (method === "beginRenderPass") {
        if (args[0]["colorAttachments"]) {
          const value = args[0]["colorAttachments"];
          for (const desc of value) {
            if (desc["view"]) {
              const view = desc["view"];
              if (this._unusedTextureViews.has(view.__id)) {
                const texture = this._unusedTextureViews.get(view.__id);
                this._unusedTextures.delete(texture);
                this._unusedTextureViews.delete(view.__id);
              }
            }
          }
        }
        if (args[0]["depthStencilAttachment"]) {
          const value = args[0]["depthStencilAttachment"];
          if (value["view"]) {
            const view = value["view"];
            if (this._unusedTextureViews.has(view.__id)) {
              const texture = this._unusedTextureViews.get(view.__id);
              this._unusedTextures.delete(texture);
              this._unusedTextureViews.delete(view.__id);
            }
          }
        }
      }
      return args;
    }

    _stringifyArgs(method, args, toJson) {
      if (args.length === 0 || (args.length === 1 && args[0] === undefined)) {
        return "";
      }

      args = this._processArgs(method, args);

      const argStrings = [];
      for (const a of args) {
        if (a === undefined) {
          if (!toJson) {
            argStrings.push("undefined");
          }
        } else if (a === null) {
          argStrings.push("null");
        } else if (a.__data !== undefined) {
          if (toJson) {
            argStrings.push(`{ "__data": ${a.__data} }`); // This is a captured data buffer.
          } else {
            argStrings.push(this._getDataVariable(a.__data));
          }
        } else if (a.__id) {
          if (toJson) {
            argStrings.push(`{ "__id": "${this._getObjectVariable(a)}" }`);
          } else {
            argStrings.push(this._getObjectVariable(a));
          }
        } else if (a.buffer instanceof ArrayBuffer) {
          argStrings.push(this._stringifyArray([...a], toJson));
        } else if (Array.isArray(a)) {
          argStrings.push(this._stringifyArray(a, toJson));
        } else if (typeof (a) === "object") {
          argStrings.push(this._stringifyObject(method, a, toJson));
        } else if (typeof (a) === "string") {
          if (!toJson && method === "createShaderModule") {
            argStrings.push(`\`${a}\``);
          } else {
            argStrings.push(JSON.stringify(a));
          }
        } else {
          argStrings.push(a);
        }
      }
      return argStrings.join();
    }

    _recordLine(line, object) {
      if (this._isRecording) {
        if (this._frameIndex === -1) {
          this._initializeCommands.push(line);
          this._initializeObjects.push(object);
        } else {
          this._currentFrameCommands.push(line);
          this._currentFrameObjects.push(object);
        }
      }
    }

    _recordCommand(async, object, method, result, args, skipLine) {
      if (!this._isRecording) {
        return;
      }

      if (result) {
        if (typeof (result) === "string") {
          return;
        }

        if (result.__id === undefined) {
          this._registerObject(result);
        }
      }

      if (this.recordSingleFrame || (this._stateful && this._isCapturingFrame)) {
        if (object && object.__id) {
          this._usedObjectIds.add(object.__id);
        }
        if (result && result.__id) {
          this._usedObjectIds.add(result.__id);
        }
        for (const arg of args) {
          if (arg && arg.__id) {
            this._usedObjectIds.add(arg.__id);
          } else if (arg && typeof arg === "object") {
            this._collectObjectIds(arg);
          }
        }
      }

      // Stateful pre-capture: redirect this command's recorded output onto the owning object's
      // registry entry (instead of the flat initialize log) by temporarily swapping the init arrays.
      let _savedInit = null;
      if (this._stateful && !this._isCapturingFrame) {
        const routeObject = this._statefulRouteObject(method, object, result);
        if (!routeObject) {
          return; // Transient/data command: reconstructed by readback at capture time.
        }
        const entry = this._statefulCreateEntry(routeObject);
        this._addDeps(entry, this._extractDeps(object, args));
        if (method === "configure") {
          // The context is created (getContext) before the device, but configure() references the
          // device. Move the context to the end of the creation order so its commands (getContext +
          // configure) are emitted after the device it depends on.
          const idx = this._creationOrder.indexOf(routeObject.__id);
          if (idx !== -1) {
            this._creationOrder.splice(idx, 1);
            this._creationOrder.push(routeObject.__id);
          }
        }
        _savedInit = [this._initializeCommands, this._initializeObjects, this._initializeCommandObjects];
        this._initializeCommands = entry.lines;
        this._initializeObjects = entry.lineObjects;
        this._initializeCommandObjects = entry.commandObjs;
      }

      try {

      async = async ? "await " : "";

      let obj = object;

      if (method === "getCurrentTexture") {
        // The canvas's per-frame texture; mark it (and below, any view of it) as transient so its
        // creation is not hoisted to the initialize block in single-frame mode.
        if (result && result.__id) {
          this._canvasObjectIds.add(result.__id);
        }
      } else if (method === "createTexture") {
        this._unusedTextures.add(result.__id);
        obj = result;
      } else if (method === "createView") {
        this._unusedTextureViews.set(result.__id, object.__id);
        // A view of a canvas texture is itself canvas-derived (and transient).
        if (object && object.__id && this._canvasObjectIds.has(object.__id) && result && result.__id) {
          this._canvasObjectIds.add(result.__id);
        }
      } else if (method === "writeTexture") {
        obj = args[0].texture;
      } else if (method === "createBuffer") {
        this._unusedBuffers.add(result.__id);
        obj = result;
      } else if (method === "writeBuffer") {
        obj = args[0];
      } else if (method === "createBindGroup") {
        this._unusedBindGroups.add(result.__id);
        obj = result;
      }

      const newArgs = `[${this._stringifyArgs(method, args, true)}]`;
      const commandObj = { "object": this._getObjectVariable(object), method, "result": this._getObjectVariable(result), args: newArgs, async };
      if (this._frameIndex === -1) {
        this._initializeCommandObjects.push(commandObj);
      } else {
        this._currentFrameCommandObjects.push(commandObj);
      }

      if (skipLine) {
        return;
      }

      // Add a blank line before render and compute passes to make them easier to
      // identify in the recording file.
      if (method === "beginRenderPass" || method === "beginComputePass") {
        this._recordLine("\n", null);
      }

      if (result) {
        this._recordLine(`${this._getObjectVariable(result)} = ${async}${this._getObjectVariable(object)}.${method}(${this._stringifyArgs(method, args)});`, obj);
      } else {
        this._recordLine(`${async}${this._getObjectVariable(object)}.${method}(${this._stringifyArgs(method, args)});`, obj);
      }

      // Add a blank line after ending render and compute passes to make them easier
      // to identify in the recording file.
      if (method === "end") {
        this._recordLine("\n", null);
      }

      if (method === "requestAdapter") {
        const adapter = this._getObjectVariable(result);
        if (this._adapter == null) {
          this._adapter = adapter;
          this._recordLine(`const requiredFeatures = [];
          for (const x of ${adapter}.features) {
              requiredFeatures.push(x);
          }`, obj);
          this._recordLine(`const requiredLimits = {};
          const exclude = new Set(["minSubgroupSize", "maxSubgroupSize"]);
          for (const x in ${adapter}.limits) {
            if (!exclude.has(x)) {
              requiredLimits[x] = ${adapter}.limits[x];
            }
          }`, obj);
        }
      }

      if (result instanceof GPUDevice) {
        const q = result.queue;
        if (q.__id === undefined) {
          const queueVar = this._getObjectVariable(q);
          this._recordLine(`${queueVar} = ${this._getObjectVariable(result)}.queue;`, result);
          this._recordCommand("", result, "__getQueue", q, [], true);
        }
      }

      } finally {
        if (_savedInit) {
          this._initializeCommands = _savedInit[0];
          this._initializeObjects = _savedInit[1];
          this._initializeCommandObjects = _savedInit[2];
        }
      }
    }

    // Scan all commands to find which data indices are referenced.
    _extractDataVariableReferences() {
      const referenced = new Set();
      const scan = (cmd) => {
        if (!cmd || !cmd.args) {
          return;
        }
        if (cmd.method === "__writeData") {
          try {
            const a = JSON.parse(cmd.args);
            if (typeof a[0] === "number") {
              referenced.add(a[0]);
            }
          } catch (e) { /* ignore */ }
          return;
        }
        const re = /"__data"\s*:\s*(\d+)/g;
        let m;
        while ((m = re.exec(cmd.args)) !== null) {
          referenced.add(parseInt(m[1], 10));
        }
      };

      for (const c of this._initializeCommandObjects) {
        scan(c);
      }
      for (const frame of this._frameCommandObjects) {
        if (frame) {
          for (const c of frame) {
            scan(c);
          }
        }
      }

      return referenced;
    }

    // Build unified binary data structure: commands + data table + raw bytes.
    _buildUnifiedBinaryData() {
      const referenced = this._extractDataVariableReferences();

      const dataTable = [];
      const blobs = [];
      let offset = 0;
      for (let i = 0; i < this._arrayCache.length; ++i) {
        const a = this._arrayCache[i];
        if (!a || a.array === null || a.array === undefined || !referenced.has(i)) {
          dataTable.push({ type: "", length: 0, offset: 0 });
          continue;
        }
        // Align offset for this data type to ensure valid TypedArray view creation
        const typeSize = this._getTypeSize(a.type);
        const alignedOffset = (offset + typeSize - 1) & ~(typeSize - 1);
        offset = alignedOffset;

        const bytes = new Uint8Array(a.array.buffer, a.array.byteOffset, a.array.byteLength);
        dataTable.push({ type: a.type, length: bytes.byteLength, offset });
        blobs.push({ offset: alignedOffset, data: bytes });
        offset += bytes.byteLength;
      }
      const dataTotal = offset;

      const rawDataBlob = new Uint8Array(dataTotal);
      for (const blob of blobs) {
        rawDataBlob.set(blob.data, blob.offset);
      }

      const init = this._initializeCommandObjects.filter((c) => !!c);
      const frames = this._frameCommandObjects.map((f) => f.filter((c) => !!c));

      return {
        version: 1,
        canvasWidth: this.config.canvasWidth,
        canvasHeight: this.config.canvasHeight,
        gpuVar: this._getObjectVariable(navigator.gpu),
        contextVar: "context",
        init,
        frames,
        dataTable,
        rawDataBlob
      };
    }

    // Serialize unified binary data to WGPR container format.
    _serializeBinaryContainer(data) {
      const header = {
        version: data.version,
        canvasWidth: data.canvasWidth,
        canvasHeight: data.canvasHeight,
        gpuVar: data.gpuVar,
        contextVar: data.contextVar,
        init: data.init,
        frames: data.frames,
        data: data.dataTable
      };
      const headerBytes = new TextEncoder().encode(JSON.stringify(header));

      const buffer = new ArrayBuffer(12 + headerBytes.byteLength + data.rawDataBlob.byteLength);
      const view = new DataView(buffer);
      const u8 = new Uint8Array(buffer);
      u8[0] = 0x57; u8[1] = 0x47; u8[2] = 0x50; u8[3] = 0x52; // "WGPR"
      view.setUint32(4, data.version, true);
      view.setUint32(8, headerBytes.byteLength, true);
      u8.set(headerBytes, 12);
      u8.set(data.rawDataBlob, 12 + headerBytes.byteLength);
      return buffer;
    }

    // Convert a command object back to a readable JavaScript line.
    _commandObjectToJavaScriptLine(cmd) {
      if (!cmd) {
        return "";
      }

      let args;
      try {
        args = JSON.parse(cmd.args);
      } catch (e) {
        args = [];
      }

      const convertArg = (arg) => {
        if (arg === null) {
          return "null";
        } else if (Array.isArray(arg)) {
          return `[${arg.map(convertArg).join(", ")}]`;
        } else if (typeof arg === "object") {
          if (arg.__id !== undefined) {
            return arg.__id;
          }
          if (arg.__data !== undefined) {
            return this._getDataVariable(arg.__data);
          }
          const entries = [];
          for (const [key, value] of Object.entries(arg)) {
            entries.push(`${key}: ${convertArg(value)}`);
          }
          return `{${entries.join(", ")}}`;
        } else if (typeof arg === "string") {
          return JSON.stringify(arg);
        } else {
          return String(arg);
        }
      };

      const argStr = args.length === 0 ? "" : args.map(convertArg).join(", ");

      if (cmd.result && cmd.result !== "undefined") {
        return `${cmd.result} = ${cmd.async}${cmd.object}.${cmd.method}(${argStr});`;
      } else {
        return `${cmd.async}${cmd.object}.${cmd.method}(${argStr});`;
      }
    }

    // Generate HTML from unified binary data.
    async _generateHtmlFromBinaryData(data) {

      const dataVariables = [];
      for (let i = 0; i < data.dataTable.length; ++i) {
        const entry = data.dataTable[i];
        if (entry.type === "") {
          continue;
        }
        const varName = this._getDataVariable(i);
        dataVariables.push({ index: i, varName });
      }

      let dataVariableDeclarations = "";
      if (dataVariables.length > 0) {
        dataVariableDeclarations = "let " + dataVariables.map(dv => dv.varName).join(", ") + ";";
      }

      let s = `
    <!DOCTYPE html>
    <html>
        <body style="text-align: center; margin: 0; padding: 0;">
            <canvas id="#webgpu" width=${data.canvasWidth} height=${data.canvasHeight}></canvas>
            <script>
    ${dataVariableDeclarations}
    async function main() {
      await loadData();

      let canvas = document.getElementById("#webgpu");
      let context = canvas.getContext("webgpu");
      let frameLabel = document.createElement("div");
      frameLabel.style = "position: absolute; top: 10px; left: 10px; font-size: 24pt; color: #f00;";
      document.body.append(frameLabel);
      ${this._getVariableDeclarations(-1)}
      ${this._initializeCommands.join("\n      ")}\n`;

      for (let fi = 0; fi < data.frames.length; ++fi) {
        s += `
      async function f${fi}() {
          ${this._getVariableDeclarations(fi)}
          ${this._frameCommands[fi].join("\n          ")}
      }\n`;
      }

      s += `
        let frames=[`;
      for (let fi = 0; fi < data.frames.length; ++fi) {
        s += `f${fi},`;
      }
      s += `];
        let frame = 0;
        let lastFrame = -1;
        let t0 = performance.now();
        async function renderFrame() {
            if (frame > ${data.frames.length - 1}) return;
            requestAnimationFrame(renderFrame);
            if (frame == lastFrame) return;
            lastFrame = frame;
            let t1 = performance.now();
            frameLabel.innerText = "F: " + (frame + 1) + "  T:" + (t1 - t0).toFixed(2);
            t0 = t1;
            try {
                await frames[frame]();
            } catch (err) {
                console.log("Error Frame:", frame);
                console.error(err.message);
            }
            frame++;
        }
        requestAnimationFrame(renderFrame);
    }

    function setCanvasSize(canvas, width, height) {
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
    }

    async function B64ToA(type, length, s) {
        if (Uint8Array.fromBase64) {
            const s2 = s.substr(s.indexOf(",") + 1);
            const b = Uint8Array.fromBase64(s2);
            if (type == "Uint32Array") {
              return new Uint32Array(b.buffer);
            }
            return b;
        }
        const res = await fetch(s);
        const x = new Uint8Array(await res.arrayBuffer());
        if (type == "Uint32Array") {
            return new Uint32Array(x.buffer, 0, x.length/4);
        }
        return new Uint8Array(x.buffer, 0, x.length);
    }

    async function loadData() {\n`;

      if (dataVariables.length > 0) {
        const b64 = await this._encodeDataUrl(data.rawDataBlob);
        s += `      const b64Data = "${b64}";\n`;
        s += `      const dataBytes = await B64ToA("Uint8Array", ${data.rawDataBlob.byteLength}, b64Data);\n`;
        for (const dv of dataVariables) {
          const entry = data.dataTable[dv.index];
          s += `      ${dv.varName} = new ${entry.type}(dataBytes.buffer, ${entry.offset}, ${entry.length / this._getTypeSize(entry.type)});\n`;
        }
      }

      s += `
        }
        main();
                </script>
            </body>
        </html>\n`;

      return s;
    }

    _getTypeSize(type) {
      const typeSizes = {
        "Uint8Array": 1,
        "Int8Array": 1,
        "Uint16Array": 2,
        "Int16Array": 2,
        "Uint32Array": 4,
        "Int32Array": 4,
        "Float32Array": 4,
        "Float64Array": 8,
        "BigUint64Array": 8,
        "BigInt64Array": 8
      };
      return typeSizes[type] || 1;
    }
  }

  WebGPURecorder._asyncMethods = new Set([
    "requestAdapter",
    "requestDevice",
    "createComputePipelineAsync",
    "createRenderPipelineAsync",
    "mapAsync",
  ]);

  // Stateful mode (recordMode 2): methods that create/define a persistent GPU object or persistent
  // state, which must be reconstructed in the initialize block of an arbitrary-frame capture.
  WebGPURecorder._persistentMethods = new Set([
    "requestAdapter",
    "requestDevice",
    "__getQueue",
    "createBuffer",
    "createTexture",
    "createView",
    "createSampler",
    "createBindGroupLayout",
    "createPipelineLayout",
    "createBindGroup",
    "createShaderModule",
    "createComputePipeline",
    "createRenderPipeline",
    "createComputePipelineAsync",
    "createRenderPipelineAsync",
    "createQuerySet",
    "getBindGroupLayout",
    "configure"
  ]);

  // Stateful mode: object types whose lifetime spans frames (as opposed to transient per-frame
  // objects like command encoders, passes, command buffers and render bundles).
  WebGPURecorder._persistentTypes = [
    GPUAdapter,
    GPUDevice,
    GPUQueue,
    GPUBuffer,
    GPUTexture,
    GPUTextureView,
    GPUSampler,
    GPUBindGroupLayout,
    GPUBindGroup,
    GPUPipelineLayout,
    GPUShaderModule,
    GPUComputePipeline,
    GPURenderPipeline,
    GPUQuerySet
  ];

  WebGPURecorder._skipMethods = new Set([
    "toString",
    "entries",
    "getContext",
    "forEach",
    "has",
    "keys",
    "values",
    "getPreferredFormat",
    "requestAdapterInfo",
    "pushErrorScope",
    "popErrorScope"
  ]);

  WebGPURecorder._formatInfo = {
    // 8-bit formats
    "r8unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 1 },
    "r8snorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 1 },
    "r8uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 1 },
    "r8sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 1 },

    // 16-bit formats
    "r16unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
    "r16snorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
    "r16uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
    "r16sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
    "r16float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
    "rg8unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
    "rg8snorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
    "rg8uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
    "rg8sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },

    // 32-bit formats
    "r32uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "r32sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "r32float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "rg16unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "rg16snorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "rg16uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "rg16sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "rg16float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "rgba8unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "rgba8unorm-srgb": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "rgba8snorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "rgba8uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "rgba8sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "bgra8unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "bgra8unorm-srgb": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    // Packed 32-bit formats
    "rgb9e5ufloat": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "rgb10a2uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "rgb10a2unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    "rg11b10ufloat": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },

    // 64-bit formats
    "rg32uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
    "rg32sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
    "rg32float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
    "rgba16unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
    "rgba16snorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
    "rgba16uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
    "rgba16sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
    "rgba16float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
    
    // 128-bit formats    
    "rgba32uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 16 },
    "rgba32sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 16 },
    "rgba32float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 16 },
    
    // Depth-stencil formats 
    "stencil8": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 1 },
    "depth16unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
    "depth24plus": { "blockWidth": 1, "blockHeight": 1 },
    "depth24plus-stencil8": { "blockWidth": 1, "blockHeight": 1 },
    "depth32float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
    
    // "depth32float-stencil8" feature
    "depth32float-stencil8": { "blockWidth": 1, "blockHeight": 1 },

    // BC compressed formats
    "bc1-rgba-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
    "bc1-rgba-unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
    "bc2-rgba-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "bc2-rgba-unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "bc3-rgba-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "bc3-rgba-unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "bc4-r-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
    "bc4-r-snorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
    "bc5-rg-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "bc5-rg-snorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "bc6h-rgb-ufloat": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "bc6h-rgb-float": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "bc7-rgba-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "bc7-rgba-unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    
    // ETC2 compressed formats
    "etc2-rgb8unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
    "etc2-rgb8unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
    "etc2-rgb8a1unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
    "etc2-rgb8a1unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
    "etc2-rgba8unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "etc2-rgba8unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "eac-r11unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
    "eac-r11snorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
    "eac-rg11unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "eac-rg11snorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    
    // ASTC compressed formats
    "astc-4x4-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "astc-4x4-unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
    "astc-5x4-unorm": { "blockWidth": 5, "blockHeight": 4, "bytesPerBlock": 16 },
    "astc-5x4-unorm-srgb": { "blockWidth": 5, "blockHeight": 4, "bytesPerBlock": 16 },
    "astc-5x5-unorm": { "blockWidth": 5, "blockHeight": 5, "bytesPerBlock": 16 },
    "astc-5x5-unorm-srgb": { "blockWidth": 5, "blockHeight": 5, "bytesPerBlock": 16 },
    "astc-6x5-unorm": { "blockWidth": 6, "blockHeight": 5, "bytesPerBlock": 16 },
    "astc-6x5-unorm-srgb": { "blockWidth": 6, "blockHeight": 5, "bytesPerBlock": 16 },
    "astc-6x6-unorm": { "blockWidth": 6, "blockHeight": 6, "bytesPerBlock": 16 },
    "astc-6x6-unorm-srgb": { "blockWidth": 6, "blockHeight": 6, "bytesPerBlock": 16 },
    "astc-8x5-unorm": { "blockWidth": 8, "blockHeight": 5, "bytesPerBlock": 16 },
    "astc-8x5-unorm-srgb": { "blockWidth": 8, "blockHeight": 5, "bytesPerBlock": 16 },
    "astc-8x6-unorm": { "blockWidth": 8, "blockHeight": 6, "bytesPerBlock": 16 },
    "astc-8x6-unorm-srgb": { "blockWidth": 8, "blockHeight": 6, "bytesPerBlock": 16 },
    "astc-8x8-unorm": { "blockWidth": 8, "blockHeight": 8, "bytesPerBlock": 16 },
    "astc-8x8-unorm-srgb": { "blockWidth": 8, "blockHeight": 8, "bytesPerBlock": 16 },
    "astc-10x5-unorm": { "blockWidth": 10, "blockHeight": 5, "bytesPerBlock": 16 },
    "astc-10x5-unorm-srgb": { "blockWidth": 10, "blockHeight": 5, "bytesPerBlock": 16 },
    "astc-10x6-unorm": { "blockWidth": 10, "blockHeight": 6, "bytesPerBlock": 16 },
    "astc-10x6-unorm-srgb": { "blockWidth": 10, "blockHeight": 6, "bytesPerBlock": 16 },
    "astc-10x8-unorm": { "blockWidth": 10, "blockHeight": 8, "bytesPerBlock": 16 },
    "astc-10x8-unorm-srgb": { "blockWidth": 10, "blockHeight": 8, "bytesPerBlock": 16 },
    "astc-10x10-unorm": { "blockWidth": 10, "blockHeight": 10, "bytesPerBlock": 16 },
    "astc-10x10-unorm-srgb": { "blockWidth": 10, "blockHeight": 10, "bytesPerBlock": 16 },
    "astc-12x10-unorm": { "blockWidth": 12, "blockHeight": 10, "bytesPerBlock": 16 },
    "astc-12x10-unorm-srgb": { "blockWidth": 12, "blockHeight": 10, "bytesPerBlock": 16 },
    "astc-12x12-unorm": { "blockWidth": 12, "blockHeight": 12, "bytesPerBlock": 16 },
    "astc-12x12-unorm-srgb": { "blockWidth": 12, "blockHeight": 12, "bytesPerBlock": 16 },
  };

  new Set([
    GPUAdapter,
    GPUDevice,
    GPUBuffer,
    GPUTexture,
    GPUTextureView,
    GPUExternalTexture,
    GPUSampler,
    GPUBindGroupLayout,
    GPUBindGroup,
    GPUPipelineLayout,
    GPUShaderModule,
    GPUComputePipeline,
    GPURenderPipeline,
    GPUCommandBuffer,
    GPUCommandEncoder,
    GPUComputePassEncoder,
    GPURenderPassEncoder,
    GPURenderBundle,
    GPUQueue,
    GPUQuerySet,
    GPUCanvasContext
  ]);

  class GPUObjectWrapper {
    constructor(idGenerator) {
      this._idGenerator = idGenerator;
      this.onPreCall = null;
      this.onPostCall = null;
      this.onPromise = null;
      this.onPromiseResolve = null;
      this.skipRecord = 0;
      // Records every prototype method we patch as { target, name, orig } so the recorder can fully
      // detach (restore the native methods) once recording is finished, leaving zero per-call overhead.
      this._wrappedFunctions = [];
      this._wrapGPUTypes();
    }

    // Patch a single prototype method, remembering the original so it can be restored later.
    _wrap(target, name) {
      const orig = target[name];
      this._wrappedFunctions.push({ target, name, orig });
      target[name] = this._wrapMethod(name, orig);
    }

    _wrapGPUTypes() {
      const w = (target, name) => this._wrap(target, name);

      w(GPU.prototype, "requestAdapter");
      w(GPU.prototype, "getPreferredFormat");

      w(GPUAdapter.prototype, "requestDevice");

      w(GPUDevice.prototype, "destroy");
      w(GPUDevice.prototype, "createBuffer");
      w(GPUDevice.prototype, "createTexture");
      w(GPUDevice.prototype, "createSampler");
      w(GPUDevice.prototype, "importExternalTexture");
      w(GPUDevice.prototype, "createBindGroupLayout");
      w(GPUDevice.prototype, "createPipelineLayout");
      w(GPUDevice.prototype, "createBindGroup");
      w(GPUDevice.prototype, "createShaderModule");
      w(GPUDevice.prototype, "createComputePipeline");
      w(GPUDevice.prototype, "createRenderPipeline");
      w(GPUDevice.prototype, "createComputePipelineAsync");
      w(GPUDevice.prototype, "createRenderPipelineAsync");
      w(GPUDevice.prototype, "createCommandEncoder");
      w(GPUDevice.prototype, "createRenderBundleEncoder");
      w(GPUDevice.prototype, "createQuerySet");

      w(GPUBuffer.prototype, "mapAsync");
      w(GPUBuffer.prototype, "getMappedRange");
      w(GPUBuffer.prototype, "unmap");
      w(GPUBuffer.prototype, "destroy");

      w(GPUTexture.prototype, "createView");
      w(GPUTexture.prototype, "destroy");

      w(GPUShaderModule.prototype, "getCompilationInfo");

      w(GPUComputePipeline.prototype, "getBindGroupLayout");

      w(GPURenderPipeline.prototype, "getBindGroupLayout");

      w(GPUCommandEncoder.prototype, "beginRenderPass");
      w(GPUCommandEncoder.prototype, "beginComputePass");
      w(GPUCommandEncoder.prototype, "copyBufferToBuffer");
      w(GPUCommandEncoder.prototype, "copyBufferToTexture");
      w(GPUCommandEncoder.prototype, "copyTextureToBuffer");
      w(GPUCommandEncoder.prototype, "copyTextureToTexture");
      w(GPUCommandEncoder.prototype, "clearBuffer");
      w(GPUCommandEncoder.prototype, "resolveQuerySet");
      w(GPUCommandEncoder.prototype, "finish");
      w(GPUCommandEncoder.prototype, "pushDebugGroup");
      w(GPUCommandEncoder.prototype, "popDebugGroup");
      w(GPUCommandEncoder.prototype, "insertDebugMarker");

      w(GPUComputePassEncoder.prototype, "setPipeline");
      w(GPUComputePassEncoder.prototype, "dispatchWorkgroups");
      w(GPUComputePassEncoder.prototype, "dispatchWorkgroupsIndirect");
      w(GPUComputePassEncoder.prototype, "end");
      w(GPUComputePassEncoder.prototype, "setBindGroup");
      w(GPUComputePassEncoder.prototype, "pushDebugGroup");
      w(GPUComputePassEncoder.prototype, "popDebugGroup");
      w(GPUComputePassEncoder.prototype, "insertDebugMarker");

      w(GPURenderPassEncoder.prototype, "setViewport");
      w(GPURenderPassEncoder.prototype, "setScissorRect");
      w(GPURenderPassEncoder.prototype, "setBlendConstant");
      w(GPURenderPassEncoder.prototype, "setStencilReference");
      w(GPURenderPassEncoder.prototype, "beginOcclusionQuery");
      w(GPURenderPassEncoder.prototype, "endOcclusionQuery");
      w(GPURenderPassEncoder.prototype, "executeBundles");
      w(GPURenderPassEncoder.prototype, "end");
      w(GPURenderPassEncoder.prototype, "setPipeline");
      w(GPURenderPassEncoder.prototype, "setIndexBuffer");
      w(GPURenderPassEncoder.prototype, "setVertexBuffer");
      w(GPURenderPassEncoder.prototype, "draw");
      w(GPURenderPassEncoder.prototype, "drawIndexed");
      w(GPURenderPassEncoder.prototype, "drawIndirect");
      w(GPURenderPassEncoder.prototype, "drawIndexedIndirect");
      w(GPURenderPassEncoder.prototype, "setBindGroup");
      w(GPURenderPassEncoder.prototype, "pushDebugGroup");
      w(GPURenderPassEncoder.prototype, "popDebugGroup");
      w(GPURenderPassEncoder.prototype, "insertDebugMarker");

      w(GPUQueue.prototype, "submit");
      w(GPUQueue.prototype, "writeBuffer");
      w(GPUQueue.prototype, "writeTexture");
      w(GPUQueue.prototype, "copyExternalImageToTexture");

      w(GPUQuerySet.prototype, "destroy");

      w(GPUCanvasContext.prototype, "configure");
      w(GPUCanvasContext.prototype, "unconfigure");
      w(GPUCanvasContext.prototype, "getCurrentTexture");

      w(GPURenderBundleEncoder.prototype, "draw");
      w(GPURenderBundleEncoder.prototype, "drawIndexed");
      w(GPURenderBundleEncoder.prototype, "drawIndirect");
      w(GPURenderBundleEncoder.prototype, "drawIndexedIndirect");
      w(GPURenderBundleEncoder.prototype, "finish");
      w(GPURenderBundleEncoder.prototype, "insertDebugMarker");
      w(GPURenderBundleEncoder.prototype, "popDebugGroup");
      w(GPURenderBundleEncoder.prototype, "pushDebugGroup");
      w(GPURenderBundleEncoder.prototype, "setBindGroup");
      w(GPURenderBundleEncoder.prototype, "setIndexBuffer");
      w(GPURenderBundleEncoder.prototype, "setPipeline");
      w(GPURenderBundleEncoder.prototype, "setVertexBuffer");
    }

    // Restore every patched prototype method to its native implementation. After this, GPU calls go
    // straight to the browser with no recorder indirection. Iterated in reverse so any method patched
    // more than once is restored to its true original.
    _unwrapGPUTypes() {
      for (let i = this._wrappedFunctions.length - 1; i >= 0; --i) {
        const { target, name, orig } = this._wrappedFunctions[i];
        target[name] = orig;
      }
      this._wrappedFunctions.length = 0;
    }

    _wrapMethod(method, origMethod) {
      const self = this;
      return function () {
        const object = this;

        const args = [...arguments];

        if (self.skipRecord === 0) {
          // Allow the arguments to be modified before the method is called.
          if (self.onPreCall) {
            self.onPreCall(object, method, args);
          }
        }

        // Call the original method
        const result = origMethod.call(object, ...args);

        // If it was an async method it will have returned a Promise
        if (self.skipRecord === 0) {
          if (result instanceof Promise) {
            const id = self._idGenerator.getNextId(object);
            if (self.onPromise) {
              self.onPromise(object, method, args, id);
            }
            const promise = result;
            const wrappedPromise = new Promise((resolve) => {
              promise.then((result) => {
                if (self.onPromiseResolve) {
                  self.onPromiseResolve(object, method, args, id, result);
                }
                resolve(result);
              });
            });
            return wrappedPromise;
          }

          // Otherwise it"s a synchronous method
          if (self.onPostCall) {
            self.onPostCall(object, method, args, result);
          }
        }

        return result;
      };
    }
  }

  // Because of how WebGPURecorder is injected into WebWorkers, worker scripts lose their local
  // path context. This code snippet fixes that by prepending the base address to all
  // fetch, Request, URL, and WebSocket requests.
  let _webgpuHostAddress = "<%=_webgpuHostAddress%>";
  let _webgpuBaseAddress = "<%=_webgpuBaseAddress%>";

  const _URL = URL;

  function _getFixedUrl(url) {
    if (_webgpuHostAddress.startsWith("<%=")) {
      return url;
    }

    if (url?.constructor === String) {
      if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("ws://") ||
          url.startsWith("wss://")|| url.startsWith("blob:") || url.startsWith("data:")){
        return url;
      }
      try {
        const _url = new _URL(url);
      if (_url.protocol) {
        return url;
      }
      } catch (e) {
      }

      if (url.startsWith("/")) {
        return `${_webgpuHostAddress}/${url}`;
      } else {
        return `${_webgpuBaseAddress}/${url}`;
      }
    }
    return url;
  }

  const _origFetch = fetch;
  self.fetch = function (input, init) {
    let url = input instanceof Request ? input.url : input;
    url = _getFixedUrl(url);
    return _origFetch(url, init);
  };

  URL = new Proxy(URL, {
    construct(target, args, newTarget) {
      if (args.length > 0) {
        args[0] = _getFixedUrl(args[0]);
      }
      return new target(...args);
    }
  });

  WebSocket = new Proxy(WebSocket, {
    construct(target, args, newTarget) {
      if (args.length > 0) {
        args[0] = _getFixedUrl(args[0]);
      }
      return new target(...args);
    }
  });

  Request = new Proxy(Request, {
    construct(target, args, newTarget) {
      if (args.length > 0) {
        args[0] = _getFixedUrl(args[0]);
      }
      return new target(...args);
    },
  });

  // Intercept Worker creation to inject inspector
  Worker = new Proxy(Worker, {
    construct(target, args, newTarget) {
      // Inject inspector before the worker loads
      let src = self.__webgpu_src ? `self.__webgpu_src = ${self.__webgpu_src.toString()};self.__webgpu_src();` : "";

      let url = args[0];

      let _url = null;
      try {
        _url = new _URL(url);
      } catch {
        const baseUrl = new _URL((document.currentScript && document.currentScript.tagName.toUpperCase() === 'SCRIPT' && document.currentScript.src || new URL('webgpu_recorder.js', document.baseURI).href));
        const baseDir = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf("/"));
        const sep = url.startsWith("/") ? "" : "/";
        _url = new URL(`${baseUrl.protocol}//${baseUrl.host}${baseDir}${sep}${url}`);
      }

      const _webgpuHostAddress = `${_url.protocol}//${_url.host}`;
      const baseDir = _url.pathname.substring(0, _url.pathname.lastIndexOf("/"));
      const fileName = _url.pathname.substring(_url.pathname.lastIndexOf("/")+1);
      const _webgpuBaseAddress = `${_webgpuHostAddress}${baseDir}`;
      const filePath = `${_webgpuBaseAddress}/${fileName}`;

      src = src.replaceAll(`<%=_webgpuHostAddress%>`, `${_webgpuHostAddress}`);
      src = src.replaceAll(`<%=_webgpuBaseAddress%>`, `${_webgpuBaseAddress}`);

      if (self._webgpu_recorder_init) {
        const filename = self._webgpu_recorder_init.filename;
        const frames = self._webgpu_recorder_init.frames;
        const messageRecording = self._webgpu_recorder_init.messageRecording;      const removeUnusedResources = self._webgpu_recorder_init.removeUnusedResources;
        const download = self._webgpu_recorder_init.download;
        const recordMode = self._webgpu_recorder_init.recordMode;
        const recordFrame = self._webgpu_recorder_init.recordFrame;
        const continuous = self._webgpu_recorder_init.continuous;
        const output = self._webgpu_recorder_init.output;
        const webgpuRecorderConfig = {
            "frames": frames || 1,
            "export": filename,
            "removeUnusedResources": !!removeUnusedResources,
            "messageRecording": !!messageRecording,
            "download": download === null ? true : download === "false" ? false : download === "true" ? true : download,
            "recordMode": recordMode ?? 0,
            "recordFrame": recordFrame ?? null,
            "continuous": !!continuous,
            "output": output ?? "html"
        };
        src = src.replaceAll(`<%=webgpuRecorderConfig%>`, JSON.stringify(webgpuRecorderConfig));
      }

      if (args.length > 1 && args[1]?.type === 'module') {
        src += `import ${JSON.stringify(filePath)};`;
      } else {
        src += `importScripts(${JSON.stringify(filePath)});`;
      }

      let blob = new Blob([src]);
      blob = blob.slice(0, blob.size, "text/javascript");
      args[0] = URL.createObjectURL(blob);

      const backing = new target(...args);
      backing.__webgpuRecorder = true;

      window.addEventListener("__WebGPURecorder", (event) => {
        // Forward messages from the page to the worker, if the worker hasn't been terminated,
        // the message is from the inspector, and the message is not from the worker.
        if (backing.__webgpuRecorder && event.detail.__webgpuRecorder &&
          !event.detail.__webgpuRecorderPage) {
          backing.postMessage(event.detail);
        }
      });

      backing.addEventListener("message", (event) => {
        if (event.data.type === "webgpu_record_download") {
          webgpu_recorder_download_data(event.data.data, event.data.filename);
        } else if (event.data.type === "webgpu_record_download_binary") {
          webgpu_recorder_download_binary(event.data.data, event.data.filename);
        } else if (event.data.__webgpuRecorder) {
          window.dispatchEvent(new CustomEvent("__WebGPURecorder", { detail: event.data }));
        }
      });

      return new Proxy(backing, {
        get(target, prop, receiver) {
          // Intercept event handlers to hide the inspectors messages
          if (prop === 'addEventListener') {
            return function () {
              if (arguments[0] === 'message') {
                const origHandler = arguments[1];
                arguments[1] = function () {
                  if (!arguments[0].data.__webGPURecorder) {
                    origHandler(...arguments);
                  }
                };
              }

              return target.addEventListener(...arguments);
            };
          }

          // Intercept worker termination and remove it from list so we don't send
          // messages to a terminated worker.
          if (prop === 'terminate') {
            return function () {
              const result = target.terminate(...arguments);
              target.__WebGPURecorder = false;
              return result;
            };
          }

          if (prop in target) {
            if (typeof target[prop] === 'function') {
              return target[prop].bind(target);
            } else {
              return target[prop];
            }
          }
        },
        set(target, prop, newValue, receiver) {
          target[prop] = newValue;
          return true;
        }
      })
    },
  });

  exports.__webgpuRecorder = null;
  (() => {
    // If the script tag has a filename attribute, then auto start recording.
    let webgpuRecorderConfig = null;

    const webgpuRecorderConfigStr = `<%=webgpuRecorderConfig%>`;
    if (!webgpuRecorderConfigStr.startsWith("<%=")) {
      try {
        webgpuRecorderConfig = JSON.parse(webgpuRecorderConfigStr);
      } catch (e) {}
    }

    if (!webgpuRecorderConfig && _document != undefined) {
      const script = _document.getElementById("__webgpu_recorder");
      if (script) {
        initialized = true;
        const filename = script.getAttribute("filename");
        const frames = script.getAttribute("frames");
        const messageRecording = script.getAttribute("messageRecording");
        const removeUnusedResources = script.getAttribute("removeUnusedResources");
        const download = script.getAttribute("download");
        const recordMode = script.getAttribute("recordMode");
        const recordFrame = script.getAttribute("recordFrame");
        const continuous = script.getAttribute("continuous");
        const output = script.getAttribute("output");
        webgpuRecorderConfig = {
          "frames": frames || 1,
          "export": filename,
          "removeUnusedResources": !!removeUnusedResources,
          "messageRecording": !!messageRecording,
          "download": download === null ? true : download === "false" ? false : download === "true" ? true : download,
          "recordMode": recordMode === null ? 0 : parseInt(recordMode, 10) || 0,
          "recordFrame": recordFrame === null ? null
            : recordFrame.indexOf(",") !== -1
              ? recordFrame.split(",").map((s) => parseInt(s.trim(), 10)).filter((n) => !isNaN(n))
              : parseInt(recordFrame, 10),
          "continuous": continuous !== null,
          "output": output === null ? "html" : output
        };
      }
    }

    if (!webgpuRecorderConfig && self._webgpu_recorder_init) {
      webgpuRecorderConfig = self._webgpu_recorder_init;
    }

    if (webgpuRecorderConfig) {
      exports.__webgpuRecorder = new WebGPURecorder(webgpuRecorderConfig);
    }
  })();

  exports.WebGPURecorder = WebGPURecorder;
  exports.webgpu_recorder_download_binary = webgpu_recorder_download_binary;
  exports.webgpu_recorder_download_data = webgpu_recorder_download_data;

  Object.defineProperty(exports, '__esModule', { value: true });

  return exports;

})({});
//# sourceMappingURL=webgpu_recorder.js.map
