import { encodeBase64 } from "./utils/base64.js";
import { GPUObjectTypes, GPUObjectWrapper } from "./utils/gpu_object_wrapper.js";
import { TextureFormatInfo } from "./utils/texture_format_info.js";
import { TextureUtils } from "./utils/texture_utils.js";
import { Actions, PanelActions } from "./utils/actions.js";
import { RollingAverage } from "./utils/rolling_average.js";
import { alignTo } from "./utils/align.js";
import { LocalCaptureStore } from "./utils/local_capture.js";
import { BridgeClient } from "./utils/bridge_client.js";

export let webgpuInspector = null;

// This code will be executed to initialize the WebGPU Inspector from
// webgpu_inspector_loader.js.
(() => {
  // Make a local copy of some global variables for simplified access.
  const _self = self;
  const _window = self.window;
  const _document = self.document;
  const _sessionStorage = self.sessionStorage;
  const _postMessage = self.postMessage;
  const _dispatchEvent = self.dispatchEvent;

  const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";

  // How much data should we send to the panel via message as a chunk.
  // Messages can't send that much data.
  const maxDataChunkSize = (1024 * 1024); // 1MB
  const maxBufferCaptureSize = (1024 * 1024) / 4; // 256KB
  const maxColorAttachments = 10;
  const captureFrameCount = 1;

  class WebGPUInspector {
    constructor() {
      this._captureFrameCommands = []; // Commands for the current frame that have been captured
      this._frameCaptureCommands = []; // Commands for all captured frames.
      this._commandId = 0;
      this._frameData = [];
      this._frameRenderPassCount = 0; // Count of render passes in the current frame
      this._captureTexturedBuffers = [];
      this._currentFrame = null;
      this._frameIndex = 0; // The current frame index based on requestAnimationFrame
      this._gpuFrameIndex = 0; // The frame index based on frames that have GPU work submitted
      this._frameGpuCommandCount = 0; // The number of GPU commands in the current frame
      this._initialized = true;
      this._objectID = 1;
      this._lastFrameTime = 0;
      this._captureFrameRequest = false;
      this._errorChecking = 1;
      this._trackedObjects = new Map();
      this._trackedObjectInfo = new Map();
      this._bindGroupCount = 0;
      this._captureTextureRequest = new Map();
      this._toDestroy = []; // Defer deleting temp objects until after finish
      this._objectReplacementMap = new Map(); // Map objects to their replacements <id:string, {id:string, object:WeakRef, replacement:Object}>
      this._captureBuffersCount = 0;
      this._captureTempBuffers = [];
      this._mappedTextureBufferCount = 0;
      this._mappedBufferCount = 0;
      this._captureData = null;
      this._frameRate = new RollingAverage(60);
      this._captureTimestamps = false;
      this._timestampQuerySupported = false;
      this._timestampQuerySet = null;
      this._timestampBuffer = null;
      this._timestampIndex = 0;
      this._maxTimestamps = 2000;
      this._captureFrameCount = 0;
      this._pendingMapCount = 0; // Number of pending async map requests
      this._hasPendingDeviceDestroy = false;

      // Local-capture mode (manual injection): when `initialize()` is called,
      // the same messages that would have gone to the devtools panel are also
      // routed into a `LocalCaptureStore` so `saveCaptureData()` can write
      // them out as the same JSON format the panel's Save Capture produces.
      this._localCapture = null;
      // True between beginFrameCapture()/endFrameCapture() — drives the same
      // `_captureFrameRequest` plumbing the devtools-initiated path uses.
      this._localCaptureActive = false;
      // Set only when `initializeServer()` is called: the opt-in live bridge
      // client. Regular `initialize()` users leave this null, so no socket is
      // ever opened for the normal file-download capture workflow.
      this._bridgeClient = null;

      // Iframe origin tagging is invariant for the lifetime of the page. Compute once
      // so _postMessage doesn't redo the parent-access try/catch on every chunk.
      this._iframeOrigin = null;
      if (_window && _window.parent && _window.parent !== _window) {
        try {
          // Touching parent.location throws for cross-origin frames.
          if (_window.parent.location) {
            this._iframeOrigin = _window.location.origin;
          }
        } catch (e) {
          this._iframeOrigin = "cross-origin";
        }
      }

      // If there is no WebGPU support, then there's nothing to inspect.
      if (!navigator.gpu) {
        return;
      }

      const self = this;

      this._statusElementsCreated = false;

      if (_document) {
        this.scheduleStatusElements();

        // If there is a document but no body yet, wait for the DOMContentLoaded event.
        _document.addEventListener("DOMContentLoaded", () => {
          const iframes = _document.getElementsByTagName("iframe");
          if (iframes.length > 0) {
            for (const iframe of iframes) {
              iframe.addEventListener("load", () => {
                try {
                  if (iframe.contentWindow) {
                    iframe.contentWindow.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: {
                      __webgpuInspector: true,
                      action: "webgpu_inspector_start_inspection" } }));
                  }
                } catch (e) {
                  // Cross-origin iframe access denied - this is expected. The
                  // extension injects into all frames independently, so the
                  // iframe still gets inspected via its own content-script port;
                  // this direct-DOM propagation is only a same-origin fast path.
                  console.debug("[WebGPU Inspector] Cannot access cross-origin iframe:", e.message);
                }
              });
            }
          }

          const canvases = _document.getElementsByTagName("canvas");
          for (const canvas of canvases) {
            self._wrapCanvas(canvas);
          }
        });

        // Set up MutationObserver to catch dynamically added iframes that might be missed
        if (_document && typeof MutationObserver !== 'undefined') {
          const observer = new MutationObserver((mutations) => {
            for (const mutation of mutations) {
              for (const node of mutation.addedNodes) {
                if (node.nodeName === 'IFRAME') {
                  node.addEventListener("load", () => {
                    try {
                      if (node.contentWindow) {
                        node.contentWindow.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: {
                          __webgpuInspector: true,
                          action: "webgpu_inspector_start_inspection" } }));
                      }
                    } catch (e) {
                      // Cross-origin iframe access denied - this is expected
                      // (see note above; per-frame injection still covers it).
                      console.debug("[WebGPU Inspector] Cannot access cross-origin iframe:", e.message);
                    }
                  });
                } else if (node.getElementsByTagName) {
                  const nestedIframes = node.getElementsByTagName('iframe');
                  for (const iframe of nestedIframes) {
                    iframe.addEventListener("load", () => {
                      try {
                        if (iframe.contentWindow) {
                          iframe.contentWindow.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: {
                            __webgpuInspector: true,
                            action: "webgpu_inspector_start_inspection" } }));
                        }
                      } catch (e) {
                        // Cross-origin iframe access denied - this is expected
                        // (see note above; per-frame injection still covers it).
                        console.debug("[WebGPU Inspector] Cannot access cross-origin iframe:", e.message);
                      }
                    });
                  }
                }
              }
            }
          });

          // When the inspector is injected very early (e.g. a CDP preload
          // script, before the document body/element exist), there is nothing
          // to observe yet — defer until the DOM is ready.
          const observeTarget = _document.body || _document.documentElement;
          if (observeTarget) {
            observer.observe(observeTarget, { childList: true, subtree: true });
          } else {
            _document.addEventListener("DOMContentLoaded", () => {
              const target = _document.body || _document.documentElement;
              if (target) {
                observer.observe(target, { childList: true, subtree: true });
              }
            }, { once: true });
          }
        }
      }

      this._gpuWrapper = new GPUObjectWrapper(this);
      this._gpuWrapper.onPromise.addListener(this._onAsyncPromise, this);
      this._gpuWrapper.onPromiseResolve.addListener(this._onAsyncResolve, this);
      this._gpuWrapper.onPreCall.addListener(this._preMethodCall, this);
      this._gpuWrapper.onPostCall.addListener(this._postMethodCall, this);

      this._garbageCollectectedObjects = [];

      // Track garbage collected WebGPU objects
      this._garbageCollectionRegistry = new FinalizationRegistry((id) => {
        if (id > 0) {
          // It's too slow to send a message for every object that gets garbage collected,
          // so we'll batch them up and send them every so often.
          self._garbageCollectectedObjects.push(id);
          const objectClass = self._trackedObjectInfo.get(id);
          //const object = self._trackedObjects.get(id)?.deref();

          if (objectClass) {
            if (objectClass === GPUBindGroup) {
              self._bindGroupCount--;
            }
            // If we're here, the object was garbage collected but not explicitly destroyed.
            // Some GPU objects need to be explicitly destroyed, otherwise it's a memory
            // leak. Notify the user of this.
            if (objectClass === GPUBuffer || objectClass === GPUTexture || objectClass === GPUDevice) {
              self._memoryLeakWarning(id, objectClass);
            }

            if (objectClass === GPUDevice) {
              if (self._captureFrameCommands.length) {
                self._sendCapturedCommands();
              }
            }
          }

          if (self._garbageCollectectedObjects.length > 100) {
            self._postMessage({ "action": Actions.DeleteObjects, "idList": self._garbageCollectectedObjects });
            self._garbageCollectectedObjects.length = 0;
          }
        }

        if (id > 0) {
          self._trackedObjects.delete(id);
          self._trackedObjectInfo.delete(id);
          self._captureTextureRequest.delete(id);
          self._objectReplacementMap.delete(id);
        }
      });

      // Clean out the garbage collected objects periodically.
      // We want to reduce the number of messages sent to the devtools panel, so we gather
      //  garbage collected objects and send them in a batch.
      const garbageCollectionInterval = 200;
      setInterval(() => {
        if (self._garbageCollectectedObjects.length > 0) {
          self._postMessage({ "action": Actions.DeleteObjects, "idList": self._garbageCollectectedObjects });
          self._garbageCollectectedObjects.length = 0;
        }
      }, garbageCollectionInterval);

      // Wrap the canvas elements so we can capture when their context is created.
      if (_document) {
        const canvases = _document.getElementsByTagName("canvas");
        for (const canvas of canvases) {
          this._wrapCanvas(canvas);
        }

        // Capture any dynamically created canvases.
        const __createElement = _document.createElement;
        _document.createElement = function (type) {
          const element = __createElement.call(_document, type);
          if (type === "canvas") {
            self._wrapCanvas(element);
          } else if (type === "iframe") {
            element.addEventListener("load", () => {
              try {
                if (element.contentWindow) {
                  element.contentWindow.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: {
                    __webgpuInspector: true,
                    action: "webgpu_inspector_start_inspection" } }));
                }
              } catch (e) {
                // Cross-origin iframe access denied - this is expected
                // (see note above; per-frame injection still covers it).
                console.debug("[WebGPU Inspector] Cannot access cross-origin iframe:", e.message);
              }
            });
          }
          return element;
        };
      }

      // Wrap requestAnimationFrame so it can keep track of framerates and frame captures.
      // This requires that the page uses requestAnimationFrame to drive the rendering loop.
      const __requestAnimationFrame = requestAnimationFrame;
      this._currentFrameTime = 0.0;

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
          return result;
        }
        return __requestAnimationFrame(callback);
      };

      // Listen for messages from the content-script.
      function eventCallback(event) {
        let message = event.detail || event.data;
        if (message?.__WebGPUInspector) {
          message = message.__WebGPUInspector;
        }

        // Ignore messages that aren't for us.
        if (typeof message !== "object" || !message.__webgpuInspector) {
          return;
        }

        if (message.action === Actions.DeltaTime) {
          // Update framerate display. This message comes from worker threads.
          if (message.__webgpuInspectorWorker) {
            self._updateFrameRate(message.deltaTime);
          }
        } else if (message.action === PanelActions.RequestTexture) {
          // The devtools panel is requesting the data for a texture.
          const textureId = message.id;
          const mipLevel = message.mipLevel ?? 0;
          self._requestTexture(textureId, mipLevel);
        } else if (message.action === PanelActions.CompileShader) {
          // The devtools panel is requesting to replace the code of a shader
          // with new code. This is used for live shader editing.
          const shaderId = message.id;
          const code = message.code;
          self._compileShader(shaderId, code);
        } else if (message.action === PanelActions.RevertShader) {
          // The devtools panel is requesting to revert a shader back to its original code.
          const shaderId = message.id;
          self._revertShader(shaderId);
        } else if (message.action === PanelActions.Capture) {
          // The devtools panel is requesting to capture a frame.
          if (_window == null) {
            if (message.data.constructor.name === "String") {
              message.data = JSON.parse(message.data);
            }
            self._captureData = message.data;
          }
        }
      }

      if (!_window) {
        // If _window is null, we're in a worker context. Listen for messages from the main thread.
        _self.addEventListener("message", eventCallback);
      } else {
        // Listen for messages from the devtools panel.
        _self.addEventListener("__WebGPUInspector", eventCallback);

        // If we're in an iframe context, set up message forwarding to parent page
        // This is critical for workers inside iframes to communicate with the inspector
        if (_window && _window.parent && _window.parent !== _window) {
          try {
            // Check if we can access the parent (same-origin iframe)
            const parentAccessible = _window.parent.location !== null;

            if (parentAccessible) {
              //console.log("[WebGPU Inspector] Setting up iframe message forwarding to parent page");

              // Listen for messages from workers in this iframe and forward them to parent
              _window.addEventListener("__WebGPUInspector", (event) => {
                const detail = event.detail || event.data;

                if (detail && detail.__webgpuInspector && !detail.__webgpuInspectorPage) {
                  // Only forward messages that originate from workers, not from parent page
                  // This prevents infinite forwarding loops
                  if (detail.__webgpuInspectorWorker || detail.__webgpuInspectorFrame) {
                    try {
                      // Tag the message as coming from an iframe to track its origin
                      const forwardedMessage = {
                        ...detail,
                        __webgpuInspectorIframe: true,
                        __webgpuInspectorIframeOrigin: _window.location.origin
                      };

                      // Forward to parent page using the same event system
                      _window.parent.dispatchEvent(new CustomEvent("__WebGPUInspector", {
                        detail: forwardedMessage
                      }));

                      //console.log("[WebGPU Inspector] Forwarded worker message from iframe to parent");
                    } catch (e) {
                      console.warn("[WebGPU Inspector] Failed to forward message to parent:", e);
                    }
                  }
                }
              });

              //console.log("[WebGPU Inspector] Iframe message forwarding enabled successfully");
            } else {
              console.log("[WebGPU Inspector] Cross-origin iframe detected - message forwarding not available");
            }
          } catch (e) {
            // Cross-origin iframe - gracefully disable forwarding
            console.log("[WebGPU Inspector] Cannot access parent (cross-origin iframe):", e.message);
          }
        }
      }

      if (_sessionStorage) {
        // Check if there is any capture data stored in sessionStorage, used for re-loading a page
        // for recording or capturing from the first frame.
        const captureData = _sessionStorage.getItem(webgpuInspectorCaptureFrameKey);
        if (captureData) {
          try {
            this._captureData = JSON.parse(captureData);
          } catch (e) {
            this._captureData = null;
          }
          _sessionStorage.removeItem(webgpuInspectorCaptureFrameKey);
        }
      }

      if (this._captureData) {
        this._initCaptureData();
      }
    }

    scheduleStatusElements() {
      if (this._statusElementsCreated || !_document) {
        return;
      }

      const create = () => {
        _window.requestAnimationFrame(() => {
          _window.requestAnimationFrame(() => this.createStatusElements());
        });
      };

      if (_document.readyState === "complete") {
        _window.setTimeout(create, 0);
      } else {
        _window.addEventListener("load", create, { once: true });
      }
    }

    // Create an on-screen status display on the page being inspected.
    createStatusElements() {
      if (this._statusElementsCreated || !_document?.body) {
        return;
      }
      this._statusElementsCreated = true;

      const statusContainer = _document.createElement("div");
      statusContainer.style = "position: absolute; top: 0px; left: 0px; z-index: 1000000; margin-left: 10px; margin-top: 5px; padding-left: 5px; padding-right: 10px; background-color: rgba(0, 0, 1, 0.75); border-radius: 5px; box-shadow: 3px 3px 5px rgba(0, 0, 0, 0.5); color: #fff; font-size: 12pt;";
      _document.body.appendChild(statusContainer);

      this._inspectingStatus = _document.createElement("div");
      this._inspectingStatus.title = "WebGPU Inspector Running";
      this._inspectingStatus.style = "height: 10px; width: 10px; display: inline-block; margin-right: 5px; background-color: #ff0; border-radius: 50%; border: 1px solid #000; box-shadow: inset -4px -4px 4px -3px rgb(255,100,0), 2px 2px 3px rgba(0,0,0,0.8);";
      statusContainer.appendChild(this._inspectingStatus);

      this._inspectingStatusFrame = _document.createElement("div");
      this._inspectingStatusFrame.style = "display: inline-block; cursor: pointer;";
      this._inspectingStatusFrame.textContent = "Frame: 0";
      statusContainer.appendChild(this._inspectingStatusFrame);

      this._inspectingStatusText = _document.createElement("div");
      this._inspectingStatusText.style = "display: inline-block; margin-left: 10px; cursor: pointer;";
      statusContainer.appendChild(this._inspectingStatusText);

      const self = this;
      // Clicking the status display will force capture a frame, for cases when
      // the automatic capture might not trigger, such as when the page does not use
      // requestAnimationFrame for its rendering loop.
      statusContainer.addEventListener("click", () => {
        if (self._captureFrameRequest) {
          self._sendCapturedCommands();
        }
      });
    }

    ///  Disable recording of WebGPU calls.
    /// This can be called multiple times, with a matching enableRecording used to re-enable recording.
    disableRecording() {
      this._gpuWrapper.disableRecording();
    }

    ///  Enable recording of WebGPU calls.
    /// This can be called multiple times, with a matching disableRecording used to stop recording.
    enableRecording() {
      this._gpuWrapper.enableRecording();
    }

    // -------- Local capture API (manual injection use case) --------
    //
    // For pages that load `webgpu_inspector.js` directly via a script tag
    // (no DevTools panel involved): keep the same lifecycle/command messages
    // the panel would have consumed in a local store, and then write them
    // out as a JSON file in the format the Capture panel's Save Capture
    // produces. The resulting file is loadable via "Load Capture" in
    // DevTools.

    // Enable local capture mode. Must be called before any WebGPU object is
    // created — captured object descriptors arrive via AddObject messages
    // and are not retroactively re-emitted for objects created earlier.
    initialize() {
      if (this._localCapture) {
        return;
      }
      this._localCapture = new LocalCaptureStore();
    }

    // Opt-in live bridge mode for the WebGPU Inspector Claude Code plugin.
    // Enables local capture (like `initialize()`), then connects to a local
    // bridge server so capture requests can be driven remotely and the
    // resulting capture JSON uploaded back instead of downloaded as a file.
    //
    // Regular `initialize()` / `saveCaptureData()` users never call this, so
    // the normal file-download workflow never opens a socket. Like
    // `initialize()`, this must run before the first WebGPU object is created.
    //
    // `options` (all optional):
    //   url        - bridge WebSocket URL (default "ws://localhost:9690/page")
    //   httpBase   - bridge HTTP base for capture uploads (derived from `url`)
    //   name       - label for this page shown to the plugin
    //   token      - shared token if the bridge was started with one
    initializeServer(options) {
      this.initialize();
      if (this._bridgeClient) {
        return;
      }
      this._bridgeClient = new BridgeClient(this, options || {});
      this._bridgeClient.connect();
    }

    // Begin recording GPU commands for one frame. Pairs with
    // `endFrameCapture()`. Each pair captures one frame; multiple pairs
    // accumulate multiple frames into the same export.
    beginFrameCapture() {
      if (!this._localCapture) {
        throw new Error("WebGPU Inspector: call initialize() before beginFrameCapture()");
      }
      if (this._localCaptureActive) {
        return;
      }
      this._localCaptureActive = true;
      this._captureMaxBufferSize = maxBufferCaptureSize;
      this._captureFrameRequest = true;
    }

    // Stop recording GPU commands and flush the captured commands to the
    // local store. Async texture/buffer readbacks finish in the background
    // and are picked up by `saveCaptureData()`.
    endFrameCapture() {
      if (!this._localCapture || !this._localCaptureActive) {
        return;
      }
      // Mirror the trailing portion of `_frameEnd` for the in-flight frame:
      // hand the command list to `_frameCaptureCommands` so the existing
      // `_sendCapturedCommands` shape (one CaptureFrameResults + N
      // CaptureFrameCommands batches) flows to the local store.
      if (this._captureFrameCommands.length) {
        this._frameCaptureCommands.push(this._captureFrameCommands);
        this._captureFrameCommands = [];
      }
      this._captureFrameRequest = false;
      this._localCaptureActive = false;
      this._flushLocalCapturedCommands();
    }

    // Send accumulated commands to the local store without resetting
    // `_commandId`. The reset matters: async buffer readbacks (from
    // copyBufferToBuffer/setVertexBuffer captures) reference commands by id,
    // and those readbacks can land between pairs — keeping ids monotonic
    // across pairs prevents collisions.
    _flushLocalCapturedCommands() {
      if (!this._frameCaptureCommands.length) {
        return;
      }
      const maxFrameCount = 2000;
      let commands;
      if (this._frameCaptureCommands.length === 1) {
        commands = this._frameCaptureCommands[0];
      } else {
        commands = [];
        for (const frameCommands of this._frameCaptureCommands) {
          commands.push(...frameCommands);
        }
      }
      this._frameCaptureCommands = [];

      const batches = Math.ceil(commands.length / maxFrameCount);
      this._postMessage({
        "action": Actions.CaptureFrameResults,
        "frame": this._frameIndex,
        "count": commands.length,
        batches
      });
      for (let i = 0; i < commands.length; i += maxFrameCount) {
        const length = Math.min(maxFrameCount, commands.length - i);
        const commandsSlice = commands.slice(i, i + length);
        this._postMessage({
          "action": Actions.CaptureFrameCommands,
          "frame": this._frameIndex,
          "commands": commandsSlice,
          "index": i,
          "count": length
        });
      }
    }

    // Wait for all outstanding texture/buffer readbacks (`mapAsync`s
    // queued during `submit`) to complete and their data messages to land
    // in the store. Returns once `_pendingMapCount` settles at 0.
    async _waitForCapturedReadbacks() {
      // Poll on rAF where available, otherwise setTimeout; ~16ms cadence.
      const sleep = () => new Promise((resolve) => {
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(() => resolve());
        } else {
          setTimeout(resolve, 16);
        }
      });
      // Bound the wait so a stuck mapAsync (lost device, destroyed buffer)
      // doesn't hang `saveCaptureData()` forever.
      const deadline = Date.now() + 30000;
      while (this._pendingMapCount > 0 && Date.now() < deadline) {
        await sleep();
      }
      // One extra tick to drain microtasks (the mapAsync.then chain posts
      // data messages synchronously after decrementing the counter).
      await sleep();
    }

    // Build the capture JSON and trigger a download. Returns the JSON
    // object for callers that want to handle the bytes themselves.
    // Pass `{ download: false }` as `options` to skip the file download and
    // only return the data (used by the live bridge to upload instead).
    async saveCaptureData(filename, options) {
      if (!this._localCapture) {
        throw new Error("WebGPU Inspector: call initialize() before saveCaptureData()");
      }
      if (this._localCaptureActive) {
        this.endFrameCapture();
      } else {
        // Flush anything still pending from a prior unsynced end.
        this._flushLocalCapturedCommands();
      }

      await this._waitForCapturedReadbacks();

      const data = this._localCapture.buildCaptureJson("__buildVersion");

      // Subsequent begin/end pairs start a fresh frame list. Object records
      // stay so anything created before this save (and still referenced by
      // a later capture) is exported next time too.
      this._commandId = 0;
      this._frameRenderPassCount = 0;
      this._localCapture.resetCaptures();

      const frame = data.frame ?? 0;
      const name = filename || `webgpu_capture_frame_${frame}.json`;
      if (!options || options.download !== false) {
        this._downloadCaptureJson(data, name);
      }

      return data;
    }

    _downloadCaptureJson(data, filename) {
      if (!_document) {
        return;
      }
      const text = JSON.stringify(data, null, 2);
      const blob = new Blob([text], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = _document.createElement("a");
      a.href = url;
      a.download = filename;
      _document.body.appendChild(a);
      a.click();
      _document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    }

    // Send a message to the devtools panel.
    _postMessage(message) {
      message.__webgpuInspector = true;
      message.__webgpuInspectorPage = true;
      message.__webgpuInspectorWorker = !_window;

      if (this._iframeOrigin !== null) {
        message.__webgpuInspectorFrame = true;
        message.__webgpuInspectorFrameOrigin = this._iframeOrigin;
      }

      // Feed the local capture store (manual-injection use case). Same
      // payload the devtools panel consumes, so the resulting JSON is
      // identical to a panel-side Save Capture.
      if (this._localCapture) {
        this._localCapture.processMessage(message);
      }

      // If _window is null, we're in a worker context. Send the message to the main thread,
      // which will then send it to the devtools panel.
      if (!_window) {
        _postMessage({ __WebGPUInspector: message });
      } else {
        _dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: message }));
      }
    }

    // Called before a GPU method is called, allowing the inspector to modify
    // the arguments or the object before the method is called.
    _preMethodCall(object, method, args) {
      // Don't include requestAdapter and requestDevice in the command count.
      if (method !== "requestAdapter" && method !== "requestDevice") {
        this._frameGpuCommandCount++;
      }

      if (method === "destroy") {
        if (object === this._device?.deref()) {
          if (this._pendingMapCount) {
            this._hasPendingDeviceDestroy = true;
            return true;
          }
        }
      }

      if (method === "requestDevice") {
        // Opportunistically add "timestamp-query" so the capture panel can
        // profile pass durations. Only request it on adapters that expose it —
        // adding an unsupported feature here would make requestDevice reject.
        if (args.length === 0) {
          args[0] = {};
        }
        if (object?.features?.has?.("timestamp-query")) {
          if (!args[0].requiredFeatures) {
            args[0].requiredFeatures = ["timestamp-query"];
          } else if (Array.from(args[0].requiredFeatures).indexOf("timestamp-query") === -1) {
            args[0].requiredFeatures = [...args[0].requiredFeatures, "timestamp-query"];
          }
          this._timestampQuerySupported = true;
        }
      }

      if (method === "setPipeline") {
        // If a shader has been recompiled, that means the pipelines that
        // used that shader were also re-created. Patch in the replacement
        // pipeline so the new version of the shader is used.
        let pipeline = args[0];
        const objectRef = this._objectReplacementMap.get(pipeline.__id);
        if (objectRef) {
          if (objectRef.replacement) {
            args[0] = objectRef.replacement;
          }
        }
      }

      if (method === "setBindGroup") {
        // If a shader has been recompiled, that means the pipelines that
        // used that shader were also re-created. Any BindGroups created
        // with a layout from pipeline.getBindGroupLayout(#) also need
        // to be re-created. Patch in the replacement BindGroup if there is one.
        let bindGroup = args[1];
        const objectRef = this._objectReplacementMap.get(bindGroup.__id);
        if (objectRef) {
          if (objectRef.replacement) {
            args[1] = objectRef.replacement;
          }
        }
      }

      if (method === "createTexture") {
        // Add COPY_SRC usage to all textures so we can capture them
        args[0].usage |= GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING;
      }

      if (method === "createBuffer") {
        // Add COPY_SRC usage to all buffers so we can capture them
        if (!(args[0].usage & GPUBufferUsage.MAP_READ)) {
          args[0].usage |= GPUBufferUsage.COPY_SRC;
        }
      }

      if (method === "createShaderModule" ||
          method === "createRenderPipeline" ||
          method === "createComputePipeline" ||
          method === "createBindGroup") {
        if (this._errorChecking > 0) {
          this._gpuWrapper.disableRecording();
          object.pushErrorScope("validation");
          this._gpuWrapper.enableRecording();
        }
      }

      if (method === "beginRenderPass" || method === "beginComputePass") {
        if (this._captureTimestamps && this._captureFrameRequest) {
          if (!this._timestampQuerySet && object.__device) {
            // Disable recording around the inspector's own device calls so the
            // captured command list isn't polluted with the QuerySet/Buffer
            // creation and command IDs stay aligned with what the page did.
            this.disableRecording();
            this._timestampQuerySet = object.__device.createQuerySet({
              type: "timestamp",
              count: this._maxTimestamps
            });
            this._timestampBuffer = object.__device.createBuffer({
              size: this._maxTimestamps * 8,
              usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC
            });
            this.enableRecording();
          }

          if (this._timestampQuerySet &&
              !args[0].timestampWrites &&
              this._timestampIndex + 1 < this._maxTimestamps) {
            args[0] = { ...args[0], timestampWrites: {
              querySet: this._timestampQuerySet,
              beginningOfPassWriteIndex: this._timestampIndex,
              endOfPassWriteIndex: this._timestampIndex + 1
            } };
            this._timestampIndex += 2;
          }
        }
      }

      // We want to be able to capture canvas textures, so we need to add COPY_SRC to
      // the usage flags of any textures created from canvases.
      if ((object instanceof GPUCanvasContext) && method === "configure") {
        const descriptor = args[0];
        if (descriptor.usage) {
          descriptor.usage |= GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
        } else {
          descriptor.usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
        }
        // Keep tabs on the device that the context was initialized with.
        Object.defineProperty(object, "__device", { value: descriptor.device, enumerable: false, writable: true });
      }
    }

    // Called after a GPU method is called, allowing the inspector to wrap the result.
    _postMethodCall(object, method, args, result, stacktrace) {
      if (object instanceof GPURenderBundleEncoder && method !== "finish") {
        if (object._commands === undefined) {
          object._commands = [];
        }
        const newArgs = this._processCommandArgs(args);
        object._commands.push({ method, args: newArgs, result });
      }

      if (method === "beginRenderPass") {
        // object is a GPUCommandEncoder
        // result is a GPURenderPassEncoder
        Object.defineProperty(result, "__commandEncoder", { value: object, enumerable: false, writable: true });

        // Check to see if any of the color attachments are canvas textures.
        // We need to know this so we can capture the canvas texture after the
        // render pass is finished.
        for (const colorAttachment of args[0].colorAttachments) {
          if (!colorAttachment) {
            continue;
          }
          const view = colorAttachment.resolveTarget ?? colorAttachment.view;
          if (view) {
            if (view.__id < 0) {
              Object.defineProperty(object, "__rendersToCanvas", { value: true, enumerable: false, writable: true });
              const texture = view.__texture;
              if (texture && texture.__frameIndex < this._frameIndex) {
                const message = "An expired canvas texture is being used as an attachment for a RenderPass.";
                this._postMessage({ "action": Actions.ValidationError, id: 0, message, stacktrace });
              }
              break;
            }
          }
        }
      }

      if (method === "finish" && object instanceof GPURenderBundleEncoder) {
        result._commands = object._commands;
      }

      if (method === "finish" && object instanceof GPUCommandEncoder) {
        // Renders to canvas tracks whether the render pass encoder renders to a canvas.
        // We only want to capture canvas textures if it's been immediatley rendered to,
        // otherwise it will be black. Store the value in the command buffer so we can
        // see it from the submit function.
        Object.defineProperty(result, "__rendersToCanvas", { value: object.__rendersToCanvas, enumerable: false, writable: true });
      }

      if (method === "submit") {
        this.disableRecording();

        let timestampDstBuffer = null;
        if (this._timestampIndex > 0) {
          const commandEncoder = object.__device.createCommandEncoder();

          commandEncoder.resolveQuerySet(this._timestampQuerySet, 0, this._timestampIndex, this._timestampBuffer, 0);

          timestampDstBuffer = object.__device.createBuffer({
            size: this._timestampIndex * 8,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
          });
          Object.defineProperty(timestampDstBuffer, "__count", { value: this._timestampIndex, enumerable: false, writable: true });
          commandEncoder.copyBufferToBuffer(this._timestampBuffer, 0, timestampDstBuffer, 0, this._timestampIndex * 8);
          object.__device.queue.submit([commandEncoder.finish()]);
          this._timestampIndex = 0;
        }

        const self = this;

        if (this._captureTextureRequest.size > 0) {
          const commandBuffers = args[0];
          let rendersToCanvas = false;
          for (const commandBuffer of commandBuffers) {
            rendersToCanvas |= !!commandBuffer.__rendersToCanvas;
          }
          this._captureTextureRequest.forEach((tex, textureId) => {
            const id = textureId;
            const mipLevel = tex?.mipLevel ?? 0;
            if (id > 0 || rendersToCanvas) {
              const texture = tex?.texture || self._trackedObjects.get(id)?.deref();
              if (mipLevel === -1) {
                const mipLevelCount = texture.mipLevelCount ?? 1;
                const baseMipLevel = 0;
                for (let mipLevel = baseMipLevel; mipLevel < mipLevelCount; ++mipLevel) {
                  self._captureTextureBuffer(object.__device, null, texture, undefined, mipLevel);
                }
              } else {
                self._captureTextureBuffer(object.__device, null, texture, undefined, mipLevel);
              }
              self._captureTextureRequest.delete(id);
            }
          });
        }

        const captureBuffers = [...this._captureTempBuffers];
        this._captureTempBuffers.length = 0;

        const captureTextures = [...this._captureTexturedBuffers];
        this._captureTexturedBuffers.length = 0;

        const toDestroy = [...this._toDestroy];
        this._toDestroy.length = 0;

        this._pendingMapCount += captureBuffers.length + captureTextures.length;

        object.onSubmittedWorkDone().then( async () => {
          self.disableRecording();

          if (timestampDstBuffer) {
            self._sendTimestampBuffer(timestampDstBuffer.__count, timestampDstBuffer);
          }

          if (captureBuffers.length) {
            self._sendCapturedBuffers(captureBuffers);
          }
          if (captureTextures.length) {
            self._sendCaptureTextureBuffers(captureTextures);
          }
          for (const obj of toDestroy) {
            obj.destroy();
          }
          self.enableRecording();
        });

        this.enableRecording();
      }

      if (method === "createShaderModule" ||
          method === "createRenderPipeline" ||
          method === "createComputePipeline" ||
          method === "createBindGroup") {
        if (this._errorChecking > 0) {
          this.disableRecording();
          const self = this;
          object.popErrorScope().then((error) => {
            if (error) {
              console.error(error.message);
              const id = result?.__id ?? 0;
              self._postMessage({ "action": Actions.ValidationError, id, "message": error.message, stacktrace });
            }
          });
          this.enableRecording();
        }
      }

      if (method === "end") {
        /*if (this._errorChecking > 0) {
          const device = object.__device;
          if (device) {
            this.disableRecording();
            device.popErrorScope().then((error) => {
              if (error) {
                console.error(error.message);
                self._postMessage({ "action": Actions.ValidationError, "message": error.message, stacktrace });
              }
            });
            this.enableRecording();
          }
        }*/
      }

      let id = undefined;

      // Canvas textures will have a negative id, which is the negative of the context's id.
      if (method === "getCurrentTexture") {
        // object is a GPUCanvasContext
        if (!object.__id) {
          // If the context hasn't been captured yet, do it now.
          this._wrapObject(object);
          this._trackObject(object.__id, object);
        }

        id = -object.__id;
        if (object.__canvasTexture) {
          object.__canvasTexture = new WeakRef(result);
          result.__frameIndex = this._frameIndex;
        } else {
          Object.defineProperty(object, "__canvasTexture", { value: new WeakRef(result), enumerable: false, writable: true });
          Object.defineProperty(result, "__frameIndex", { value: this._frameIndex, enumerable: false, writable: true });
        }
      } else if (method === "createView") {
        if (object.__id < 0) {
          id = object.__id - 0.5;
        }
      }

      if (object instanceof GPUDevice && object?.__id === undefined) {
        // If we haven't wrapped the object yet, so do it now.
        // Probably the GPUDevice where requestDevice happened
        // before we started recording.
        this._wrapDevice(null, object);

        // This probably means we haven't wrapped the adapter yet, either.
        if (!object.__adapter) {
          // The wrapper will pick up and register the resulting adapter.
          // We don't need the adapter to be a true owner of the device,
          // we're just using it for inspection purposes.
          navigator.gpu.requestAdapter().then((adapter) => {
            Object.defineProperty(object, "__adapter", { value: adapter, enumerable: false, writable: true });
          });
        }
      }

      if (result) {
        // Wrap GPU objects
        if (GPUObjectTypes.has(result.constructor)) {
          this._wrapObject(result, id);
        }

        if (method === "getBindGroupLayout") {
          Object.defineProperty(result, "__pipeline", { value: object, enumerable: false, writable: true });
          Object.defineProperty(result, "__bindGroupIndex", { value: args[0], enumerable: false, writable: true });
        }

        if (method === "createShaderModule" ||
            method === "createRenderPipeline") {
          Object.defineProperty(result, "__descriptor", { value: args[0], enumerable: false, writable: true });
          Object.defineProperty(result, "__device", { value: object, enumerable: false, writable: true });
          this._objectReplacementMap.set(result.__id, { id: result.__id, object: new WeakRef(result), replacement: null });
        } else if (method === "createRenderBundleEncoder") {
          Object.defineProperty(result, "__descriptor", { value: args[0], enumerable: false, writable: true });
          Object.defineProperty(result, "__device", { value: object, enumerable: false, writable: true });
        } else if (method === "getCurrentTexture") {
          result.__context = object;
          this._trackObject(result.__id, result);
          result.label = "CanvasTexture";
        } else if (method === "createTexture") {
          this._trackObject(result.__id, result);
        } else if (method === "createView" && !id) {
          this._trackObject(result.__id, result);
          Object.defineProperty(result, "__texture", { value: object, enumerable: false, writable: true });
          if (result.__id < 0) {
            result.label = "CanvasTextureView";
          }
        } else if (method === "createBuffer") {
          this._trackObject(result.__id, result);
        } else if (method === "createBindGroup") {
          this._trackObject(result.__id, result);
          Object.defineProperty(result, "__descriptor", { value: args[0], enumerable: false, writable: true });
          this._objectReplacementMap.set(result.__id, { id: result.__id, object: new WeakRef(result), replacement: null });
        } else if (method === "setBindGroup") {
          const descriptor = args[1].__descriptor;
          if (descriptor) {
            for (const entry of descriptor.entries) {
              if (entry.resource instanceof GPUTextureView && entry.resource.__id < 0) {
                // This is a canvas texture view
                const texture = entry.resource.__texture;
                if (texture.__frameIndex < this._frameIndex) {
                  const message = `A BindGroup(${object.__id}) with an expired canvas texture is being used.`;
                  this._postMessage({ "action": Actions.ValidationError, id: 0, message, stacktrace });
                }
              }
            }
          }
        }
      }

      this._recordCommand(object, method, result, args, stacktrace);
    }

    // Called when an async GPU method promise is created, allowing the inspector to wrap the result.
    _onAsyncPromise(object, method, args, id, stacktrace) {
      switch (method) {
        case "createRenderPipelineAsync":
          this._sendAddObjectMessage(id, object.__id, "RenderPipeline", this._stringifyDescriptor(args[0]), stacktrace, true);
          break;
        case "createComputePipelineAsync":
          this._sendAddObjectMessage(id, object.__id, "ComputePipeline", this._stringifyDescriptor(args[0]), stacktrace, true);
          break;
        default:
          this._postMethodCall(object, method, args, id, stacktrace);
          break;
      }
    }

    // Called when an async GPU method promise resolves, allowing the inspector to wrap the result.
    _onAsyncResolve(object, method, args, id, result, stacktrace) {
      if (method === "requestAdapter") {
        const adapter = result;
        if (adapter) {
          this._wrapAdapter(result, id, stacktrace);
        }
      } else if (method === "requestDevice") {
        const adapter = object;
        const device = result;
        if (device) {
          this._wrapDevice(adapter, device, id, args, stacktrace);
        }
      } else if (result) {
        this._wrapObject(result, id);
        this._postMessage({ action: Actions.ResolveAsyncObject, id: result.__id });
      }
    }

    // Wrap a GPUAdapter object for inspection.
    _wrapAdapter(adapter, id, stacktrace) {
      this._wrapObject(adapter, id);
      id ??= adapter.__id;
      const self = this;
      // When adapter.info becomes ubuquitous, we can remove the requestAdapterInfo check.
      if (adapter.info) {
        const info = {
          vendor: adapter.info.vendor,
          device: adapter.info.device,
          architecture: adapter.info.architecture,
          subgroupMinSize: adapter.info.subgroupMinSize,
          subgroupMaxSize: adapter.info.subgroupMaxSize,
          description: adapter.info.description,
          features: self._gpuToArray(adapter.features),
          limits: self._gpuToObject(adapter.limits),
          isFallbackAdapter: adapter.info.isFallbackAdapter,
          wgslFeatures: self._gpuToArray(navigator.gpu.wgslLanguageFeatures)
        };
        self._sendAddObjectMessage(id, 0, "Adapter", JSON.stringify(info), stacktrace);
      } else if (adapter.requestAdapterInfo) {
        adapter.requestAdapterInfo().then((infoObj) => {
          const info = {
            vendor: infoObj.vendor,
            architecture: infoObj.architecture,
            device: infoObj.device,
            description: infoObj.description,
            features: self._gpuToArray(adapter.features),
            limits: self._gpuToObject(adapter.limits),
            isFallbackAdapter: adapter.isFallbackAdapter,
            wgslFeatures: self._gpuToArray(navigator.gpu.wgslLanguageFeatures)
          };
          self._sendAddObjectMessage(id, 0, "Adapter", JSON.stringify(info), stacktrace);
        });
      }
    }

    // Wrap a GPUDevice object for inspection.
    _wrapDevice(adapter, device, id, args, stacktrace) {
      if (adapter && adapter.__id === undefined) {
        this._wrapAdapter(adapter, undefined, stacktrace);
      }

      if (device && device.__id === undefined) {
        device.queue.__device = device;

        const self = this;
        device.addEventListener("uncapturederror", (event) => {
          self._postMessage({ "action": Actions.ValidationError, id: 0, "message": event.error.message });
        });

        args ??= [];
        this._wrapObject(device, id);
        const descriptor = args[0] ?? {};
        const deviceId = device.__id;
        const adapterId = adapter?.__id ?? 0;
        descriptor["features"] = this._gpuToArray(device.features);
        descriptor["limits"] = this._gpuToObject(device.limits);
        this._trackObject(deviceId, device);
        this._sendAddObjectMessage(id, adapterId, "Device", JSON.stringify(descriptor), stacktrace);
        Object.defineProperty(device, "__adapter", { value: adapter, enumerable: false, writable: true });

        //this._device = device;
        this._device = new WeakRef(device);
      }
    }

    // Clear the captured frame commands.
    clear() {
      this._frameCaptureCommands.length = 0;
      this._captureFrameCommands.length = 0;
      this._currentFrame = null;
      this._commandId = 0;
    }

    // Get the next unique object ID.
    getNextId(object) {
      // We don't need unique id's for some types of objects
      // and they get created so frequently they make the ID's
      // grow too quickly.
      if (object instanceof GPUCommandEncoder ||
          object instanceof GPUComputePassEncoder ||
          object instanceof GPURenderPassEncoder ||
          object instanceof GPUCommandBuffer) {
        return 0;
      }
      return this._objectID++;
    }

    // Warn about potential GPU memory leaks.
    // This is called for buffers that are garbage collected without being explicitly destroyed.
    _memoryLeakWarning(id, object) {
      if (object) {
        const type = object.name;
        const message = `${type} was garbage collected without being explicitly destroyed. These objects should explicitly destroyed to avoid GPU memory leaks.`;
        this._postMessage({ "action": Actions.ValidationError, id: 0, "message": message });
      }
    }

    // Is the object a number, string, boolean, null, or undefined?
    _isPrimitiveType(obj) {
      return !obj || obj.constructor === String || obj.constructor === Number || obj.constructor === Boolean;
    }

    _isArrayBuffer(obj) {
      if (typeof SharedArrayBuffer === 'function') {
        return obj && (obj instanceof ArrayBuffer || obj instanceof SharedArrayBuffer);
      }
      return obj && obj instanceof ArrayBuffer;
    }

    // Is the object a typed array?
    _isTypedArray(obj) {
      return obj && (obj instanceof ArrayBuffer || this._isArrayBuffer(obj.buffer));
    }

    // Is the object a regular array?
    _isArray(obj) {
      return obj && obj.constructor === Array;
    }

    // Duplicate an array, optionally replacing GPU objects with their IDs so it can be serialized
    // for sending to the devtools panel.
    _duplicateArray(array, replaceGpuObjects) {
      const newArray = new Array(array.length);
      for (let i = 0, l = array.length; i < l; ++i) {
        const x = array[i];
        if (this._isPrimitiveType(x)) {
          newArray[i] = x;
        } else if (x.__id !== undefined) {
          if (replaceGpuObjects) {
            // Replace GPU objects with an object containing just the id and class name.
            // This allows the devtools panel to reference its version of the object.
            newArray[i] = { __id: x.__id, __class: x.constructor.name };
          } else {
            newArray[i] = x;
          }
        } else if (this._isTypedArray(x)) {
          newArray[i] = x;
        } else if (this._isArray(x)) {
          // Arrays and objects can be nested, so duplicate them recursively.
          newArray[i] = this._duplicateArray(x, replaceGpuObjects);
        } else if (x instanceof Object) {
          // Arrays and objects can be nested, so duplicate them recursively.
          newArray[i] = this._duplicateObject(x, replaceGpuObjects);
        } else {
          newArray[i] = x;
        }
      }
      return newArray;
    }

    // Duplicate an object, optionally replacing GPU objects with their IDs so it can be serialized
    // for sending to the devtools panel.
    _duplicateObject(object, replaceGpuObjects) {
      const obj = {};
      for (const key in object) {
        if (key.startsWith("_")) {
          continue;
        }
        const x = object[key];
        if (x === undefined) {
          continue;
        }
        if (this._isPrimitiveType(x)) {
          obj[key] = x;
        } else if (x.__id !== undefined) {
          if (replaceGpuObjects) {
            // Replace GPU objects with an object containing just the id and class name.
            // This allows the devtools panel to reference its version of the object.
            obj[key] = { __id: x.__id, __class: x.constructor.name };
          } else {
            obj[key] = x;
          }
        } else if (x.label !== undefined) {
          obj[key] = x;
        } else if (this._isTypedArray(x)) {
          obj[key] = x;
        } else if (this._isArray(x)) {
          // Arrays and objects can be nested, so duplicate them recursively.
          obj[key] = this._duplicateArray(x, replaceGpuObjects);
        } else if (x instanceof Object) {
          // Arrays and objects can be nested, so duplicate them recursively.
          obj[key] = this._duplicateObject(x, replaceGpuObjects);
        } else {
          obj[key] = x;
        }
      }
      return obj;
    }

    // If a shader was overridden with edited code, revert it to the original shader.
    _revertShader(shaderId) {
      const objectMap = this._objectReplacementMap.get(shaderId);
      if (!objectMap) {
        return;
      }
      const shader = objectMap.object?.deref();
      if (!shader) {
        return;
      }

      objectMap.replacement = null;

      // Any pipelines that used this shader need to be reverted as well.
      for (const objectRef of this._objectReplacementMap.values()) {
        const pipelineObject = objectRef.object.deref();
        const isRenderPipeline = pipelineObject instanceof GPURenderPipeline;
        const isComputePipeline = pipelineObject instanceof GPUComputePipeline;
        if (isRenderPipeline || isComputePipeline) {
          const descriptor = pipelineObject.__descriptor;

          let found = false;

          if (descriptor.vertex?.module === shader) {
            found = true;
          }
          if (descriptor.fragment?.module === shader) {
            found = true;
          }
          if (descriptor.compute?.module === shader) {
            found = true;
          }

          if (found) {
            objectRef.replacement = null;

            // Any BindGroup that was created with a BindGroupLayout from pipeline.getBindGroupLayout(#)
            // need to be reverted as well.
            for (const objectRef of this._objectReplacementMap.values()) {
              const bindGroup = objectRef.object.deref();
              if (bindGroup instanceof GPUBindGroup) {
                const descriptor = bindGroup.__descriptor;
                let layout = descriptor.layout;
                if (layout instanceof GPUBindGroupLayout) {
                  const parentPipeline = layout.__pipeline;
                  if (parentPipeline === pipelineObject) {
                    objectRef.replacement = null;
                  }
                }
              }
            }
          }
        }
      }
    }

    // Replace a shader with a new shader with the given code.
    // This is used for editing shaders live.
    _compileShader(shaderId, code) {
      const objectMap = this._objectReplacementMap.get(shaderId);
      if (!objectMap) {
        return;
      }
      const shader = objectMap.object?.deref();
      if (!shader) {
        return;
      }

      const device = shader.__device;
      const descriptor = this._duplicateObject(shader.__descriptor);
      descriptor.code = code;

      this.disableRecording();
      this._errorChecking--;
      device.pushErrorScope("validation");
      Object.defineProperty(descriptor, "__replacement", { value: shaderId, enumerable: false, writable: true });
      const newShaderModule = device.createShaderModule(descriptor);
      const self = this;
      device.popErrorScope().then((error) => {
        if (error) {
          console.error(error.message);
          const id = shaderId ?? 0;
          self._postMessage({ "action": Actions.ValidationError, id, "message": error.message });
        }
      });
      this._errorChecking++;
      this.enableRecording();

      objectMap.replacement = newShaderModule;

      // Create replacements for any RenderPipeline that uses shaderId
      for (const objectRef of this._objectReplacementMap.values()) {
        const object = objectRef.object.deref();
        const isRenderPipeline = object instanceof GPURenderPipeline;
        const isComputePipeline = object instanceof GPUComputePipeline;
        if (isRenderPipeline || isComputePipeline) {
          const descriptor = object.__descriptor;

          let found = false;
          let newDescriptor = null;
          let vertexModule = null;
          let fragmentModule = null;
          let computeModule = 0;

          if (descriptor.vertex?.module === shader) {
            vertexModule = shader;
            if (!newDescriptor) {
              newDescriptor = this._duplicateObject(descriptor);
            }
            found = true;
            newDescriptor.vertex.module = newShaderModule;
          }
          if (descriptor.fragment?.module === shader) {
            fragmentModule = shader;
            if (!newDescriptor) {
              newDescriptor = this._duplicateObject(descriptor);
            }
            found = true;
            newDescriptor.fragment.module = newShaderModule;
          }
          if (descriptor.compute?.module === shader) {
            computeModule = shader;
            if (!newDescriptor) {
              newDescriptor = this._duplicateObject(descriptor);
            }
            found = true;
            newDescriptor.compute.module = newShaderModule;
          }

          if (found) {
            this.disableRecording();
            this._errorChecking--;
            Object.defineProperty(newDescriptor, "__replacement", { value: objectRef.id, enumerable: false, writable: true });
            device.pushErrorScope("validation");
            const newPipeline = isRenderPipeline ?
                device.createRenderPipeline(newDescriptor) :
                device.createComputePipeline(newDescriptor);
            const self = this;
            device.popErrorScope().then((error) => {
              if (error) {
                console.error(error.message);
                const id = objectRef.id ?? 0;
                self._postMessage({ "action": Actions.ValidationError, id, "message": error.message });
              }
            });
            this._errorChecking++;
            this.enableRecording();

            objectRef.replacement = newPipeline;

            // If any BindGroup was created with a BindGroupLayout from pipeline.getBindGroupLayout(#),
            // We need to recreate those as well.
            for (const bindGroupRef of this._objectReplacementMap.values()) {
              const bindGroup = bindGroupRef.object.deref();
              if (bindGroup instanceof GPUBindGroup) {
                const descriptor = bindGroup.__descriptor;
                let layout = descriptor.layout;
                if (layout instanceof GPUBindGroupLayout) {
                  const parentPipeline = layout.__pipeline;
                  const bindGroupIndex = layout.__bindGroupIndex;
                  if (parentPipeline === object) {
                    layout = objectRef.replacement.getBindGroupLayout(bindGroupIndex);
                    const newBindGroupDescriptor = this._duplicateObject(descriptor);
                    newBindGroupDescriptor.layout = layout;
                    this.disableRecording();
                    Object.defineProperty(newBindGroupDescriptor, "__replacement", { value: bindGroupRef.id, enumerable: false, writable: true });
                    const newBindGroup = device.createBindGroup(newBindGroupDescriptor);
                    this.enableRecording();
                    bindGroupRef.replacement = newBindGroup;
                  }
                }
              }
            }
          }
        }
      }
    }

    // The devtools panel has requested a texture to be captured.
    _requestTexture(textureId, mipLevel) {
      mipLevel = parseInt(mipLevel || 0) || 0;
      if (textureId < 0) {
        this._captureTextureRequest.set(textureId, null);
      } else {
        const ref = this._trackedObjects.get(textureId);
        const texture = ref?.deref();
        if (texture instanceof GPUTexture) {
          if (texture.__device) {
            this._captureTextureBuffer(texture.__device, null, texture, undefined, mipLevel);
            const captureTextures = [...this._captureTexturedBuffers];
            this._captureTexturedBuffers.length = 0;
            const toDestroy = [...this._toDestroy];
            this._toDestroy.length = 0;

            if (captureTextures.length) {
              this._pendingMapCount += captureTextures.length;
              const self = this;
              texture.__device.queue.onSubmittedWorkDone().then(() => {
                self.disableRecording();
                self._sendCaptureTextureBuffers(captureTextures);
                for (const obj of toDestroy) {
                  obj.destroy();
                }
                self.enableRecording();
              });
              return;
            }
          }
          this._captureTextureRequest.set(textureId, { texture, mipLevel });
        }
      }
    }

    // Update the status overlay message.
    _updateStatusMessage() {
      if (!this._inspectingStatusFrame) {
        return;
      }

      let status = "";

      if (this._captureTexturedBuffers.length > 0) {
        status += `Texture: ${this._captureTexturedBuffers.length} `;
      }

      if (this._mappedTextureBufferCount > 0) {
        status += `Pending Texture Reads: ${this._mappedTextureBufferCount} `;
      }

      if (this._captureBuffersCount) {
        status += `Buffers: ${this._captureBuffersCount} `;
      }

      if (this._mappedBufferCount > 0) {
        status += `Pending Buffer Reads: ${this._mappedBufferCount} `;
      }

      if (status) {
        status = `Capturing: ${status} `;
      }

      if (this._captureFrameRequest) {
        status = `Recording (click to stop): ${status}`;
        this._inspectingStatusText.title = "Click to stop recording";
      } else {
        this._inspectingStatusText.title = "";
      }

      this._inspectingStatusText.textContent = status;
    }

    // Update the frame rate overlay.
    _updateFrameRate(deltaTime) {
      this._frameRate.add(deltaTime);
      this._frameIndex++;
      if (this._inspectingStatusFrame) {
        this._updateFrameStatus();
      }
    }

    // Update the frame status overlay.
    _updateFrameStatus() {
      if (this._inspectingStatusFrame) {
        let statusMessage = `Frame: ${this._frameIndex}`;
        const frameRate = this._frameRate.average;
        if (frameRate !== 0) {
          statusMessage += ` : ${frameRate.toFixed(2)}ms`;
        }
        this._inspectingStatusFrame.textContent = statusMessage;
      }
    }

    // Begin capturing frame data based on the settings passed in _captureData from the devtools panel.
    _initCaptureData() {
      if (this._captureData.frame < 0 || this._gpuFrameIndex >= this._captureData.frame) {
        this._captureMaxBufferSize = this._captureData.maxBufferSize || maxBufferCaptureSize;
        this._captureFrameCount = this._captureData.captureFrameCount || captureFrameCount;
        this._captureFrameRequest = true;
        // Stacktraces during frame capture are opt-in: they're cheap individually but
        // a few thousand per frame dominates the CaptureFrameCommands payload size.
        // Create-method stacktraces (in GPUObjectWrapper) are unaffected and still fire.
        this._gpuWrapper.recordStacktraces = !!this._captureData.captureStacktraces;
        // Profile Passes is opt-in from the panel. The actual per-pass timestampWrites
        // injection happens in _preMethodCall on beginRenderPass/beginComputePass; the
        // device must have been requested with "timestamp-query", which only happens
        // when the adapter exposes it (see the guard around requestDevice).
        this._captureTimestamps = !!this._captureData.captureTimestamps && this._timestampQuerySupported;
        this._timestampIndex = 0;
        this._captureData = null;
        this._commandId = 0;
        this._updateStatusMessage();
      }
    }

    // Called at the start of each frame, before the requestAnimationFrame callback is invoked.
    _frameStart(time) {
      this._frameGpuCommandCount = 0;

      let deltaTime = 0;
      if (this._lastFrameTime == 0) {
        this._lastFrameTime = time;
      } else {
        deltaTime = time - this._lastFrameTime;
        this._postMessage({ "action": Actions.DeltaTime, deltaTime });
        this._lastFrameTime = time;

        this._frameRate.add(deltaTime);
      }

      if (_sessionStorage) {
        const captureData = _sessionStorage.getItem(webgpuInspectorCaptureFrameKey);
        if (captureData) {
          try {
            this._captureData = JSON.parse(captureData);
          } catch (e) {
            this._captureData = null;
          }
          _sessionStorage.removeItem(webgpuInspectorCaptureFrameKey);

        }
      }

      if (this._captureData) {
        this._initCaptureData();
      }

      if (this._captureFrameCount <= 0) {
        this._frameData.length = 0;
        this._captureFrameCommands.length = 0;
        this._frameRenderPassCount = 0;
        this._frameIndex++;
      }

      if (this._inspectingStatusFrame) {
        this._updateFrameStatus();
        this._updateStatusMessage();
      }
    }

    // Send all captured frame commands to the devtools panel.
    _sendCapturedCommands() {
      const maxFrameCount = 2000;

      let commands = null;
      if (this._frameCaptureCommands.length === 1) {
        commands = this._frameCaptureCommands[0];
      } else {
        commands = [];
        for (const frameCommands of this._frameCaptureCommands) {
          commands.push(...frameCommands);
        }
      }
      this._frameCaptureCommands = [];

      const batches = Math.ceil(commands.length / maxFrameCount);
      this._postMessage({ "action": Actions.CaptureFrameResults, "frame": this._frameIndex, "count": commands.length, "batches": batches });

      for (let i = 0; i < commands.length; i += maxFrameCount) {
        const length = Math.min(maxFrameCount, commands.length - i);
        const commandsSlice = commands.slice(i, i + length);
        this._postMessage({
            "action": Actions.CaptureFrameCommands,
            "frame": this._frameIndex - 1,
            "commands": commandsSlice,
            "index": i,
            "count": length
          });
      }

      this._commandId = 0;
      this._captureFrameRequest = false;
      this._gpuWrapper.recordStacktraces = false;
      this._updateStatusMessage();
    }

    // Called at the end of each frame, after the requestAnimationFrame callback have been invoked.
    _frameEnd(time) {
      if (this._frameGpuCommandCount > 0) {
        this._gpuFrameIndex++;
        this._frameGpuCommandCount = 0;
      }

      // If we're captureing frames, and some commands have been recorded, send them to the devtools panel.
      if (this._captureFrameCommands.length) {
        this._frameCaptureCommands.push(this._captureFrameCommands);
        if (this._captureFrameCommands.length === 1) {
          if (this._captureFrameCommands[0].method === "requestAdapter" ||
              this._captureFrameCommands[0].method === "requestDevice") {
            // Don't count requestAdapter and requestDevice as frames.
            this._captureFrameCount++;
          }
        }
        this._captureFrameCommands = [];
        this._captureFrameCount--;
        // If we're capturing multiple frames, wait until all frames have been captured.
        if (this._captureFrameCount <= 0) {
          this._sendCapturedCommands();
        }
      }

      this._updateStatusMessage();
    }

    _trackObject(id, object) {
      this._trackedObjects.set(id, new WeakRef(object));
      this._trackedObjectInfo.set(id, object.constructor);
    }

    _wrapCanvas(canvas) {
      if (canvas.__id) {
        return;
      }

      Object.defineProperty(canvas, "__id", { value: this.getNextId(canvas), enumerable: false, writable: true });
      this._trackObject(canvas.__id, canvas);

      const self = this;
      const __getContext = canvas.getContext;

      canvas.getContext = function (a1, a2) {
        const result = __getContext.call(canvas, a1, a2);
        if (result instanceof GPUCanvasContext) {
          self._wrapObject(result);
          self._trackObject(result.__id, result);
        }
        return result;
      };
    }

    _wrapObject(object, id) {
      // The object has already been wrapped
      if (!object || object.__id !== undefined) {
        return;
      }

      Object.defineProperty(object, "__id", { value: id ?? this.getNextId(object), enumerable: false, writable: true });

      // Track garbage collected objects
      this._garbageCollectionRegistry.register(object, object.__id);

      if (object.label !== undefined) {
        // Capture chaning of the GPUObjectBase label
        const l = object.label;
        object._label = l;
        const self = this;
        Object.defineProperty(object, "label", {
         enumerable: true,
          configurable: true,
          get() {
            return this._label;
          },
          set(label) {
            if (label !== this._label) {
              this._label = label;
              const id = this.__id;
              self._postMessage({ "action": Actions.ObjectSetLabel, id, label });
            }
          }
        });
      }

      if (object instanceof GPUDevice) {
        // Automatically wrap the device's queue
        if (object.queue.__id === undefined) {
          this._wrapObject(object.queue);
        }
      }
    }

    _gpuToArray(gpu) {
      const array = [];
      if (gpu) {
        for (const v of gpu) {
          array.push(v);
        }
      }
      return array;
    }

    _gpuToObject(gpu) {
      const obj = {};
      if (gpu) {
        for (const v in gpu) {
          obj[v] = gpu[v];
        }
      }
      return obj;
    }

    _stringifyDescriptor(args) {
      const descriptor = this._duplicateObject(args, true) ?? {};
      let s = null;
      try {
        s = JSON.stringify(descriptor);
      } catch (e) {
        console.log(e.message);
      }
      return s;
    }

    _sendAddObjectMessage(id, parent, type, descriptor, stacktrace, pending) {
      this._postMessage({ "action": Actions.AddObject, id, parent, type, descriptor, stacktrace, pending });
    }

    _destroyDevice() {
      this._device.deref()?.destroy();
      /*if (this._captureFrameCommands.length) {
        this._sendCapturedCommands();
      }
      this._device = null;
      const id = object.__id;
        object.__destroyed = true;
        // Don't remove canvas textures from the tracked objects, which have negative id's.
        // These are frequently created and destroyed via getCurrentTexture.
        if (id > 0) {
          this._trackedObjects.delete(id);
          this._trackedObjectInfo.delete(id);
          this._objectReplacementMap.delete(id);
        }
        if (object instanceof GPUBindGroup) {
          this._bindGroupCount--;
        }
        if (id >= 0) {
          this._captureTextureRequest.delete(id);
          this._postMessage({ "action": Actions.DeleteObject, id });
        }*/
    }

    _recordCommand(object, method, result, args, stacktrace) {
      const parent = object?.__id ?? 0;
      if (method === "destroy") {
        if (object === this._device?.deref()) {
          if (this._captureFrameCommands.length) {
            this._sendCapturedCommands();
          }
          this._device = null;
        }
        const id = object.__id;
        object.__destroyed = true;
        // Don't remove canvas textures from the tracked objects, which have negative id's.
        // These are frequently created and destroyed via getCurrentTexture.
        if (id > 0) {
          this._trackedObjects.delete(id);
          this._trackedObjectInfo.delete(id);
          this._objectReplacementMap.delete(id);
        }
        if (object instanceof GPUBindGroup) {
          this._bindGroupCount--;
        }
        if (id >= 0) {
          this._captureTextureRequest.delete(id);
          this._postMessage({ "action": Actions.DeleteObject, id });
        }
      } else if (method === "createShaderModule") {
        const id = result.__id;
        if (!args[0].__replacement) {
          this._sendAddObjectMessage(id, parent, "ShaderModule", this._stringifyDescriptor(args[0]), stacktrace);
        }
      } else if (method === "createBuffer") {
        const id = result.__id;
        this._sendAddObjectMessage(id, parent, "Buffer", this._stringifyDescriptor(args[0]), stacktrace);
      } else if (method === "createTexture") {
        const id = result.__id;
        this._sendAddObjectMessage(id, parent, "Texture", this._stringifyDescriptor(args[0]), stacktrace);
        result.__device = object;
      } else if (method === "getCurrentTexture") {
        const id = result.__id;
        if (result) {
          const info = {
            size: [result.width, result.height, result.depthOrArrayLayers],
            mipLevelCount: result.mipLevelCount,
            sampleCount: result.sampleCount,
            dimension: result.dimension,
            format: result.format,
            usage: result.usage
          };
          const infoStr = JSON.stringify(info);
          this._sendAddObjectMessage(id, parent, "Texture", infoStr, stacktrace);
        }
      } else if (method === "createView") {
        const id = result.__id;
        result.__texture = object;
        this._sendAddObjectMessage(id, parent, "TextureView", this._stringifyDescriptor(args[0]), stacktrace);
      } else if (method === "createSampler") {
        const id = result.__id;
        this._sendAddObjectMessage(id, parent, "Sampler", this._stringifyDescriptor(args[0]), stacktrace);
      } else if (method === "createBindGroup") {
        this._bindGroupCount++;
        const id = result.__id;
        result.__descriptor = args[0];
        this._sendAddObjectMessage(id, parent, "BindGroup", this._stringifyDescriptor(args[0]), stacktrace);
      } else if (method === "createBindGroupLayout") {
        const id = result.__id;
       result.__descriptor = args[0];
        this._sendAddObjectMessage(id, parent, "BindGroupLayout", this._stringifyDescriptor(args[0]), stacktrace);
      } else if (method === "createPipelineLayout") {
        const id = result.__id;
        this._sendAddObjectMessage(id, parent, "PipelineLayout", this._stringifyDescriptor(args[0]), stacktrace);
      } else if (method === "createRenderPipeline") {
        const id = result.__id;
        if (!args[0].__replacement) {
          this._sendAddObjectMessage(id, parent, "RenderPipeline", this._stringifyDescriptor(args[0]), stacktrace);
          // There are cases when the shader modules used by the render pipeline will be garbage collected, and we won't be able to inspect them after that.
          // Hang on to the shader modules used in the descriptor by attaching them to the pipeline.
          if (args[0].vertex?.module) {
            result.__vertexModule = args[0].vertex?.module;
          }
          if (args[0].fragment?.module) {
            result.__fragmentModule = args[0].fragment?.module;
          }
        }
      } else if (method === "createComputePipeline") {
        const id = result.__id;
        if (!args[0].__replacement) {
          this._sendAddObjectMessage(id, parent, "ComputePipeline", this._stringifyDescriptor(args[0]), stacktrace);
          if (args[0].compute?.module) {
            result.__computeModule = args[0].compute?.module;
          }
        }
      } else if (method === "createCommandEncoder") {
        // We'll need the CommandEncoder's device for capturing textures
        result.__device = object;
      } else if (result instanceof GPURenderBundle) {
        const id = result.__id;
        const desc = object.__descriptor;
        desc.commands = result._commands;
        this._sendAddObjectMessage(id, parent, "RenderBundle", this._stringifyDescriptor(desc), stacktrace);
        delete desc.commands;
      }

      if (this._captureFrameRequest) {
        this._captureCommand(object, method, args, stacktrace, result);
      }
    }

    _captureCommand(object, method, args, stacktrace, result) {
      const commandId = this._commandId++;

      const a = args;
      if (a.length === 1 && a[0] === undefined) {
        a.length = 0;
      }

      if (method === "beginRenderPass" || method === "beginComputePass" ||
          method === "createCommandEncoder" || method === "createRenderPassEncoder" ||
          (method === "finish" && object instanceof GPUCommandEncoder)) {
        Object.defineProperty(result, "__id", { value: `_${commandId}`, enumerable: false, writable: true });
      }

      let newArgs = null;
      if (method === "setBindGroup") {
        newArgs = [];
        const binding = a[0];
        const bindGroup = a[1];
        newArgs.push(binding);
        newArgs.push(bindGroup);

        if (a.length > 2 && a[2]?.length) {
          const dynamicOffsetsData = a[2];
          if (dynamicOffsetsData.length > 0) {
            // Wasm can pass dynamic offsets as a buffer view with offset and size.
            // Convert that to a Uint32Array for easier passing to devtools.
            if (dynamicOffsetsData instanceof Uint32Array && a.length === 5) {
              const dynamicOffsetsDataStart = a[3];
              const dynamicOffsetsDataLength = a[4];
              // If dynamicOffsetsDataLength is 0, then there are no dynamic offsets.
              if (dynamicOffsetsDataLength > 0) {
                const dynamicOffsetsSubData = new Uint32Array(dynamicOffsetsData.buffer, dynamicOffsetsDataStart * 4, dynamicOffsetsDataLength);
                newArgs.push(dynamicOffsetsSubData);
              }
            } else {
              // Normal JS array of dynamic offsets.
              newArgs.push(dynamicOffsetsData);
            }
          }
        }

        const dynamicOffsets = (newArgs.length > 2) ? newArgs[2] : null;

        // Bind groups are immutable, so the static parts of the capture plan (which
        // entries reference buffers/views, sizes, and the dynamic-offset remap) only
        // need to be computed once per bind group. Cache the plan on the bind group.
        const plan = this._getBindGroupCapturePlan(bindGroup);
        if (plan) {
          // Reorder dynamic offsets by binding number once, instead of per-iteration
          // Map/sort/Uint32Array allocations.
          let mappedDynamicOffsets = null;
          if (plan.dynOffsetRemap !== null && dynamicOffsets) {
            const remap = plan.dynOffsetRemap;
            mappedDynamicOffsets = new Uint32Array(remap.length);
            for (let i = 0; i < remap.length; i++) {
              mappedDynamicOffsets[i] = dynamicOffsets[remap[i]];
            }
          }

          const bufferEntries = plan.bufferEntries;
          let dynIdx = 0;
          for (let i = 0; i < bufferEntries.length; i++) {
            const be = bufferEntries[i];
            const size = be.size;
            if (this._captureMaxBufferSize >= 0 && size > this._captureMaxBufferSize) {
              if (be.hasDynamicOffset && mappedDynamicOffsets) dynIdx++;
              continue;
            }
            let offset = be.baseOffset;
            if (be.hasDynamicOffset && mappedDynamicOffsets) {
              offset = mappedDynamicOffsets[dynIdx++];
            }
            if (!object.__captureBuffers) {
              object.__captureBuffers = [];
            }
            object.__captureBuffers.push({ commandId, entryIndex: be.entryIndex, buffer: be.buffer, offset, size });
            this._captureBuffersCount++;
          }

          const textureViewEntries = plan.textureViewEntries;
          if (textureViewEntries.length > 0) {
            if (!object.__captureTextureViews) {
              object.__captureTextureViews = new Set();
            }
            for (let i = 0; i < textureViewEntries.length; i++) {
              object.__captureTextureViews.add(textureViewEntries[i]);
            }
          }

          if (bufferEntries.length > 0 || textureViewEntries.length > 0) {
            this._updateStatusMessage();
          }
        }
      } else if (method === "writeBuffer") {
        newArgs = [];
        const buffer = a[0];
        const bufferOffset = a[1];
        newArgs.push(buffer);
        newArgs.push(bufferOffset);
        let data = a[2];
        if (a.length > 3) {
          const offset = a[3] ?? 0;
         const size = a[4];
          const buffer = this._isArrayBuffer(data) ? data : data.buffer;
          if (!buffer) {
            // It's a []<number>
          } else if (size > 0) {
            data = new Uint8Array(buffer, offset, size);
          } else if (offset > 0) {
            data = new Uint8Array(buffer, offset);
          }
        }
        // We can't push the actual data to the inspector server, it would be too much data.
        // Instead, we push a description of the data. If we actually want the data, we should
        // push it separately in chunks as an ID'd data block, and then reference that ID here.
        newArgs.push(data);
      } else {
        newArgs = a;
      }

      newArgs = this._processCommandArgs(newArgs);

      this._captureFrameCommands.push({
        "class": object.constructor.name,
        "object": object.__id,
        "result": result?.__id ?? 0,
        commandId,
        method,
        args: newArgs,
        stacktrace
      });

      if (method === "setVertexBuffer") {
        const slot = args[0];
        const buffer = args[1];
        const offset = args[2] ?? 0;
        const size = args[3] ?? (buffer.size - offset);
        if (!object.__captureBuffers) {
          object.__captureBuffers = [];
        }
        object.__captureBuffers.push({ commandId, entryIndex: slot, buffer, offset, size });
        this._captureBuffersCount++;
        this._updateStatusMessage();
      }

      if (method === "setIndexBuffer") {
        object.__indexBuffer = args;
        const buffer = args[0];
        const size = buffer.size;
        if (!object.__captureBuffers) {
          object.__captureBuffers = [];
        }
        object.__captureBuffers.push({ commandId, entryIndex: 0, buffer, offset: 0, size });
        this._captureBuffersCount++;
        this._updateStatusMessage();
      }

      if (method === "drawIndirect" || method === "drawIndexedIndirect" || method === "dispatchWorkgroupsIndirect") {
        const buffer = args[0];
       const offset = 0;
        const size = buffer.size;
        if (!object.__captureBuffers) {
          object.__captureBuffers = [];
        }
        object.__captureBuffers.push({ commandId, entryIndex: 0, buffer, offset, size });
        this._captureBuffersCount++;
        this._updateStatusMessage();
      }

      if (method === "beginRenderPass") {
        if (args[0]?.colorAttachments?.length > 0) {
          result.__captureRenderPassTextures = new Set();
          for (const attachment of args[0].colorAttachments) {
            if (!attachment) {
              continue;
            }
            const captureTextureView = attachment.resolveTarget ?? attachment.view;
            result.__captureRenderPassTextures.add(captureTextureView);
          }
        }
        result.__descriptor = args[0];
        if (args[0]?.depthStencilAttachment) {
          if (!result.__captureRenderPassTextures) {
            result.__captureRenderPassTextures = new Set();
          }
          const attachment = args[0].depthStencilAttachment;
          const captureTextureView = attachment.resolveTarget ?? attachment.view;
          result.__captureRenderPassTextures.add(captureTextureView);
        }
        this._inComputePass = false;
        result.__commandEncoder = object;
      } else if (method === "beginComputePass") {
        result.__commandEncoder = object;
        this._inComputePass = true;
      } else if (method === "end") {
        this._inComputePass = false;
        const commandEncoder = object.__commandEncoder;
        if (object.__captureBuffers?.length > 0) {
          this._recordCaptureBuffers(commandEncoder, object.__captureBuffers);
          object.__captureBuffers = [];
          this._updateStatusMessage();
        }

        if (object.__captureRenderPassTextures?.size > 0) {
          let passId = this._frameRenderPassCount * maxColorAttachments;
          for (const captureTextureView of object.__captureRenderPassTextures) {
            const texture = captureTextureView.__texture;
            if (texture) {
              this._captureTextureBuffer(commandEncoder?.__device, commandEncoder, texture, passId++);
            }
          }
          object.__captureRenderPassTextures.clear();
        }

        if (object.__captureTextureViews?.size > 0) {
          for (const captureTextureView of object.__captureTextureViews) {
            const texture = captureTextureView.__texture;
            if (texture) {
              const mipLevelCount = captureTextureView.mipLevelCount ?? texture.mipLevelCount ?? 1;
              const baseMipLevel = captureTextureView.baseMipLevel ?? 0;
              for (let mipLevel = baseMipLevel; mipLevel < mipLevelCount; ++mipLevel) {
                this._captureTextureBuffer(commandEncoder?.__device, commandEncoder, texture, -1, mipLevel);
                break; // Just capture the first mip level for now.
              }
            }
          }
          object.__captureTextureViews.clear();
        }
        object.__commandEncoder = null;
        if (object instanceof GPURenderPassEncoder) {
          this._frameRenderPassCount++;
        }
      }
    }

    _pendingMapFinished() {
      this._pendingMapCount--;
      if (this._pendingMapCount === 0) {
        if (this._hasPendingDeviceDestroy) {
          this._hasPendingDeviceDestroy = false;
          this._destroyDevice();
        }
      }
    }

    _sendCaptureTextureBuffers(buffers) {
      const textures = [];
      for (const textureBuffer of buffers) {
        textures.push(textureBuffer.id);
      }

      let totalChunks = 0;
      for (const textureBuffer of buffers) {
        const size = textureBuffer.tempBuffer.size;
        const numChunks = Math.ceil(size / maxDataChunkSize);
        totalChunks += numChunks;
      }

      this._postMessage({
        "action": Actions.CaptureTextureFrames,
        "chunkCount": totalChunks,
        "count": buffers.length,
        textures });

      for (const textureBuffer of buffers) {
        const { id, tempBuffer, passId, mipLevel, format, width, height, depthOrArrayLayers } = textureBuffer;

        this._mappedTextureBufferCount++;
        const self = this;
        tempBuffer.mapAsync(GPUMapMode.READ).then(() => {
          self._mappedTextureBufferCount--;
          self._updateStatusMessage();
          self.disableRecording();
          const range = tempBuffer.getMappedRange();
          let data = new Uint8Array(range);
          if (format === "stencil8") {
            data = self._stencilBufferToFloatData(data, width, height, depthOrArrayLayers);
          }
          // Own the data so we can destroy the temp buffer before encoding chunks.
          const owned = new Uint8Array(data).slice();
          tempBuffer.destroy();
          self._sendTextureData(id, passId, owned, mipLevel);
          self.enableRecording();
          self._pendingMapFinished();
        }).catch((e) => {
          console.error(e);
        });
      }
      this._updateStatusMessage();
    }

    _stencilBufferToFloatData(data, width, height, depthOrArrayLayers) {
      const srcBytesPerRow = (width + 255) & ~0xff;
      const dstBytesPerRow = ((width * 4) + 255) & ~0xff;
      const dst = new Uint8Array(dstBytesPerRow * height * depthOrArrayLayers);
      const dstFloats = new Float32Array(dst.buffer);
      const dstStride = dstBytesPerRow / 4;

      for (let layer = 0; layer < depthOrArrayLayers; ++layer) {
        const srcLayerOffset = layer * srcBytesPerRow * height;
        const dstLayerOffset = layer * dstStride * height;
        for (let y = 0; y < height; ++y) {
          const srcRowOffset = srcLayerOffset + y * srcBytesPerRow;
          const dstRowOffset = dstLayerOffset + y * dstStride;
          for (let x = 0; x < width; ++x) {
            dstFloats[dstRowOffset + x] = data[srcRowOffset + x];
          }
        }
      }

      return dst;
    }

    _sendTextureData(id, passId, data, mipLevel) {
      const size = data.length;
      const numChunks = Math.ceil(size / maxDataChunkSize);

      for (let i = 0; i < numChunks; ++i) {
        const offset = i * maxDataChunkSize;
        const chunkSize = Math.min(maxDataChunkSize, size - offset);
        const chunk = data.subarray(offset, offset + chunkSize);
        this._postMessage({
          "action": Actions.CaptureTextureData,
          id,
          passId,
          mipLevel,
          offset,
          size,
          index: i,
          count: numChunks,
          chunk: encodeBase64(chunk)
        });
      }
    }

    _getTextureUtils(device) {
      if (!device) {
        return null;
      }
      if (!device.__textureUtils) {
        device.__textureUtils = new TextureUtils(device);
      }
      return device.__textureUtils;
    }

    // Send buffer data associated with a command to the inspector server.
    // The data is sent in chunks since the message pipe can't handle very
    // much data at a time.
    _sendBufferData(commandId, entryIndex, data) {
      const size = data.length;
      const numChunks = Math.ceil(size / maxDataChunkSize);

      for (let i = 0; i < numChunks; ++i) {
        const offset = i * maxDataChunkSize;
        const chunkSize = Math.min(maxDataChunkSize, size - offset);
        // subarray (not slice): the caller owns `data`, so a copy per chunk would be wasted.
        // encodeBase64 reads bytes synchronously into a fresh string, so the chunk view's
        // lifetime is bounded by this call.
        const chunk = data.subarray(offset, offset + chunkSize);
        this._postMessage({
          "action": Actions.CaptureBufferData,
          commandId,
          entryIndex,
          offset,
          size,
          index: i,
          count: numChunks,
          chunk: encodeBase64(chunk)
        });
      }
    }

    _sendTimestampBuffer(count, buffer) {
      const self = this;
      this._pendingMapCount++;
      buffer.mapAsync(GPUMapMode.READ).then(() => {
        self.disableRecording();
        const range = buffer.getMappedRange();
        const data = new Uint8Array(range);
        self._sendBufferData(-1000, -1000, data);
        buffer.destroy();
        self.enableRecording();
        self._pendingMapFinished();
     }).catch((error) => {
        console.error(error);
      });
    }

    // Buffers associated with a command are recorded and then sent to the inspector server.
    // The data is sent in chunks since the message pipe can't handle very much data at a time.
    // Each entry in `buffers` is a pool: { tempBuffer, ranges: [{commandId, entryIndex, offset, size}] }.
    _sendCapturedBuffers(buffers) {
      if (buffers.length > 0) {
        let totalChunks = 0;
        let totalRanges = 0;
        for (const pool of buffers) {
          totalRanges += pool.ranges.length;
          for (const r of pool.ranges) {
            totalChunks += Math.ceil(r.size / maxDataChunkSize);
          }
        }

        this._postMessage({
          "action": Actions.CaptureBuffers,
          "count": totalRanges,
          "chunkCount": totalChunks });
      }

      for (const pool of buffers) {
        const tempBuffer = pool.tempBuffer;
        const ranges = pool.ranges;
        const self = this;
        this._mappedBufferCount++;
        this._updateStatusMessage();
        tempBuffer.mapAsync(GPUMapMode.READ).then(() => {
          self._mappedBufferCount--;
          self.disableRecording();
          self._updateStatusMessage();
          // Copy out of the mapped range so we can destroy immediately and don't
          // pin GPU memory while we're encoding chunks.
          const owned = new Uint8Array(tempBuffer.getMappedRange()).slice();
          tempBuffer.destroy();
          for (let i = 0; i < ranges.length; i++) {
            const r = ranges[i];
            self._sendBufferData(r.commandId, r.entryIndex, owned.subarray(r.offset, r.offset + r.size));
          }
          self.enableRecording();
          self._pendingMapFinished();
        }).catch((error) => {
          console.error(error);
        });
      }
    }

    // Builds (and memoizes) the per-bind-group capture plan: which entries reference
    // buffers (with their static offset/size and whether they consume a dynamic offset)
    // and which reference texture views. Also computes the remap from dynamic-offset
    // input order (positional in the BGL entries) to binding-number order.
    _getBindGroupCapturePlan(bindGroup) {
      if (!bindGroup) {
        return null;
      }
      if (bindGroup.__capturePlan) {
        return bindGroup.__capturePlan;
      }
      const desc = bindGroup.__descriptor;
      if (!desc || !desc.entries) {
        return null;
      }
      const bglEntries = desc.layout?.__descriptor?.entries;

      // Dynamic-offset remap: callers pass dynamic offsets in positional BGL-entry order,
      // but the original code reordered them by binding number before consuming positionally
      // against bindGroupDesc.entries. Preserve that behavior by building a fixed remap.
      let dynOffsetRemap = null;
      if (bglEntries) {
        const dynEntries = []; // [{binding, srcIndex}]
        let srcIndex = 0;
        for (let i = 0; i < bglEntries.length; i++) {
          if (bglEntries[i].buffer?.hasDynamicOffset) {
            dynEntries.push({ binding: parseInt(bglEntries[i].binding), srcIndex: srcIndex++ });
          }
        }
        if (dynEntries.length > 0) {
          dynEntries.sort((a, b) => a.binding - b.binding);
          dynOffsetRemap = new Uint32Array(dynEntries.length);
          for (let i = 0; i < dynEntries.length; i++) {
            dynOffsetRemap[i] = dynEntries[i].srcIndex;
          }
        }
      }

      const bufferEntries = [];
      const textureViewEntries = [];
      for (const entryIndex in desc.entries) {
        const entry = desc.entries[entryIndex];
        const layoutEntry = bglEntries ? bglEntries[entryIndex] : undefined;
        const buffer = entry?.resource?.buffer;
        if (buffer) {
          const baseOffset = entry.resource.offset ?? 0;
          const origSize = entry.resource.size ?? (buffer.size - baseOffset);
          bufferEntries.push({
            entryIndex,
            buffer,
            baseOffset,
            size: alignTo(origSize, 4),
            hasDynamicOffset: layoutEntry?.buffer?.hasDynamicOffset ?? false,
          });
        } else if (entry?.resource instanceof GPUTextureView) {
          textureViewEntries.push(entry.resource);
        }
      }

      const plan = { bufferEntries, textureViewEntries, dynOffsetRemap };
      bindGroup.__capturePlan = plan;
      return plan;
    }

    // Buffers associated with a command are recorded and then sent to the inspector server.
    // The data is copied to one or more pool buffers so that the original buffers can continue
    // to be used by the page, and so a render/compute pass only triggers one mapAsync per pool
    // instead of one per bound buffer.
    _recordCaptureBuffers(commandEncoder, buffers) {
      const device = commandEncoder?.__device;
      if (!device) {
        this._captureBuffersCount -= buffers.length;
        return;
      }

      // Build the packed plan: filter out destroyed buffers and assign each one a
      // 4-byte-aligned slot in a pool buffer.
      const plan = [];
      for (const info of buffers) {
        if (info.buffer.__destroyed) {
          continue;
        }
        plan.push({
          commandId: info.commandId,
          entryIndex: info.entryIndex,
          buffer: info.buffer,
          srcOffset: info.offset,
          size: info.size,
          alignedSize: (info.size + 3) & ~3,
        });
      }

      this._captureBuffersCount -= buffers.length;

      if (plan.length === 0) {
        return;
      }

      const maxBufferSize = device.limits.maxBufferSize;

      this.disableRecording();
      try {
        // Pack into as few pool buffers as possible while respecting maxBufferSize.
        let poolStart = 0;
        while (poolStart < plan.length) {
          let poolEnd = poolStart;
          let poolSize = 0;
          while (poolEnd < plan.length && poolSize + plan[poolEnd].alignedSize <= maxBufferSize) {
            poolSize += plan[poolEnd].alignedSize;
            poolEnd++;
          }
          if (poolEnd === poolStart) {
            // A single entry is larger than maxBufferSize; skip it. The _captureMaxBufferSize
            // gate in _captureCommand normally prevents this, but be defensive.
            poolStart++;
            continue;
          }

          let poolBuffer = null;
          try {
            poolBuffer = device.createBuffer({
              size: poolSize,
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
              label: "BUFFER CAPTURE POOL",
            });
          } catch (e) {
            console.log(e);
            poolStart = poolEnd;
            continue;
          }

          const ranges = new Array(poolEnd - poolStart);
          let cur = 0;
          for (let i = poolStart; i < poolEnd; i++) {
            const p = plan[i];
            try {
              commandEncoder.copyBufferToBuffer(p.buffer, p.srcOffset, poolBuffer, cur, p.alignedSize);
            } catch (e) {
              console.log(e);
            }
            ranges[i - poolStart] = { commandId: p.commandId, entryIndex: p.entryIndex, offset: cur, size: p.size };
            cur += p.alignedSize;
          }

          this._captureTempBuffers.push({ tempBuffer: poolBuffer, ranges });
          poolStart = poolEnd;
        }
      } finally {
        this.enableRecording();
      }
    }

    _isCompatibilityMode(device) {
      const adapter = device?.__adapter;
      if (adapter?.features.has("core-features-and-limits")) {
        if (!device?.features.has("core-features-and-limits")) {
          return true;
        }
      }
      return false;
    }

    // Copy the texture to a buffer so we can send it to the inspector server.
    // The texture data is copied to a buffer now, then after the frame has finished
    // the buffer data is sent to the inspector server.
    _captureTextureBuffer(device, commandEncoder, texture, passId, mipLevel) {
      // can't capture canvas texture
      if (!device) {
        return;
      }

      const doSubmit = !commandEncoder;
      commandEncoder ??= device.createCommandEncoder();

      mipLevel ??= 0;
      passId ??= -1;

      mipLevel = Math.max(Math.min(mipLevel, (texture?.mipLevelCount ?? 1) - 1), 0);

      const id = texture.__id;
      let format = texture.format;
      let formatInfo = format ? TextureFormatInfo[format] : undefined;
      let copyMipLevel = mipLevel;
      if (!formatInfo) { // GPUExternalTexture?
        return;
      }

      for (const captureTexture of this._captureTexturedBuffers) {
        if (captureTexture.id === id && captureTexture.passId === passId && captureTexture.mipLevel === mipLevel) {
          return;
        }
      }

      if (formatInfo.isDepthStencil && formatInfo.hasDepth) {
        this.disableRecording();
        try {
          const textureUtils = this._getTextureUtils(device);
          // depth24plus texture's can't be copied to a buffer,
          // https://github.com/gpuweb/gpuweb/issues/652,
          // convert it to a float texture.
          texture = textureUtils.copyDepthTexture(texture, "r32float", commandEncoder, mipLevel);
        } catch (e) {
          this.enableRecording();
          console.log(e);
          return;
       }
        this.enableRecording();
        format = texture.format;
        formatInfo = format ? TextureFormatInfo[format] : undefined;
        texture.__id = id;
        copyMipLevel = 0;
        this._toDestroy.push(texture); // Destroy the temp texture at the end of the frame
      } else if (formatInfo.isDepthStencil && formatInfo.hasStencil) {
        formatInfo = TextureFormatInfo["stencil8"];
      } else if (texture.sampleCount > 1) {
        this.disableRecording();
        try {
          const textureUtils = this._getTextureUtils(device);
          texture = textureUtils.copyMultisampledTexture(texture);
          texture.__id = id;
          this._toDestroy.push(texture); // Destroy the temp texture at the end of the frame
        } catch (e) {
          this.enableRecording();
          console.log(e);
          return;
        }
        this.enableRecording();
      }

      const width = (texture.width >> copyMipLevel) || 1;
      const height = (texture.height >> copyMipLevel) || 1;
      const depthOrArrayLayers = texture.depthOrArrayLayers || 1;
      const texelByteSize = formatInfo.bytesPerBlock;
      const bytesPerRow = (width * texelByteSize + 255) & ~0xff;
      const rowsPerImage = height;
      let bufferSize = bytesPerRow * rowsPerImage * depthOrArrayLayers;
      if (!bufferSize || width < formatInfo.blockWidth || height < formatInfo.blockHeight) {
        return;
      }
      const copySize = { width, height, depthOrArrayLayers };

      const maxBufferSize = device.limits.maxBufferSize;
      if (bufferSize > maxBufferSize) {
        // Limit layers to fit within the max buffer size
        const maxLayers = Math.max(1, Math.floor(maxBufferSize / (bytesPerRow * rowsPerImage)));
        copySize.depthOrArrayLayers = Math.min(depthOrArrayLayers, maxLayers);
        bufferSize = bytesPerRow * rowsPerImage * copySize.depthOrArrayLayers;
        // If a single layer still exceeds the limit, limit the height
        if (bufferSize > maxBufferSize) {
          const blockHeight = formatInfo.blockHeight || 1;
          const maxRows = Math.max(blockHeight, Math.floor(maxBufferSize / bytesPerRow) & ~(blockHeight - 1));
          copySize.height = Math.min(height, maxRows);
          copySize.depthOrArrayLayers = 1;
          bufferSize = bytesPerRow * copySize.height;
        }
      }

      let tempBuffer = null;
      try {
        this.disableRecording();

        tempBuffer = device.createBuffer({
          size: bufferSize,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const aspect = formatInfo.hasStencil ? "stencil-only" : "all";

        commandEncoder.copyTextureToBuffer(
          { texture, aspect, mipLevel: copyMipLevel },
          { buffer: tempBuffer, bytesPerRow, rowsPerImage: copySize.height },
          copySize
        );

      } catch (e) {
        console.log(e);
      }

      if (doSubmit) {
        device.queue.submit([commandEncoder.finish()]);
      }

      this.enableRecording();

     if (tempBuffer) {
        this._captureTexturedBuffers.push({ id, tempBuffer, width: copySize.width, height: copySize.height, depthOrArrayLayers: copySize.depthOrArrayLayers, format, passId, mipLevel });
        this._updateStatusMessage();
      }
    }

    _addCommandData(data) {
      if (this._captureFrameRequest) {
        const id = this._frameData.length;
        this._frameData.push(data);
        return id;
      }
      return -1;
    }

    _isHTMLImageElement(object) {
      if (!_window) {
        return false;
      }
      return object instanceof HTMLImageElement ||
        object instanceof HTMLCanvasElement ||
        object instanceof HTMLVideoElement;
    }

    // Convert any objects to a string representation that can be sent to the inspector server.
    _processCommandArgs(object) {
      if (!object || object.constructor === Number || object.constructor === String || object.constructor === Boolean) {
        return object;
      }
      if (object.__id !== undefined) {
        return { "__id": object.__id, "__class": object.constructor.name };
      }
      if (object instanceof ImageBitmap ||
        object instanceof ImageData ||
        object instanceof OffscreenCanvas ||
        object instanceof VideoFrame ||
        this._isHTMLImageElement(object)) {
        return `@-1 ${object.constructor.name} ${object.width} ${object.height}`;
      }
      if (this._isArray(object) || this._isTypedArray(object)) {
        const maxMessageArrayLength = 100;
        if (object.length > maxMessageArrayLength) {
          const id = this._addCommandData(object);
          return `@${id} ${object.constructor.name} ${object.byteLength}`;
        }
        const newArray = [];
        for (const i in object) {
          newArray[i] = this._processCommandArgs(object[i]);
        }
        return newArray;
      }
      if (this._isArrayBuffer(object)) {
        const id = this._addCommandData(object);
        return `@${id} ${object.constructor.name} ${object.byteLength}`;
      }
      if (object instanceof Object) {
        const newObject = {};
        for (const key in object) {
          newObject[key] = this._processCommandArgs(object[key]);
        }
       return newObject;
      }
      return object;
    }
  }

  webgpuInspector = new WebGPUInspector();

  // Expose the inspector instance on the global so a page that loaded
  // webgpu_inspector.js via a script tag (manual injection / CDN) can call
  // initialize(), beginFrameCapture(), endFrameCapture(), saveCaptureData(),
  // or initializeServer() for the Claude Code plugin live bridge.
  try {
    Object.defineProperty(_self, "webgpuInspector", {
      value: webgpuInspector,
      writable: true,
      configurable: true
    });
  } catch (e) {
    _self.webgpuInspector = webgpuInspector;
  }

  // WebGPUInspector can inject itself into Web Workers (see the Worker proxy
  // below). Such a worker is created from a `blob:` URL, so it loses the
  // directory context of its original script — relative URLs passed to
  // fetch / importScripts / new URL() / new WebSocket() / new Request() would
  // resolve against the blob instead of the worker's real location.
  //
  // To compensate, an injected worker has the directory of its real script
  // baked into this placeholder and resolves relative URLs against it. The
  // placeholder is ONLY substituted for inspector-injected workers; on the
  // main page (and in manually-injected workers) it keeps its `<%=...%>` form,
  // so none of the URL rewriting below is installed there and the native
  // URL / WebSocket / Request globals are left untouched.
  let _webgpuBaseAddress = "<%=_webgpuBaseAddress%>";

  const _URL = URL;
  const _isInjectedWorker = !_webgpuBaseAddress.startsWith("<%=");

  if (_isInjectedWorker) {
    // Resolve a possibly-relative URL against the worker's real base address.
    const _getFixedUrl = (url) => {
      if (typeof url !== "string") {
        return url;
      }
      // A URL that parses standalone already has a scheme (http:, https:,
      // ws:, wss:, blob:, data:, ...). Leave it untouched so an already-
      // absolute URL is never re-encoded or normalized.
      try {
        new _URL(url);
        return url;
      } catch (e) {
        // Not absolute — fall through and resolve it against the base.
      }
      // `new URL(relative, base)` performs correct RFC-3986 resolution, which
      // handles "/abs", "rel", "./rel", "../rel", "?query" and "#hash" — all
      // cases the previous hand-rolled string concatenation got wrong.
      try {
        return new _URL(url, `${_webgpuBaseAddress}/`).href;
      } catch (e) {
        return url;
      }
    };

    const _origFetch = self.fetch;
    self.fetch = function (input, init) {
      // A Request argument already had its URL fixed when it was constructed
      // (Request is proxied below), so pass it through untouched.
      if (input instanceof Request) {
        return _origFetch(input, init);
      }
      return _origFetch(_getFixedUrl(input), init);
    };

    if (self.importScripts) {
      const _origImportScripts = self.importScripts;
      self.importScripts = function (...args) {
        return _origImportScripts(...args.map(_getFixedUrl));
      };
    }

    URL = new Proxy(URL, {
      construct(target, args, newTarget) {
        // Only rewrite when the URL is parsed standalone. When a base argument
        // is supplied, resolution is already correct relative to that base;
        // rewriting args[0] to an absolute URL would make the base be ignored.
        if (args.length > 0 && (args.length < 2 || args[1] === undefined)) {
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
        // The first argument may be an existing Request to clone; only a
        // string URL needs to be rewritten.
        if (args.length > 0 && typeof args[0] === "string") {
          args[0] = _getFixedUrl(args[0]);
        }
        return new target(...args);
      }
    });
  }

  // Intercept Worker creation to inject the inspector. Opt-in: the proxy is
  // only installed when the DevTools panel's "Inspect Workers" setting is on
  // (webgpu_inspector_loader.js sets this global before running the inspector),
  // or when a parent injected worker propagated the flag. Otherwise the native
  // Worker global is left untouched and workers run unmodified.
  if (_self.__webgpuInspectorInspectWorkers) {
    Worker = new Proxy(Worker, {
    construct(target, args, newTarget) {
      // Inject the inspector before the worker loads. The injected worker also
      // receives the inspect-workers flag so its own child workers are injected.
      let src = self.__webgpu_src ? `self.__webgpuInspectorInspectWorkers = true;self.__webgpu_src = ${self.__webgpu_src.toString()};self.__webgpu_src();` : "";

      let url = args[0];

      let _url = null;
      try {
        _url = new _URL(url);
      } catch {
        const baseUrl = new _URL(import.meta.url);
        const baseDir = baseUrl.pathname.substring(0, baseUrl.pathname.lastIndexOf("/"));
        const sep = url.startsWith("/") ? "" : "/";
        _url = new URL(`${baseUrl.protocol}//${baseUrl.host}${baseDir}${sep}${url}`);
      }

      // The base address is the worker script's host + directory. Relative
      // URLs inside the injected worker are resolved against it (see the
      // `_getFixedUrl` block above), since the worker itself loads from a
      // `blob:` URL that carries no directory context.
      const baseDir = _url.pathname.substring(0, _url.pathname.lastIndexOf("/"));
      const _webgpuBaseAddress = `${_url.protocol}//${_url.host}${baseDir}`;

      src = src.replaceAll(`<%=_webgpuBaseAddress%>`, `${_webgpuBaseAddress}`);

      if (args.length > 1 && args[1]?.type === "module") {
        // Use dynamic import with top-level await rather than a static import.
        // Static `import` is hoisted: the imported module would evaluate before
        // `self.__webgpu_src()` runs, so the fetch / URL / WebSocket / Request
        // proxies installed by the inspector would not yet be in place when the
        // user's worker code makes its first request against a relative URL.
        // `await import(...)` runs at this textual point and keeps the worker
        // module in evaluation state until the user's module finishes loading,
        // so any messages posted by the parent are queued until the user's
        // onmessage handler is installed.
        src += `await import(${JSON.stringify(_url.href)});`;
      } else {
        src += `importScripts(${JSON.stringify(_url.href)});`;
      }

      let blob = new Blob([src]);
      blob = blob.slice(0, blob.size, "text/javascript");
      args[0] = URL.createObjectURL(blob);

      const backing = new target(...args);
      backing.__webgpuInspector = true;

      window.addEventListener("__WebGPUInspector", (event) => {
        // Forward messages from the page to the worker, if the worker hasn't been terminated,
        // the message is from the inspector, and the message is not from the worker.
        if (backing.__webgpuInspector && event.detail.__webgpuInspector &&
          !event.detail.__webgpuInspectorPage) {
          backing.postMessage({ __WebGPUInspector: event.detail });
       }
      });

      backing.addEventListener("message", (event) => {
        let message = event.data;
        if (message.__WebGPUInspector) {
          message = message.__WebGPUInspector;
        }
        if (message.__webgpuInspector) {
          // Tag this message as coming from a worker to enable proper forwarding in iframe contexts
          message.__webgpuInspectorWorker = true;
          window.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: message }));
        }
      });

      return new Proxy(backing, {
        get(target, prop, receiver) {
          // Intercept event handlers to hide the inspectors messages
          if (prop === "addEventListener") {
            return function (...args) {
              if (args[0] === "message") {
                const origHandler = args[1];
                args[1] = function (...args) {
                  if (!args[0].data.__webgpuInspector && !args[0].data.__WebGPUInspector) {
                    origHandler(...args);
                  }
                };
              }

              return target.addEventListener(...args);
            };
          }

          // Intercept worker termination and remove it from list so we don't send
          // messages to a terminated worker.
          if (prop === "terminate") {
            return function (...args) {
              const result = target.terminate(...args);
              target.__webgpuInspector = false;
              return result;
            };
          }

          if (prop in target) {
            if (typeof target[prop] === "function") {
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
  }
})();
