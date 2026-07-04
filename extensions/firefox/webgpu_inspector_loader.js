(function () {
  'use strict';

  function coreLoader() { ((function (exports) {

    // Synchronous base64 helpers. Used to ferry binary buffer/texture chunks across the
    // page → content-script → background → panel pipeline, which is JSON-only.
    //
    // Prefer the native Uint8Array.prototype.toBase64 / Uint8Array.fromBase64 when present
    // (Chrome 137+, Firefox 132+). Fall back to btoa/atob with chunked String.fromCharCode
    // for older runtimes.

    const _hasNativeToBase64 = typeof Uint8Array.prototype.toBase64 === "function";
    const _hasNativeFromBase64 = typeof Uint8Array.fromBase64 === "function";

    // 0x8000 keeps String.fromCharCode.apply below typical engine argument limits.
    const _fromCharCodeChunk = 0x8000;

    function encodeBase64(bytes) {
      if (_hasNativeToBase64) {
        return bytes.toBase64();
      }
      let binary = "";
      const len = bytes.length;
      for (let i = 0; i < len; i += _fromCharCodeChunk) {
        const end = i + _fromCharCodeChunk < len ? i + _fromCharCodeChunk : len;
        binary += String.fromCharCode.apply(null, bytes.subarray(i, end));
      }
      return btoa(binary);
    }

    function decodeBase64(str) {
      if (_hasNativeFromBase64) {
        return Uint8Array.fromBase64(str);
      }
      const binary = atob(str);
      const len = binary.length;
      const out = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        out[i] = binary.charCodeAt(i);
      }
      return out;
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
      emit(...args) {
        if (Signal.disabled) {
          return null;
        }

        for (const k of this.slots) {
          const s = k[1][0];
          const o = k[1][1] || s;
          if (!s) {
            continue;
          }

          if (s.constructor === Signal) {
            s.emit.apply(o, args);
          } else {
            let res = s.apply(o, args);
            if (res) {
              return res;
            }
          }
        }
        return null;
      }

      /**
       * Connect a listener to the signal. This can be a function, object method,
       * class static method, or another signal. There is no type-checking to
       * ensure the listener function can successfully receive the arguments that
       * will be emitted by the signal, which will result in an exception if you
       * connect an incompatible listener and emit the signal.
       * To have an object method listen to a signal, pass in the object, too.
       * @param {Function|Signal} callback
       * @param {Object?} [object=null]
       * @returns {number} A handle that can be used to disconnect the listener. Returns -1 if the listener was already connected.
       * @example
       * listen(Function)
       * listen(Signal)
       * listen(method, object)
       */
      addListener(callback, object) {
        // Don't add the same listener multiple times.
        if (this.isListening(callback, object)) {
          return -1;
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
        if ((callback === null || callback === undefined) &&
          (object === null || object === undefined)) {
          this.slots.clear();
          return true;
        }

        if (typeof callback === 'number') {
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
        .filter((line) => line && !line.includes("webgpu_inspector_loader.js"));

      return stack.join("\n");
    }

    const GPUObjectTypes = new Set([
      GPUAdapter,
      GPUDevice,
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
      GPUCommandBuffer,
      GPUCommandEncoder,
      GPUComputePassEncoder,
      GPURenderPassEncoder,
      GPURenderBundle,
      GPURenderBundleEncoder,
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
      "createView",
    ]);

    class GPUObjectWrapper {
      constructor(idGenerator) {
        this._idGenerator = idGenerator;
        this.onPreCall = new Signal();
        this.onPostCall = new Signal();
        this.onPromise = new Signal();
        this.onPromiseResolve = new Signal();
        this.recordStacktraces = false;
        this._skipRecord = 0;
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

        GPURenderBundleEncoder.prototype.draw = this._wrapMethod("draw", GPURenderBundleEncoder.prototype.draw);
        GPURenderBundleEncoder.prototype.drawIndexed = this._wrapMethod("drawIndexed", GPURenderBundleEncoder.prototype.drawIndexed);
        GPURenderBundleEncoder.prototype.drawIndirect = this._wrapMethod("drawIndirect", GPURenderBundleEncoder.prototype.drawIndirect);
        GPURenderBundleEncoder.prototype.drawIndexedIndirect = this._wrapMethod("drawIndexedIndirect", GPURenderBundleEncoder.prototype.drawIndexedIndirect);
        GPURenderBundleEncoder.prototype.finish = this._wrapMethod("finish", GPURenderBundleEncoder.prototype.finish);
        GPURenderBundleEncoder.prototype.insertDebugMarker = this._wrapMethod("insertDebugMarker", GPURenderBundleEncoder.prototype.insertDebugMarker);
        GPURenderBundleEncoder.prototype.popDebugGroup = this._wrapMethod("popDebugGroup", GPURenderBundleEncoder.prototype.popDebugGroup);
        GPURenderBundleEncoder.prototype.pushDebugGroup = this._wrapMethod("pushDebugGroup", GPURenderBundleEncoder.prototype.pushDebugGroup);
        GPURenderBundleEncoder.prototype.setBindGroup = this._wrapMethod("setBindGroup", GPURenderBundleEncoder.prototype.setBindGroup);
        GPURenderBundleEncoder.prototype.setIndexBuffer = this._wrapMethod("setIndexBuffer", GPURenderBundleEncoder.prototype.setIndexBuffer);
        GPURenderBundleEncoder.prototype.setPipeline = this._wrapMethod("setPipeline", GPURenderBundleEncoder.prototype.setPipeline);
        GPURenderBundleEncoder.prototype.setVertexBuffer = this._wrapMethod("setVertexBuffer", GPURenderBundleEncoder.prototype.setVertexBuffer);
      }

      disableRecording() {
        this._skipRecord++;
      }

      enableRecording() {
        this._skipRecord--;
        if (this._skipRecord < 0) {
          this._skipRecord = 0; // If this happened, we did something wrong and disable/enable calls are unbalanced.
        }
      }

      get isRecordingEnabled() {
        return this._skipRecord === 0;
      }

      _wrapMethod(method, origMethod) {
        const self = this;
        return function () {
          const object = this;

          const args = [...arguments];

          if (self._skipRecord > 0) {
            return origMethod.call(object, ...args);
          }

          // Allow the arguments to be modified before the method is called.
          const res = self.onPreCall.emit(object, method, args);
          if (res) {
            return undefined;
          }

          // Call the original method.
          // destroy() on a buffer with pending mapAsync throws AbortError — suppress it.
          let result;
          try {
            result = origMethod.call(object, ...args);
          } catch (e) {
            if (method === "destroy") {
              self.onPostCall.emit(object, method, args, undefined, undefined);
              return undefined;
            }
            throw e;
          }

          const isCreate = GPUCreateMethods.has(method) || (self instanceof GPURenderBundleEncoder && method === "finish");

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
        "r8unorm": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1, "sampleType": "float" },
        "r8snorm": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1, "sampleType": "float" },
        "r8uint": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1, "sampleType": "uint" },
        "r8sint": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1, "sampleType": "sint" },
        "rg8unorm": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2, "sampleType": "float" },
        "rg8snorm": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2, "sampleType": "float" },
        "rg8uint": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2, "sampleType": "uint" },
        "rg8sint": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2, "sampleType": "sint" },

        "rgba8unorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "float" },
        "rgba8unorm-srgb": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "float" },
        "rgba8snorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "float" },
        "rgba8uint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "uint" },
        "rgba8sint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "sint" },
        "bgra8unorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "float" },
        "bgra8unorm-srgb": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "float" },

        "r16unorm": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1, "sampleType": "unfilterable-float" },
        "r16snorm": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1, "sampleType": "float" },
        "r16uint": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1, "sampleType": "uint" },
        "r16sint": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1, "sampleType": "sint" },
        "r16float": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1, "sampleType": "float" },

        "rg16unorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2, "sampleType": "unfilterable-float" },
        "rg16snorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2, "sampleType": "unfilterable-float" },
        "rg16uint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2, "sampleType": "uint" },
        "rg16sint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2, "sampleType": "sint" },
        "rg16float": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2, "sampleType": "float" },

        "rgba16unorm": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "unfilterable-float" },
        "rgba16snorm": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "unfilterable-float" },
        "rgba16uint": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "uint" },
        "rgba16sint": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "sint" },
        "rgba16float": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "float" },

        "r32uint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1, "sampleType": "uint" },
        "r32sint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1, "sampleType": "sint" },
        "r32float": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 1, "sampleType": "float" },

        "rg32uint": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2, "sampleType": "uint" },
        "rg32sint": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2, "sampleType": "sint" },
        "rg32float": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 2, "sampleType": "float" },

        "rgba32uint": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "uint" },
        "rgba32sint": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "sint" },
        "rgba32float": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "float" },
        "rgb10a2uint": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "uint" },
        "rgb10a2unorm": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "float" },
        "rg11b10ufloat": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "float" },

        // Depth Stencil Formats
        "stencil8": { "bytesPerBlock": 1, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": false, "hasStencil": true, "channels": 1, "sampleType": "uint" }, // bytesPerBlock is actually 1-4
        "depth16unorm": { "bytesPerBlock": 2, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": false, "channels": 1, "sampleType": "unfilterable-float" },
        "depth24plus": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": false, "depthOnlyFormat": "depth32float", "channels": 1, "sampleType": "unfilterable-float" },
        "depth24plus-stencil8": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": true, "depthOnlyFormat": "depth32float", "channels": 1, "sampleType": "unfilterable-float" }, // bytesPerBlock is actually 4-8
        "depth32float": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": false, "channels": 1, "sampleType": "unfilterable-float" },
        "depth32float-stencil8": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "isDepthStencil": true, "hasDepth": true, "hasStencil": true, "stencilOnlyFormat": "depth32float", "channels": 1, "sampleType": "unfilterable-float" }, // bytesPerBlock is actually 5-8

        // Packed Formats
        "rgb9e5ufloat": { "bytesPerBlock": 4, "blockWidth": 1, "blockHeight": 1, "isCompressed": false, "channels": 4, "sampleType": "float" },

        // Compressed Formats
        "bc1-rgba-unorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "bc1-rgba-unorm-srgb": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "bc2-rgba-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "bc2-rgba-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "bc3-rgba-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "bc3-rgba-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },

        "bc4-r-unorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 1, "sampleType": "float" },
        "bc4-r-snorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 1, "sampleType": "float" },

        "bc5-rg-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 2, "sampleType": "float" },
        "bc5-rg-snorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 2, "sampleType": "float" },

        "bc6h-rgb-ufloat": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "bc6h-rgb-float": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "bc7-rgba-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "bc7-rgba-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        
        "etc2-rgb8unorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "etc2-rgb8unorm-srgb": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "etc2-rgb8a1unorm": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "etc2-rgb8a1unorm-srgb": { "bytesPerBlock": 8, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "etc2-rgba8unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "etc2-rgba8unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        
        "eac-r11unorm": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": true, "channels": 1, "sampleType": "float" },
        "eac-r11snorm": { "bytesPerBlock": 8, "blockWidth": 1, "blockHeight": 1, "isCompressed": true, "channels": 1, "sampleType": "float" },

        "eac-rg11unorm": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": true, "channels": 2, "sampleType": "float" },
        "eac-rg11snorm": { "bytesPerBlock": 16, "blockWidth": 1, "blockHeight": 1, "isCompressed": true, "channels": 2, "sampleType": "float" },

        "astc-4x4-unorm": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-4x4-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 4, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-5x4-unorm": { "bytesPerBlock": 16, "blockWidth": 5, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-5x4-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 5, "blockHeight": 4, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-5x5-unorm": { "bytesPerBlock": 16, "blockWidth": 5, "blockHeight": 5, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-5x5-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 5, "blockHeight": 5, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-6x5-unorm": { "bytesPerBlock": 16, "blockWidth": 6, "blockHeight": 5, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-6x5-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 6, "blockHeight": 5, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-6x6-unorm": { "bytesPerBlock": 16, "blockWidth": 6, "blockHeight": 6, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-6x6-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 6, "blockHeight": 6, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-8x5-unorm": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 5, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-8x5-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 5, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-8x6-unorm": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 6, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-8x6-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 6, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-8x8-unorm": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 8, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-8x8-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 8, "blockHeight": 8, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-10x5-unorm": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 5, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-10x5-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 5, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-10x6-unorm": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 6, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-10x6-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 6, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-10x8-unorm": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 8, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-10x8-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 8, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-10x10-unorm": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 10, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-10x10-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 10, "blockHeight": 10, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-12x10-unorm": { "bytesPerBlock": 16, "blockWidth": 12, "blockHeight": 10, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-12x10-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 12, "blockHeight": 10, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-12x12-unorm": { "bytesPerBlock": 16, "blockWidth": 12, "blockHeight": 12, "isCompressed": true, "channels": 4, "sampleType": "float" },
        "astc-12x12-unorm-srgb": { "bytesPerBlock": 16, "blockWidth": 12, "blockHeight": 12, "isCompressed": true, "channels": 4, "sampleType": "float" },
    };

    class TextureUtils {
      constructor(device) {
        this.device = device;

        this.blitShaderModule = device.createShaderModule({ code: _getBlitShader("f32") });
        this.blitU32ShaderModule = device.createShaderModule({ code: _getBlitShader("u32") });
        this.blitS32ShaderModule = device.createShaderModule({ code: _getBlitShader("i32") });

        this.computeTextureMinMaxModule = device.createShaderModule({ code: _getComputeTextureMinMax("f32") });
        this.computeTextureMinMaxU32Module = device.createShaderModule({ code: _getComputeTextureMinMax("u32") });
        this.computeTextureMinMaxS32Module = device.createShaderModule({ code: _getComputeTextureMinMax("i32") });

        this.computeTextureMinMax3dModule = device.createShaderModule({ code: _getComputeTextureMinMax3d("f32") });
        this.computeTextureMinMax3dU32Module = device.createShaderModule({ code: _getComputeTextureMinMax3d("u32") });
        this.computeTextureMinMax3dS32Module = device.createShaderModule({ code: _getComputeTextureMinMax3d("i32") });

        this.blit3dShaderModule = device.createShaderModule({ code: TextureUtils.blit3dShader });
        this.multisampleBlitShaderModule = device.createShaderModule({ code: TextureUtils.multisampleBlitShader });
        this.depthToFloatShaderModule = device.createShaderModule({ code: TextureUtils.depthToFloatShader });
        this.depthCubeToFloatShaderModule = device.createShaderModule({ code: TextureUtils.depthCubeToFloatShader });
        this.depthToFloatMultisampleShaderModule = device.createShaderModule({ code: TextureUtils.depthToFloatMultisampleShader });
        this.blitPipelines = {};
        this.blitDepthPipelines = {};
        this.bindGroupLayouts = new Map();
        this.pipelineLayouts = new Map();
        this.depthToFloatPipeline = null;
        this.depthToFloatMSPipeline = null;

        this.pointSampler = device.createSampler({
            magFilter: 'nearest',
            minFilter: 'nearest',
        });

        this.depthCompareSampler = device.createSampler({
            compare: 'less-equal',
            magFilter: 'nearest',
            minFilter: 'nearest',
        });

        this.displayUniformBuffer = device.createBuffer({
          size: 4 * 8,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });

        this.depthCubeFaceUniformBuffers = [];
        for (let face = 0; face < 6; ++face) {
          const buffer = device.createBuffer({
            size: 16,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
          });
          device.queue.writeBuffer(buffer, 0, new Uint32Array([face, 0, 0, 0]));
          this.depthCubeFaceUniformBuffers.push(buffer);
        }

        this.minMaxStorageBuffer = device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
        });

        this.minMaxReadbackBuffer = device.createBuffer({
            size: 32,
            usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
        });

        this.displayBindGroupLayout = device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.FRAGMENT,
              buffer: { type: "uniform" }
            },
            {
              binding: 1,
              visibility: GPUShaderStage.FRAGMENT,
              buffer: { type: "read-only-storage" }
            }
          ]
        });

        this.displayBindGroup = device.createBindGroup({
          layout: this.displayBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: { buffer: this.displayUniformBuffer }
            },
            {
              binding: 1,
              resource: { buffer: this.minMaxStorageBuffer }
            }
          ]
        });

        this.computeMinMaxPipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: this.computeTextureMinMaxModule, entryPoint: 'main' }
        });

        this.computeMinMaxU32Pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: this.computeTextureMinMaxU32Module, entryPoint: 'main' }
        });

        this.computeMinMaxS32Pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: this.computeTextureMinMaxS32Module, entryPoint: 'main' }
        });

        this.computeMinMax3dPipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: this.computeTextureMinMax3dModule, entryPoint: 'main' }
        });

        this.computeMinMax3dU32Pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: this.computeTextureMinMax3dU32Module, entryPoint: 'main' }
        });

        this.computeMinMax3dS32Pipeline = device.createComputePipeline({
            layout: 'auto',
            compute: { module: this.computeTextureMinMax3dS32Module, entryPoint: 'main' }
        });
      }

      copyDepthTexture(src, format, commandEncoder, mipLevel) {
        mipLevel ??= 0;
        const width = (src.width >> mipLevel) || 1;
        const height = (src.height >> mipLevel) || 1;
        const depthOrArrayLayers = src.depthOrArrayLayers;
        const usage = src.usage | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
        const size = [width, height, depthOrArrayLayers];
        format = format || "r32float";

        const dst = this.device.createTexture({ format, size, usage });

        if (src.sampleCount === 1 && depthOrArrayLayers === 6) {
          const srcView = src.createView({
            dimension: "cube",
            aspect: "depth-only",
            baseArrayLayer: 0,
            arrayLayerCount: 6,
            baseMipLevel: mipLevel,
            mipLevelCount: 1
          });

          for (let i = 0; i < depthOrArrayLayers; ++i) {
            const dstView = dst.createView({ dimension: "2d", baseArrayLayer: i, arrayLayerCount: 1 });
            this.convertDepthCubeFaceToFloat(srcView, i, dstView, format, commandEncoder);
          }

          return dst;
        }

        for (let i = 0; i < depthOrArrayLayers; ++i) {
          const srcView = src.createView({
            dimension: "2d",
            aspect: "depth-only",
            baseArrayLayer: i,
            arrayLayerCount: 1,
            baseMipLevel: mipLevel,
            mipLevelCount: 1
          });
          const dstView = dst.createView({ dimension: "2d", baseArrayLayer: i, arrayLayerCount: 1 });
          this.convertDepthToFloat(srcView, src.sampleCount, dstView, format, commandEncoder);
        }

        return dst;
      }

      copyMultisampledTexture(src) {
        const width = src.width;
        const height = src.height;
        const format = src.format;
        const usage = src.usage | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
        const size = [width, height, 1];
        const dst = this.device.createTexture({ format, size, usage });

        this.blitTexture(src.createView(), src.format, src.sampleCount, dst.createView(), format);

        return dst;
      }

      blitTexture(srcView, srcFormat, sampleCount, dstView, dstFormat, display, dimension, layer,
          minMaxUpdateCallback) {
        layer ??= 0;
        dimension ??= "2d";
        const sampleType = TextureFormatInfo[srcFormat]?.sampleType || "unfilterable-float";

        const bgLayoutKey = `${sampleType}#${sampleCount}#${dimension}`;

        if (!this.bindGroupLayouts.has(bgLayoutKey)) {
          const entries = dimension === "3d"
            ? [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
                { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "3d", sampleType } }
              ]
            : [
                { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: dimension, sampleType, multisampled: sampleCount > 1 } }
              ];
          const bindGroupLayout = this.device.createBindGroupLayout({ entries });
          this.bindGroupLayouts.set(bgLayoutKey, bindGroupLayout);

          const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [bindGroupLayout, this.displayBindGroupLayout]
          });
          this.pipelineLayouts.set(bgLayoutKey, pipelineLayout);
        }

        const formatInfo = TextureFormatInfo[srcFormat];
        const numChannels = formatInfo?.channels ?? 4;

        const bindGroupLayout = this.bindGroupLayouts.get(bgLayoutKey);
        const pipelineLayout = this.pipelineLayouts.get(bgLayoutKey);

        const shaderType = (formatInfo?.sampleType === "uint") ? "U32" : (formatInfo?.sampleType === "sint") ? "S32" : "f32";

        const pipelineKey = `${dstFormat}#${sampleType}#${sampleCount}#${dimension}#${shaderType}`;
        let pipeline = this.blitPipelines[pipelineKey];
        if (!pipeline) {
          const module = sampleCount > 1 ? this.multisampleBlitShaderModule : dimension === "3d" ? this.blit3dShaderModule
              : shaderType == "f32" ? this.blitShaderModule : shaderType == "U32" ? this.blitU32ShaderModule : this.blitS32ShaderModule;

          pipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
              module,
              entryPoint: 'vertexMain',
            },
            fragment: {
              module: module,
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
          entries: dimension === "3d"
            ? [{ binding: 0, resource: this.pointSampler }, { binding: 1, resource: srcView }]
            : [{ binding: 0, resource: srcView }]
        });

        const commandEncoder = this.device.createCommandEncoder();

        const minMaxPipeline = dimension === "3d"
            ? ((formatInfo?.sampleType === "uint") ? this.computeMinMax3dU32Pipeline :
               (formatInfo?.sampleType === "sint") ? this.computeMinMax3dS32Pipeline : this.computeMinMax3dPipeline)
            : ((formatInfo?.sampleType === "uint") ? this.computeMinMaxU32Pipeline :
               (formatInfo?.sampleType === "sint") ? this.computeMinMaxS32Pipeline : this.computeMinMaxPipeline);

        const minMaxBindGroup = this.device.createBindGroup({
            layout: minMaxPipeline.getBindGroupLayout(0),
            entries: [
                { binding: 0, resource: srcView },
                { binding: 1, resource: { buffer: this.minMaxStorageBuffer } }
            ]
        });

        const computePass = commandEncoder.beginComputePass();
        computePass.setPipeline(minMaxPipeline);
        computePass.setBindGroup(0, minMaxBindGroup);
        computePass.dispatchWorkgroups(1);
        computePass.end();

        if (display) {
          this.device.queue.writeBuffer(this.displayUniformBuffer, 0,
            new Float32Array([display.exposure, display.channels, numChannels, display.autoRange ?? 0 ? 1 : 0,
              display.minRange ?? 0, display.maxRange ?? 1, layer, 0]));
        } else {
          this.device.queue.writeBuffer(this.displayUniformBuffer, 0,
            new Float32Array([1, 0, numChannels, 0, 0, 1, layer, 0]));
        }

        const passEncoder = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: dstView,
            loadOp: 'clear',
            storeOp: 'store'
          }]
        });
        passEncoder.setPipeline(pipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.setBindGroup(1, this.displayBindGroup);
        passEncoder.draw(3);
        passEncoder.end();

        if (!this.minMaxReadbackBuffer._mapRequested) {
          commandEncoder.copyBufferToBuffer(this.minMaxStorageBuffer, 0, this.minMaxReadbackBuffer, 0, 32);
        }
        this.device.queue.submit([commandEncoder.finish()]);

        if (minMaxUpdateCallback && !this.minMaxReadbackBuffer._mapRequested) {
          this.minMaxReadbackBuffer._mapRequested = true;
          this.minMaxReadbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
              const arrayBuffer = this.minMaxReadbackBuffer.getMappedRange();
              const data = new Float32Array(arrayBuffer.slice(0));
              this.minMaxReadbackBuffer.unmap();
              this.minMaxReadbackBuffer._mapRequested = false;
              display.minRange = data[0];
              display.maxRange = data[4];
              minMaxUpdateCallback(display.minRange, display.maxRange);
          });
        }
      }

      convertDepthToFloat(fromTextureView, sampleCount, toTextureView, dstFormat, commandEncoder) {
        if (sampleCount > 1) {
          if (!this.depthToFloatMSPipeline) {
            this.device.pushErrorScope('validation');

            this.depthToFloatBindGroupMSLayout = this.device.createBindGroupLayout({
              entries: [
                {
                  binding: 0,
                  visibility: GPUShaderStage.FRAGMENT,
                  texture: { sampleType: "depth", multisampled: true },
                }
              ]
            });

            const pipelineLayout = this.device.createPipelineLayout({
              bindGroupLayouts: [this.depthToFloatBindGroupMSLayout]
            });

            const module = this.depthToFloatMultisampleShaderModule;
            this.depthToFloatMSPipeline = this.device.createRenderPipeline({
              layout: pipelineLayout,
              vertex: {
                module,
                entryPoint: 'vertexMain',
              },
              fragment: {
                module: module,
                entryPoint: 'fragmentMain',
                targets: [ { format: dstFormat } ],
              },
              primitive: {
                topology: 'triangle-list',
              },
            });

            this.device.popErrorScope().then((result) => {
              if (result) {
                console.error(result.message);
              }
            });
          }
        } else if (!this.depthToFloatPipeline) {
          this.device.pushErrorScope('validation');

          this.depthToFloatBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: "comparison" },
              },
              {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: "depth" },
              }
            ]
          });

          const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.depthToFloatBindGroupLayout]
          });

          const module = this.depthToFloatShaderModule;
          this.depthToFloatPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
              module,
              entryPoint: 'vertexMain',
            },
            fragment: {
              module: module,
              entryPoint: 'fragmentMain',
              targets: [ { format: dstFormat } ],
            },
            primitive: {
              topology: 'triangle-list',
            },
          });

          this.device.popErrorScope().then((result) => {
            if (result) {
              console.error(result.message);
            }
          });
        }

        this.device.pushErrorScope('validation');

        const bindGroup = this.device.createBindGroup({
          layout: sampleCount > 1 ? this.depthToFloatBindGroupMSLayout : this.depthToFloatBindGroupLayout,
          entries: sampleCount > 1
            ? [ { binding: 0, resource: fromTextureView } ]
            : [ { binding: 0, resource: this.depthCompareSampler }, { binding: 1, resource: fromTextureView } ],
        });

        const doSubmit = !commandEncoder;

        commandEncoder ??= this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: toTextureView,
            loadOp: 'clear',
            storeOp: 'store',
            clearColor: { r: 0, g: 0, b: 0, a: 0 }
          }]
        });

        passEncoder.setPipeline(sampleCount > 1 ? this.depthToFloatMSPipeline : this.depthToFloatPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.draw(3);
        passEncoder.end();

        if (doSubmit) {
          this.device.queue.submit([commandEncoder.finish()]);
        }

        this.device.popErrorScope().then((result) => {
          if (result) {
            console.error(result.message);
          }
        });
      }

      convertDepthCubeFaceToFloat(fromTextureView, face, toTextureView, dstFormat, commandEncoder) {
        if (!this.depthCubeToFloatPipeline) {
          this.device.pushErrorScope('validation');

          this.depthCubeToFloatBindGroupLayout = this.device.createBindGroupLayout({
            entries: [
              {
                binding: 0,
                visibility: GPUShaderStage.FRAGMENT,
                sampler: { type: "comparison" },
              },
              {
                binding: 1,
                visibility: GPUShaderStage.FRAGMENT,
                texture: { sampleType: "depth", viewDimension: "cube" },
              },
              {
                binding: 2,
                visibility: GPUShaderStage.FRAGMENT,
                buffer: { type: "uniform" },
              }
            ]
          });

          const pipelineLayout = this.device.createPipelineLayout({
            bindGroupLayouts: [this.depthCubeToFloatBindGroupLayout]
          });

          const module = this.depthCubeToFloatShaderModule;
          this.depthCubeToFloatPipeline = this.device.createRenderPipeline({
            layout: pipelineLayout,
            vertex: {
              module,
              entryPoint: 'vertexMain',
            },
            fragment: {
              module: module,
              entryPoint: 'fragmentMain',
              targets: [ { format: dstFormat } ],
            },
            primitive: {
              topology: 'triangle-list',
            },
          });

          this.device.popErrorScope().then((result) => {
            if (result) {
              console.error(result.message);
            }
          });
        }

        this.device.pushErrorScope('validation');

        const bindGroup = this.device.createBindGroup({
          layout: this.depthCubeToFloatBindGroupLayout,
          entries: [
            { binding: 0, resource: this.depthCompareSampler },
            { binding: 1, resource: fromTextureView },
            { binding: 2, resource: { buffer: this.depthCubeFaceUniformBuffers[face] } },
          ],
        });

        const doSubmit = !commandEncoder;

        commandEncoder ??= this.device.createCommandEncoder();
        const passEncoder = commandEncoder.beginRenderPass({
          colorAttachments: [{
            view: toTextureView,
            loadOp: 'clear',
            storeOp: 'store',
            clearColor: { r: 0, g: 0, b: 0, a: 0 }
          }]
        });

        passEncoder.setPipeline(this.depthCubeToFloatPipeline);
        passEncoder.setBindGroup(0, bindGroup);
        passEncoder.draw(3);
        passEncoder.end();

        if (doSubmit) {
          this.device.queue.submit([commandEncoder.finish()]);
        }

        this.device.popErrorScope().then((result) => {
          if (result) {
            console.error(result.message);
          }
        });
      }
    }

    function _getComputeTextureMinMax(fmt) {
      return `
  struct Result {
      minValue: vec4f,
      maxValue: vec4f,
  };
  @group(0) @binding(0) var inputTexture: texture_2d<${fmt}>;
  @group(0) @binding(1) var<storage, read_write> output: Result;
  @compute @workgroup_size(1)
  fn main() {
      let dims = textureDimensions(inputTexture);
      // Another option is the set minValue to 0, which would manke the
      // range [0, maxValue] unless there are negative values in the texture.
      // Not sure which is better for general use.
      //var minValue = vec4f(0.0);
      var minValue = vec4f(3.402823466e+38); // max float
      var maxValue = vec4f(0.0);
      for (var x = 0u; x < dims.x; x++) {
          for (var y = 0u; y < dims.y; y++) {
              let color = vec4f(textureLoad(inputTexture, vec2<u32>(x, y), 0));
              minValue = min(minValue, color);
              maxValue = max(maxValue, color);
          }
      }
      output.minValue = minValue;
      output.maxValue = maxValue;
  }`;
    }

    function _getComputeTextureMinMax3d(fmt) {
      return `
  struct Result {
      minValue: vec4f,
      maxValue: vec4f,
  };
  @group(0) @binding(0) var inputTexture: texture_3d<${fmt}>;
  @group(0) @binding(1) var<storage, read_write> output: Result;
  @compute @workgroup_size(1)
  fn main() {
      let dims = textureDimensions(inputTexture);
      var minValue = vec4f(3.402823466e+38);
      var maxValue = vec4f(0.0);
      for (var x = 0u; x < dims.x; x++) {
          for (var y = 0u; y < dims.y; y++) {
              for (var z = 0u; z < dims.z; z++) {
                  let color = vec4f(textureLoad(inputTexture, vec3u(x, y, z), 0));
                  minValue = min(minValue, color);
                  maxValue = max(maxValue, color);
              }
          }
      }
      output.minValue = minValue;
      output.maxValue = maxValue;
  }`;
    }

    function _getBlitShader(fmt) {
      return `
  var<private> posTex:array<vec4f, 3> = array<vec4f, 3>(
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
  @group(0) @binding(0) var texture: texture_2d<${fmt}>;
  struct Display {
    exposure: f32,
    channels: f32,
    numChannels: f32,
    autoRange: f32,
    minRange: f32,
    maxRange: f32,
    _pad2: f32,
    _pad3: f32
  };
  struct MinMax {
      min_val: vec4f,
      max_val: vec4f,
  };
  @group(1) @binding(0) var<uniform> display: Display;
  @group(1) @binding(1) var<storage> minMax: MinMax;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    var dim = textureDimensions(texture);
    var color = vec4f(textureLoad(texture, vec2i(input.uv * vec2f(dim)), 0));
    var minVal = minMax.min_val;
    var maxVal = minMax.max_val;

    var minCh = min(minVal.r, min(minVal.g, minVal.b));
    var maxCh = max(maxVal.r, max(maxVal.g, maxVal.b));
    if (display.autoRange > 0.0 && abs(maxCh - minCh) > 0.00001) {
      color = vec4f((color.rgb - vec3f(minCh)) / vec3f(maxCh - minCh), color.a);
    }

    if (display.numChannels == 1.0) {
      if (display.minRange != display.maxRange) {
        if (color.r < display.minRange) {
          color = vec4f(0.0, 0.0, 0.0, 1);
        } else if (color.r > display.maxRange) {
          color = vec4f(1.0, 0.0, 0.0, 1);
        } else {
          color = vec4f((color.r - display.minRange) / (display.maxRange - display.minRange), 0.0, 0.0, 1);
        }
      }
      color = vec4f(color.r, color.r, color.r, 1.0);
    } else if (display.numChannels == 2.0) {
      color = vec4f(color.r, color.g, 0.0, 1.0);
    }

    if (display.channels == 1.0) { // R
      var rgb = color.rgb * display.exposure;
      return vec4f(rgb.r, 0.0, 0.0, 1);
    } else if (display.channels == 2.0) { // G
      var rgb = color.rgb * display.exposure;
      return vec4f(0.0, rgb.g, 0.0, 1);
    } else if (display.channels == 3.0) { // B
      var rgb = color.rgb * display.exposure;
      return vec4f(0.0, 0.0, rgb.b, 1);
    } else if (display.channels == 4.0) { // A
      var a = color.a * display.exposure;
      return vec4f(a, a, a, 1);
    } else if (display.channels == 5.0) { // Luminance
      var luminance = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
      var rgb = vec3f(luminance) * display.exposure;
      return vec4f(rgb, 1);
    }

    // RGB
    var rgb = color.rgb * display.exposure;
    return vec4f(rgb, 1);
  }`;
    }

    TextureUtils.blit3dShader = `
  var<private> posTex:array<vec4f, 3> = array<vec4f, 3>(
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
  @group(0) @binding(0) var texSampler: sampler;
  @group(0) @binding(1) var texture: texture_3d<f32>;
  struct Display {
    exposure: f32,
    channels: f32,
    numChannels: f32,
    autoRange: f32,
    minRange: f32,
    maxRange: f32,
    layer: f32,
    _pad3: f32
  };
  struct MinMax {
      min_val: vec4f,
      max_val: vec4f,
  };
  @group(1) @binding(0) var<uniform> display: Display;
  @group(1) @binding(1) var<storage> minMax: MinMax;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    var color = textureSampleLevel(texture, texSampler, vec3f(input.uv, display.layer), 0.0);
    var minVal = minMax.min_val;
    var maxVal = minMax.max_val;

    var minCh = min(minVal.r, min(minVal.g, minVal.b));
    var maxCh = max(maxVal.r, max(maxVal.g, maxVal.b));
    if (display.autoRange > 0.0 && abs(maxCh - minCh) > 0.00001) {
      color = vec4f((color.rgb - vec3f(minCh)) / vec3f(maxCh - minCh), color.a);
    }

    if (display.numChannels == 1.0) {
      if (display.minRange != display.maxRange) {
        if (color.r < display.minRange) {
          color = vec4f(0.0, 0.0, 0.0, 1);
        } else if (color.r > display.maxRange) {
          color = vec4f(1.0, 0.0, 0.0, 1);
        } else {
          color = vec4f((color.r - display.minRange) / (display.maxRange - display.minRange), 0.0, 0.0, 1);
        }
      }
      color = vec4f(color.r, color.r, color.r, 1.0);
    } else if (display.numChannels == 2.0) {
      color = vec4f(color.r, color.g, 0.0, 1.0);
    }

    if (display.channels == 1.0) { // R
      var rgb = color.rgb * display.exposure;
      return vec4f(rgb.r, 0.0, 0.0, 1);
    } else if (display.channels == 2.0) { // G
      var rgb = color.rgb * display.exposure;
      return vec4f(0.0, rgb.g, 0.0, 1);
    } else if (display.channels == 3.0) { // B
      var rgb = color.rgb * display.exposure;
      return vec4f(0.0, 0.0, rgb.b, 1);
    } else if (display.channels == 4.0) { // A
      var a = color.a * display.exposure;
      return vec4f(a, a, a, 1);
    } else if (display.channels == 5.0) { // Luminance
      var luminance = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
      var rgb = vec3f(luminance) * display.exposure;
      return vec4f(rgb, 1);
    }

    // RGB
    var rgb = color.rgb * display.exposure;
    return vec4f(rgb, 1);
  }
`;

    TextureUtils.multisampleBlitShader = `
  var<private> posTex:array<vec4f, 3> = array<vec4f, 3>(
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
  @group(0) @binding(0) var texSampler: sampler;
  @group(0) @binding(1) var texture: texture_multisampled_2d<f32>;
  struct Display {
    exposure: f32,
    channels: f32,
    numChannels: f32,
    autoRange: f32,
    minRange: f32,
    maxRange: f32,
    _pad2: f32,
    _pad3: f32
  };
  struct MinMax {
      min_val: vec4f,
      max_val: vec4f,
  };
  @group(1) @binding(0) var<uniform> display: Display;
  @group(1) @binding(1) var<storage> minMax: MinMax;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    var coords = vec2i(input.uv * vec2f(textureDimensions(texture)));
    var color = textureLoad(texture, coords, 0);
    var minVal = minMax.min_val;
    var maxVal = minMax.max_val;

    var minCh = min(minVal.r, min(minVal.g, minVal.b));
    var maxCh = max(maxVal.r, max(maxVal.g, maxVal.b));
    if (display.autoRange > 0.0 && abs(maxCh - minCh) > 0.00001) {
      color = vec4f((color.rgb - vec3f(minCh)) / vec3f(maxCh - minCh), color.a);
    }

    if (display.numChannels == 1.0) {
      if (display.minRange != display.maxRange) {
        if (color.r < display.minRange) {
          color = vec4f(0.0, 0.0, 0.0, color.a);
        } else if (color.r > display.maxRange) {
          color = vec4f(1.0, 1.0, 1.0, color.a);
        } else {
          color = vec4f((color.r - display.minRange) / (display.maxRange - display.minRange), 0.0, 0.0, color.a);
        }
      }
      color = vec4f(color.r, color.r, color.r, 1.0);
    } else if (display.numChannels == 2.0) {
      color = vec4f(color.r, color.g, 0.0, 1.0);
    }
    if (display.channels == 1.0) { // R
      var rgb = color.rgb * display.exposure;
      return vec4f(rgb.r, 0.0, 0.0, color.a);
    } else if (display.channels == 2.0) { // G
      var rgb = color.rgb * display.exposure;
      return vec4f(0.0, rgb.g, 0.0, color.a);
    } else if (display.channels == 3.0) { // B
      var rgb = color.rgb * display.exposure;
      return vec4f(0.0, 0.0, rgb.b, color.a);
    } else if (display.channels == 4.0) { // A
      var a = color.a * display.exposure;
      return vec4f(a, a, a, color.a);
    } else if (display.channels == 5.0) { // Luminance
      var luminance = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
      var rgb = vec3f(luminance) * display.exposure;
      return vec4f(rgb, color.a);
    }

    // RGB
    var rgb = color.rgb * display.exposure;
    return vec4f(rgb, color.a);
  }`;

    TextureUtils.depthToFloatShader = `
  var<private> posTex:array<vec4f, 3> = array<vec4f, 3>(
    vec4f(-1.0, 1.0, 0.0, 0.0),
    vec4f(3.0, 1.0, 2.0, 0.0),
    vec4f(-1.0, -3.0, 0.0, 2.0));
  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv : vec2f
  };
  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    output.uv = posTex[vertexIndex].zw;
    output.position = vec4f(posTex[vertexIndex].xy, 0.0, 1.0);
    return output;;
  }

  @binding(0) @group(0) var depthSampler: sampler_comparison;
  @binding(1) @group(0) var depth: texture_depth_2d;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) f32 {
    var lo = 0.0;
    var hi = 1.0;
    for (var i = 0; i < 16; i++) {
      let mid = (lo + hi) * 0.5;
      let compare = textureSampleCompare(depth, depthSampler, input.uv, mid);
      if (compare > 0.5) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo;
  }`;

    TextureUtils.depthCubeToFloatShader = `
  var<private> posTex:array<vec4f, 3> = array<vec4f, 3>(
    vec4f(-1.0, 1.0, 0.0, 0.0),
    vec4f(3.0, 1.0, 2.0, 0.0),
    vec4f(-1.0, -3.0, 0.0, 2.0));
  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv : vec2f
  };
  struct FaceUniform {
    face: u32,
  };
  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    output.uv = posTex[vertexIndex].zw;
    output.position = vec4f(posTex[vertexIndex].xy, 0.0, 1.0);
    return output;;
  }

  fn cubeDirection(face: u32, uv: vec2f) -> vec3f {
    let xy = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    if (face == 0u) {
      return vec3f(1.0, xy.y, -xy.x);
    } else if (face == 1u) {
      return vec3f(-1.0, xy.y, xy.x);
    } else if (face == 2u) {
      return vec3f(xy.x, 1.0, -xy.y);
    } else if (face == 3u) {
      return vec3f(xy.x, -1.0, xy.y);
    } else if (face == 4u) {
      return vec3f(xy.x, xy.y, 1.0);
    }
    return vec3f(-xy.x, xy.y, -1.0);
  }

  @binding(0) @group(0) var depthSampler: sampler_comparison;
  @binding(1) @group(0) var depth: texture_depth_cube;
  @binding(2) @group(0) var<uniform> faceUniform: FaceUniform;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) f32 {
    let direction = cubeDirection(faceUniform.face, input.uv);
    var lo = 0.0;
    var hi = 1.0;
    for (var i = 0; i < 16; i++) {
      let mid = (lo + hi) * 0.5;
      let compare = textureSampleCompare(depth, depthSampler, direction, mid);
      if (compare > 0.5) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo;
  }`;

    TextureUtils.depthToFloatMultisampleShader = `
  var<private> posTex:array<vec4f, 3> = array<vec4f, 3>(
    vec4f(-1.0, 1.0, 0.0, 0.0),
    vec4f(3.0, 1.0, 2.0, 0.0),
    vec4f(-1.0, -3.0, 0.0, 2.0));
  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv : vec2f
  };
  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    output.uv = posTex[vertexIndex].zw;
    output.position = vec4f(posTex[vertexIndex].xy, 0.0, 1.0);
    return output;;
  }

  @binding(0) @group(0) var depth: texture_depth_multisampled_2d;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) f32 {
    var depthSize = textureDimensions(depth);
    var coords = vec2<i32>(i32(f32(depthSize.x) * input.uv.x),
                           i32(f32(depthSize.y) * input.uv.y));
    var d = textureLoad(depth, coords, 0);
    return d;
  }`;

    const Actions = {
      CaptureBufferData: "webgpu_inspect_capture_buffer_data",
      CaptureBuffers: "webgpu_inspect_capture_buffers",
      DeleteObjects: "webgpu_inspect_delete_objects",
      ValidationError: "webgpu_inspect_validation_error",
      MemoryLeakWarning: "webgpu_inspect_memory_leak_warning",
      DeltaTime: "webgpu_inspect_delta_time",
      CaptureFrameResults: "webgpu_inspect_capture_frame_results",
      CaptureFrameCommands: "webgpu_inspect_capture_frame_commands",
      ObjectSetLabel: "webgpu_inspect_object_set_label",
      AddObject: "webgpu_inspect_add_object",
      ResolveAsyncObject: "webgpu_inspect_resolve_async_object",
      DeleteObject: "webgpu_inspect_delete_object",
      CaptureTextureFrames: "webgpu_inspect_capture_texture_frames",
      CaptureTextureData: "webgpu_inspect_capture_texture_data",
      CaptureBufferData: "webgpu_inspect_capture_buffer_data",
      WriteBuffer: "wrebgpu_inspect_write_buffer",

      Recording: "webgpu_record_recording",
      RecordingCommand: "webgpu_record_command",
      RecordingDataCount: "webgpu_record_data_count",
      RecordingData: "webgpu_record_data",

      // Connection handshake actions. Sent automatically by MessagePort on every
      // (re)connect via its readyAction option so the background can re-register
      // each port after a service-worker restart.
      PageReady: "webgpu_inspect_page_ready",
      PanelReady: "webgpu_inspect_panel_ready",
    };

    Actions.values = new Set(Object.values(Actions));

    const PanelActions = {
      RequestTexture: "webgpu_inspect_request_texture",
      CompileShader: "webgpu_inspect_compile_shader",
      RevertShader: "webgpu_inspect_revert_shader",
      Capture: "webgpu_inspector_capture",
      InitializeInspector: "webgpu_initialize_inspector",
      InitializeRecorder: "webgpu_initialize_recorder",
      // Runtime trigger for on-demand (stateful, recordMode 2) recording. Forwarded by the
      // content script to the page as a "webgpu_recorder_record_frame" __WebGPURecorder event.
      RecordFrame: "webgpu_record_frame"
    };

    class RollingAverage {
      constructor(windowSize) {
        this.windowSize = windowSize;
        this.buffer = [];
        this.sum = 0;
      }
      
      add(frameTime) {
        this.buffer.push(frameTime);
        if (this.buffer.length > this.windowSize) {
          this.sum -= this.buffer.shift();
        }
        this.sum += frameTime;
      }
      
      get average() {
        if (this.buffer.length === 0) {
          return 0;
        }
        return this.sum / this.buffer.length;
      }
    }

    function alignTo(size, alignment) {
      return (size + alignment - 1) & ~(alignment - 1);
    }

    // Page-side store that mirrors what the devtools panel keeps when a frame is

    // 1.1 splits payload bytes (buffer/texture data) out of the metadata into a
    // side list referenced by `{__payloadId}`, so the capture can be streamed as
    // NDJSON and never built as one >512MB string. Loaders still accept 1.0 files,
    // which inlined the bytes as `__base64`.
    const SCHEMA_VERSION = "1.1";

    const _hasOwn = Object.prototype.hasOwnProperty;

    // Collects payload byte blobs during serialization and hands back lightweight
    // references to embed in the metadata. Each blob gets a sequential id; the
    // bytes are streamed out-of-band (see BridgeClient / saveCaptureData).
    class PayloadCollector {
      constructor() {
        this.payloads = []; // [{ id, typedArray, bytes: Uint8Array }]
      }

      // `length` is the element count of the original view; `bytes` is the captured
      // byte slice; `originalByteLength` (optional) is the true length when the
      // capture cap truncated the data. Returns the metadata reference.
      add(typedArray, length, bytes, originalByteLength) {
        const id = this.payloads.length;
        this.payloads.push({ id, typedArray, bytes });
        const ref = {
          __payloadId: id,
          __typedArray: typedArray,
          __length: length,
          __byteLength: bytes.length
        };
        if (originalByteLength && originalByteLength > bytes.length) {
          ref.__truncated = { byteLength: originalByteLength, capturedBytes: bytes.length };
        }
        return ref;
      }
    }

    class LocalCaptureStore {
      constructor() {
        // id -> record { id, type, label, descriptor, stacktrace, pending, parent,
        //                 imageData[], isImageDataLoaded[], _loadedImageChunks[] }
        this._objects = new Map();
        this._validationErrors = [];
        // commandId -> command record. Used to route CaptureBufferData chunks back
        // to the command they belong to.
        this._commandsById = new Map();
        // Concatenated commands across every frame the user captured, in order.
        this._commands = [];
        // CaptureFrameResults reserves the next slice in `_commands`; the
        // CaptureFrameCommands batches fill it in.
        this._currentSlot = null;
        // Track the frame number of the first captured frame so the export reports
        // a meaningful `frame` field. Defaults to 0 if nothing was captured.
        this._firstFrame = null;
        // commandId -> array of CaptureBufferData messages that arrived before the
        // corresponding command record. Drained when the command lands.
        this._pendingBufferData = new Map();
        // Timestamp readback (commandId === -1000). Accumulated chunks; once all
        // chunks arrive, decode and merge per-pass timings onto the matching
        // beginRenderPass/beginComputePass command records so they survive
        // saveCaptureData()/importCaptureJson() round-trips.
        this._timestampBytes = null;
        this._timestampChunksRemaining = 0;
      }

      hasCapturedCommands() {
        return this._commands.length > 0 || this._currentSlot !== null;
      }

      // Clear everything: object records, captured frames, validation errors.
      // Used when the user calls `initialize()` after a save to start over.
      reset() {
        this._objects.clear();
        this._validationErrors = [];
        this._commandsById.clear();
        this._commands = [];
        this._currentSlot = null;
        this._firstFrame = null;
        this._pendingBufferData.clear();
      }

      // Clear just the captured commands (and the pending-by-id state that goes
      // with them). Keeps object records so a subsequent capture-then-save still
      // has access to the GPU objects created earlier.
      resetCaptures() {
        this._commandsById.clear();
        this._commands = [];
        this._currentSlot = null;
        this._firstFrame = null;
        this._pendingBufferData.clear();
        this._timestampBytes = null;
        this._timestampChunksRemaining = 0;
      }

      processMessage(message) {
        if (!message?.action) {
          return;
        }
        switch (message.action) {
          case Actions.AddObject:
            this._handleAddObject(message);
            break;
          case Actions.DeleteObject:
            // Keep records around: a captured command may still reference an
            // object the page has since destroyed, and the devtools-side capture
            // also retains these via `capturedObjects`.
            break;
          case Actions.DeleteObjects:
            break;
          case Actions.ObjectSetLabel: {
            const o = this._objects.get(message.id);
            if (o) {
              o.label = message.label || "";
            }
            break;
          }
          case Actions.ResolveAsyncObject: {
            const o = this._objects.get(message.id);
            if (o) {
              o.pending = false;
            }
            break;
          }
          case Actions.ValidationError:
            this._validationErrors.push({
              id: this._validationErrors.length + 1,
              objectId: message.id ?? 0,
              message: message.message,
              stacktrace: message.stacktrace || ""
            });
            break;
          case Actions.CaptureFrameResults:
            this._handleCaptureFrameResults(message);
            break;
          case Actions.CaptureFrameCommands:
            this._handleCaptureFrameCommands(message);
            break;
          case Actions.CaptureBufferData:
            this._handleCaptureBufferData(message);
            break;
          case Actions.CaptureTextureData:
            this._handleCaptureTextureData(message);
            break;
        }
      }

      _handleAddObject(message) {
        let descriptor = null;
        if (message.descriptor) {
          try {
            descriptor = JSON.parse(message.descriptor);
          } catch (e) {
            descriptor = null;
          }
        }
        const id = message.id;
        const existing = this._objects.get(id);
        if (existing) {
          // Re-add of an existing id (the wrapper does this for some types).
          existing.descriptor = descriptor;
          existing.stacktrace = message.stacktrace || "";
          existing.pending = !!message.pending;
          existing.parent = message.parent;
          if (descriptor?.label) {
            existing.label = descriptor.label;
          }
          return;
        }
        this._objects.set(id, {
          id,
          type: message.type,
          label: descriptor?.label ?? "",
          descriptor,
          stacktrace: message.stacktrace || "",
          parent: message.parent,
          pending: !!message.pending,
          imageData: [],
          isImageDataLoaded: [],
          _loadedImageChunks: []
        });
      }

      _handleCaptureFrameResults(message) {
        const count = message.count | 0;
        const start = this._commands.length;
        // Reserve slots; CaptureFrameCommands batches will fill them.
        this._commands.length = start + count;
        this._currentSlot = {
          frame: message.frame,
          start,
          count,
          batchesRemaining: message.batches | 0
        };
        if (this._firstFrame === null) {
          this._firstFrame = message.frame;
        }
      }

      _handleCaptureFrameCommands(message) {
        const slot = this._currentSlot;
        if (!slot) {
          return;
        }
        const base = slot.start + (message.index | 0);
        const commands = message.commands || [];
        for (let i = 0; i < message.count; ++i) {
          const cmd = commands[i];
          this._commands[base + i] = cmd;
          if (cmd && cmd.commandId !== undefined) {
            this._commandsById.set(cmd.commandId, cmd);
            // Drain any CaptureBufferData chunks that arrived before this
            // command's batch.
            const pending = this._pendingBufferData.get(cmd.commandId);
            if (pending) {
              for (const pendingMessage of pending) {
                this._applyBufferDataChunk(cmd, pendingMessage);
              }
              this._pendingBufferData.delete(cmd.commandId);
            }
          }
        }
        slot.batchesRemaining--;
        if (slot.batchesRemaining <= 0) {
          this._currentSlot = null;
        }
      }

      _handleCaptureBufferData(message) {
        if (message.commandId === -1000) {
          this._handleTimestampChunk(message);
          return;
        }
        const cmd = this._commandsById.get(message.commandId);
        if (!cmd) {
          // The command batch hasn't been flushed to us yet. Park the chunk and
          // apply it once the command record arrives.
          let bucket = this._pendingBufferData.get(message.commandId);
          if (!bucket) {
            bucket = [];
            this._pendingBufferData.set(message.commandId, bucket);
          }
          bucket.push(message);
          return;
        }
        this._applyBufferDataChunk(cmd, message);
      }

      _applyBufferDataChunk(cmd, message) {
        const entryIndex = message.entryIndex | 0;
        if (!cmd.bufferData) {
          cmd.bufferData = [];
        }
        if (!cmd._loadedChunks) {
          cmd._loadedChunks = [];
        }
        if (!cmd.isBufferDataLoaded) {
          cmd.isBufferDataLoaded = [];
        }
        // > 0 only when the capture cap truncated this buffer; remember the true
        // length so the serialized command can mark the payload truncated.
        if (message.originalSize > 0) {
          if (!cmd.bufferOriginalSize) {
            cmd.bufferOriginalSize = [];
          }
          cmd.bufferOriginalSize[entryIndex] = message.originalSize;
        }
        if (!cmd.bufferData[entryIndex] || cmd.bufferData[entryIndex].length !== message.size) {
          cmd.bufferData[entryIndex] = new Uint8Array(message.size);
          cmd._loadedChunks[entryIndex] = new Array(message.count);
        }
        let chunk;
        try {
          chunk = decodeBase64(message.chunk);
        } catch (e) {
          return;
        }
        cmd.bufferData[entryIndex].set(chunk, message.offset);
        cmd._loadedChunks[entryIndex][message.index] = true;
        let loaded = true;
        for (let i = 0; i < message.count; ++i) {
          if (!cmd._loadedChunks[entryIndex][i]) {
            loaded = false;
            break;
          }
        }
        cmd.isBufferDataLoaded[entryIndex] = loaded;
      }

      // Accumulates the raw u64 timestamp buffer streamed in CaptureBufferData
      // messages with commandId === -1000. When the last chunk arrives, decodes the
      // BigInt64Array and writes startTime/endTime/duration onto each
      // beginRenderPass/beginComputePass command in capture order. Mirrors the
      // decode in src/devtools/capture_data.js so the merged fields are picked up
      // unchanged by _serializeCommand → saveCaptureData → importCaptureJson.
      _handleTimestampChunk(message) {
        if (this._timestampBytes === null) {
          this._timestampBytes = new Uint8Array(message.size);
          this._timestampChunksRemaining = message.count;
        }
        let chunk;
        try {
          chunk = decodeBase64(message.chunk);
        } catch (e) {
          return;
        }
        this._timestampBytes.set(chunk, message.offset);
        this._timestampChunksRemaining--;
        if (this._timestampChunksRemaining > 0) {
          return;
        }

        const timestampData = new BigInt64Array(this._timestampBytes.buffer);
        this._timestampBytes = null;

        let i = 2;
        for (let k = 0; k < this._commands.length && i < timestampData.length; k++) {
          const command = this._commands[k];
          if (!command || (command.method !== "beginRenderPass" && command.method !== "beginComputePass")) {
            continue;
          }
          const start = timestampData[i];
          const end = timestampData[i + 1];
          command.startTime = Number(start) / 1000000.0;
          command.endTime = Number(end) / 1000000.0;
          command.duration = Number(end - start) / 1000000.0;
          i += 2;
        }
      }

      _handleCaptureTextureData(message) {
        const obj = this._objects.get(message.id);
        if (!obj) {
          return;
        }
        const mipLevel = message.mipLevel ?? 0;
        if (!(obj.imageData[mipLevel] instanceof Uint8Array) ||
            obj.imageData[mipLevel].length !== message.size) {
          obj.imageData[mipLevel] = new Uint8Array(message.size);
          obj._loadedImageChunks[mipLevel] = new Array(message.count);
        }
        let chunk;
        try {
          chunk = decodeBase64(message.chunk);
        } catch (e) {
          return;
        }
        obj.imageData[mipLevel].set(chunk, message.offset);
        obj._loadedImageChunks[mipLevel][message.index] = true;
        let loaded = true;
        for (let i = 0; i < message.count; ++i) {
          if (!obj._loadedImageChunks[mipLevel][i]) {
            loaded = false;
            break;
          }
        }
        obj.isImageDataLoaded[mipLevel] = loaded;
      }

      // --- Serialization (mirrors src/devtools/capture_export.js) ---

      // Build the capture as split metadata + out-of-band payloads. Returns
      // `{ metadata, payloads }`; the caller streams them (NDJSON: metadata first,
      // then one line per payload) so no single huge string is ever allocated.
      buildCaptureStream(toolVersion) {
        const collector = new PayloadCollector();

        const objects = {};
        this._objects.forEach((rec, id) => {
          objects[String(id)] = this._serializeObject(rec, collector);
        });

        const cmdRecords = new Array(this._commands.length);
        for (let i = 0; i < this._commands.length; ++i) {
          const c = this._commands[i];
          cmdRecords[i] = c ? this._serializeCommand(c, i, collector) : null;
        }

        const metadata = {
          schemaVersion: SCHEMA_VERSION,
          tool: "webgpu_inspector",
          toolVersion: toolVersion || "",
          exportedAt: new Date().toISOString(),
          frame: this._firstFrame ?? 0,
          statistics: {},
          validationErrors: this._validationErrors.slice(),
          objects,
          commands: cmdRecords,
          payloadCount: collector.payloads.length
        };

        return { metadata, payloads: collector.payloads };
      }

      _objectRef(id) {
        const ref = { __id: id };
        const o = this._objects.get(id);
        if (o) {
          ref.__class = o.type;
          if (o.label) {
            ref.__label = o.label;
          }
        }
        return ref;
      }

      _cloneValue(value, collector) {
        if (value === null || value === undefined) {
          return value ?? null;
        }
        const t = typeof value;
        if (t === "string" || t === "boolean") {
          return value;
        }
        if (t === "number") {
          return Number.isFinite(value) ? value : null;
        }
        if (t === "bigint") {
          return value.toString();
        }
        if (ArrayBuffer.isView(value)) {
          const bytes = value instanceof Uint8Array
            ? value
            : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
          return collector.add(value.constructor.name, value.length, bytes);
        }
        if (value instanceof ArrayBuffer) {
          return collector.add("ArrayBuffer", value.byteLength, new Uint8Array(value));
        }
        if (Array.isArray(value)) {
          const out = new Array(value.length);
          for (let i = 0; i < value.length; ++i) {
            out[i] = this._cloneValue(value[i], collector);
          }
          return out;
        }
        if (t === "object") {
          if (value.__id !== undefined && Object.keys(value).length <= 3) {
            // The page side already tags refs with __id/__class; re-emit them
            // expanded with the current label.
            return this._objectRef(value.__id);
          }
          const out = {};
          for (const k in value) {
            if (!_hasOwn.call(value, k)) {
              continue;
            }
            out[k] = this._cloneValue(value[k], collector);
          }
          return out;
        }
        return null;
      }

      _serializeObject(rec, collector) {
        const out = {
          id: rec.id,
          type: rec.type,
          label: rec.label || undefined,
          descriptor: rec.descriptor ? this._cloneValue(rec.descriptor, collector) : null
        };
        if (rec.stacktrace) {
          out.stacktrace = rec.stacktrace;
        }
        if (rec.type === "Buffer") {
          const size = rec.descriptor?.size;
          if (size != null) {
            out.size = size;
          }
        }
        if (rec.type === "Texture") {
          const dims = _textureDims(rec.descriptor);
          out.width = dims.width;
          out.height = dims.height;
          out.depthOrArrayLayers = dims.depthOrArrayLayers;
          out.mipLevelCount = rec.descriptor?.mipLevelCount ?? 1;
          out.format = rec.descriptor?.format ?? "<unknown format>";
          out.dimension = rec.descriptor?.dimension ?? "2d";
          const gpuSize = _textureGpuSize(rec.descriptor);
          if (gpuSize >= 0) {
            out.gpuSize = gpuSize;
          }
          const mipData = [];
          for (let level = 0; level < rec.imageData.length; ++level) {
            const bytes = rec.imageData[level];
            if (!(bytes instanceof Uint8Array)) {
              continue;
            }
            if (rec.isImageDataLoaded[level] === false) {
              continue;
            }
            mipData.push({
              mipLevel: level,
              byteLength: bytes.length,
              ...collector.add("Uint8Array", bytes.length, bytes)
            });
          }
          if (mipData.length) {
            out.mipData = mipData;
          }
        }
        if (rec.type === "TextureView" && rec.parent != null) {
          out.texture = this._objectRef(rec.parent);
        }
        if (rec.type === "ShaderModule") {
          const code = rec.descriptor?.code;
          out.hasVertexEntries = code ? code.indexOf("@vertex") !== -1 : false;
          out.hasFragmentEntries = code ? code.indexOf("@fragment") !== -1 : false;
          out.hasComputeEntries = code ? code.indexOf("@compute") !== -1 : false;
        }
        return out;
      }

      _serializeCommand(command, index, collector) {
        const record = {
          index,
          method: command.method
        };
        if (command.object !== undefined) {
          record.object = this._cloneValue(command.object, collector);
        }
        if (command.args !== undefined) {
          record.args = this._cloneValue(command.args, collector);
        }
        if (command.result !== undefined) {
          record.result = this._cloneValue(command.result, collector);
        }
        if (command.stacktrace) {
          record.stacktrace = command.stacktrace;
        }
        if (command.duration !== undefined) {
          record.duration = command.duration;
          record.startTime = command.startTime;
          record.endTime = command.endTime;
        }
        if (command.bufferData && command.isBufferDataLoaded) {
          const entries = [];
          for (let i = 0; i < command.bufferData.length; ++i) {
            if (!command.isBufferDataLoaded[i]) {
              continue;
            }
            const bytes = command.bufferData[i];
            if (!bytes) {
              continue;
            }
            const originalSize = command.bufferOriginalSize ? command.bufferOriginalSize[i] : 0;
            entries.push({
              entryIndex: i,
              byteLength: originalSize || bytes.length,
              ...collector.add("Uint8Array", bytes.length, bytes, originalSize)
            });
          }
          if (entries.length) {
            record.bufferData = entries;
          }
        }
        for (const k in command) {
          if (!_hasOwn.call(command, k)) {
            continue;
          }
          if (k in record) {
            continue;
          }
          if (k === "method" || k === "object" || k === "args" || k === "result" ||
              k === "stacktrace" || k === "duration" || k === "startTime" ||
              k === "endTime" || k === "bufferData" || k === "isBufferDataLoaded" ||
              k === "bufferOriginalSize") {
            continue;
          }
          if (k.startsWith("_")) {
            continue;
          }
          record[k] = this._cloneValue(command[k], collector);
        }
        return record;
      }
    }

    function _textureDims(descriptor) {
      const size = descriptor?.size;
      let width = 0;
      let height = 1;
      let depthOrArrayLayers = 1;
      if (Array.isArray(size)) {
        width = size[0] ?? 0;
        height = size[1] ?? 1;
        depthOrArrayLayers = size[2] ?? 1;
      } else if (size && typeof size === "object") {
        width = size.width ?? 0;
        height = size.height ?? 1;
        depthOrArrayLayers = size.depthOrArrayLayers ?? 1;
      }
      return { width, height, depthOrArrayLayers };
    }

    function _textureGpuSize(descriptor) {
      const format = descriptor?.format;
      const info = format ? TextureFormatInfo[format] : null;
      if (!info) {
        return -1;
      }
      const { width, height, depthOrArrayLayers } = _textureDims(descriptor);
      if (width <= 0) {
        return -1;
      }
      const dimension = descriptor?.dimension ?? "2d";
      const blockWidth = width / info.blockWidth;
      const blockHeight = dimension === "1d" ? 1 : height / info.blockHeight;
      return blockWidth * blockHeight * info.bytesPerBlock * depthOrArrayLayers;
    }

    // Binary capture container ("WGPUCAP"), the default save format for captures.
    //
    // Layout (offsets are absolute file offsets):
    //
    //   "WGPUCAP <containerVersion> <jsonByteLength>\n"   ASCII header line
    //   <jsonByteLength bytes>                            metadata JSON, UTF-8
    //   "\n" * k                                          padding so the binary
    //                                                     section starts 8-aligned
    //   <binary section>                                  raw payload bytes
    //
    // The header and metadata are plain text, so the front of the file is readable
    // in a text editor; only the trailing payload bytes are binary. The metadata
    // object is the same one the 1.x NDJSON format carried (schemaVersion,
    // objects, commands, ...) plus one extra field:
    //
    //   payloadTable: Array<[byteOffset, byteLength] | null>
    //
    // indexed by payloadId, with byteOffset relative to the start of the binary
    // section. Each payload is zero-padded to an 8-byte boundary so loaders can
    // create TypedArray views (up to Float64/BigInt64) directly over the file
    // bytes without copying. `{__payloadId}` references inside the metadata are
    // unchanged from the NDJSON format.
    //
    // This file must stay in sync with its Node twin,
    // claude-plugin/server/capture-binary.js — the plugin server is distributed
    // standalone and cannot import from src/. Test coverage in
    // claude-plugin/server/test/run.js round-trips files across the two.

    const MAGIC = "WGPUCAP";
    const CONTAINER_VERSION = 1;

    const _textEncoder = new TextEncoder();
    new TextDecoder();

    // Arithmetic (not bitwise) so offsets past 2^31 don't truncate.
    function _align8(n) {
      return Math.ceil(n / 8) * 8;
    }

    /**
     * Encode a capture stream (`{ metadata, payloads }` from buildCaptureStream,
     * where payloads is `[{ id, typedArray, bytes: Uint8Array }]`) into an ordered
     * list of byte chunks. Payload bytes are referenced, never copied, so this is
     * cheap even for multi-GB captures; hand the parts to `new Blob(parts)` or
     * write them sequentially to a stream.
     *
     * @returns {{ parts: Uint8Array[], byteLength: number }}
     */
    function encodeCaptureBinaryParts(stream) {
      const payloads = stream.payloads || [];
      const table = [];
      let offset = 0;
      for (const p of payloads) {
        const len = p.bytes ? p.bytes.length : 0;
        while (table.length < p.id) {
          table.push(null);
        }
        table[p.id] = [offset, len];
        offset = _align8(offset + len);
      }

      const metadata = { ...stream.metadata, payloadTable: table };
      const jsonBytes = _textEncoder.encode(JSON.stringify(metadata));
      const header = _textEncoder.encode(`${MAGIC} ${CONTAINER_VERSION} ${jsonBytes.length}\n`);

      const parts = [header, jsonBytes];
      const preludeLength = header.length + jsonBytes.length;
      let byteLength = _align8(preludeLength);
      const preludePad = byteLength - preludeLength;
      if (preludePad) {
        parts.push(new Uint8Array(preludePad).fill(0x0a));
      }

      for (const p of payloads) {
        const bytes = p.bytes || new Uint8Array(0);
        if (bytes.length) {
          parts.push(bytes);
          byteLength += bytes.length;
        }
        const pad = _align8(bytes.length) - bytes.length;
        if (pad) {
          parts.push(new Uint8Array(pad));
          byteLength += pad;
        }
      }

      return { parts, byteLength };
    }

    // Page-side client for the WebGPU Inspector Claude Code plugin's live bridge.

    const DEFAULT_URL = "ws://localhost:9690/page";

    // If a capture is requested but the page does not produce a new animation
    // frame within this window, fall back to an immediate begin/end capture so a
    // non-rAF (e.g. compute-only) page still yields a capture.
    const FRAME_WAIT_MS = 3000;

    class BridgeClient {
      constructor(inspector, options) {
        this._inspector = inspector;
        options = options || {};

        this._url = options.url || DEFAULT_URL;
        this._httpBase = options.httpBase || _deriveHttpBase(this._url);
        this._token = options.token || null;
        this._name = options.name || _defaultName();
        this._autoReconnect = options.autoReconnect !== false;

        this._ws = null;
        this._connected = false;
        this._closed = false;
        this._reconnectTimer = null;

        // Capture driver state.
        this._capturing = false;
        this._activeRequestId = null;
        this._framesRemaining = 0;
        this._fallbackTimer = null;
        // Per-request capture options (maxBufferSize / passLabel / passType),
        // forwarded into beginFrameCapture so scoped/size-capped captures work.
        this._captureOptions = null;

        this._installRafHook();
      }

      // --- Connection -----------------------------------------------------------

      connect() {
        if (this._closed || this._ws) {
          return;
        }
        let ws;
        try {
          ws = new WebSocket(this._url);
        } catch (e) {
          this._log("failed to open WebSocket:", e && e.message);
          this._scheduleReconnect();
          return;
        }
        this._ws = ws;

        ws.addEventListener("open", () => {
          this._connected = true;
          this._log("connected to bridge at", this._url);
          this._send({
            type: "hello",
            name: this._name,
            url: _location(),
            userAgent: (typeof navigator !== "undefined" && navigator.userAgent) || "",
            isWorker: typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope,
            hasRequestAnimationFrame: typeof self.requestAnimationFrame === "function"
          });
        });

        ws.addEventListener("message", (event) => this._onMessage(event));

        ws.addEventListener("close", () => {
          this._connected = false;
          this._ws = null;
          if (!this._closed) {
            this._scheduleReconnect();
          }
        });

        ws.addEventListener("error", () => {
          // The close handler drives reconnect; nothing extra to do here.
        });
      }

      close() {
        this._closed = true;
        this._autoReconnect = false;
        if (this._reconnectTimer) {
          clearTimeout(this._reconnectTimer);
          this._reconnectTimer = null;
        }
        if (this._ws) {
          try {
            this._ws.close();
          } catch (e) { /* ignore */ }
          this._ws = null;
        }
      }

      _scheduleReconnect() {
        if (!this._autoReconnect || this._closed || this._reconnectTimer) {
          return;
        }
        this._reconnectTimer = setTimeout(() => {
          this._reconnectTimer = null;
          this.connect();
        }, 2000);
      }

      _send(obj) {
        if (this._ws && this._connected) {
          try {
            this._ws.send(JSON.stringify(obj));
          } catch (e) {
            this._log("send failed:", e && e.message);
          }
        }
      }

      _onMessage(event) {
        let msg;
        try {
          msg = JSON.parse(event.data);
        } catch (e) {
          return;
        }
        switch (msg && msg.type) {
          case "capture":
            this._startCapture(msg);
            break;
          case "readBuffer":
            this._handleReadBuffer(msg);
            break;
          case "readTexture":
            this._handleReadTexture(msg);
            break;
          case "ping":
            this._send({ type: "pong" });
            break;
        }
      }

      // --- Live buffer readback -------------------------------------------------

      // Read a live GPU buffer's current contents and send the bytes back over the
      // WebSocket. Delegates the actual GPU work to the inspector, which knows how
      // to allocate a readback buffer and map it.
      async _handleReadBuffer(msg) {
        try {
          const result = await this._inspector.readBuffer(msg.bufferId, msg.offset, msg.size);
          this._send({
            type: "readResult",
            requestId: msg.requestId,
            bufferId: msg.bufferId,
            offset: result.offset || 0,
            byteLength: result.byteLength || 0,
            base64: result.base64 || "",
            truncated: result.truncated || null
          });
        } catch (e) {
          this._send({
            type: "readResult",
            requestId: msg.requestId,
            error: (e && e.message) ? e.message : String(e)
          });
        }
      }

      // Read a live GPU texture region and send its pixel bytes (base64) + layout back
      // over the WebSocket. Like _handleReadBuffer, the GPU work lives in the inspector.
      async _handleReadTexture(msg) {
        try {
          const r = await this._inspector.readTexture(msg.textureId, {
            mipLevel: msg.mipLevel, layer: msg.layer,
            x: msg.x, y: msg.y, width: msg.width, height: msg.height
          });
          this._send({ type: "readTextureResult", requestId: msg.requestId, ...r });
        } catch (e) {
          this._send({
            type: "readTextureResult",
            requestId: msg.requestId,
            error: (e && e.message) ? e.message : String(e)
          });
        }
      }

      // --- Capture driver -------------------------------------------------------

      // Wrap requestAnimationFrame so that, while a capture is in progress, each
      // frame the page renders is bracketed by begin/endFrameCapture. The hook is
      // a no-op passthrough whenever no capture is active.
      _installRafHook() {
        if (typeof self.requestAnimationFrame !== "function") {
          return; // Worker / non-rAF context: the immediate fallback handles it.
        }
        const origRaf = self.requestAnimationFrame.bind(self);
        const client = this;
        self.requestAnimationFrame = function (callback) {
          return origRaf(function (time) {
            if (client._framesRemaining > 0) {
              client._inspector.beginFrameCapture(client._captureOptions);
              try {
                callback(time);
              } finally {
                client._inspector.endFrameCapture();
                client._onFrameCaptured();
              }
            } else {
              callback(time);
            }
          });
        };
      }

      _startCapture(msg) {
        if (this._capturing) {
          this._send({
            type: "captureError",
            requestId: msg.requestId,
            message: "A capture is already in progress."
          });
          return;
        }
        this._capturing = true;
        this._activeRequestId = msg.requestId;
        this._framesRemaining = Math.max(1, (msg.frames | 0) || 1);
        this._captureOptions = {
          maxBufferSize: (typeof msg.maxBufferSize === "number") ? msg.maxBufferSize : undefined,
          maxTextureSize: (typeof msg.maxTextureSize === "number") ? msg.maxTextureSize : undefined,
          passLabel: msg.passLabel,
          passType: msg.passType
        };

        this._send({
          type: "captureStarted",
          requestId: msg.requestId,
          frames: this._framesRemaining
        });

        this._armFallback();
      }

      _armFallback() {
        if (this._fallbackTimer) {
          clearTimeout(this._fallbackTimer);
        }
        this._fallbackTimer = setTimeout(() => {
          this._fallbackTimer = null;
          this._immediateCapture();
        }, FRAME_WAIT_MS);
      }

      _onFrameCaptured() {
        this._framesRemaining--;
        if (this._framesRemaining > 0) {
          this._armFallback();
        } else {
          if (this._fallbackTimer) {
            clearTimeout(this._fallbackTimer);
            this._fallbackTimer = null;
          }
          this._finishCapture();
        }
      }

      // The page did not render a frame in time (no rAF loop, or it stalled).
      // Capture whatever GPU work happens within a single synchronous begin/end
      // pair so the request still resolves with a valid (if possibly empty) file.
      _immediateCapture() {
        if (!this._capturing || this._framesRemaining <= 0) {
          return;
        }
        this._inspector.beginFrameCapture(this._captureOptions);
        this._inspector.endFrameCapture();
        this._framesRemaining = 0;
        this._finishCapture();
      }

      async _finishCapture() {
        const requestId = this._activeRequestId;
        try {
          // `saveCaptureData` returns `{ metadata, payloads }`: metadata is small,
          // payload bytes are streamed out-of-band so nothing is ever stringified
          // as one giant blob.
          const stream = await this._inspector.saveCaptureData(undefined, { download: false });
          const metadata = stream.metadata;
          await this._upload(requestId, stream);
          this._send({
            type: "captureComplete",
            requestId,
            frame: metadata && metadata.frame,
            commands: metadata && metadata.commands ? metadata.commands.length : 0,
            objects: metadata && metadata.objects ? Object.keys(metadata.objects).length : 0
          });
        } catch (e) {
          this._send({
            type: "captureError",
            requestId,
            message: (e && e.message) ? e.message : String(e)
          });
        } finally {
          this._capturing = false;
          this._activeRequestId = null;
        }
      }

      async _upload(requestId, stream) {
        let url = `${this._httpBase}/capture/${encodeURIComponent(requestId)}`;
        if (this._token) {
          url += `?token=${encodeURIComponent(this._token)}`;
        }
        // Build the body in the WGPUCAP binary container: the Blob parts reference
        // the payload typed arrays directly, so the upload carries raw bytes (no
        // base64 inflation) and never allocates giant strings.
        // text/plain keeps this a CORS "simple request" (no preflight); the bridge
        // sniffs the WGPUCAP magic regardless of the declared content type.
        const { parts } = encodeCaptureBinaryParts(stream);
        const body = new Blob(parts, { type: "text/plain" });
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "text/plain" },
          body
        });
        if (!response.ok) {
          throw new Error(`Capture upload failed: HTTP ${response.status}`);
        }
      }

      _log(...args) {
        if (typeof console !== "undefined" && console.log) {
          console.log("[webgpu-inspector bridge]", ...args);
        }
      }
    }

    function _deriveHttpBase(wsUrl) {
      try {
        const u = new URL(wsUrl);
        const protocol = u.protocol === "wss:" ? "https:" : "http:";
        return `${protocol}//${u.host}`;
      } catch (e) {
        return "http://localhost:9690";
      }
    }

    function _location() {
      try {
        if (typeof self.location !== "undefined" && self.location) {
          return self.location.href;
        }
      } catch (e) { /* ignore */ }
      return "";
    }

    function _defaultName() {
      const loc = _location();
      return loc || "webgpu-page";
    }

    exports.webgpuInspector = null;

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
      const maxBufferCaptureSize = 64 * 1024; // 64KB — light by default; raise via capture options.
      // Default cap on captured texture pixel data, per texture (bytes). Full-res
      // render targets are large, so the programmatic/bridge capture path skips
      // textures above this by default to stay light; raise or set -1 to disable.
      const maxTextureCaptureSize = 16 * 1024 * 1024; // 16MB
      const maxColorAttachments = 10;
      const captureFrameCount = 1;

      // Build a scoped-capture filter from capture options. Returns null when no
      // scoping is requested (capture everything). `passLabel` may be a string
      // (treated as a RegExp source) or a RegExp; `passType` is "render"/"compute".
      function _buildCaptureScope(options) {
        if (!options || (!options.passLabel && !options.passType)) {
          return null;
        }
        let passLabelRegex = null;
        if (options.passLabel) {
          try {
            passLabelRegex = options.passLabel instanceof RegExp
              ? options.passLabel
              : new RegExp(options.passLabel);
          } catch (e) {
            passLabelRegex = null;
          }
        }
        const passType = (options.passType === "render" || options.passType === "compute")
          ? options.passType
          : null;
        if (!passLabelRegex && !passType) {
          return null;
        }
        return { passLabelRegex, passType };
      }

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
          // Per-capture buffer payload cap (bytes). Set in beginFrameCapture; -1 = uncapped.
          this._captureMaxBufferSize = maxBufferCaptureSize;
          // Per-capture texture pixel-data cap (bytes). -1 = uncapped (the default for
          // devtools-panel captures; the programmatic/bridge path caps by default).
          this._captureMaxTextureSize = -1;
          // Optional scoped-capture filter ({ passLabelRegex, passType }); null = capture everything.
          this._captureScope = null;
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
        // `options` (all optional):
        //   maxBufferSize - cap, in bytes, on every captured buffer payload
        //                   (vertex/index/storage/uniform/indirect). Use -1 to
        //                   disable the cap. Defaults to `maxBufferCaptureSize`.
        //   maxTextureSize- cap, in bytes, on each captured texture's pixel data;
        //                   larger textures are skipped (no pixels). Use -1 to
        //                   disable. Defaults to `maxTextureCaptureSize`.
        //   passLabel     - only capture heavy payloads for render/compute passes
        //                   whose label matches this string or RegExp.
        //   passType      - "render" | "compute": only capture payloads for passes
        //                   of this type.
        beginFrameCapture(options) {
          if (!this._localCapture) {
            throw new Error("WebGPU Inspector: call initialize() before beginFrameCapture()");
          }
          if (this._localCaptureActive) {
            return;
          }
          options = options || {};
          this._localCaptureActive = true;
          this._captureMaxBufferSize = (typeof options.maxBufferSize === "number")
            ? options.maxBufferSize
            : maxBufferCaptureSize;
          this._captureMaxTextureSize = (typeof options.maxTextureSize === "number")
            ? options.maxTextureSize
            : maxTextureCaptureSize;
          this._captureScope = _buildCaptureScope(options);
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
          this._captureScope = null;
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

        // Build the capture and trigger a download of the binary capture file.
        // Returns the capture stream for callers that want the data themselves.
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

          // Split metadata from payload bytes so the capture is never built as one
          // giant JSON string. Returns `{ metadata, payloads }`.
          const stream = this._localCapture.buildCaptureStream("1.5.0");

          // Subsequent begin/end pairs start a fresh frame list. Object records
          // stay so anything created before this save (and still referenced by
          // a later capture) is exported next time too.
          this._commandId = 0;
          this._frameRenderPassCount = 0;
          this._localCapture.resetCaptures();

          const frame = stream.metadata.frame ?? 0;
          const name = filename || `webgpu_capture_frame_${frame}.wgpuc`;
          if (!options || options.download !== false) {
            this._downloadCaptureStream(stream, name);
          }

          return stream;
        }

        // Encode a capture stream (the `{ metadata, payloads }` value
        // saveCaptureData() resolves with) into a Blob of the binary capture file
        // (WGPUCAP container; see src/utils/capture_binary.js). The Blob parts
        // reference the payload typed arrays directly, so nothing is
        // base64-inflated or built as a giant string. Public because a worker has
        // no `document` to trigger a download with — it can build the Blob here,
        // post it to a page context (Blobs are structured-cloneable), and let the
        // page download it.
        captureStreamToBlob(stream) {
          const { parts } = encodeCaptureBinaryParts(stream);
          return new Blob(parts, { type: "application/octet-stream" });
        }

        // Download a capture as a binary capture file. The file is loadable via
        // DevTools "Load Capture" / load_capture_file, which also still accept the
        // legacy NDJSON (1.1) and single-object JSON (1.0) captures.
        _downloadCaptureStream(stream, filename) {
          if (!_document) {
            return;
          }
          const blob = this.captureStreamToBlob(stream);
          const url = URL.createObjectURL(blob);
          const a = _document.createElement("a");
          a.href = url;
          a.download = filename;
          _document.body.appendChild(a);
          a.click();
          _document.body.removeChild(a);
          setTimeout(() => URL.revokeObjectURL(url), 0);
        }

        // Read a live GPU buffer's current contents without taking a full capture.
        // Copies the buffer to a MAP_READ readback buffer, maps it, and returns the
        // bytes as base64. The source buffer must have COPY_SRC usage (buffers
        // created while a capture is armed get COPY_SRC automatically). Returns
        // { offset, byteLength, base64, truncated }.
        async readBuffer(bufferId, offset, size) {
          const buffer = this._trackedObjects.get(bufferId)?.deref();
          if (!buffer) {
            throw new Error(`No live GPU buffer with id ${bufferId}.`);
          }
          if (buffer.__destroyed) {
            throw new Error(`Buffer ${bufferId} has been destroyed.`);
          }
          const device = buffer.__device;
          if (!device) {
            throw new Error(`Buffer ${bufferId} has no associated device.`);
          }
          if (!(buffer.usage & GPUBufferUsage.COPY_SRC)) {
            throw new Error(`Buffer ${bufferId} lacks COPY_SRC usage and can't be read back. ` +
              "Buffers created while a capture is armed are given COPY_SRC automatically.");
          }

          const bufferSize = buffer.size;
          offset = Math.max(0, offset | 0);
          if (offset >= bufferSize) {
            throw new Error(`offset ${offset} is past the buffer size ${bufferSize}.`);
          }
          const maxRead = 16 * 1024 * 1024;
          let requested = (typeof size === "number" && size > 0) ? size : (bufferSize - offset);
          requested = Math.min(requested, bufferSize - offset);
          let truncated = null;
          if (requested > maxRead) {
            truncated = { byteLength: requested, capturedBytes: maxRead };
            requested = maxRead;
          }

          // copyBufferToBuffer requires 4-byte-aligned source offset and size, so
          // copy from an aligned offset and slice the requested window back out.
          const alignedOffset = offset & ~3;
          const pad = offset - alignedOffset;
          const avail = bufferSize - alignedOffset;
          let copySize = (requested + pad + 3) & ~3;
          if (copySize > avail) {
            copySize = avail & ~3;
          }
          const outSize = Math.max(0, Math.min(requested, copySize - pad));

          this.disableRecording();
          let readbackBuffer = null;
          try {
            readbackBuffer = device.createBuffer({
              size: Math.max(4, copySize),
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
              label: "READ BUFFER"
            });
            const encoder = device.createCommandEncoder();
            encoder.copyBufferToBuffer(buffer, alignedOffset, readbackBuffer, 0, copySize);
            device.queue.submit([encoder.finish()]);
            await readbackBuffer.mapAsync(GPUMapMode.READ);
            const mapped = new Uint8Array(readbackBuffer.getMappedRange());
            const bytes = mapped.slice(pad, pad + outSize);
            readbackBuffer.unmap();
            readbackBuffer.destroy();
            readbackBuffer = null;
            return { offset, byteLength: outSize, base64: encodeBase64(bytes), truncated };
          } finally {
            if (readbackBuffer) {
              try { readbackBuffer.destroy(); } catch (e) { /* ignore */ }
            }
            this.enableRecording();
          }
        }

        // Read a live GPU texture's current pixels (a region of one mip level / array
        // layer) without taking a full capture. Copies the region to a MAP_READ buffer
        // via copyTextureToBuffer, maps it, and returns the raw bytes as base64 plus the
        // layout needed to decode them (format, channels, bytesPerRow, region). Mirrors
        // readBuffer. All textures get COPY_SRC while a capture is armed, so render
        // targets (G-buffer, depth, canvas) are readable. Returns
        // { format, mipLevel, mipWidth, mipHeight, x, y, width, height, layer,
        //   bytesPerRow, channels, sampleType, base64 }.
        async readTexture(textureId, opts) {
          opts = opts || {};
          const texture = this._trackedObjects.get(textureId)?.deref();
          if (!texture) {
            throw new Error(`No live GPU texture with id ${textureId}.`);
          }
          if (texture.__destroyed) {
            throw new Error(`Texture ${textureId} has been destroyed.`);
          }
          const device = texture.__device;
          if (!device) {
            throw new Error(`Texture ${textureId} has no associated device.`);
          }
          if (!(texture.usage & GPUTextureUsage.COPY_SRC)) {
            throw new Error(`Texture ${textureId} lacks COPY_SRC usage and can't be read back. ` +
              "Textures created while a capture is armed are given COPY_SRC automatically.");
          }
          const format = texture.format;
          const info = TextureFormatInfo[format];
          if (!info || info.isCompressed) {
            throw new Error(`Texture format "${format}" is unsupported for readback (compressed/unknown).`);
          }
          const mipLevelCount = texture.mipLevelCount || 1;
          const mipLevel = Math.max(0, Math.min(opts.mipLevel | 0, mipLevelCount - 1));
          const mipW = Math.max(1, texture.width >> mipLevel);
          const mipH = Math.max(1, texture.height >> mipLevel);
          const x = Math.max(0, Math.min(opts.x | 0, mipW - 1));
          const y = Math.max(0, Math.min(opts.y | 0, mipH - 1));
          const maxDim = 1024; // cap the read region so the readback stays light
          let w = (typeof opts.width === "number" && opts.width > 0) ? opts.width : (mipW - x);
          let h = (typeof opts.height === "number" && opts.height > 0) ? opts.height : (mipH - y);
          w = Math.min(w, mipW - x, maxDim);
          h = Math.min(h, mipH - y, maxDim);
          const layer = Math.max(0, opts.layer | 0);
          const texel = info.bytesPerBlock;
          const bytesPerRow = (w * texel + 255) & ~0xff; // 256-byte row alignment
          const bufferSize = bytesPerRow * h;

          this.disableRecording();
          let readbackBuffer = null;
          try {
            readbackBuffer = device.createBuffer({
              size: Math.max(4, bufferSize),
              usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
              label: "READ TEXTURE"
            });
            const aspect = info.hasDepth ? "depth-only" : (info.hasStencil ? "stencil-only" : "all");
            const encoder = device.createCommandEncoder();
            encoder.copyTextureToBuffer(
              { texture, mipLevel, origin: { x, y, z: layer }, aspect },
              { buffer: readbackBuffer, bytesPerRow, rowsPerImage: h },
              { width: w, height: h, depthOrArrayLayers: 1 }
            );
            device.queue.submit([encoder.finish()]);
            await readbackBuffer.mapAsync(GPUMapMode.READ);
            const bytes = new Uint8Array(readbackBuffer.getMappedRange()).slice(0, bufferSize);
            readbackBuffer.unmap();
            readbackBuffer.destroy();
            readbackBuffer = null;
            return {
              format, mipLevel, mipWidth: mipW, mipHeight: mipH,
              x, y, width: w, height: h, layer, bytesPerRow,
              channels: info.channels, sampleType: info.sampleType,
              base64: encodeBase64(bytes)
            };
          } finally {
            if (readbackBuffer) {
              try { readbackBuffer.destroy(); } catch (e) { /* ignore */ }
            }
            this.enableRecording();
          }
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

              if (descriptor.vertex?.module === shader) {
                if (!newDescriptor) {
                  newDescriptor = this._duplicateObject(descriptor);
                }
                found = true;
                newDescriptor.vertex.module = newShaderModule;
              }
              if (descriptor.fragment?.module === shader) {
                if (!newDescriptor) {
                  newDescriptor = this._duplicateObject(descriptor);
                }
                found = true;
                newDescriptor.fragment.module = newShaderModule;
              }
              if (descriptor.compute?.module === shader) {
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
            // Devtools-panel captures keep full-resolution textures by default (the
            // texture viewer needs them); only cap if the panel explicitly asks.
            this._captureMaxTextureSize = (typeof this._captureData.maxTextureSize === "number")
              ? this._captureData.maxTextureSize
              : -1;
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
          } else if (method === "configure" && object instanceof GPUCanvasContext) {
            // Capture the WebGPU canvas context configuration so it can be inspected
            // in the devtools panel. There may be more than one canvas, and configure
            // can be called more than once on a context (e.g. on resize); the devtools
            // side updates the existing entry rather than duplicating it.
            if (object.__id === undefined) {
              this._wrapObject(object);
              this._trackObject(object.__id, object);
            }
            const id = object.__id;
            const descriptor = this._duplicateObject(args[0], true) ?? {};
            const canvas = object.canvas;
            if (canvas) {
              // Include the canvas element id, if one was set, to help identify which
              // canvas this context belongs to in the inspector panel.
              if (canvas.id) {
                descriptor.canvasId = canvas.id;
              }
              descriptor.width = canvas.width;
              descriptor.height = canvas.height;
            }
            let descriptorStr = null;
            try {
              descriptorStr = JSON.stringify(descriptor);
            } catch (e) {
              console.log(e.message);
            }
            // Parent the configuration to the device it was configured with.
            this._sendAddObjectMessage(id, args[0]?.device?.__id ?? 0, "CanvasContext", descriptorStr, stacktrace);
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
                // Always consume the dynamic offset for this entry, even if the cap
                // or scope filter drops the capture, so later entries stay aligned.
                let offset = be.baseOffset;
                if (be.hasDynamicOffset && mappedDynamicOffsets) {
                  offset = mappedDynamicOffsets[dynIdx++];
                }
                this._queueCaptureBuffer(object, commandId, be.entryIndex, be.buffer, offset, be.size);
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
              if (!buffer) ; else if (size > 0) {
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
            this._queueCaptureBuffer(object, commandId, slot, buffer, offset, size);
            this._updateStatusMessage();
          }

          if (method === "setIndexBuffer") {
            object.__indexBuffer = args;
            const buffer = args[0];
            const size = buffer.size;
            this._queueCaptureBuffer(object, commandId, 0, buffer, 0, size);
            this._updateStatusMessage();
          }

          if (method === "drawIndirect" || method === "drawIndexedIndirect" || method === "dispatchWorkgroupsIndirect") {
            const buffer = args[0];
            const offset = 0;
            const size = buffer.size;
            this._queueCaptureBuffer(object, commandId, 0, buffer, offset, size);
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
            result.__passType = "render";
            result.__passLabel = args[0]?.label || "";
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
            result.__passType = "compute";
            result.__passLabel = args[0]?.label || "";
            this._inComputePass = true;
          } else if (method === "end") {
            this._inComputePass = false;
            const commandEncoder = object.__commandEncoder;
            // Scoped capture: when a pass is filtered out, skip its heavy texture
            // payloads too. Buffer payloads were already gated at queue time.
            const captureThisPass = this._matchesCaptureScope(object);
            if (object.__captureBuffers?.length > 0) {
              this._recordCaptureBuffers(commandEncoder, object.__captureBuffers);
              object.__captureBuffers = [];
              this._updateStatusMessage();
            }

            if (captureThisPass && object.__captureRenderPassTextures?.size > 0) {
              let passId = this._frameRenderPassCount * maxColorAttachments;
              for (const captureTextureView of object.__captureRenderPassTextures) {
                const texture = captureTextureView.__texture;
                if (texture) {
                  this._captureTextureBuffer(commandEncoder?.__device, commandEncoder, texture, passId++);
                }
              }
              object.__captureRenderPassTextures.clear();
            }

            if (captureThisPass && object.__captureTextureViews?.size > 0) {
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
        // `originalSize` (optional, > 0 only when the buffer was truncated to the
        // capture cap) is the buffer's true byte length, recorded so the export can
        // mark the payload truncated.
        _sendBufferData(commandId, entryIndex, data, originalSize) {
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
              originalSize: originalSize || 0,
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
                self._sendBufferData(r.commandId, r.entryIndex, owned.subarray(r.offset, r.offset + r.size), r.originalSize);
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

        // Whether the active pass matches the scoped-capture filter. `passObject` is
        // the render/compute pass encoder carrying __passLabel/__passType (set in
        // beginRenderPass/beginComputePass). With no scope set, everything matches.
        _matchesCaptureScope(passObject) {
          const scope = this._captureScope;
          if (!scope) {
            return true;
          }
          if (scope.passType && passObject?.__passType && scope.passType !== passObject.__passType) {
            return false;
          }
          if (scope.passLabelRegex && !scope.passLabelRegex.test(passObject?.__passLabel || "")) {
            return false;
          }
          return true;
        }

        // Single choke point for queuing a buffer slice for capture. Applies the
        // per-capture size cap (truncating to the first `_captureMaxBufferSize`
        // bytes rather than dropping the buffer, so early vertices/indices are still
        // decodable) and the scoped-capture filter. When truncated, the original
        // size is recorded so the export can mark the payload. `passObject` is the
        // encoder the capture is attached to (also used for scope matching).
        _queueCaptureBuffer(passObject, commandId, entryIndex, buffer, offset, size) {
          if (!this._matchesCaptureScope(passObject)) {
            return;
          }
          let capturedSize = size;
          let originalSize = 0;
          const cap = this._captureMaxBufferSize;
          if (cap >= 0 && size > cap) {
            originalSize = size;
            capturedSize = cap;
          }
          if (capturedSize <= 0) {
            return;
          }
          if (!passObject.__captureBuffers) {
            passObject.__captureBuffers = [];
          }
          passObject.__captureBuffers.push({ commandId, entryIndex, buffer, offset, size: capturedSize, originalSize });
          this._captureBuffersCount++;
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
              originalSize: info.originalSize || 0,
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
                ranges[i - poolStart] = { commandId: p.commandId, entryIndex: p.entryIndex, offset: cur, size: p.size, originalSize: p.originalSize };
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
            // Capture the stencil aspect as stencil8. The format string must also be
            // updated so the mapped-buffer handler knows to convert the stencil bytes
            // to float data (see _stencilBufferToFloatData).
            format = "stencil8";
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
          // Texture size cap: skip capturing pixels for textures larger than the cap
          // to keep captures light (the texture's descriptor is still recorded). The
          // devtools-panel path leaves this uncapped so the texture viewer works.
          if (this._captureMaxTextureSize >= 0 && bufferSize > this._captureMaxTextureSize) {
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

      exports.webgpuInspector = new WebGPUInspector();

      // Expose the inspector instance on the global so a page that loaded
      // webgpu_inspector.js via a script tag (manual injection / CDN) can call
      // initialize(), beginFrameCapture(), endFrameCapture(), saveCaptureData(),
      // or initializeServer() for the Claude Code plugin live bridge.
      try {
        Object.defineProperty(_self, "webgpuInspector", {
          value: exports.webgpuInspector,
          writable: true,
          configurable: true
        });
      } catch (e) {
        _self.webgpuInspector = exports.webgpuInspector;
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
            const baseUrl = new _URL((document.currentScript && document.currentScript.tagName.toUpperCase() === 'SCRIPT' && document.currentScript.src || new URL('webgpu_inspector.js', document.baseURI).href));
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
            //
            // Messages posted by the parent while `await import(...)` is still
            // loading are NOT queued for the user's module: the worker's port
            // message queue is enabled when the initial evaluation suspends at the
            // first `await`, so those messages fire with no listener and are lost.
            // Apps that post a job to a worker right after constructing it (tile
            // decoders, bake workers, ...) would silently never get a response.
            // Buffer every message that arrives during the import and re-dispatch
            // once the user's module has installed its handlers.
            src += `
const __wgiQueuedMessages = [];
const __wgiBufferMessage = (e) => { __wgiQueuedMessages.push(e); };
self.addEventListener("message", __wgiBufferMessage);
await import(${JSON.stringify(_url.href)});
self.removeEventListener("message", __wgiBufferMessage);
for (const e of __wgiQueuedMessages) {
  self.dispatchEvent(new MessageEvent("message", { data: e.data, origin: e.origin, lastEventId: e.lastEventId, ports: [...e.ports] }));
}
__wgiQueuedMessages.length = 0;`;
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

    Object.defineProperty(exports, '__esModule', { value: true });

    return exports;

  }))({});

   }

  // WebGPU Inspector code is injected here by the npm rollup build process.

  const webgpuInspectorLoadedKey = "WEBGPU_INSPECTOR_LOADED";
  const webgpuInspectorCaptureFrameKey = "WEBGPU_INSPECTOR_CAPTURE_FRAME";
  // Set by content_script.js from the DevTools panel's "Inspect Workers"
  // setting. Tells the inspector whether to inject itself into Web Workers.
  const webgpuInspectorWorkersKey = "WEBGPU_INSPECTOR_WORKERS";

  // The Inspector doesn't start listening for WebGPU calls until it is instructed
  // to do so. Otherwise we would be adding ovearhead to all WebGPU applications
  // even when the inspector is not being used.

  // Check session storage to see if we should start the inspector.
  // This happens when you start the inspector from the devtools panel.
  // That action will set the session storage key and then reload the page.
  // When the page reloads we see the key here and start the inspector.
  const inspectMessage = sessionStorage.getItem(webgpuInspectorLoadedKey);
  if (inspectMessage) {
    // Defer removal until the window's load event. Same-origin iframes share
    // sessionStorage with the top frame: if the first loader to run removes
    // the key immediately, the other frames' loaders see null at their own
    // document_start and never start their inspectors. That in particular
    // breaks workers created in iframes, because the Worker proxy is only
    // installed once the inspector starts, so any worker spawned by the
    // iframe before that proxy is in place runs unpatched.
    //
    // By the time load fires, every frame's loader has already read the
    // value, so the cleanup is still complete in time to keep subsequent
    // navigations from auto-starting the inspector.
    window.addEventListener("load", () => {
      sessionStorage.removeItem(webgpuInspectorLoadedKey);
      sessionStorage.removeItem(webgpuInspectorWorkersKey);
    }, { once: true });

    if (inspectMessage !== "true") {
      sessionStorage.setItem(webgpuInspectorCaptureFrameKey, inspectMessage);
    }

    // webgpu_inspector.js reads this global when deciding whether to install its
    // Worker proxy. The DevTools panel's "Inspect Workers" setting controls it
    // (on by default). Manual <script>-tag injection never runs this loader, so
    // worker injection stays off for manual injection.
    self.__webgpuInspectorInspectWorkers =
      sessionStorage.getItem(webgpuInspectorWorkersKey) === "true";

    self.__webgpu_src = coreLoader;
    self.__webgpu_src();
  }

  if (window) {
    // Listen for a custom event to start the inspector. If we get the event
    // that instructs us to start inspection, then we start the inspector code.
    window.addEventListener("__WebGPUInspector", (event) => {
      const message = event.detail || event.data;
      if (typeof message !== "object" || !message.__webgpuInspector) {
        return;
      }
      if (message.action === "webgpu_inspector_start_inspection") {
        if (!self.__webgpu_src) {
          self.__webgpuInspectorInspectWorkers = !!message.inspectWorkers;
          self.__webgpu_src = coreLoader;
          self.__webgpu_src();
        }
      }
    });
  }

})();
//# sourceMappingURL=webgpu_inspector_loader.js.map
