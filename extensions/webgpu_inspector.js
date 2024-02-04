(function () {
  'use strict';

  async function encodeDataUrl(bytes, type = "application/octet-stream") {
    return await new Promise((resolve, reject) => {
      const reader = Object.assign(new FileReader(), {
        onload: () => resolve(reader.result),
        onerror: () => reject(reader.error),
      });
      reader.readAsDataURL(new File([bytes], "", { type }));
    });
  }

  /**
   * A Signal is like a proxy function that can have multiple "listeners" assigned to it, such that
   * when the Signal is executed (or "emitted"), it executes each of its associated listeners.
   * A listener is a callback function, object method, or another Signal.
   */
  class Signal {
    /**
     * @param {String} [name=""] Optional name for the signal, usually used for debugging purposes.
     */
    constructor(name) {
      this._lastSlotId = 0;
      this.slots = new Map();
      if (name) {
        this.name = name;
      }
    }

    /**
     * @property {bool} enabled Returns true if signals are allowed to be emitted. If false,
     * calling the Signal's emit method will do nothing.
     */
    static get enabled() {
      return Signal._disableSignals == 0;
    }

    /***
     * @property {bool} disabled Returns true if signals are disabled from being emitted. If true,
     * calling the Signal's emit method will do nothing.
     */
    static get disabled() {
      return Signal._disableSignals > 0;
    }

    /**
     * Disables all signals from being emitted. This can be called multiple times, but an equal
     * number of calls to enable should be used to re-enable signals. This is often used to disable
     * any callbacks while doing heavy operations, like file loading, so a single signal will be
     * emitted at the end.
     */
    static disable() {
      return Signal._disableSignals++;
    }

    /**
     * Enable signals to be emitted, having been previously disabled.
     * @param {bool} [force=false] If true, signals will be forced to the enabled state,
     * even if there were an unbalanced number of calls to disable..
     */
    static enable(force) {
      if (force) {
        Signal._disableSignals = 0;
        return 0;
      }
      return Signal._disableSignals > 0 ? Signal._disableSignals-- : 0;
    }

    /**
     * Disconnect the listener from all signals of the given object.
     * @param {Object} object The object to disconnect from.
     * @param {Function|Signal|Object} callback The listener to disconnect
     * @param {Object?} [instance=null] The optional listener instance that owns callback.
     */
    static disconnect(object, callback, instance) {
      for (const i in object) {
        const p = object[i];
        if (p.constructor === Signal) {
          p.disconnect(callback, instance);
        }
      }
    }

    /**
     * Return all signals that belong to the object.
     * @param {Object} object The object to get the signals from.
     * @param {Array?} out Optional storage for the results. A new array will be created if null.
     * @return {Array} The list of signals that belong to the object.
     */
    static getSignals(object, out) {
      out = out || [];
      for (const i in object) {
        const p = object[i];
        if (p.constructor === Signal) {
          out.push(p);
        }
      }
      return out;
    }

    /**
     * @property {bool} hasListeners True if this signal has at least one listener.
     */
    get hasListeners() {
      return this.slots.size > 0;
    }

    /**
     * Emit a signal, calling all listeners.
     * @param {...*} arguments Optional arguments to call the listeners with.
     */
    emit() {
      if (Signal.disabled) {
        return;
      }

      for (const k of this.slots) {
        const s = k[1][0];
        const o = k[1][1] || s;
        if (!s) {
          continue;
        }

        if (s.constructor === Signal) {
          s.emit.apply(o, arguments);
        } else {
          s.apply(o, arguments);
        }
      }
    }

    /**
     * Connect a listener to the signal. This can be a function, object method,
     * class static method, or another signal. There is no type-checking to
     * ensure the listener function can successfully receive the arguments that
     * will be emitted by the signal, which will result in an exception of you
     * connect an incompatible listener and emit the signal.
     * To have an object method listen to a signal, pass in the object, too.
     * @param {Function|Signal} callback
     * @param {Object?} [object=null]
     * @example
     * listen(Function)
     * listen(Signal)
     * listen(method, object)
     */
    addListener(callback, object) {
      // Don't add the same listener multiple times.
      if (this.isListening(callback, object)) {
        return null;
      }

      this.slots.set(this._lastSlotId++, [callback, object]);
      return this._lastSlotId - 1;
    }

    /**
     * Checks if there is a binded listener that matches the criteria.
     * @param {Function|Signal|Object} callback
     * @param {Object?} [object=null]
     * @return {bool}
     * @example
     * isListening(Signal)
     * isListening(callback)
     * isListening(object)
     * isListening(method, object)
     */
    isListening(callback, object) {
      for (const slot of this.slots) {
        const slotInfo = slot[1];

        if (callback && !object) {
          if (slotInfo[0] === callback || slotInfo[1] === callback) {
            return true;
          }
        } else if (!callback && object) {
          if (slotInfo[1] === object) {
            return true;
          }
        } else {
          if (slotInfo[0] === callback && slotInfo[1] === object) {
            return true;
          }
        }
      }
      return false;
    }

    /**
     * Disconnect a listener from the signal.
     * @param {*} callback
     * @param {Object?} object
     * @example
     * disconnect(Object) -- Disconnect all method listeners of the given object.
     * disconnect(Function) -- Disconnect the function listener.
     * disconnect(Signal) -- Disconnect the signal listener.
     * disconnect(method, object) -- Disconnect the method listener.
     * disconnect() -- Disconnect all listeners from the signal.
     */
    disconnect(callback, object) {
      if (
        (callback === null || callback === undefined) &&
        (object === null || object === undefined)
      ) {
        this.slots.clear();
        return true;
      }

      if (callback.constructor === Number) {
        const handle = callback;
        if (!this.slots.has(handle)) {
          return false;
        }
        this.slots.delete(handle);
        return true;
      }

      let found = false;
      for (const slot of this.slots) {
        const slotHandle = slot[0];
        const slotInfo = slot[1];

        if (callback && !object) {
          if (slotInfo[0] === callback || slotInfo[1] === callback) {
            this.slots.delete(slotHandle);
            found = true;
          }
        } else if (!callback && object) {
          if (slotInfo[1] === object) {
            this.slots.delete(slotHandle);
            found = true;
          }
        } else {
          if (slotInfo[0] === callback && slotInfo[1] === object) {
            this.slots.delete(slotHandle);
            found = true;
          }
        }
      }

      return found;
    }
  }

  Signal._disableSignals = 0;

  function getStacktrace() {
    if (!Error.captureStackTrace) {
      return "";
    }
    const stacktrace = {};
    Error.captureStackTrace(stacktrace, getStacktrace);
    if (!stacktrace.stack) {
      return "";
    }
    let stack = stacktrace.stack
      .split("\n")
      .map((line) => line.split("at ")[1])
      .slice(2) // Skip the Error line and the GPU.* line.
      .filter((line) => line && !line.includes("webgpu_inspector.js"));

    return stack.join("\n");
  }

  const GPUObjectTypes = new Set([
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

  const GPUCreateMethods = new Set([
    "createBuffer",
    "createTexture",
    "createSampler",
    "importExternalTexture",
    "createBindGroupLayout",
    "createPipelineLayout",
    "createBindGroup",
    "createShaderModule",
    "createComputePipeline",
    "createRenderPipeline",
    "createComputePipelineAsync",
    "createRenderPipelineAsync",
    "createCommandEncoder",
    "createRenderBundleEncoder",
    "createQuerySet",
    "createView"
  ]);

  class GPUObjectWrapper {
    constructor(idGenerator) {
      this._idGenerator = idGenerator;
      this.onPreCall = new Signal();
      this.onPostCall = new Signal();
      this.onPromise = new Signal();
      this.onPromiseResolve = new Signal();
      this.recordStacktraces = false;
      this._wrapGPUTypes();
    }

    _wrapGPUTypes() {
      GPU.prototype.requestAdapter = this._wrapMethod("requestAdapter", GPU.prototype.requestAdapter);
      GPU.prototype.getPreferredFormat = this._wrapMethod("getPreferredFormat", GPU.prototype.getPreferredFormat);

      GPUAdapter.prototype.requestDevice = this._wrapMethod("requestDevice", GPUAdapter.prototype.requestDevice);

      GPUDevice.prototype.destroy = this._wrapMethod("destroy", GPUDevice.prototype.destroy);
      GPUDevice.prototype.createBuffer = this._wrapMethod("createBuffer", GPUDevice.prototype.createBuffer);
      GPUDevice.prototype.createTexture = this._wrapMethod("createTexture", GPUDevice.prototype.createTexture);
      GPUDevice.prototype.createSampler = this._wrapMethod("createSampler", GPUDevice.prototype.createSampler);
      GPUDevice.prototype.importExternalTexture = this._wrapMethod("importExternalTexture", GPUDevice.prototype.importExternalTexture);
      GPUDevice.prototype.createBindGroupLayout = this._wrapMethod("createBindGroupLayout", GPUDevice.prototype.createBindGroupLayout);
      GPUDevice.prototype.createPipelineLayout = this._wrapMethod("createPipelineLayout", GPUDevice.prototype.createPipelineLayout);
      GPUDevice.prototype.createBindGroup = this._wrapMethod("createBindGroup", GPUDevice.prototype.createBindGroup);
      GPUDevice.prototype.createShaderModule = this._wrapMethod("createShaderModule", GPUDevice.prototype.createShaderModule);
      GPUDevice.prototype.createComputePipeline = this._wrapMethod("createComputePipeline", GPUDevice.prototype.createComputePipeline);
      GPUDevice.prototype.createRenderPipeline = this._wrapMethod("createRenderPipeline", GPUDevice.prototype.createRenderPipeline);
      GPUDevice.prototype.createComputePipelineAsync = this._wrapMethod("createComputePipelineAsync", GPUDevice.prototype.createComputePipelineAsync);
      GPUDevice.prototype.createRenderPipelineAsync = this._wrapMethod("createRenderPipelineAsync", GPUDevice.prototype.createRenderPipelineAsync);
      GPUDevice.prototype.createCommandEncoder = this._wrapMethod("createCommandEncoder", GPUDevice.prototype.createCommandEncoder);
      GPUDevice.prototype.createRenderBundleEncoder = this._wrapMethod("createRenderBundleEncoder", GPUDevice.prototype.createRenderBundleEncoder);
      GPUDevice.prototype.createQuerySet = this._wrapMethod("createQuerySet", GPUDevice.prototype.createQuerySet);

      GPUBuffer.prototype.mapAsync = this._wrapMethod("mapAsync", GPUBuffer.prototype.mapAsync);
      GPUBuffer.prototype.getMappedRange = this._wrapMethod("getMappedRange", GPUBuffer.prototype.getMappedRange);
      GPUBuffer.prototype.unmap = this._wrapMethod("unmap", GPUBuffer.prototype.unmap);
      GPUBuffer.prototype.destroy = this._wrapMethod("destroy", GPUBuffer.prototype.destroy);

      GPUTexture.prototype.createView = this._wrapMethod("createView", GPUTexture.prototype.createView);
      GPUTexture.prototype.destroy = this._wrapMethod("destroy", GPUTexture.prototype.destroy);

      GPUShaderModule.prototype.getCompilationInfo = this._wrapMethod("getCompilationInfo", GPUShaderModule.prototype.getCompilationInfo);

      GPUComputePipeline.prototype.getBindGroupLayout = this._wrapMethod("getBindGroupLayout", GPUComputePipeline.prototype.getBindGroupLayout);

      GPURenderPipeline.prototype.getBindGroupLayout = this._wrapMethod("getBindGroupLayout", GPURenderPipeline.prototype.getBindGroupLayout);

      GPUCommandEncoder.prototype.beginRenderPass = this._wrapMethod("beginRenderPass", GPUCommandEncoder.prototype.beginRenderPass);
      GPUCommandEncoder.prototype.beginComputePass = this._wrapMethod("beginComputePass", GPUCommandEncoder.prototype.beginComputePass);
      GPUCommandEncoder.prototype.copyBufferToBuffer = this._wrapMethod("copyBufferToBuffer", GPUCommandEncoder.prototype.copyBufferToBuffer);
      GPUCommandEncoder.prototype.copyBufferToTexture = this._wrapMethod("copyBufferToTexture", GPUCommandEncoder.prototype.copyBufferToTexture);
      GPUCommandEncoder.prototype.copyTextureToBuffer = this._wrapMethod("copyTextureToBuffer", GPUCommandEncoder.prototype.copyTextureToBuffer);
      GPUCommandEncoder.prototype.copyTextureToTexture = this._wrapMethod("copyTextureToTexture", GPUCommandEncoder.prototype.copyTextureToTexture);
      GPUCommandEncoder.prototype.clearBuffer = this._wrapMethod("clearBuffer", GPUCommandEncoder.prototype.clearBuffer);
      GPUCommandEncoder.prototype.resolveQuerySet = this._wrapMethod("resolveQuerySet", GPUCommandEncoder.prototype.resolveQuerySet);
      GPUCommandEncoder.prototype.finish = this._wrapMethod("finish", GPUCommandEncoder.prototype.finish);
      GPUCommandEncoder.prototype.pushDebugGroup = this._wrapMethod("pushDebugGroup", GPUCommandEncoder.prototype.pushDebugGroup);
      GPUCommandEncoder.prototype.popDebugGroup = this._wrapMethod("popDebugGroup", GPUCommandEncoder.prototype.popDebugGroup);
      GPUCommandEncoder.prototype.insertDebugMarker = this._wrapMethod("insertDebugMarker", GPUCommandEncoder.prototype.insertDebugMarker);

      GPUComputePassEncoder.prototype.setPipeline = this._wrapMethod("setPipeline", GPUComputePassEncoder.prototype.setPipeline);
      GPUComputePassEncoder.prototype.dispatchWorkgroups = this._wrapMethod("dispatchWorkgroups", GPUComputePassEncoder.prototype.dispatchWorkgroups);
      GPUComputePassEncoder.prototype.dispatchWorkgroupsIndirect = this._wrapMethod("dispatchWorkgroupsIndirect", GPUComputePassEncoder.prototype.dispatchWorkgroupsIndirect);
      GPUComputePassEncoder.prototype.end = this._wrapMethod("end", GPUComputePassEncoder.prototype.end);
      GPUComputePassEncoder.prototype.setBindGroup = this._wrapMethod("setBindGroup", GPUComputePassEncoder.prototype.setBindGroup);
      GPUComputePassEncoder.prototype.setBindGroup = this._wrapMethod("setBindGroup", GPUComputePassEncoder.prototype.setBindGroup);
      GPUComputePassEncoder.prototype.pushDebugGroup = this._wrapMethod("pushDebugGroup", GPUComputePassEncoder.prototype.pushDebugGroup);
      GPUComputePassEncoder.prototype.popDebugGroup = this._wrapMethod("popDebugGroup", GPUComputePassEncoder.prototype.popDebugGroup);
      GPUComputePassEncoder.prototype.insertDebugMarker = this._wrapMethod("insertDebugMarker", GPUComputePassEncoder.prototype.insertDebugMarker);

      GPURenderPassEncoder.prototype.setViewport = this._wrapMethod("setViewport", GPURenderPassEncoder.prototype.setViewport);
      GPURenderPassEncoder.prototype.setScissorRect = this._wrapMethod("setScissorRect", GPURenderPassEncoder.prototype.setScissorRect);
      GPURenderPassEncoder.prototype.setBlendConstant = this._wrapMethod("setBlendConstant", GPURenderPassEncoder.prototype.setBlendConstant);
      GPURenderPassEncoder.prototype.setStencilReference = this._wrapMethod("setStencilReference", GPURenderPassEncoder.prototype.setStencilReference);
      GPURenderPassEncoder.prototype.beginOcclusionQuery = this._wrapMethod("beginOcclusionQuery", GPURenderPassEncoder.prototype.beginOcclusionQuery);
      GPURenderPassEncoder.prototype.endOcclusionQuery = this._wrapMethod("endOcclusionQuery", GPURenderPassEncoder.prototype.endOcclusionQuery);
      GPURenderPassEncoder.prototype.executeBundles = this._wrapMethod("executeBundles", GPURenderPassEncoder.prototype.executeBundles);
      GPURenderPassEncoder.prototype.end = this._wrapMethod("end", GPURenderPassEncoder.prototype.end);
      GPURenderPassEncoder.prototype.setPipeline = this._wrapMethod("setPipeline", GPURenderPassEncoder.prototype.setPipeline);
      GPURenderPassEncoder.prototype.setIndexBuffer = this._wrapMethod("setIndexBuffer", GPURenderPassEncoder.prototype.setIndexBuffer);
      GPURenderPassEncoder.prototype.setVertexBuffer = this._wrapMethod("setVertexBuffer", GPURenderPassEncoder.prototype.setVertexBuffer);
      GPURenderPassEncoder.prototype.draw = this._wrapMethod("draw", GPURenderPassEncoder.prototype.draw);
      GPURenderPassEncoder.prototype.drawIndexed = this._wrapMethod("drawIndexed", GPURenderPassEncoder.prototype.drawIndexed);
      GPURenderPassEncoder.prototype.drawIndirect = this._wrapMethod("drawIndirect", GPURenderPassEncoder.prototype.drawIndirect);
      GPURenderPassEncoder.prototype.drawIndexedIndirect = this._wrapMethod("drawIndexedIndirect", GPURenderPassEncoder.prototype.drawIndexedIndirect);
      GPURenderPassEncoder.prototype.setBindGroup = this._wrapMethod("setBindGroup", GPURenderPassEncoder.prototype.setBindGroup);
      GPURenderPassEncoder.prototype.pushDebugGroup = this._wrapMethod("pushDebugGroup", GPURenderPassEncoder.prototype.pushDebugGroup);
      GPURenderPassEncoder.prototype.popDebugGroup = this._wrapMethod("popDebugGroup", GPURenderPassEncoder.prototype.popDebugGroup);
      GPURenderPassEncoder.prototype.insertDebugMarker = this._wrapMethod("insertDebugMarker", GPURenderPassEncoder.prototype.insertDebugMarker);

      GPUQueue.prototype.submit = this._wrapMethod("submit", GPUQueue.prototype.submit);
      GPUQueue.prototype.writeBuffer = this._wrapMethod("writeBuffer", GPUQueue.prototype.writeBuffer);
      GPUQueue.prototype.writeTexture = this._wrapMethod("writeTexture", GPUQueue.prototype.writeTexture);
      GPUQueue.prototype.copyExternalImageToTexture = this._wrapMethod("copyExternalImageToTexture", GPUQueue.prototype.copyExternalImageToTexture);

      GPUQuerySet.prototype.destroy = this._wrapMethod("destroy", GPUQuerySet.prototype.destroy);

      GPUCanvasContext.prototype.configure = this._wrapMethod("configure", GPUCanvasContext.prototype.configure);
      GPUCanvasContext.prototype.unconfigure = this._wrapMethod("unconfigure", GPUCanvasContext.prototype.unconfigure);
      GPUCanvasContext.prototype.getCurrentTexture = this._wrapMethod("getCurrentTexture", GPUCanvasContext.prototype.getCurrentTexture);
    }

    _wrapMethod(method, origMethod) {
      const self = this;
      return function () {
        const object = this;

        const args = [...arguments];

        // Allow the arguments to be modified before the method is called.
        self.onPreCall.emit(object, method, args);

        // Call the original method
        const result = origMethod.call(object, ...args);

        const isCreate = GPUCreateMethods.has(method);

        const stacktrace = self.recordStacktraces || isCreate ? getStacktrace() : undefined;

        // If it was an async method it will have returned a Promise
        if (result instanceof Promise) {
          const id = self._idGenerator.getNextId(object);
          self.onPromise.emit(object, method, args, id, stacktrace);
          const promise = result;
          const wrappedPromise = new Promise((resolve) => {
            promise.then((result) => {
              self.onPromiseResolve.emit(object, method, args, id, result, stacktrace);
              resolve(result);
            });
          });
          return wrappedPromise;
        }

        // Otherwise it's a synchronous method
        self.onPostCall.emit(object, method, args, result, stacktrace);

        return result;
      };
    }
  }

  const TextureFormatInfo = {
      "r8unorm": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "r8snorm": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "r8uint": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "r8sint": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rg8unorm": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rg8snorm": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rg8uint": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rg8sint": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rgba8unorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rgba8unorm-srgb": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rgba8snorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rgba8uint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rgba8sint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "bgra8unorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "bgra8unorm-srgb": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "r16uint": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "r16sint": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "r16float": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rg16uint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rg16sint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rg16float": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rgba16uint": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rgba16sint": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rgba16float": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "r32uint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "r32sint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "r32float": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rg32uint": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rg32sint": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rg32float": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rgba32uint": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rgba32sint": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rgba32float": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rgb10a2uint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rgb10a2unorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },
      "rg11b10ufloat": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },

      // Depth Stencil Formats
      "stencil8": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": false, "hasStencil": true }, // bytesPerBlock is actually 1-4
      "depth16unorm": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": false },
      "depth24plus": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": false, "depthOnlyFormat": "depth32float" },
      "depth24plus-stencil8": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": true, "depthOnlyFormat": "depth32float" }, // bytesPerBlock is actually 4-8
      "depth32float": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": false },
      "depth32float-stencil8": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": true, "stencilOnlyFormat": "depth32float" }, // bytesPerBlock is actually 5-8

      // Packed Formats
      "rgb9e5ufloat": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false },

      // Compressed Formats
      "bc1-rgba-unorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "bc1-rgba-unorm-srgb": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "bc2-rgba-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "bc2-rgba-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "bc3-rgba-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "bc3-rgba-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "bc4-r-unorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "bc4-r-snorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "bc5-rg-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "bc5-rg-snorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "bc6h-rgb-ufloat": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "bc6h-rgb-float": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "bc7-rgba-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "bc7-rgba-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      
      "etc2-rgb8unorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "etc2-rgb8unorm-srgb": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "etc2-rgb8a1unorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "etc2-rgb8a1unorm-srgb": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "etc2-rgba8unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "etc2-rgba8unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      
      "eac-r11unorm": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": true },
      "eac-r11snorm": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": true },
      "eac-rg11unorm": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": true },
      "eac-rg11snorm": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": true },

      "astc-4x4-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "astc-4x4-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true },
      "astc-5x4-unorm": { "bytesPerBlock": 16, "blockWidth": 5, "blockHeight": 4, "isCompressed": true },
      "astc-5x4-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 5, "blockHeight": 4, "isCompressed": true },
      "astc-5x5-unorm": { "bytesPerBlock": 16, "blockWidth": 5, "blockHeight": 5, "isCompressed": true },
      "astc-5x5-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 5, "blockHeight": 5, "isCompressed": true },
      "astc-6x5-unorm": { "bytesPerBlock": 16, "blockWidth": 6, "blockHeight": 5, "isCompressed": true },
      "astc-6x5-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 6, "blockHeight": 5, "isCompressed": true },
      "astc-6x6-unorm": { "bytesPerBlock": 16, "blockWidth": 6, "blockHeight": 6, "isCompressed": true },
      "astc-6x6-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 6, "blockHeight": 6, "isCompressed": true },
      "astc-8x5-unorm": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 5, "isCompressed": true },
      "astc-8x5-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 5, "isCompressed": true },
      "astc-8x6-unorm": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 6, "isCompressed": true },
      "astc-8x6-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 6, "isCompressed": true },
      "astc-8x8-unorm": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 8, "isCompressed": true },
      "astc-8x8-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 8, "isCompressed": true },
      "astc-10x5-unorm": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 5, "isCompressed": true },
      "astc-10x5-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 5, "isCompressed": true },
      "astc-10x6-unorm": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 6, "isCompressed": true },
      "astc-10x6-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 6, "isCompressed": true },
      "astc-10x8-unorm": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 8, "isCompressed": true },
      "astc-10x8-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 8, "isCompressed": true },
      "astc-10x10-unorm": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 10, "isCompressed": true },
      "astc-10x10-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 10, "isCompressed": true },
      "astc-12x10-unorm": { "bytesPerBlock": 16, "blockWidth": 12, "blockHeight": 10, "isCompressed": true },
      "astc-12x10-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 12, "blockHeight": 10, "isCompressed": true },
      "astc-12x12-unorm": { "bytesPerBlock": 16, "blockWidth": 12, "blockHeight": 12, "isCompressed": true },
      "astc-12x12-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 12, "blockHeight": 12, "isCompressed": true },
  };

  class TextureUtils {
    constructor(device) {
      this.device = device;
      this.blitShaderModule = device.createShaderModule({code: TextureUtils.blitShader});
      this.blitDepthShaderModule = device.createShaderModule({code: TextureUtils.blitDepthShader});
      this.blitPipelines = {};
      this.blitDepthPipelines = {};
      this.bindGroupLayouts = new Map();
      this.pipelineLayouts = new Map();

      this.pointSampler = device.createSampler({
          magFilter: 'nearest',
          minFilter: 'nearest',
      });
    }

    copyDepthTexture(src, format) {
      const width = src.width;
      const height = src.height;
      const usage = src.usage | GPUTextureUsage.RENDER_TARGET | GPUTextureUsage.COPY_SRC;
      const size = [width, height, 1];
      const dst = this.device.createTexture({ format, size, usage });

      let pipeline = this.blitDepthPipelines[format];
      if (!pipeline) {
        pipeline = this.device.createRenderPipeline({
          layout: 'auto',
          vertex: {
            module: this.blitDepthShaderModule,
            entryPoint: 'vertexMain',
          },
          fragment: {
            module: this.blitDepthShaderModule,
            entryPoint: 'fragmentMain',
            targets: [],
          },
          depthStencil: {
            format,
            depthWriteEnabled: true,
            depthCompare: "always"
          },
          primitive: {
            topology: 'triangle-list',
          },
        });
        this.blitDepthPipelines[format] = pipeline;
      }

      const srcView = src.createView({ aspect: "depth-only" });

      const bindGroupLayout = pipeline.getBindGroupLayout(0);
      const bindGroup = this.device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: this.pointSampler },
          { binding: 1, resource: srcView }
        ],
      });

      const commandEncoder = this.device.createCommandEncoder();

      const dstView = dst.createView();

      const passDesc = {
        colorAttachments: [],
        depthStencilAttachment: {
          view: dstView,
          depthLoadOp: 'clear',
          depthStoreOp: 'store',
          depthClearValue: 0,
          depthReadOnly: false
        }
      };

      const passEncoder = commandEncoder.beginRenderPass(passDesc);
      passEncoder.setPipeline(pipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.draw(3);
      passEncoder.end();
      this.device.queue.submit([commandEncoder.finish()]);
      
      return dst;
    }

    blitTexture(src, srcFormat, dst, dstFormat) {
      //const srcFormatInfo = TextureFormatInfo[srcFormat];
      const sampleType = "unfilterable-float";

      if (!this.bindGroupLayouts.has(sampleType)) {
        const bindGroupLayout = this.device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.FRAGMENT,
              sampler: {
                type: "non-filtering"
              }
            },
            {
              binding: 1,
              visibility: GPUShaderStage.FRAGMENT,
              texture: {
                sampleType: sampleType
              }
            }
          ]
        });
        this.bindGroupLayouts.set(sampleType, bindGroupLayout);

        const pipelineLayout = this.device.createPipelineLayout({
          bindGroupLayouts: [bindGroupLayout]
        });
        this.pipelineLayouts.set(sampleType, pipelineLayout);
      }

      const bindGroupLayout = this.bindGroupLayouts.get(sampleType);
      const pipelineLayout = this.pipelineLayouts.get(sampleType);

      const pipelineKey = `${dstFormat}#${sampleType}`;
      let pipeline = this.blitPipelines[pipelineKey];
      if (!pipeline) {
        pipeline = this.device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: {
            module: this.blitShaderModule,
            entryPoint: 'vertexMain',
          },
          fragment: {
            module: this.blitShaderModule,
            entryPoint: 'fragmentMain',
            targets: [ { format: dstFormat } ],
          },
          primitive: {
            topology: 'triangle-list',
          },
        });
        this.blitPipelines[pipelineKey] = pipeline;
      }

      const bindGroup = this.device.createBindGroup({
        layout: bindGroupLayout,
        entries: [
          { binding: 0, resource: this.pointSampler },
          { binding: 1, resource: src }
        ],
      });
      
      const commandEncoder = this.device.createCommandEncoder();

      const passDesc = {
        colorAttachments: [{
          view: dst,
          loadOp: 'clear',
          storeOp: 'store'
        }]
      };

      const passEncoder = commandEncoder.beginRenderPass(passDesc);
      passEncoder.setPipeline(pipeline);
      passEncoder.setBindGroup(0, bindGroup);
      passEncoder.draw(3);
      passEncoder.end();

      this.device.queue.submit([commandEncoder.finish()]);
    }
  }

  TextureUtils.blitShader = `
  var<private> posTex = array<vec4f, 3>(
    vec4f(-1.0, 1.0, 0.0, 0.0),
    vec4f(3.0, 1.0, 2.0, 0.0),
    vec4f(-1.0, -3.0, 0.0, 2.0));
  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f
  };
  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    output.uv = posTex[vertexIndex].zw;
    output.position = vec4f(posTex[vertexIndex].xy, 0.0, 1.0);
    return output;;
  }
  @binding(0) @group(0) var texSampler: sampler;
  @binding(1) @group(0) var texture: texture_2d<f32>;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    return textureSample(texture, texSampler, input.uv);
  }
`;

  TextureUtils.blitDepthShader = `
  var<private> posTex = array<vec4f, 3>(
    vec4f(-1.0, 1.0, 0.0, 0.0),
    vec4f(3.0, 1.0, 2.0, 0.0),
    vec4f(-1.0, -3.0, 0.0, 2.0));
  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f
  };
  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    output.uv = posTex[vertexIndex].zw;
    output.position = vec4f(posTex[vertexIndex].xy, 0.0, 1.0);
    return output;;
  }
  @binding(0) @group(0) var texSampler: sampler;
  @binding(1) @group(0) var texture: texture_depth_2d;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @builtin(frag_depth) f32 {
    return textureSample(texture, texSampler, input.uv);
  }
`;

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
        this._trackedObjects = new Map();
        this._trackedObjectInfo = new Map();
        this._bindGroupCount = 0;
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
          if (type == "canvas") {
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
          if (message.action == "inspect_request_texture") {
            const textureId = message.id;
            self._requestTexture(textureId);
          }
        });
      }

      // Called before a GPU method is called, allowing the inspector to modify
      // the arguments or the object before the method is called.
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
            descriptor.usage |= GPUTextureUsage.COPY_DST | GPUTextureUsage.COPY_SRC;
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

      // Called after a GPU method is called, allowing the inspector to wrap the result.
      _onMethodCall(object, method, args, result, stacktrace) {
        this._frameCommandCount++;

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

          if (method == "createTexture") {
            this._trackObject(result.__id, result);
          } else if (method == "createView" && !id) {
            this._trackObject(result.__id, result);
            result.__texture = object;
          } else if (method == "createBuffer") {
            this._trackObject(result.__id, result);
          } else if (method == "getCurrentTexture") {
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
          //window.postMessage({"action": "inspect_capture_frame_results", "frame": this._frameIndex, "commands": this._frameCommands}, "*");
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
        // The object has already been wrapped
        if (object.__id) {
          return;
        }

        object.__id = id ?? this.getNextId(object);

        // Track garbage collected objects
        this._garbageCollectionRegistry.register(object, object.__id);

        /*if (object.label !== undefined) {
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
        }*/

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
        //return descriptor;
        const s = JSON.stringify(descriptor);
        return s;
      }

      _sendAddObjectMessage(id, parent, type, descriptor, stacktrace, pending) {
        window.postMessage({ "action": "inspect_add_object", id, parent, type, descriptor, stacktrace, pending }, "*");
      }

      _recordCommand(object, method, result, args, stacktrace) {
        const parent = object?.__id ?? 0;

        if (method == "destroy") {
          const id = object.__id;
          this._trackedObjects.delete(id);
          this._trackedObjectInfo.delete(id);
          if (object instanceof GPUBindGroup) {
            this._bindGroupCount--;
          }
          if (id >= 0) {
            this._captureTextureRequest.delete(id);
            window.postMessage({"action": "inspect_delete_object", id}, "*");
          }
        } else if (method == "createShaderModule") {
          const id = result.__id;
          this._sendAddObjectMessage(id, parent, "ShaderModule", this._stringifyDescriptor(args[0]), stacktrace);
        } else if (method == "createBuffer") {
          const id = result.__id;
          this._sendAddObjectMessage(id, parent, "Buffer", this._stringifyDescriptor(args[0]), stacktrace);
        } else if (method == "createTexture") {
          const id = result.__id;
          this._sendAddObjectMessage(id, parent, "Texture", this._stringifyDescriptor(args[0]), stacktrace);
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
            this._sendAddObjectMessage(id, parent, "Texture", infoStr, stacktrace);
          }
        } else if (method == "createView") {
          const id = result.__id;
          result.__texture = object;
          this._sendAddObjectMessage(id, parent, "TextureView", this._stringifyDescriptor(args[0]), stacktrace);
        } else if (method == "createSampler") {
          const id = result.__id;
          this._sendAddObjectMessage(id, parent, "Sampler", this._stringifyDescriptor(args[0]), stacktrace);
        } else if (method == "createBindGroup") {
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
        } else if (method == "createBindGroupLayout") {
          const id = result.__id;
          this._sendAddObjectMessage(id, parent, "BindGroupLayout", this._stringifyDescriptor(args[0]), stacktrace);
        } else if (method == "createPipelineLayout") {
          const id = result.__id;
          this._sendAddObjectMessage(id, parent, "PipelineLayout", this._stringifyDescriptor(args[0]), stacktrace);
        } else if (method == "createRenderPipeline") {
          const id = result.__id;
          this._sendAddObjectMessage(id, parent, "RenderPipeline", this._stringifyDescriptor(args[0]), stacktrace);
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
          this._sendAddObjectMessage(id, parent, "ComputePipeline", this._stringifyDescriptor(args[0]), stacktrace);
          if (args[0].compute?.module) {
            result.__computeModule = args[0].compute?.module;
          }
        } else if (method == "createCommandEncoder") {
          // We'll need the CommandEncoder's device for capturing textures
          result.__device = object;
          this._lastCommandEncoder = result;
        } else if (method == "finish") {
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
            if (!buffer) ; else if (size > 0) {
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
          args: newArgs,
          stacktrace
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

})();
//# sourceMappingURL=webgpu_inspector.js.map
