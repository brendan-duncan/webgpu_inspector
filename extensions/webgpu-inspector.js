(() => {
  let webgpuInspector = null;

  const webgpuInspectorGrabFrameKey = "WEBGPU_INSPECTOR_GRAB_FRAME";

  class Buffer {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class Sampler {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class Texture {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class ShaderModule {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class BindGroupLayout {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class BindGroup {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class PipelineLayout {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class RenderPipeline {
    constructor(descriptor) {
      this.descriptor = descriptor;
      this.time = 0;
      this.element = null;
    }
  }

  class ComputePipeline {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class ObjectDatabase {
    constructor() {
      this.allObjects = new Map();
      this.samplers = new Map();
      this.textures = new Map();
      this.buffers = new Map();
      this.bindGroups = new Map();
      this.bindGroupLayouts = new Map();
      this.pipelineLayouts = new Map();
      this.shaderModules = new Map();
      this.renderPipelines = new Map();
      this.computePipelines = new Map();
      this.pendingRenderPipelines = new Map();
      this.pendingComputePipelines = new Map();

      this.objectsPanel = null;
      this.renderPassCount = 0;
    }

    initGui() {
    }

    enable() {
    }

    disable() {
    }

    beginFrame() {
      this.startFrameTime = performance.now();
      this.renderPassCount = 0;
    }

    presentFrame() {
      this.endFrameTime = performance.now();
      this.frameTime = this.endFrameTime - this.startFrameTime;
    }

    beginRenderPass() {
      this.renderPassCount++;
    }

    getObject(id) {
      return this.allObjects.get(id);
    }

    addObject(id, object, pending) {
      this.allObjects.set(id, object);
      if (object instanceof Sampler) {
        this.samplers.set(id, object);
      } else if (object instanceof Texture) {
        this.textures.set(id, object);
      } else if (object instanceof Buffer) {
        this.buffers.set(id, object);
      } else if (object instanceof BindGroup) {
        this.bindGroups.set(id, object);
      } else if (object instanceof BindGroupLayout) {
        this.bindGroupLayouts.set(id, object);
      } else if (object instanceof PipelineLayout) {
        this.pipelineLayouts.set(id, object);
      } else if (object instanceof ShaderModule) {
        this.shaderModules.set(id, object);
      } else if (object instanceof RenderPipeline) {
        if (pending) {
          this.pendingRenderPipelines.set(id, object);
        } else {
          this.renderPipelines.set(id, object);
        }
      } else if (object instanceof ComputePipeline) {
        this.computePipelines.set(id, object);
      }
    }

    resolvePendingObject(id) {
      let object = this.allObjects.get(id);
      if (object instanceof RenderPipeline) {
        this.pendingRenderPipelines.delete(id);
        this.renderPipelines.set(id, object);
      } else if (object instanceof ComputePipeline) {
        this.pendingComputePipelines.delete(id);
        this.computePipelines.set(id, object);
      }
    }

    deleteObject(id) {
      let object = this.allObjects.get(id);
      this.allObjects.delete(id);
      this.samplers.delete(id);
      this.textures.delete(id);
      this.buffers.delete(id);
      this.bindGroups.delete(id);
      this.bindGroupLayouts.delete(id);
      this.pipelineLayouts.delete(id);
      this.shaderModules.delete(id);
      this.renderPipelines.delete(id);
      this.computePipelines.delete(id);
      this.pendingRenderPipelines.delete(id);
      this.pendingComputePipelines.delete(id);
    }
  }

  class WebGPUInspector {
    constructor(options) {
      if (!window.navigator.gpu) {
        return;
      }

      this._frameCommands = [];
      this._currentFrame = null;
      this._frameIndex = -1;
      this._initalized = true;
      this._objectID = 1;
      this._frameStartTime = -1;
      this._timeSinceLastFrame = 0;
      this._maxFramesToRecord = 1000;
      this._recordRequest = false;

      this._objectDatabase = new ObjectDatabase();

      this._wrapObject(window.navigator.gpu);
      this._wrapCanvases();

      let self = this;

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

    enable() {
      this._objectDatabase.enable();
    }

    disable() {
      this._objectDatabase.disable();
    }

    clear() {
      this._frameCommands.length = 0;
      this._currentFrame = null;
      this._frameIndex = 0;
    }

    _frameStart() {
      this._objectDatabase.beginFrame();
      window.postMessage({"action": "inspect_begin_frame"}, "*");

      if (sessionStorage.getItem(webgpuInspectorGrabFrameKey)) {
        sessionStorage.removeItem(webgpuInspectorGrabFrameKey);
        this._recordRequest = true;
      } else {
        this._recordRequest = false;
      }
      this._frameCommands.length = 0;
    }

    _frameEnd() {
      this._objectDatabase.presentFrame();
      window.postMessage({"action": "inspect_end_frame"}, "*");
      this._recordRequest = false;

      if (this._frameCommands.length) {
        window.postMessage({"action": "inspect_grab_frame_results", "commands": this._frameCommands}, "*");
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

      for (const m in object) {
        if (typeof object[m] == "function") {
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
                  description: infoObj.description
                };
                window.postMessage({"action": "inspect_adapter_info", info}, "*");
              });
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
        const obj = this._objectDatabase.getObject(id);
        if (obj) {
          if (obj.element) {
            obj.element.remove();
          }
          this._objectDatabase.deleteObject(id);
        }
        window.postMessage({"action": "inspect_delete_object", id}, "*");
      } else if (method == "createShaderModule") {
        const id = result.__id;
        const obj = new ShaderModule(args[0]);
        this._objectDatabase.addObject(id, obj);
        obj.size = args[0][0].code.length;
        window.postMessage({"action": "inspect_add_object", id, "type": "ShaderModule", "descriptor": JSON.stringify(obj.descriptor[0])}, "*");
      } else if (method == "createBuffer") {
        const id = result.__id;
        const obj = new Buffer(args[0]);
        this._objectDatabase.addObject(id, obj);
        obj.size = args[0][0].size;
        window.postMessage({"action": "inspect_add_object", id, "type": "Buffer", "descriptor": JSON.stringify(obj.descriptor[0])}, "*");
      } else if (method == "createTexture") {
        const id = result.__id;
        const obj = new Texture(args[0]);
        this._objectDatabase.addObject(id, obj);
        window.postMessage({"action": "inspect_add_object", id, "type": "Texture", "descriptor": JSON.stringify(obj.descriptor[0])}, "*");
      } else if (method == "createSampler") {
        const id = result.__id;
        const obj = new Sampler(args[0]);
        this._objectDatabase.addObject(id, obj);
        window.postMessage({"action": "inspect_add_object", id, "type": "Sampler", "descriptor": JSON.stringify(obj.descriptor[0])}, "*");
      } else if (method == "createBindGroup") {
        const id = result.__id;
        const obj = new BindGroup(args[0]);
        this._objectDatabase.addObject(id, obj);
        obj.size = args[0][0].size;
        window.postMessage({"action": "inspect_add_object", id, "type": "BindGroup", "descriptor": JSON.stringify(obj.descriptor[0])}, "*");
      } else if (method == "createBindGroupLayout") {
        const id = result.__id;
        const obj = new BindGroupLayout(args[0]);
        this._objectDatabase.addObject(id, obj);
        window.postMessage({"action": "inspect_add_object", id, "type": "BindGroupLayout", "descriptor": JSON.stringify(obj.descriptor[0])}, "*");
      } else if (method == "createPipelineLayout") {
        const id = result.__id;
        const obj = new PipelineLayout(args[0]);
        this._objectDatabase.addObject(id, obj);
        window.postMessage({"action": "inspect_add_object", id, "type": "PipelineLayout", "descriptor": JSON.stringify(obj.descriptor[0])}, "*");
      } else if (method == "createRenderPipeline") {
        const id = result.__id;
        const obj = new RenderPipeline(args[0]);
        obj.time = time;
        this._objectDatabase.addObject(id, obj);
        window.postMessage({"action": "inspect_add_object", id, "type": "RenderPipeline", "descriptor": JSON.stringify(obj.descriptor[0])}, "*");
      } else if (method == "createComputePipeline") {
        const id = result.__id;
        const obj = new ComputePipeline(args[0]);
        obj.time = time;
        this._objectDatabase.addObject(id, obj);
        window.postMessage({"action": "inspect_add_object", id, "type": "ComputePipeline", "descriptor": JSON.stringify(obj.descriptor[0])}, "*");
      } else if (method == "setBindGroup") {
        // TODO send dynamic offsets
        //window.postMessage({"action": "set_bind_group", "args": [args[0][0], JSON.stringify(args[0][1])]}, "*");
      } else if (method == "beginRenderPass") {
        this._objectDatabase.beginRenderPass();
        window.postMessage({"action": "inspect_begin_render_pass", "descriptor": JSON.stringify(args[0][0])}, "*");
      } else if (method == "beginComputePass") {
          window.postMessage({"action": "inspect_begin_compute_pass", "descriptor": JSON.stringify(args[0][0])}, "*");
      } else if (method == "end") {
        window.postMessage({"action": "inspect_end"}, "*");
      }

      if (this._recordRequest) {
        this._frameCommands.push({
          "object": object.__id,
          method,
          "args": this._stringifyArgs(args)
        });
      }
    }

    _stringifyArgs(args, writeKeys = false) {
      let s = "";
      for (const key in args) {
        let a = args[key];
        if (s != "") {
          s += ", ";
        }

        if (writeKeys) {
          s += `"${key}":`;
        }

        if (!a) {
          s += a;
        } else if (typeof a == "string") {
          s += `\`${a}\``;
        } else if (a.length && a.length > 10) {
          s += `${a.constructor.name}(${a.length})`;
        } else if (a.length !== undefined) {
          s += `[${this._stringifyArgs(a, false)}]`;
        } else if (a.__id !== undefined) {
          s += `${a.constructor.name}@${a.__id}`;
        } else if (typeof a == "object") {
          s += `{ ${this._stringifyArgs(a, true)} }`;
        } else {
          s += JSON.stringify(a);
        }
      }
      return s;
    }

    _recordAsyncCommand(object, method, id, ...args) {
      if (method == "createRenderPipelineAsync") {
        const obj = new RenderPipeline(args[0]);
        this._objectDatabase.addObject(id, obj, true);
      }
    }

    _resolveAsyncCommand(id, time, result) {
      const obj = this._objectDatabase.getObject(id);
      if (obj instanceof RenderPipeline) {
        obj.time = time;
        this._objectDatabase.resolvePendingObject(id);
      }
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
  webgpuInspector.enable();
})();
