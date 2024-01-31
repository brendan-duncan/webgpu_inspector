import { encodeBase64, encodeDataUrl } from "./src/base64.js";
import { GPUObjectTypes, GPUObjectWrapper } from "./src/gpu_object_wrapper.js";
import { TextureFormatInfo } from "./src/texture_format_info.js";
import { TextureUtils } from "./src/texture_utils.js";

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
      this._maxFramesToRecord = 1000;
      this._captureRequest = false;
      this.__skipRecord = false;
      this._trackedObjects = new Map();
      this._captureTextureRequest = new Map();
      this._toDestroy = [];

      if (!window.navigator.gpu) {
        // No WebGPU support
        return;
      }

      this._gpuWrapper = new GPUObjectWrapper(this);

      const self = this;
      this._gpuWrapper.onPromiseResolve.addListener(this._onAsyncResolve, this);
      this._gpuWrapper.onPreCall.addListener(this._preMethodCall, this);
      this._gpuWrapper.onPostCall.addListener(this._onMethodCall, this);
     
      // Try to track garbage collected WebGPU objects
      this._gcRegistry = new FinalizationRegistry((id) => {
        if (id >= 0) {
          window.postMessage({"action": "inspect_delete_object", id}, "*");
          if (self._trackedObjects.has(id)) {
            const object = self._trackedObjects.get(id);
            // If we're here, the object was garbage collected but not explicitly destroyed.
            // Some GPU objects need to be explicitly destroyed, otherwise it's a memory
            // leak. Notify the user of this.
            if (object instanceof GPUBuffer || object instanceof GPUTexture || object instanceof GPUDevice) {
              self._memoryLeakWarning(object);
            }
            self._trackedObjects.delete(id);
          }
        }
        self._trackedObjects.delete(id);
        self._captureTextureRequest.delete(id);
      });

      this._wrapCanvases();

      // Capture any dynamically created canvases
      const __createElement = document.createElement;
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
        if (message.action == "inspect_request_texture") {
          const textureId = message.id;
          self._requestTexture(textureId);
        }
      });
    }

    _preMethodCall(object, method, args) {
      const self = this;

      if (method == "createTexture") {
        // Add COPY_SRC usage to all textures so we can capture them
        args[0].usage |= GPUTextureUsage.COPY_SRC;
      }

      this._capturedRenderView = null;
      if (method == "beginRenderPass") {
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
      if ((object == this._lastCommandEncoder) && method == "finish") {
        if (this._captureTextureRequest.size > 0) {
          this._captureTextureBuffers();
        }
      }

      // We want to be able to capture canvas textures, so we need to add COPY_SRC to
      // the usage flags of any textures created from canvases.
      if ((object instanceof GPUCanvasContext) && method == "configure") {
        const descriptor = args[0];
        if (descriptor.usage) {
          descriptor.usage |= GPUTextureUsage.COPY_DST;
        } else {
          descriptor.usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
        }
        object.__device = descriptor.device;
      }       

      if (method == "submit") {
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

    _onMethodCall(object, method, args, result) {
      if (method == "beginRenderPass") {
        result.__commandEncoder = object;
        if (this._capturedRenderView) {
          result.__capturedRenderView = this._capturedRenderView;
        }
      }

      if (method == "end") {
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
      if (method == "getCurrentTexture" && result) {
        id = -(object.__canvas?.__id ?? 1);
      } else if (method == "createView") {
        if (object.__isCanvasTexture) {
          id = object.__id - 0.5;
        }
      }
      
      if (result) {
        if (GPUObjectTypes.has(result.constructor)) {
          this._wrapObject(result, id);
        }

        if (method == "createTexture") {
          this._trackedObjects.set(result.__id, result);
        } else if (method == "createView" && !id) {
          this._trackedObjects.set(result.__id, result);
        } else if (method == "createBuffer") {
          this._trackedObjects.set(result.__id, result);
        } else if (method == "getCurrentTexture") {
          result.__isCanvasTexture = true;
          result.__context = object;
          this._trackedObjects.set(result.__id, result);
          if (object.__canvas) {
            result.__canvas = object.__canvas;
          }
        }
      }

      this._recordCommand(object, method, result, args);
    }

    _onAsyncResolve(object, method, args, id, result) {
      if (method === "requestAdapter") {
        const adapter = result;
        if (adapter) {
          this._wrapAdapter(result, id);
        }
      } else if (method === "requestDevice") {
        const adapter = object;
        const device = result;
        if (device) {
          this._wrapDevice(adapter, device, id, args);
        }
      }
    }

    _wrapAdapter(adapter, id) {
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
        window.postMessage({"action": "inspect_add_object", id, "type": "Adapter", "descriptor": JSON.stringify(info)}, "*");
      });
    }

    _wrapDevice(adapter, device, id, args) {
      if (adapter.__id === undefined) {
        this._wrapAdapter(adapter);
      }

      if (device && device.__id === undefined) {
        this._wrapObject(device, id);
        const descriptor = args[0] ?? {};
        const deviceId = device.__id;
        const adapterId = adapter.__id;
        descriptor["features"] = this._gpuToArray(device.features);
        descriptor["limits"] = this._gpuToObject(device.limits);
        this._trackedObjects.set(deviceId, device);
        window.postMessage({"action": "inspect_add_object", id: deviceId, parent: adapterId, "type": "Device", "descriptor": JSON.stringify(descriptor)}, "*");
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

    _requestTexture(textureId) {
      if (textureId < 0) {
        // canvas texture
        const canvasId = -textureId;
        const canvas = this._trackedObjects.get(canvasId);
        if (canvas) {
          if (canvas.__captureTexture) {
            this._captureTextureRequest.set(textureId, canvas.__captureTexture);
            return;
          }
        }
      }
      const object = this._trackedObjects.get(textureId);
      if (!object || !(object instanceof GPUTexture)) {
        return;
      }
      this._captureTextureRequest.set(textureId, object);
    }

    _frameStart() {
      window.postMessage({"action": "inspect_begin_frame"}, "*");

      if (sessionStorage.getItem(webgpuInspectorCaptureFrameKey)) {
        sessionStorage.removeItem(webgpuInspectorCaptureFrameKey);
        this._captureRequest = true;
      }
      this._frameData.length = 0;
      this._frameCommands.length = 0;
      this._frameRenderPassCount = 0;
      this._frameIndex++;
    }

    _frameEnd() {
      window.postMessage({"action": "inspect_end_frame"}, "*");

      if (this._frameCommands.length) {
        window.postMessage({"action": "inspect_capture_frame_results", "frame": this._frameIndex, "commands": this._frameCommands}, "*");
        this._frameCommands.length = 0;
        this._captureRequest = false;
      }
    }

    _wrapCanvas(c) {
      if (c.__id) {
        return;
      }
      c.__id = this.getNextId(c);

      this._trackedObjects.set(c.__id, c);

      const self = this;
      const __getContext = c.getContext;

      c.getContext = function (a1, a2) {
        const ret = __getContext.call(c, a1, a2);
        if (a1 == "webgpu") {
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
          typeof object[m] == "function" &&
          WebGPUInspector._skipMethods.indexOf(m) == -1
        ) {
          return true;
        }
      }
      return false;
    }

    _wrapObject(object, id) {
      if (object.__id) {
        return;
      }
      object.__id = id ?? this.getNextId(object);

      this._gcRegistry.register(object, object.__id);

      if (object.label !== undefined) {
        // Capture chaning of the GPUObjectBase label
        const l = object.label;
        object._label = l;
        Object.defineProperty(object, "label", {
          enumerable: true,
          configurable: true,
          get() {
            return object._label;
          },
          set(label) {
            object._label = label;
            const id = object.__id;
            window.postMessage({ "action": "inspect_object_set_label", id, label }, "*");
          }
        });
      }

      if (object instanceof GPUDevice) {
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

    _prepareDescriptor(args) {
      if (!args || args.constructor === Number || args.constructor === String || args.constructor === Boolean) {
        return args;
      }
      if (args.buffer === ArrayBuffer || args instanceof ArrayBuffer) {
        return args;
      }
      if (args instanceof Array) {
        const array = [];
        for (const v of args) {
          array.push(this._prepareDescriptor(v));
        }
        return array;
      }

      if (args.__id !== undefined) {
        return {"__id": args.__id, "__class": args.constructor.name };
      }
      
      const descriptor = {};
      for (const key in args) {
        descriptor[key] = this._prepareDescriptor(args[key]);
      }

      return descriptor;
    }

    _stringifyDescriptor(args) {
      const descriptor = this._prepareDescriptor(args) ?? {};
      const s = JSON.stringify(descriptor);
      return s;
    }

    _recordCommand(object, method, result, args) {
      const parent = object.__id;
      if (method == "destroy") {
        const id = object.__id;
        this._trackedObjects.delete(id);
        if (id >= 0) {
          this._captureTextureRequest.delete(id);
          window.postMessage({"action": "inspect_delete_object", id}, "*");
        }
      } else if (method == "createShaderModule") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, parent, "type": "ShaderModule", "descriptor": this._stringifyDescriptor(args[0])}, "*");
      } else if (method == "createBuffer") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, parent,"type": "Buffer", "descriptor": this._stringifyDescriptor(args[0])}, "*");
      } else if (method == "createTexture") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, parent,"type": "Texture", "descriptor": this._stringifyDescriptor(args[0])}, "*");
        result.__device = object;
      } else if (method == "getCurrentTexture") {
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
          window.postMessage({"action": "inspect_add_object", id, parent, "type": "Texture", "descriptor": infoStr}, "*");
        }
      } else if (method == "createView") {
        const id = result.__id;
        result.__texture = object;
        window.postMessage({"action": "inspect_add_object", id, parent,"type": "TextureView", "descriptor": this._stringifyDescriptor(args[0])}, "*");
      } else if (method == "createSampler") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, parent,"type": "Sampler", "descriptor": this._stringifyDescriptor(args[0])}, "*");
      } else if (method == "createBindGroup") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, parent,"type": "BindGroup", "descriptor": this._stringifyDescriptor(args[0])}, "*");
      } else if (method == "createBindGroupLayout") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, parent,"type": "BindGroupLayout", "descriptor": this._stringifyDescriptor(args[0])}, "*");
      } else if (method == "createPipelineLayout") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, parent,"type": "PipelineLayout", "descriptor": this._stringifyDescriptor(args[0])}, "*");
      } else if (method == "createRenderPipeline") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, parent,"type": "RenderPipeline", "descriptor": this._stringifyDescriptor(args[0])}, "*");
        // There are cases when the shader modules used by the render pipeline will be garbage collected, and we won't be able to inspect them after that.
        // Hang on to the shader modules used in the descriptor by attaching them to the pipeline.
        if (args[0].vertex?.module) {
          result.__vertexModule = args[0].vertex?.module;
        }
        if (args[0].fragment?.module) {
          result.__fragmentModule = args[0].fragment?.module;
        }
      } else if (method == "createComputePipeline") {
        const id = result.__id;
        window.postMessage({"action": "inspect_add_object", id, parent,"type": "ComputePipeline", "descriptor": this._stringifyDescriptor(args[0])}, "*");
        if (args[0].compute?.module) {
          result.__computeModule = args[0].compute?.module;
        }
      } else if (method == "beginRenderPass") {
        window.postMessage({"action": "inspect_begin_render_pass", "descriptor": this._stringifyDescriptor(args[0])}, "*");
        this._frameRenderPassCount++;
      } else if (method == "beginComputePass") {
          window.postMessage({"action": "inspect_begin_compute_pass", "descriptor": this._stringifyDescriptor(args[0])}, "*");
      } else if (method == "end") {
        window.postMessage({"action": "inspect_end_pass"}, "*");
      } else if (method == "createCommandEncoder") {
        // We'll need the CommandEncoder's device for capturing textures
        result.__device = object;
        this._lastCommandEncoder = result;
      } else if (method == "finish") {
        if (object == this._lastCommandEncoder) {
          this._lastCommandEncoder = null;
        }
      }

      if (this._captureRequest) {
        this._captureCommand(object, method, args);
      }
    }

    _captureCommand(object, method, args) {
      const a = args;
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

      if (method == "beginRenderPass") {
        if (args[0]?.colorAttachments?.length > 0) {
          for (const attachment of args[0].colorAttachments) {
            const captureTextureView = attachment.resolveTarget ?? attachment.view;
            this._captureTextureViews.push(captureTextureView);
          }
          this._captureCommandEncoder = object;
        }
      } else if (method == "end") {
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

  new WebGPUInspector();
})();
