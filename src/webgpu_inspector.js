import { encodeDataUrl } from "./utils/base64.js";
import { GPUObjectTypes, GPUObjectWrapper } from "./utils/gpu_object_wrapper.js";
import { TextureFormatInfo } from "./utils/texture_format_info.js";
import { TextureUtils } from "./utils/texture_utils.js";

(() => {
  const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";

  class WebGPUInspector {
    constructor() {
      this._frameCommands = [];
      this._frameData = [];
      this._frameRenderPassCount = 0;
      this._captureTextureViews = [];
      this._lastCommandEncoder = null;
      this._captureCommandEncoder = null;
      this._captureTexturedBuffers = [];
      this._currentFrame = null;
      this._frameIndex = 0;
      this._initalized = true;
      this._objectID = 1;
      this._nonTrackingID = 0.5;
      this._frameStartTime = -1;
      this._timeSinceLastFrame = 0;
      this._frameCommandCount = 0;
      this._captureRequest = false;
      this.__skipRecord = false;
      this.__errorChecking = true;
      this._trackedObjects = new Map();
      this._trackedObjectInfo = new Map();
      this._bindGroupCount = 0;
      this._captureTextureRequest = new Map();
      this._toDestroy = [];
      this._objectMap = new Map();

      if (!window.navigator.gpu) {
        // No WebGPU support
        return;
      }

      this._gpuWrapper = new GPUObjectWrapper(this);

      const self = this;
      this._gpuWrapper.onPromiseResolve.addListener(this._onAsyncResolve, this);
      this._gpuWrapper.onPreCall.addListener(this._preMethodCall, this);
      this._gpuWrapper.onPostCall.addListener(this._onMethodCall, this);

      this._garbageCollectectedObjects = [];
     
      // Track garbage collected WebGPU objects
      this._garbageCollectionRegistry = new FinalizationRegistry((id) => {
        if (id > 0) {
          // It's too slow to send a message for every object that gets garbage collected,
          // so we'll batch them up and send them every so often.
          self._garbageCollectectedObjects.push(id);
          const objectClass = self._trackedObjectInfo.get(id);
          const object = self._trackedObjects.get(id)?.deref();

          if (objectClass) {
            if (objectClass === GPUBindGroup) {
              self._bindGroupCount--;
            }
            // If we're here, the object was garbage collected but not explicitly destroyed.
            // Some GPU objects need to be explicitly destroyed, otherwise it's a memory
            // leak. Notify the user of this.
            if (objectClass === GPUBuffer || object === GPUTexture || object === GPUDevice) {
              self._memoryLeakWarning(id);
            }
          }

          if (self._garbageCollectectedObjects.length > 100) {
            window.postMessage({"action": "inspect_delete_objects", "idList": self._garbageCollectectedObjects}, "*");
            self._garbageCollectectedObjects.length = 0;
          }
        }

        self._trackedObjects.delete(id);
        self._trackedObjectInfo.delete(id);
        self._captureTextureRequest.delete(id);
        self._objectMap.delete(id);
      });

      // Clean out the garbage collected objects every so often.
      const garbageCollectionInterval = 200;
      setInterval(() => {
        if (self._garbageCollectectedObjects.length > 0) {
          window.postMessage({"action": "inspect_delete_objects", "idList": self._garbageCollectectedObjects}, "*");
          self._garbageCollectectedObjects.length = 0;
        }
      }, garbageCollectionInterval);

      // Wrap the canvas elements so we can capture when their context is created.
      this._wrapCanvases();

      // Capture any dynamically created canvases.
      const __createElement = document.createElement;
      document.createElement = function (type) {
        const element = __createElement.call(document, type);
        if (type === "canvas") {
          self._wrapCanvas(element);
        }
        return element;
      };

      // Wrap requestAnimationFrame so it can keep track of framerates and frame captures.
      // This requires that the page uses requestAnimationFrame to drive the rendering loop.
      const __requestAnimationFrame = window.requestAnimationFrame;
      window.requestAnimationFrame = function (cb) {
        function callback() {
          self._frameStart();
          cb(performance.now());
          self._frameEnd();
        }
        __requestAnimationFrame(callback);
      };

      // Listen for messages from the content-script.
      window.addEventListener('message', (event) => {
        if (event.source !== window) {
          return;
        }
        const message = event.data;
        if (typeof message !== 'object' || message === null) {
          return;
        }
        if (message.action === "inspect_request_texture") {
          const textureId = message.id;
          self._requestTexture(textureId);
        }
        if (message.action === "inspect_compile_shader") {
          const shaderId = message.id;
          const code = message.code;
          self._compileShader(shaderId, code);
        }
      });
    }

    // Called before a GPU method is called, allowing the inspector to modify
    // the arguments or the object before the method is called.
    _preMethodCall(object, method, args) {
      const self = this;

      if (method === "setPipeline") {
        // If a shader has been recompiled, that means the pipelines that
        // used that shader were also re-created. Patch in the replacement
        // pipeline so the new version of the shader is used.
        let pipeline = args[0];
        const objectRef = this._objectMap.get(pipeline.__id);
        if (objectRef) {
          if (objectRef.replacement) {
            args[0] = objectRef.replacement;
          }
        }
      }

      if (method === "createTexture") {
        // Add COPY_SRC usage to all textures so we can capture them
        args[0].usage |= GPUTextureUsage.COPY_SRC;
      }

      if (method === "createShaderModule"|| method === "createRenderPipeline" || method === "createComputePipeline" || method === "createBindGroup") {
        if (this.__errorChecking) {
          this.__skipRecord = true;
          object.pushErrorScope("validation");
          this.__skipRecord = false;
        }
      }

      this._capturedRenderView = null;
      if (method === "beginRenderPass") {
        if (this.__errorChecking) {
          this.__skipRecord = true;
          object.__device.pushErrorScope("validation");
          this.__skipRecord = false;
        }

        const descriptor = args[0];
        const colorAttachments = descriptor.colorAttachments;
        if (colorAttachments) {
          for (let i = 0; i < colorAttachments.length; ++i) {
            const attachment = colorAttachments[i];
            if (attachment.view) {
              // If there's a resolveTarget, get that instead of the regular view, which will
              // have MSAA and can't be read directly.
              const texture = attachment.view.__texture;
              if (texture) {
                if (texture.__isCanvasTexture) {
                  const context = texture.__context;
                  if (context) {
                    if (context.__captureTexture) {
                      if (context.__captureTexture?.width != texture.width ||
                          context.__captureTexture?.height != texture.height ||
                          context.__captureTexture?.format != texture.format) {
                        this.__skipRecord = true;
                        context.__captureTexture.destroy();
                        context.__captureTexture = null;
                        context.__canvas.__captureTexture = null;
                        this.__skipRecord = false;
                      }
                    }

                    if (!context.__captureTexture) {
                      const device = context.__device;
                      if (device) {
                        this.__skipRecord = true;
                        const captureTexture = device.createTexture({
                          size: [texture.width, texture.height, 1],
                          format: texture.format,
                          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
                        });
                        context.__captureTexture = captureTexture;
                        captureTexture.__id = texture.__id;
                        captureTexture.__view = context.__captureTexture.createView();
                        captureTexture.__view.__texture = captureTexture;
                        captureTexture.__canvasTexture = texture;
                        texture.__captureTexture = captureTexture;
                        texture.__canvas.__captureTexture = captureTexture;
                        this.__skipRecord = false;
                      }
                    }

                    if (context.__captureTexture) {
                      context.__captureTexture.__canvasTexture = texture;
                      attachment.view = context.__captureTexture.__view;
                      this._capturedRenderView = attachment.view;
                    }
                  }
                }
              }
            }
          }
        }
      }

      // Before we finish the command encoder, inject any pending texture captures
      if ((object === this._lastCommandEncoder) && method === "finish") {
        if (this._captureTextureRequest.size > 0) {
          this._captureTextureBuffers();
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
        object.__device = descriptor.device;
      }       

      if (method === "submit") {
        this.__skipRecord = true;
        object.onSubmittedWorkDone().then(() => {
          self._sendCaptureTextureBuffers();
          for (const obj of this._toDestroy) {
            obj.destroy();
          }
          self._toDestroy.length = 0;
        });
        this.__skipRecord = false;
      }
    }

    // Called after a GPU method is called, allowing the inspector to wrap the result.
    _onMethodCall(object, method, args, result, stacktrace) {
      this._frameCommandCount++;

      if (method === "beginRenderPass") {
        result.__commandEncoder = object;
        if (this._capturedRenderView) {
          result.__capturedRenderView = this._capturedRenderView;
        }
      }

      if (method === "createShaderModule" || method === "createRenderPipeline" || method === "createComputePipeline" || method === "createBindGroup") {
        if (this.__errorChecking) {
          this.__skipRecord = true;
          object.popErrorScope().then((error) => {
            if (error) {
              const id = result?.__id ?? 0;
              window.postMessage({ "action": "inspect_validation_error", id, "message": error.message, stacktrace }, "*");
            }
          });
          this.__skipRecord = false;
        }
      }

      if (method === "end") {
        if (this.__errorChecking) {
          this.__skipRecord = true;
          const device = object.__device;
          if (device) {
            device.popErrorScope().then((error) => {
              if (error) {
                window.postMessage({ "action": "inspect_validation_error", "message": error.message, stacktrace }, "*");
              }
            });
          }
          this.__skipRecord = false;
        }

        // If the captured canvas texture was rendered to, blit it to the real canvas texture
        if (object.__capturedRenderView) {
          const texture = object.__capturedRenderView.__texture;
          if (texture) {
            const commandEncoder = object.__commandEncoder;
            if (commandEncoder) {
              this.__skipRecord = true;
              commandEncoder.copyTextureToTexture({ texture },
                { texture: texture.__canvasTexture },
                [texture.width, texture.height, 1]);
              this.__skipRecord = false;
            }
          }
        }
      }

      // If __skipRecord is set, don't wrap the result object or record the command.
      // It is set when we're creating utilty objects that aren't from the page.
      if (this.__skipRecord) {
        return result;
      }

      let id = undefined;
      if (method === "getCurrentTexture" && result) {
        id = -(object.__canvas?.__id ?? 1);
      } else if (method === "createView") {
        if (object.__isCanvasTexture) {
          id = object.__id - 0.5;
        }
      }

      if (object instanceof GPUDevice && object?.__id === undefined) {
        // We haven't wrapped the object yet, so do it now.
        // Probably the GPUDevice where requestDevice happened
        // before we started recording.
        this._wrapDevice(null, object);
      }
      
      if (result) {
        // Wrap GPU objects
        if (GPUObjectTypes.has(result.constructor)) {
          this._wrapObject(result, id);
        }

        if (method === "createShaderModule" || method === "createRenderPipeline") {
          result.__descriptor = args[0];
          result.__device = object;
          this._objectMap.set(result.__id, { id: result.__id, object: new WeakRef(result), replacement: null });
        }

        if (method === "createTexture") {
          this._trackObject(result.__id, result);
        } else if (method === "createView" && !id) {
          this._trackObject(result.__id, result);
          result.__texture = object;
        } else if (method === "createBuffer") {
          this._trackObject(result.__id, result);
        } else if (method === "getCurrentTexture") {
          result.__isCanvasTexture = true;
          result.__context = object;
          this._trackObject(result.__id, result);
          if (object.__canvas) {
            result.__canvas = object.__canvas;
          }
        } else if (method === "createBindGroup") {
          this._trackObject(result.__id, result);
        }
      }

      this._recordCommand(object, method, result, args, stacktrace);
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
      }
    }

    _wrapAdapter(adapter, id, stacktrace) {
      this._wrapObject(adapter, id);
      id ??= adapter.__id;
      const self = this;
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

    _wrapDevice(adapter, device, id, args, stacktrace) {
      if (adapter && adapter.__id === undefined) {
        this._wrapAdapter(adapter, undefined, stacktrace);
      }

      if (device && device.__id === undefined) {
        args ??= [];
        this._wrapObject(device, id);
        const descriptor = args[0] ?? {};
        const deviceId = device.__id;
        const adapterId = adapter?.__id ?? 0;
        descriptor["features"] = this._gpuToArray(device.features);
        descriptor["limits"] = this._gpuToObject(device.limits);
        this._trackObject(deviceId, device);
        this._sendAddObjectMessage(id, adapterId, "Device", JSON.stringify(descriptor), stacktrace);
      }
    }

    clear() {
      this._frameCommands.length = 0;
      this._currentFrame = null;
    }

    getNextId(object) {
      // We don't need unique id's for some types of objects
      // and they get created so frequenty they make the ID's
      // grow too quickly.
      if (object instanceof GPUCommandEncoder ||
          object instanceof GPUComputePassEncoder ||
          object instanceof GPURenderPassEncoder ||
          object instanceof GPUCommandBuffer) {
        return 0;//this._nonTrackingID++;
      }
      return this._objectID++;
    }

    _memoryLeakWarning(object) {
      const label = object.label ?? "";
      const type = object.constructor.name;
      const id = object.__id;
      const message = `WebGPU ${type} ${id} ${label} was garbage collected without being explicitly destroyed. This is a memory leak.`;
      window.postMessage({"action": "inspect_memory_leak_warning", id, "message": message}, "*");
    }

    _isPrimitiveType(obj) {
      return !obj || obj.constructor === String || obj.constructor === Number || obj.constructor === Boolean;
    }

    _isTypedArray(obj) {
      return obj && (obj instanceof ArrayBuffer || obj.buffer instanceof ArrayBuffer);
    }

    _isArray(obj) {
      return obj && obj.constructor === Array;
    }

    _duplicateArray(array, replaceGpuObjects) {
      const newArray = new Array(array.length);
      for (let i = 0, l = array.length; i < l; ++i) {
        const x = array[i];
        if (this._isPrimitiveType(x)) {
          newArray[i] = x;
        } else if (x.__id !== undefined) {
          if (replaceGpuObjects) {
            newArray[i] = { __id: x.__id, __class: x.constructor.name }
          } else {
            newArray[i] = x;
          }
        } else if (this._isTypedArray(x)) {
          newArray[i] = x;
        } else if (this._isArray(x)) {
          newArray[i] = this._duplicateArray(x, replaceGpuObjects);
        } else if (x instanceof Object) {
          newArray[i] = this._duplicateObject(x, replaceGpuObjects);
        } else {
          newArray[i] = x;
        }
      }
      return newArray;
    }

    _duplicateObject(object, replaceGpuObjects) {
      const obj = {};
      for (const key in object) {
        const x = object[key];
        if (this._isPrimitiveType(x)) {
          obj[key] = x;
        } else if (x.__id !== undefined) {
          if (replaceGpuObjects) {
            obj[key] = { __id: x.__id, __class: x.constructor.name }
          } else {
            obj[key] = x;
          }
        } else if (this._isTypedArray(x)) {
          obj[key] = x;
        } else if (this._isArray(x)) {
          obj[key] = this._duplicateArray(x, replaceGpuObjects);
        } else if (x instanceof Object) {
          obj[key] = this._duplicateObject(x, replaceGpuObjects);
        } else {
          obj[key] = x;
        }
      }
      return obj;
    }

    _compileShader(shaderId, code) {
      const objectMap = this._objectMap.get(shaderId);
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

      this.__skipRecord = true;
      this.__errorChecking = false;
      device.pushErrorScope('validation');
      descriptor.__replacement = shaderId;
      const newShaderModule = device.createShaderModule(descriptor);
      device.popErrorScope().then((error) => {
        if (error) {
          const id = shaderId ?? 0;
          window.postMessage({ "action": "inspect_validation_error", id, "message": error.message }, "*");
        }
      });
      this.__errorChecking = true;
      this.__skipRecord = false;

      objectMap.replacement = newShaderModule;

      // Create replacements for any RenderPipeline that uses shaderId
      for (const objectRef of this._objectMap.values()) {
        const object = objectRef.object.deref();
        const isRenderPipeline = object instanceof GPURenderPipeline;
        const isComputePipeline = object instanceof GPUComputePipeline;
        if (isRenderPipeline || isComputePipeline) {
          const descriptor = object.__descriptor;
          let newDescriptor = null;
          
          if (descriptor.vertex?.module === shader) {
            if (!newDescriptor) {
              newDescriptor = this._duplicateObject(descriptor);
            }
            newDescriptor.vertex.module = newShaderModule;
          }
          if (descriptor.fragment?.module === shader) {
            if (!newDescriptor) {
              newDescriptor = this._duplicateObject(descriptor);
            }
            newDescriptor.fragment.module = newShaderModule;
          }
          if (descriptor.compute?.module === shader) {
            if (!newDescriptor) {
              newDescriptor = this._duplicateObject(descriptor);
            }
            newDescriptor.compute.module = newShaderModule;
          }

          if (newDescriptor !== null) {
            this.__skipRecord = true;
            this.__errorChecking = false;
            newDescriptor.__replacement = objectRef.id;
            device.pushErrorScope('validation');
            const newPipeline = isRenderPipeline ?
                device.createRenderPipeline(newDescriptor) :
                device.createComputePipeline(newDescriptor);
            device.popErrorScope().then((error) => {
              if (error) {
                const id = objectRef.id ?? 0;
                window.postMessage({ "action": "inspect_validation_error", id, "message": error.message }, "*");
              }
            });
            this.__errorChecking = true;
            this.__skipRecord = false;

            objectRef.replacement = newPipeline;
          }
        }
      }
    }

    _requestTexture(textureId) {
      if (textureId < 0) {
        // canvas texture
        const canvasId = -textureId;
        const canvas = this._trackedObjects.get(canvasId).deref();
        if (canvas) {
          if (canvas.__captureTexture) {
            this._captureTextureRequest.set(textureId, canvas.__captureTexture);
            return;
          }
        }
      }
      const object = this._trackedObjects.get(textureId).deref();
      if (!object || !(object instanceof GPUTexture)) {
        return;
      }
      this._captureTextureRequest.set(textureId, object);
    }

    _frameStart() {
      window.postMessage({"action": "inspect_begin_frame"}, "*");

      const captureMode = sessionStorage.getItem(webgpuInspectorCaptureFrameKey);
      if (captureMode) {
        sessionStorage.removeItem(webgpuInspectorCaptureFrameKey);
        this._captureRequest = true;
        this._gpuWrapper.recordStacktraces = true;
      }
      this._frameData.length = 0;
      this._frameCommands.length = 0;
      this._frameRenderPassCount = 0;
      this._frameIndex++;
      this._frameCommandCount = 0;
    }

    _frameEnd() {
      window.postMessage({ "action": "inspect_end_frame", "commandCount": this._frameCommandCount }, "*");

      if (this._frameCommands.length) {
        const maxFrameCount = 2000;
        const batches = Math.ceil(this._frameCommands.length / maxFrameCount);
        window.postMessage({"action": "inspect_capture_frame_results", "frame": this._frameIndex, "count": this._frameCommands.length, "batches": batches}, "*");

        for (let i = 0; i < this._frameCommands.length; i += maxFrameCount) {
          const length = Math.min(maxFrameCount, this._frameCommands.length - i);
          const commands = this._frameCommands.slice(i, i + length);
          window.postMessage({"action": "inspect_capture_frame_commands",
              "frame": this._frameIndex,
              "commands": commands,
              "index": i,
              "count": length
            }, "*");
        }
        this._frameCommands.length = 0;
        this._captureRequest = false;
        this._gpuWrapper.recordStacktraces = false;
      }
    }

    _trackObject(id, object) {
      this._trackedObjects.set(id, new WeakRef(object));
      this._trackedObjectInfo.set(id, object.constructor);
    }

    _wrapCanvas(c) {
      if (c.__id) {
        return;
      }
      c.__id = this.getNextId(c);

      this._trackObject(c.__id, c);

      const self = this;
      const __getContext = c.getContext;

      c.getContext = function (a1, a2) {
        const ret = __getContext.call(c, a1, a2);
        if (a1 === "webgpu") {
          if (ret) {
            self._wrapObject(ret);
            ret.__canvas = c;
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
          typeof object[m] === "function" &&
          WebGPUInspector._skipMethods.indexOf(m) == -1
        ) {
          return true;
        }
      }
      return false;
    }

    _wrapObject(object, id) {
      // The object has already been wrapped
      if (object.__id) {
        return;
      }

      object.__id = id ?? this.getNextId(object);

      // Track garbage collected objects
      this._garbageCollectionRegistry.register(object, object.__id);

      if (object.label !== undefined) {
        // Capture chaning of the GPUObjectBase label
        const l = object.label;
        object._label = l;
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
              window.postMessage({ "action": "inspect_object_set_label", id, label }, "*");
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

    _captureTextureBuffers() {
      const self = this;
      this._captureTextureRequest.forEach((texture) => {
        self._captureTexture(self._lastCommandEncoder, texture);
      });
      this._captureTextureRequest.clear();
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
      //return descriptor;
      const s = JSON.stringify(descriptor);
      return s;
    }

    _sendAddObjectMessage(id, parent, type, descriptor, stacktrace, pending) {
      window.postMessage({ "action": "inspect_add_object", id, parent, type, descriptor, stacktrace, pending }, "*");
    }

    _recordCommand(object, method, result, args, stacktrace) {
      const parent = object?.__id ?? 0;

      if (method === "destroy") {
        const id = object.__id;
        this._trackedObjects.delete(id);
        this._trackedObjectInfo.delete(id);
        this._objectMap.delete(id);
        if (object instanceof GPUBindGroup) {
          this._bindGroupCount--;
        }
        if (id >= 0) {
          this._captureTextureRequest.delete(id);
          window.postMessage({"action": "inspect_delete_object", id}, "*");
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
        // Attach resources to the bindgroups that use them to keep them from being garbage collected so we can inspect them later.
        /*if (result.__entries === undefined) {
          result.__entries = [];
        }
        if (args[0].entries?.length > 0) {
          for (const entry of args[0].entries) {
            const resource = entry.resource;
            if (resource) {
              if (resource.__id !== undefined) {
                result.__entries.push(resource);
              } else if (resource.buffer?.__id !== undefined) {
                result.__entries.push(resource.buffer);
              }
            }
          }
        }*/
        this._sendAddObjectMessage(id, parent, "BindGroup", this._stringifyDescriptor(args[0]), stacktrace);
      } else if (method === "createBindGroupLayout") {
        const id = result.__id;
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
        this._lastCommandEncoder = result;
      } else if (method === "finish") {
        if (object == this._lastCommandEncoder) {
          this._lastCommandEncoder = null;
        }
      } else if (method === "beginRenderPass") {
        this._frameRenderPassCount++;
      }

      if (this._captureRequest) {
        this._captureCommand(object, method, args, stacktrace);
      }
    }

    _captureCommand(object, method, args, stacktrace) {
      const a = args;
      if (a.length === 1 && a[0] === undefined) {
        a.length = 0;
      }

      let newArgs = null;
      if (method === "setBindGroup") {
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

      const commandId = this._frameCommands.length;
      this._frameCommands.push({
        "class": object.constructor.name,
        "id": object.__id,
        commandId,
        method,
        args: newArgs,
        stacktrace
      });

      if (method === "beginRenderPass") {
        if (args[0]?.colorAttachments?.length > 0) {
          for (const attachment of args[0].colorAttachments) {
            const captureTextureView = attachment.resolveTarget ?? attachment.view;
            this._captureTextureViews.push(captureTextureView);
          }
          this._captureCommandEncoder = object;
        }
      } else if (method === "end") {
        if (this._captureTextureViews.length > 0) {
          for (const captureTextureView of this._captureTextureViews) {
            const texture = captureTextureView.__texture;
            if (texture) {
              this._captureTexture(this._captureCommandEncoder, texture, this._frameRenderPassCount - 1);
            }
          }
          this._captureTextureViews.length = 0;
        }
        this._captureCommandEncoder = null;
      }
    }

    _sendCaptureTextureBuffers() {
      if (this._captureTexturedBuffers.length > 0) {
        window.postMessage({
          "action": "inspect_capture_texture_frames", "count": this._captureTexturedBuffers.length }, "*");
      }

      for (const textureBuffer of this._captureTexturedBuffers) {
        const { id, buffer, width, height, depthOrArrayLayers, format, passId } = textureBuffer;

        const self = this;
        buffer.mapAsync(GPUMapMode.READ).then(() => {
          const range = buffer.getMappedRange();
          const data = new Uint8Array(range);

          self._sendTextureData(id, width, height, depthOrArrayLayers, format, passId, data);

          buffer.destroy();
        });
      }
      this._captureTexturedBuffers.length = 0;
    }

    _sendTextureData(id, width, height, depthOrArrayLayers, format, passId, data) {
      const maxChunkSize = 1024 * 1024;
      const size = data.length;
      const numChunks = Math.ceil(size / maxChunkSize);
      
      for (let i = 0; i < numChunks; ++i) {
        const offset = i * maxChunkSize;
        const chunkSize = Math.min(maxChunkSize, size - offset);
        const chunk = data.slice(offset, offset + chunkSize);

        encodeDataUrl(chunk).then((chunkData) => {
          window.postMessage({
            "action": "inspect_capture_texture_data",
            id,
            passId,
            offset,
            size,
            index: i,
            count: numChunks,
            chunk: chunkData
          }, "*");
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

    _captureTexture(commandEncoder, texture, passId) {
      const device = commandEncoder.__device;
      // can't capture canvas texture
      if (!device) {
        return;
      }

      passId ??= -1;

      const id = texture.__id;
      let format = texture.format;
      let formatInfo = format ? TextureFormatInfo[format] : undefined;
      if (!formatInfo) { // GPUExternalTexture?
        return;
      }

      // depth24plus texture's can't be copied to a buffer,
      // https://github.com/gpuweb/gpuweb/issues/652.
      if (format === "depth24plus" || format === "depth24plus-stencil8") {
        this.__skipRecord = true;
        try {
          const textureUtils = this._getTextureUtils(texture.__device);
          texture = textureUtils.copyDepthTexture(texture, format === "depth24plus-stencil8" ? "depth32float" : "depth32float-stencil8");
        } catch (e) {
          this.__skipRecord = false;
          console.log(e);
          return;
        }
        this.__skipRecord = false;
        format = texture.format;
        formatInfo = format ? TextureFormatInfo[format] : undefined;
        texture.__id = id;
        this._toDestroy.push(texture); // Destroy the temp texture at the end of the frame
      }

      const width = texture.width;
      const height = texture.height || 1;
      const depthOrArrayLayers = texture.depthOrArrayLayers || 1;
      const texelByteSize = formatInfo.bytesPerBlock;
      const bytesPerRow = (width * texelByteSize + 255) & ~0xff;
      const rowsPerImage = height;
      const bufferSize = bytesPerRow * rowsPerImage * depthOrArrayLayers;
      if (!bufferSize) {
        return;
      }
      const copySize = { width, height, depthOrArrayLayers };

      let buffer = null;
      try {
        this.__skipRecord = true;
        buffer = device.createBuffer({
          size: bufferSize,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const aspect = format === 'depth24plus-stencil8' || format === 'depth32float-stencil8' ? 'depth-only' : 'all';

        commandEncoder.copyTextureToBuffer(
          { texture, aspect },
          { buffer, bytesPerRow, rowsPerImage: height },
          copySize
        );

      } catch (e) {
        console.log(e);
      }
      this.__skipRecord = false;

      if (buffer) {
        this._captureTexturedBuffers.push({ id, buffer, width, height, depthOrArrayLayers, format, passId });
      }
    }

    _addCommandData(data) {
      if (this._captureRequest) {
        const id = this._frameData.length;
        this._frameData.push(data);
        return id;
      }
      return -1;
    }

    // Convert any objects to a string representation that can be sent to the inspector server.
    _processCommandArgs(object) {
      if (!object || object.constructor === Number || object.constructor === String || object.constructor === Boolean) {
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

  new WebGPUInspector();
})();
