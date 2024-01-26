(() => {
  let webgpuInspector = null;

  const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";

  class WebGPUInspector {
    constructor(options) {
      if (!window.navigator.gpu) {
        return;
      }

      this._frameCommands = [];
      this._frameData = [];
      this._currentFrame = null;
      this._frameIndex = 0;
      this._initalized = true;
      this._objectID = 1;
      this._frameStartTime = -1;
      this._timeSinceLastFrame = 0;
      this._maxFramesToRecord = 1000;
      this._recordRequest = false;

      const self = this;
      // Try to track garbage collected WebGPU objects
      this._gcRegistry = new FinalizationRegistry((id) => {
        window.postMessage({"action": "inspect_delete_object", id}, "*");
      });

      this._wrapObject(window.navigator.gpu);
      this._wrapCanvases();

      // Capture any dynamically created canvases
      let __createElement = document.createElement;
      document.createElement = function (type) {
        let element = __createElement.call(document, type);
        if (type == "canvas") {
          self._wrapCanvas(element);
        }
        return element;
      };

      // Wrap requestAnimationFrame so it can keep track of per-frame recording and know when
      // the maximum number of frames has been reached.
      //
      // It would be nice to be able to arbitrarily start/stop recording. To do this,
      // we would need to keep track of things like shader creation/deletion that can happen
      // at arbitrary frames prior to the start, for any objects used within that recorded
      // duration.
      let __requestAnimationFrame = window.requestAnimationFrame;
      window.requestAnimationFrame = function (cb) {
        function callback() {
          self._frameStart();
          cb(performance.now());
          self._frameEnd();
        }
        __requestAnimationFrame(callback);
      };
    }

    clear() {
      this._frameCommands.length = 0;
      this._currentFrame = null;
    }

    _frameStart() {
      window.postMessage({"action": "inspect_begin_frame"}, "*");

      if (sessionStorage.getItem(webgpuInspectorCaptureFrameKey)) {
        sessionStorage.removeItem(webgpuInspectorCaptureFrameKey);
        this._recordRequest = true;
      } else {
        this._recordRequest = false;
      }
      this._frameData.length = 0;
      this._frameCommands.length = 0;
      this._frameIndex++;
    }

    _frameEnd() {
      window.postMessage({"action": "inspect_end_frame"}, "*");
      this._recordRequest = false;

      if (this._frameCommands.length) {
        window.postMessage({"action": "inspect_capture_frame_results", "frame": this._frameIndex, "commands": this._frameCommands}, "*");
        this._frameCommands.length = 0;
      }
    }

    _wrapCanvas(c) {
      if (c.__id) {
        return;
      }
      c.__id = this._objectID++;
      let self = this;
      let __getContext = c.getContext;

      c.getContext = function (a1, a2) {
        const ret = __getContext.call(c, a1, a2);
        if (a1 == "webgpu") {
          if (ret) {
            self._wrapObject(ret);
          }
        }
        return ret;
      };
    }

    _wrapCanvases() {
      const canvases = document.getElementsByTagName("canvas");
      for (let i = 0; i < canvases.length; ++i) {
        const c = canvases[i];
        this._wrapCanvas(c);
      }
    }

    _objectHasMethods(object) {
      for (const m in object) {
        if (
          typeof object[m] == "function" &&
          WebGPUInspector._skipMethods.indexOf(m) == -1
        ) {
          return true;
        }
      }
      return false;
    }

    _wrapObject(object) {
      if (object.__id) {
        return;
      }
      object.__id = this._objectID++;

      this._gcRegistry.register(object, object.__id);

      for (const m in object) {
        if (m == "label") {
          // Capture chaning of the GPUObjectBase label
          const l = object[m];
          object._label = l;
          Object.defineProperty(object, m, {
            enumerable: true,
            configurable: true,
            get() {
              return object._label;
            },
            set(label) {
              object._label = label;
              const id = object.__id;
              window.postMessage({"action": "inspect_object_set_label", id, label}, "*");
            }
          });
        } else if (typeof object[m] == "function") {
          if (WebGPUInspector._skipMethods.indexOf(m) == -1) {
            if (WebGPUInspector._asyncMethods.indexOf(m) != -1) {
              this._wrapAsync(object, m);
            } else {
              this._wrapMethod(object, m);
            }
          }
        } else if (typeof object[m] == "object") {
          const o = object[m];
          if (!o || o.__id) {
            continue;
          }
          const hasMethod = this._objectHasMethods(o);
          if (!o.__id && hasMethod) {
            this._wrapObject(o);
          }
        }
      }
    }

    _wrapMethod(object, method) {
      if (WebGPUInspector._skipMethods.indexOf(method) != -1) {
        return;
      }
      const origMethod = object[method];
      const self = this;

      object[method] = function () {
        const t0 = performance.now();
        const result = origMethod.call(object, ...arguments);
        const t1 = performance.now();
        if (result && typeof result == "object") {
          self._wrapObject(result);
        }

        self._recordCommand(object, method, result, t1 - t0, arguments);
        return result;
      };
    }

    _gpuToArray(gpu) {
      const array = [];
      for (const v of gpu) {
        array.push(v);
      }
      return array;
    }

    _gpuToObject(gpu) {
      const obj = {};
      for (const v in gpu) {
        obj[v] = gpu[v];
      }
      return obj;
    }

    _wrapAsync(object, method) {
      const origMethod = object[method];
      const self = this;

      object[method] = function () {
        const t0 = performance.now();
        const id = self._objectID++;
        const promise = origMethod.call(object, ...arguments);
        self._recordAsyncCommand(object, method, id, arguments);
        const wrappedPromise = new Promise((resolve) => {
          promise.then((result) => {
            const t1 = performance.now();
            self._resolveAsyncCommand(id, t1 - t0, result);
            if (method == "requestAdapter") {
              result.requestAdapterInfo().then((infoObj) => {
                const info = {
                  vendor: infoObj.vendor,
                  architecture: infoObj.architecture,
                  device: infoObj.device,
                  description: infoObj.description,
                  features: self._gpuToArray(result.features),
                  limits: self._gpuToObject(result.limits),
                  isFallbackAdapter: result.isFallbackAdapter
                };
                window.postMessage({"action": "inspect_add_object", id, "type": "Adapter", "descriptor": JSON.stringify(info)}, "*");
              });
            } else if (method == "requestDevice") {
              const descriptor = arguments[0] ?? {};
              descriptor["features"] = self._gpuToArray(result.features);
              descriptor["limits"] = self._gpuToObject(result.limits);
              window.postMessage({"action": "inspect_add_object", id, "type": "Device", "descriptor": JSON.stringify(descriptor)}, "*");
            }
            if (result && result.__id) {
              resolve(result);
              return;
            }
            if (result && typeof result == "object") {
              self._wrapObject(result);
            }
            resolve(result);
          });
        });
        return wrappedPromise;
      };
    }

    _recordCommand(object, method, result, time, ...args) {
      if (method == "destroy") {
        const id = object.__id;
        window.postMessage({"action": "inspect_delete_object", id}, "*");
      } else if (method == "createShaderModule") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, "type": "ShaderModule", "descriptor": JSON.stringify(args[0][0])}, "*");
      } else if (method == "createBuffer") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, "type": "Buffer", "descriptor": JSON.stringify(args[0][0])}, "*");
      } else if (method == "createTexture") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, "type": "Texture", "descriptor": JSON.stringify(args[0][0])}, "*");
      } else if (method == "createSampler") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, "type": "Sampler", "descriptor": JSON.stringify(args[0][0])}, "*");
      } else if (method == "createBindGroup") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, "type": "BindGroup", "descriptor": JSON.stringify(args[0][0])}, "*");
      } else if (method == "createBindGroupLayout") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, "type": "BindGroupLayout", "descriptor": JSON.stringify(args[0][0])}, "*");
      } else if (method == "createPipelineLayout") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, "type": "PipelineLayout", "descriptor": JSON.stringify(args[0][0])}, "*");
      } else if (method == "createRenderPipeline") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, "type": "RenderPipeline", "descriptor": JSON.stringify(args[0][0])}, "*");
      } else if (method == "createComputePipeline") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, "type": "ComputePipeline", "descriptor": JSON.stringify(args[0][0])}, "*");
      } else if (method == "beginRenderPass") {
        window.postMessage({"action": "inspect_begin_render_pass", "descriptor": JSON.stringify(args[0][0])}, "*");
      } else if (method == "beginComputePass") {
          window.postMessage({"action": "inspect_begin_compute_pass", "descriptor": JSON.stringify(args[0][0])}, "*");
      } else if (method == "end") {
        window.postMessage({"action": "inspect_end_pass"}, "*");
      }

      if (this._recordRequest) {
        const a = [...args[0]];
        if (a.length === 1 && a[0] === undefined) {
          a.length = 0;
        }

        let newArgs = null;
        if (method == "setBindGroup") {
          newArgs = [];
          const binding = a[0];
          const bindGroup = a[1];
          newArgs.push(binding);
          newArgs.push(bindGroup);
          // handle dynamic offsets data, converting buffer views to Uint32Array
          if (a.length > 2) {
            const array = a[2];
            const offset = a[3] ?? 0;
            const size = a[4];
            if (size !== 0) {
              const buffer = array instanceof ArrayBuffer ? array : array.buffer;
              if (!buffer) { // It's a []<number>
                newArgs.push(array);
              } else if (size > 0) {
                newArgs.push(new Uint32Array(buffer, offset, size));
              } else if (offset > 0) {
                newArgs.push(new Uint32Array(buffer, offset));
              } else {
                newArgs.push(array);
              }
            }
          }
        } else if (method == "writeBuffer") {
          newArgs = [];
          const buffer = a[0];
          const bufferOffset = a[1];
          newArgs.push(buffer);
          newArgs.push(bufferOffset);
          let data = a[2];
          if (a.length > 3) {
            const offset = a[3] ?? 0;
            const size = a[4];
            const buffer = data instanceof ArrayBuffer ? data : data.buffer;
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
          // push it seperately in chunks as an ID'd data block, and then reference that ID here.
          newArgs.push(data);
        } else {
          newArgs = a;
        }

        newArgs = this._processCommandArgs(newArgs);

        this._frameCommands.push({
          "class": object.constructor.name,
          "id": object.__id,
          method,
          args: newArgs
        });
      }
    }

    _addCommandData(data) {
      if (this._recordRequest) {
        const id = this._frameData.length;
        this._frameData.push(data);
        return id;
      }
      return -1;
    }

    // Convert any objects to a string representation that can be sent to the inspector server.
    _processCommandArgs(object) {
      if (!object || object instanceof Number || object instanceof String || object instanceof Boolean) {
        return object;
      }
      if (object.__id !== undefined) {
        return {"__id": object.__id, "__class": object.constructor.name };
      }
      if (object instanceof ImageBitmap ||
        object instanceof ImageData ||
        object instanceof HTMLImageElement ||
        object instanceof HTMLCanvasElement ||
        object instanceof HTMLVideoElement ||
        object instanceof OffscreenCanvas ||
        object instanceof VideoFrame) {
        return `@-1 ${object.constructor.name} ${object.width} ${object.height}`;
      }
      if (object instanceof Array || object.buffer !== undefined) {
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
      if (object instanceof ArrayBuffer) {
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

    _recordAsyncCommand(object, method, id, ...args) {
      if (method == "createRenderPipelineAsync") {
        window.postMessage({"action": "inspect_add_object", id, "pending": true, "type": "RenderPipelinePipeline", "descriptor": JSON.stringify(args[0])}, "*");
      } else if (method == "createComputePipelineAsync") {
        window.postMessage({"action": "inspect_add_object", id, "pending": true, "type": "ComputePipelinePipeline", "descriptor": JSON.stringify(args[0])}, "*");
      }
    }

    _resolveAsyncCommand(id, time, result) {
      window.postMessage({"action": "inspect_resolve_async_object", id, time}, "*");
    }
  }

  WebGPUInspector._asyncMethods = [
    "requestAdapter",
    "requestDevice",
    "createComputePipelineAsync",
    "createRenderPipelineAsync",
  ];

  WebGPUInspector._skipMethods = [
    "toString",
    "entries",
    "getContext",
    "forEach",
    "has",
    "keys",
    "values",
    "getPreferredFormat",
    "pushErrorScope",
    "popErrorScope",
  ];

  webgpuInspector = new WebGPUInspector();
})();
