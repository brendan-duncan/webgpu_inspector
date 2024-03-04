import { encodeDataUrl } from "./utils/base64.js";
import { GPUObjectTypes, GPUObjectWrapper } from "./utils/gpu_object_wrapper.js";
import { TextureFormatInfo } from "./utils/texture_format_info.js";
import { TextureUtils } from "./utils/texture_utils.js";
import { Actions, PanelActions } from "./utils/actions.js";
import { RollingAverage } from "./utils/rolling_average.js";
import { alignTo } from "./utils/align.js";

(() => {
  const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";

  // How much data should we send to the panel via message as a chunk.
  // Messages can't send that much data .
  const maxDataChunkSize = (1024 * 1024) / 4; // 256KB
  const maxBufferCaptureSize = (1024 * 1024) / 4; // 256KB
  const maxColorAttachments = 10;

  class WebGPUInspector {
    constructor() {
      this._captureFrameCommands = [];
      this._frameData = [];
      this._frameRenderPassCount = 0;
      this._captureTexturedBuffers = [];
      this._currentFrame = null;
      this._frameIndex = 0;
      this._initalized = true;
      this._objectID = 1;
      this._lastFrameTime = 0;
      this._frameCommandCount = 0;
      this._captureFrameRequest = false;
      this._errorChecking = 1;
      this._trackedObjects = new Map();
      this._trackedObjectInfo = new Map();
      this._bindGroupCount = 0;
      this._captureTextureRequest = new Map();
      this._toDestroy = []; // Defer deleting temp objects until after finish
      this._objectReplacementMap = new Map(); // Map objects to their replacements
      this._captureBuffersCount = 0;
      this._captureTempBuffers = [];
      this._mappedTextureBufferCount = 0;
      this._encodingTextureChunkCount = 0;
      this._mappedBufferCount = 0;
      this._encodingBufferChunkCount = 0;
      this._captureData = null;
      this._frameRate = new RollingAverage(60);

      if (!window.navigator.gpu) {
        // No WebGPU support
        return;
      }

      const statusContainer = document.createElement("div");
      statusContainer.style = "position: absolute; z-index: 1000000; margin-left: 10px; margin-top: 5px; padding-left: 5px; padding-right: 10px; background-color: rgba(0, 0, 1, 0.75); border-radius: 5px; box-shadow: 3px 3px 5px rgba(0, 0, 0, 0.5); color: #fff; font-size: 12pt;";
      document.body.insertBefore(statusContainer, document.body.firstChild);

      this._inspectingStatus = document.createElement("div");
      this._inspectingStatus.title = "WebGPU Inspector Running";
      this._inspectingStatus.style = "height: 10px; width: 10px; display: inline-block; margin-right: 5px; background-color: #ff0; border-radius: 50%; border: 1px solid #000; box-shadow: inset -4px -4px 4px -3px rgb(255,100,0), 2px 2px 3px rgba(0,0,0,0.8);";
      statusContainer.appendChild(this._inspectingStatus);

      this._inspectingStatusFrame = document.createElement("div");
      this._inspectingStatusFrame.style = "display: inline-block;";
      this._inspectingStatusFrame.textContent = "Frame: 0";
      statusContainer.appendChild(this._inspectingStatusFrame);

      this._inspectingStatusText = document.createElement("div");
      this._inspectingStatusText.style = "display: inline-block; margin-left: 10px;";
      statusContainer.appendChild(this._inspectingStatusText);

      this._gpuWrapper = new GPUObjectWrapper(this);

      const self = this;
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
          }

          if (self._garbageCollectectedObjects.length > 100) {
            window.postMessage({ "action": Actions.DeleteObjects, "idList": self._garbageCollectectedObjects }, "*");
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

      // Clean out the garbage collected objects every so often.
      const garbageCollectionInterval = 200;
      setInterval(() => {
        if (self._garbageCollectectedObjects.length > 0) {
          window.postMessage({ "action": Actions.DeleteObjects, "idList": self._garbageCollectectedObjects }, "*");
          self._garbageCollectectedObjects.length = 0;
        }
      }, garbageCollectionInterval);

      // Wrap the canvas elements so we can capture when their context is created.
      const canvases = document.getElementsByTagName("canvas");
      for (const canvas of canvases) {
        this._wrapCanvas(canvas);
      }

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
          const time = performance.now();
          self._frameStart(time);
          cb(time);
          self._frameEnd();
        }
        __requestAnimationFrame(callback);
      };

      // Listen for messages from the content-script.
      window.addEventListener("message", (event) => {
        if (event.source !== window) {
          return;
        }
        const message = event.data;
        if (typeof message !== "object" || message === null) {
          return;
        }
        if (message.action === PanelActions.RequestTexture) {
          const textureId = message.id;
          self._requestTexture(textureId);
        } else if (message.action === PanelActions.CompileShader) {
          const shaderId = message.id;
          const code = message.code;
          self._compileShader(shaderId, code);
        } else if (message.action === PanelActions.RevertShader) {
          const shaderId = message.id;
          self._revertShader(shaderId);
        }
      });
    }

    disableRecording() {
      this._gpuWrapper.disableRecording();
    }

    enableRecording() {
      this._gpuWrapper.enableRecording();
    }

    _updateCanvasAttachment(attachment) {
      let textureView = null;
      if (attachment.resolveTarget) {
        textureView = attachment.resolveTarget;
      } else if (attachment.view) {
        textureView = attachment.view;
      }

      const texture = textureView?.__texture;
      const context = texture?.__context;

      // If the texture has a context, it's a canvas texture.
      if (!context) {
        return;
      }

      if (context.__captureTexture) {
        if (context.__captureTexture.width != texture.width ||
            context.__captureTexture.height != texture.height ||
            context.__captureTexture.format != texture.format) {
          this.disableRecording();
          context.__captureTexture.destroy();
          context.__captureTexture = null;
          this.enableRecording();
        }
      }

      const device = context.__device;
      if (device) {
        this.disableRecording();

        const captureTexture = device.createTexture({
          size: [texture.width, texture.height, 1],
          format: texture.format,
          usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC
        });

        context.__captureTexture = captureTexture;
        if (captureTexture) {
          captureTexture.__id = texture.__id;
          captureTexture.__canvasTexture = texture;
          captureTexture.__context = context;

          const captureView = captureTexture.createView();
          captureView.__texture = captureTexture;
          captureView.__canvasView = textureView;
          captureTexture.__view = captureView;
          captureView.__context = context;

          if (attachment.resolveTarget) {
            attachment.resolveTarget = captureView;
          } else {
            attachment.view = captureView;
          }
        }

        this.enableRecording();
      }
    }

    // Called before a GPU method is called, allowing the inspector to modify
    // the arguments or the object before the method is called.
    _preMethodCall(object, method, args) {
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

      if (method === "beginRenderPass") {
        /*if (this._errorChecking > 0) {
          if (object.__device) {
            this.disableRecording();
            object.__device.pushErrorScope("validation");
            this.enableRecording();
          }
        }*/
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
        object.__device = descriptor.device;
      }
    }

    // Called after a GPU method is called, allowing the inspector to wrap the result.
    _postMethodCall(object, method, args, result, stacktrace) {
      this._frameCommandCount++;

      if (method === "beginRenderPass") {
        // object is a GPUCommandEncoder
        // result is a GPURenderPassEncoder
        result.__commandEncoder = object;

        // Check to see if any of the color attachments are canvas textures.
        // We need to know this so we can capture the canvas texture after the
        // render pass is finished.
        for (const colorAttachment of args[0].colorAttachments) {
          const view = colorAttachment.resolveTarget ?? colorAttachment.view;
          if (view) {
            if (view.__id < 0) {
              object.__rendersToCanvas = true;
              const texture = view.__texture;
              if (texture.__frameIndex < this._frameIndex) {
                const message = "An expired canvas texture is being used as an attachment for a RenderPass.";
                window.postMessage({ "action": Actions.ValidationError, id: 0, message, stacktrace }, "*");
              }
              break;
            }
          }
        }
      }

      if (method === "finish") {
        // Renders to canvas tracks whether the render pass encoder renders to a canvas.
        // We only want to capture canvas textures if it's been immediatley rendered to,
        // otherwise it will be black. Store the value in the command buffer so we can
        // see it from the submit function.
        result.__rendersToCanvas = object.__rendersToCanvas;
      }

      if (method === "submit") {
        this.disableRecording();

        if (this._captureTextureRequest.size > 0) {
          const self = this;
          const commandBuffers = args[0];
          let rendersToCanvas = false;
          for (const commandBuffer of commandBuffers) {
            rendersToCanvas |= !!commandBuffer.__rendersToCanvas;
          }
          this._captureTextureRequest.forEach((texture, id) => {
            if (id > 0 || rendersToCanvas) {
              texture = texture || self._trackedObjects.get(id)?.deref();
              self._captureTextureBuffer(object.__device, null, texture);
              self._captureTextureRequest.delete(id);
            }
          });
        }

        if (this._captureTempBuffers.length) {
          this._sendCapturedBuffers();
        }

        if (this._captureTexturedBuffers.length) {
          this._sendCaptureTextureBuffers();
        }

        for (const obj of this._toDestroy) {
          obj.destroy();
        }
        this._toDestroy.length = 0;

        this.enableRecording();
      }

      if (method === "createShaderModule" ||
          method === "createRenderPipeline" ||
          method === "createComputePipeline" ||
          method === "createBindGroup") {
        if (this._errorChecking > 0) {
          this.disableRecording();
          object.popErrorScope().then((error) => {
            if (error) {
              console.error(error.message);
              const id = result?.__id ?? 0;
              window.postMessage({ "action": Actions.ValidationError, id, "message": error.message, stacktrace }, "*");
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
                window.postMessage({ "action": Actions.ValidationError, "message": error.message, stacktrace }, "*");
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
        object.__canvasTexture = new WeakRef(result);
        result.__frameIndex = this._frameIndex;
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
            object.__adapter = adapter;
          });
        }
      }
      
      if (result) {
        // Wrap GPU objects
        if (GPUObjectTypes.has(result.constructor)) {
          this._wrapObject(result, id);
        }

        if (method === "createShaderModule" ||
            method === "createRenderPipeline") {
          result.__descriptor = args[0];
          result.__device = object;
          this._objectReplacementMap.set(result.__id, { id: result.__id, object: new WeakRef(result), replacement: null });
        } else if (method === "getCurrentTexture") {
          result.__context = object;
          this._trackObject(result.__id, result);
          result.label = "CanvasTexture";
        } else if (method === "createTexture") {
          this._trackObject(result.__id, result);
        } else if (method === "createView" && !id) {
          this._trackObject(result.__id, result);
          result.__texture = object;
          if (result.__id < 0) {
            result.label = "CanvasTextureView";
          }
        } else if (method === "createBuffer") {
          this._trackObject(result.__id, result);
        } else if (method === "createBindGroup") {
          this._trackObject(result.__id, result);
          result.__descriptor = args[0];
        } else if (method === "setBindGroup") {
          const descriptor = args[1].__descriptor;
          if (descriptor) {
            for (const entry of descriptor.entries) {
              if (entry.resource instanceof GPUTextureView && entry.resource.__id < 0) {
                // This is a canvas texture view
                const texture = entry.resource.__texture;
                if (texture.__frameIndex < this._frameIndex) {
                  const message = `A BindGroup(${object.__id}) with an expired canvs texture is being used.`;
                  window.postMessage({ "action": Actions.ValidationError, id: 0, message, stacktrace }, "*");
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
        window.postMessage({ action: Actions.ResolveAsyncObject, id: result.__id });
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
        device.queue.__device = device;

        device.addEventListener('uncapturederror', (event) => {
          window.postMessage({ "action": Actions.ValidationError, id: 0, "message": event.error.message }, "*");
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
        device.__adapter = adapter; // prevent adapter from being garbage collected
      }
    }

    clear() {
      this._captureFrameCommands.length = 0;
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
        return 0;
      }
      return this._objectID++;
    }

    _memoryLeakWarning(id, object) {
      if (object) {
        const type = object.name;
        const message = `${type} was garbage collected without being explicitly destroyed. These objects should explicitly destroyed to avoid GPU memory leaks.`;
        window.postMessage({"action": Actions.ValidationError, id: 0, "message": message}, "*");
      }
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
        } else if (x.label !== undefined) {
          obj[key] = x;
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

      for (const objectRef of this._objectReplacementMap.values()) {
        const object = objectRef.object.deref();
        const isRenderPipeline = object instanceof GPURenderPipeline;
        const isComputePipeline = object instanceof GPUComputePipeline;
        if (isRenderPipeline || isComputePipeline) {
          const descriptor = object.__descriptor;
          
          let found = false;
          let vertexModule = null;
          let fragmentModule = null;
          let computeModule = 0;

          if (descriptor.vertex?.module === shader) {
            vertexModule = shader;
            found = true;
          }
          if (descriptor.fragment?.module === shader) {
            fragmentModule = shader;
            found = true;
          }
          if (descriptor.compute?.module === shader) {
            computeModule = shader;
            found = true;
          }

          if (found) {
            objectRef.replacement = null;
          }
        }
      }
    }

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
      device.pushErrorScope('validation');
      descriptor.__replacement = shaderId;
      const newShaderModule = device.createShaderModule(descriptor);
      device.popErrorScope().then((error) => {
        if (error) {
          console.error(error.message);
          const id = shaderId ?? 0;
          window.postMessage({ "action": Actions.ValidationError, id, "message": error.message }, "*");
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
            newDescriptor.__replacement = objectRef.id;
            device.pushErrorScope('validation');
            const newPipeline = isRenderPipeline ?
                device.createRenderPipeline(newDescriptor) :
                device.createComputePipeline(newDescriptor);
            device.popErrorScope().then((error) => {
              if (error) {
                console.error(error.message);
                const id = objectRef.id ?? 0;
                window.postMessage({ "action": Actions.ValidationError, id, "message": error.message }, "*");
              }
            });
            this._errorChecking++;
            this.enableRecording();

            objectRef.replacement = newPipeline;
          }
        }
      }
    }

    _requestTexture(textureId) {
      if (textureId < 0) {
        this._captureTextureRequest.set(textureId, null);
      } else {
        const ref = this._trackedObjects.get(textureId);
        const texture = ref?.deref();
        if (texture instanceof GPUTexture) {
          this._captureTextureRequest.set(textureId, texture);
        }
      }
    }

    _updateStatusMessage() {
      let status = "";

      if (this._captureTexturedBuffers.length > 0) {
        status += `Texture: ${this._captureTexturedBuffers.length} `;
      }

      if (this._mappedTextureBufferCount > 0) {
        status += `Pending Texture Reads: ${this._mappedTextureBufferCount} `;
      }

      if (this._encodingTextureChunkCount > 0) {
        status += `Pending Texture Encoding: ${this._encodingTextureChunkCount} `;
      }

      if (this._captureBuffersCount) {
        status += `Buffers: ${this._captureBuffersCount} `;
      }

      if (this._mappedBufferCount > 0) {
        status += `Pending Buffer Reads: ${this._mappedBufferCount} `;
      }

      if (this._encodingBufferChunkCount > 0) {
        status += `Pending Buffer Encoding: ${this._encodingBufferChunkCount} `;
      }

      if (status) {
        status = `Capturing: ${status} `;
      }

      this._inspectingStatusText.textContent = status;
    }

    _frameStart(time) {
      let deltaTime = 0;
      if (this._lastFrameTime == 0) {
        this._lastFrameTime = time;
      } else {
        deltaTime = time - this._lastFrameTime;
        window.postMessage({ "action": Actions.DeltaTime, deltaTime }, "*");
        this._lastFrameTime = time;

        this._frameRate.add(deltaTime);
      }

      const captureData = sessionStorage.getItem(webgpuInspectorCaptureFrameKey);
      if (captureData) {
        try {
          this._captureData = JSON.parse(captureData);
        } catch (e) {
          this._captureData = null;
        }
        sessionStorage.removeItem(webgpuInspectorCaptureFrameKey);
      }

      if (this._captureData) {
        if (this._captureData.frame < 0 || this._frameIndex >= this._captureData.frame) {
          this._captureMaxBufferSize = this._captureData.maxBufferSize || maxBufferCaptureSize;
          this._captureFrameRequest = true;
          this._gpuWrapper.recordStacktraces = true;
          this._captureData = null;
        }
      }

      this._frameData.length = 0;
      this._captureFrameCommands.length = 0;
      this._frameRenderPassCount = 0;
      this._frameIndex++;
      this._frameCommandCount = 0;

      this._inspectingStatusFrame.textContent = `Frame: ${this._frameIndex} : ${this._frameRate.average.toFixed(2)}ms`;
    }

    _frameEnd() {
      if (this._captureFrameCommands.length) {
        const maxFrameCount = 2000;
        const batches = Math.ceil(this._captureFrameCommands.length / maxFrameCount);
        window.postMessage({ "action": Actions.CaptureFrameResults, "frame": this._frameIndex, "count": this._captureFrameCommands.length, "batches": batches }, "*");

        for (let i = 0; i < this._captureFrameCommands.length; i += maxFrameCount) {
          const length = Math.min(maxFrameCount, this._captureFrameCommands.length - i);
          const commands = this._captureFrameCommands.slice(i, i + length);
          window.postMessage({
              "action": Actions.CaptureFrameCommands,
              "frame": this._frameIndex - 1,
              "commands": commands,
              "index": i,
              "count": length
            }, "*");
        }
        this._captureFrameCommands.length = 0;
        this._captureFrameRequest = false;
        this._gpuWrapper.recordStacktraces = false;
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

      canvas.__id = this.getNextId(canvas);
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
              window.postMessage({ "action": Actions.ObjectSetLabel, id, label }, "*");
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
      //return descriptor;
      const s = JSON.stringify(descriptor);
      return s;
    }

    _sendAddObjectMessage(id, parent, type, descriptor, stacktrace, pending) {
      window.postMessage({ "action": Actions.AddObject, id, parent, type, descriptor, stacktrace, pending }, "*");
    }

    _recordCommand(object, method, result, args, stacktrace) {
      const parent = object?.__id ?? 0;

      if (method === "destroy") {
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
          window.postMessage({"action": Actions.DeleteObject, id}, "*");
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
      }

      if (this._captureFrameRequest) {
        this._captureCommand(object, method, args, stacktrace, result);
      }
    }

    _captureCommand(object, method, args, stacktrace, result) {
      const commandId = this._captureFrameCommands.length;

      const a = args;
      if (a.length === 1 && a[0] === undefined) {
        a.length = 0;
      }

      if (method === "beginRenderPass") {
        result.__id = `_${commandId}`;
      } else if (method === "beginComputePass") {
        result.__id = `_${commandId}`;
      } else if (method === "createCommandEncoder") {
        result.__id = `_${commandId}`;
      } else if (method === "finish") {
        result.__id = `_${commandId}`;
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
          if (array.length > 0) {
            if (array instanceof Uint32Array) {
              const offset = a[3];
              const size = a[4];
              if (size > 0) {
                const subArray = new Uint32Array(array.buffer, offset * 4, size);
                newArgs.push(subArray);
              }
            } else {
              newArgs.push(array);
            }
          }
        }

        const dynamicOffsets = (newArgs.length > 2) ? newArgs[2] : null;
        let dynamicOffsetIndex = 0;
        const bindGroupDesc = bindGroup.__descriptor;
        const bindGroupLayoutDesc = bindGroupDesc.layout?.__descriptor;
        if (bindGroupDesc) {
          for (const entryIndex in bindGroupDesc.entries) {
            const entry = bindGroupDesc.entries[entryIndex];
            const layoutEntry = bindGroupLayoutDesc?.entries[entryIndex];
            const buffer = entry?.resource?.buffer;
            const usesDynamicOffset = layoutEntry?.buffer?.hasDynamicOffset ?? false;
            if (buffer) {
              let offset = entry.resource.offset ?? 0;
              const origSize = entry.resource.size ?? (buffer.size - offset);
              const size = alignTo(origSize, 4);

              if (size < this._captureMaxBufferSize) {
                if (usesDynamicOffset) {
                  offset = dynamicOffsets[dynamicOffsetIndex++];
                }

                if (!object.__captureBuffers) {
                  object.__captureBuffers = [];
                }
                
                object.__captureBuffers.push({ commandId, entryIndex, buffer, offset, size });
                this._captureBuffersCount++;
                this._updateStatusMessage();
              }
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

      this._captureFrameCommands.push({
        "class": object.constructor.name,
        "object": object.__id,
        "result": result?.__id ?? 0,
        commandId,
        method,
        args: newArgs,
        stacktrace
      });

      if (method === "setIndexBuffer") {
        object.__indexBuffer = args;
      }

      if (method === "drawIndexed") {
        if (object.__indexBuffer) {
          // TODO: Capture the index buffer.
          // There is a problem that we can't copy the index buffer if the size isn't aligned to 4,
          // and if we bump the size up to the next multiple of 4, we'll be copying more data than
          // the original buffer has. We need to make sure index buffers are allocated to an alignment size of 4.
          /*const indexCount = args[0];
          const firstIndex = args[2] ?? 0;

          const buffer = object.__indexBuffer[0];
          const format = object.__indexBuffer[1];
          const elementSize = format === "uint32" ? 4 : 2;
          const bufferOffset = object.__indexBuffer[2] ?? 0;
          //const bufferSize = object.__indexBuffer[3] ?? (buffer.size - bufferOffset);

          const firstIndexOffset = bufferOffset + (firstIndex * elementSize);
          const indexCountSize = indexCount * elementSize;

          if (!object.__captureBuffers) {
            object.__captureBuffers = [];
          }
          
          const size = alignTo(indexCountSize, 4);
          object.__captureBuffers.push({ commandId, entryIndex: 0, buffer, offset: firstIndexOffset, size });
          this._captureBuffersCount++;
          this._updateStatusMessage();*/
        }
      }

      if (method === "drawIndirect" || method === "drawIndexedIndirect" || method === "dispatchWorkgroupsIndirect") {
        const buffer = args[0];
        const offset = args[1];
        const size = 32;
        if (!object.__captureBuffers) {
          object.__captureBuffers = [];
        }

        const indexBuffer = method === "drawIndexedIndirect" ? {} : undefined;

        if (method === "drawIndexedIndirect" && object.__indexBuffer) {
          // The index buffer for indirect draws can't be captured here because the
          // indexCount and firstIndex args are in the indirect buffer. The indirect
          // buffer needs to be read first, those args extracted, and then the index
          // buffer can be copied.
          const buffer = object.__indexBuffer[0];
          const format = object.__indexBuffer[1];
          const bufferOffset = object.__indexBuffer[2] ?? 0;
          const bufferSize = object.__indexBuffer[3] ?? (buffer.size - bufferOffset);
          indexBuffer.buffer = buffer;
          indexBuffer.format = format;
          indexBuffer.bufferOffset = bufferOffset;
          indexBuffer.bufferSize = bufferSize;
        }

        object.__captureBuffers.push({ commandId, entryIndex: 0, buffer, offset, size, indexBuffer });
        this._captureBuffersCount++;
        this._updateStatusMessage();
      }

      if (method === "beginRenderPass") {
        if (args[0]?.colorAttachments?.length > 0) {
          result.__captureTextureViews = new Set();
          for (const attachment of args[0].colorAttachments) {
            const captureTextureView = attachment.resolveTarget ?? attachment.view;
            result.__captureTextureViews.add(captureTextureView);
          }
        }
        result.__descriptor = args[0];
        if (args[0]?.depthStencilAttachment) {
          if (!result.__captureTextureViews) {
            result.__captureTextureViews = new Set();
          }
          const attachment = args[0].depthStencilAttachment;
          const captureTextureView = attachment.resolveTarget ?? attachment.view;
          result.__captureTextureViews.add(captureTextureView);
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
          this._updateStatusMessage();
        }
        if (object.__captureTextureViews?.size > 0) {
          let passId = this._frameRenderPassCount * maxColorAttachments;
          for (const captureTextureView of object.__captureTextureViews) {
            const texture = captureTextureView.__texture;
            if (texture) {
              this._captureTextureBuffer(commandEncoder?.__device, commandEncoder, texture, passId++);
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

    _sendCaptureTextureBuffers() {
      const textures = [];
      for (const textureBuffer of this._captureTexturedBuffers) {
        textures.push(textureBuffer.id);
      }

      let totalChunks = 0;
      for (const textureBuffer of this._captureTexturedBuffers) {
        const size = textureBuffer.tempBuffer.size;
        const numChunks = Math.ceil(size / maxDataChunkSize);
        totalChunks += numChunks;
      }

      window.postMessage({
        "action": Actions.CaptureTextureFrames, 
        "chunkCount": totalChunks,
        "count": this._captureTexturedBuffers.length,
        textures }, "*");
     
      for (const textureBuffer of this._captureTexturedBuffers) {
        const { id, tempBuffer, passId } = textureBuffer;

        this._mappedTextureBufferCount++;
        const self = this;
        tempBuffer.mapAsync(GPUMapMode.READ).then(() => {
          self._mappedTextureBufferCount--;
          self._updateStatusMessage();
          const range = tempBuffer.getMappedRange();
          const data = new Uint8Array(range);
          self._sendTextureData(id, passId, data);
          tempBuffer.destroy();
        }).catch((e) => {
          console.error(e);
        });
      }
      this._captureTexturedBuffers.length = 0;
      this._updateStatusMessage();
    }

    _sendTextureData(id, passId, data) {
      const size = data.length;
      const numChunks = Math.ceil(size / maxDataChunkSize);

      const self = this;
      for (let i = 0; i < numChunks; ++i) {
        const offset = i * maxDataChunkSize;
        const chunkSize = Math.min(maxDataChunkSize, size - offset);
        const chunk = data.slice(offset, offset + chunkSize);

        this._encodingTextureChunkCount++;
        this._updateStatusMessage();
        encodeDataUrl(chunk).then((chunkData) => {
          window.postMessage({
            "action": Actions.CaptureTextureData,
            id,
            passId,
            offset,
            size,
            index: i,
            count: numChunks,
            chunk: chunkData
          }, "*");
          self._encodingTextureChunkCount--;
          self._updateStatusMessage();
        }).catch((e) => {
          console.log("Error encoding texture data:", e);
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
      const self = this;

      for (let i = 0; i < numChunks; ++i) {
        const offset = i * maxDataChunkSize;
        const chunkSize = Math.min(maxDataChunkSize, size - offset);
        const chunk = data.slice(offset, offset + chunkSize);

        this._encodingBufferChunkCount++;
        this._updateStatusMessage();
        encodeDataUrl(chunk).then((chunkData) => {
          window.postMessage({
            "action": Actions.CaptureBufferData,
            commandId,
            entryIndex,
            offset,
            size,
            index: i,
            count: numChunks,
            chunk: chunkData
          }, "*");
          self._encodingBufferChunkCount--;
          self._updateStatusMessage();
        });
      }
    }

    // Buffers associated with a command are recorded and then sent to the inspector server.
    // The data is sent in chunks since the message pipe can't handle very much data at a time.
    _sendCapturedBuffers() {
      const buffers = this._captureTempBuffers;
      if (buffers.length > 0) {
        let totalChunks = 0;
        for (const bufferInfo of buffers) {
          const size = bufferInfo.tempBuffer.size;
          const numChunks = Math.ceil(size / maxDataChunkSize);
          totalChunks += numChunks;
        }

        window.postMessage({
          "action": Actions.CaptureBuffers,
          "count": buffers.length,
          "chunkCount": totalChunks }, "*");
      }

      for (const bufferInfo of buffers) {
        const tempBuffer = bufferInfo.tempBuffer;
        const commandId = bufferInfo.commandId;
        const entryIndex = bufferInfo.entryIndex;
        const self = this;
        this._mappedBufferCount++;
        this._updateStatusMessage();
        tempBuffer.mapAsync(GPUMapMode.READ).then(() => {
          self._mappedBufferCount--;
          self._updateStatusMessage();
          const range = tempBuffer.getMappedRange();
          const data = new Uint8Array(range);
          self._sendBufferData(commandId, entryIndex, data);
          tempBuffer.destroy();
        });
      }
      this._captureTempBuffers.length = 0;
    }

    // Buffers associated with a command are recorded and then sent to the inspector server.
    // The data is copied to a temp buffer so that the original buffer can continue to be used
    // by the page.
    _recordCaptureBuffers(commandEncoder, buffers) {
      const device = commandEncoder?.__device;
      if (!device) {
        this._captureBuffersCount -= buffers.length;
        buffers.length = 0;
        return;
      }

      for (const bufferInfo of buffers) {
        const { commandId, entryIndex, buffer, offset, size } = bufferInfo;

        if (buffer.__destroyed) {
          continue;
        }

        let tempBuffer = null;
        this.disableRecording();

        try {
          tempBuffer = device.createBuffer({
            size,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
            label: `BUFFER CAPTURE TEMP [${commandId},${entryIndex}]`
          });

          commandEncoder.copyBufferToBuffer(buffer, offset, tempBuffer, 0, size);

          this._captureTempBuffers.push({ commandId, entryIndex, tempBuffer });
          
        } catch (e) {
          console.log(e);
        }

        this.enableRecording();
      }

      this._captureBuffersCount -= buffers.length;
      buffers.length = 0;
    }

    // Copy the texture to a buffer so we can send it to the inspector server.
    // The texture data is copied to a buffer now, then after the frame has finished
    // the buffer data is sent to the inspector server.
    _captureTextureBuffer(device, commandEncoder, texture, passId) {
      // can't capture canvas texture
      if (!device) {
        return;
      }

      const doSubmit = !commandEncoder;
      commandEncoder ??= device.createCommandEncoder();

      passId ??= -1;

      const id = texture.__id;
      let format = texture.format;
      let formatInfo = format ? TextureFormatInfo[format] : undefined;
      if (!formatInfo) { // GPUExternalTexture?
        return;
      }

      if (formatInfo.isDepthStencil) {
        this.disableRecording();
        try {
          const textureUtils = this._getTextureUtils(device);
          // depth24plus texture's can't be copied to a buffer,
          // https://github.com/gpuweb/gpuweb/issues/652,
          // convert it to a float texture.
          texture = textureUtils.copyDepthTexture(texture, "r32float", commandEncoder);
        } catch (e) {
          this.enableRecording();
          console.log(e);
          return;
        }
        this.enableRecording();
        format = texture.format;
        formatInfo = format ? TextureFormatInfo[format] : undefined;
        texture.__id = id;
        this._toDestroy.push(texture); // Destroy the temp texture at the end of the frame
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

      let tempBuffer = null;
      try {
        this.disableRecording();

        tempBuffer = device.createBuffer({
          size: bufferSize,
          usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ
        });

        const aspect = "all";

        commandEncoder.copyTextureToBuffer(
          { texture, aspect },
          { buffer: tempBuffer, bytesPerRow, rowsPerImage: height },
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
        this._captureTexturedBuffers.push({ id, tempBuffer, width, height, depthOrArrayLayers, format, passId });
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

  new WebGPUInspector();
})();
