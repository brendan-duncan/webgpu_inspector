var __webgpu_inspector_window = (function (exports) {
  'use strict';

  /**
   * A Signal is like a proxy function that can have multiple "listeners" assigned to it, such that
   * when the Signal is executed (or "emitted"), it executes each of its associated listeners.
   * A listener is a callback function, object method, or another Signal.
   *
   * Signals are used extensively throughout Loki3D. They are similar to Javascript events, with the
   * advantage of being bound to an object rather than a string, so they are very explicit about what
   * signals are provided and reduce errors from mis-spelling event names.
   * @category Util
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

  class GPUObject {
    constructor(id) {
      this.id = id;
      this.label = "";
      this.parent = null;
      this.children = [];
    }

    get name() {
      return this.label || this.constructor.name;
    }
  }

  class Adapter extends GPUObject {
    constructor(id, descriptor) {
      super(id);
      this.descriptor = descriptor;
    }
  }

  class Device extends GPUObject {
    constructor(id, descriptor) {
      super(id);
      this.descriptor = descriptor;
    }
  }

  class Buffer extends GPUObject {
    constructor(id, descriptor) {
      super(id);
      this.descriptor = descriptor;
    }
  }

  class Sampler extends GPUObject {
    constructor(id, descriptor) {
      super(id);
      this.descriptor = descriptor;
    }
  }

  class Texture extends GPUObject {
    constructor(id, descriptor) {
      super(id);
      this.descriptor = descriptor;
      this.imageData = null;
      this.loadedImageDataChunks = [];
      this.isImageDataLoaded = false;
    }

    get dimension() {
      return this.descriptor?.dimension ?? "2d";
    }

    get width() {
      const size = this.descriptor?.size;
      if (size instanceof Array && size.length > 0) {
        return size[0] ?? 0;
      } else if (size instanceof Object) {
        return size.width ?? 0;
      }
      return 0;
    }

    get height() {
      const size = this.descriptor?.size;
      if (size instanceof Array && size.length > 1) {
        return size[1] ?? 1;
      } else if (size instanceof Object) {
        return size.height ?? 1;
      }
      return 0;
    }

    get depthOrArrayLayers() {
      const size = this.descriptor?.size;
      if (size instanceof Array && size.length > 2) {
        return size[2] ?? 1;
      } else if (size instanceof Object) {
        return size.depthOrArrayLayers ?? 1;
      }
      return 0;
    }

    getGpuSize() {
      const format = this.descriptor?.format;
      const formatInfo = TextureFormatInfo[format];
      const width = this.width;
      if (!format || width <= 0 || !formatInfo) {
        return -1;
      }

      const height = this.height;
      const dimension = this.dimension;
      const blockWidth = width / formatInfo.blockWidth;
      const blockHeight = height / formatInfo.blockHeight;
      const bytesPerBlock = formatInfo.bytesPerBlock;

      if (dimension === "2d") {
        return blockWidth * blockHeight * bytesPerBlock;
      }

      // TODO other dimensions

      return -1;
    }
  }

  class TextureView extends GPUObject {
    constructor(id, descriptor) {
      super(id);
      this.descriptor = descriptor;
    }
  }

  class ShaderModule extends GPUObject {
    constructor(id, descriptor) {
      super(id);
      this.descriptor = descriptor;
      this.hasVertexEntries = descriptor?.code ? descriptor.code.indexOf("@vertex") != -1 : false;
      this.hasFragmentEntries = descriptor?.code ? descriptor.code.indexOf("@fragment") != -1 : false;
      this.hasComputeEntries = descriptor?.code ? descriptor.code.indexOf("@compute") != -1 : false;
    }
  }

  class BindGroupLayout extends GPUObject {
    constructor(id, descriptor) {
      super(id);
      this.descriptor = descriptor;
    }
  }

  class PipelineLayout extends GPUObject {
    constructor(id, descriptor) {
      super(id);
      this.descriptor = descriptor;
    }
  }

  class BindGroup extends GPUObject {
    constructor(id, descriptor) {
      super(id);
      this.descriptor = descriptor;
    }
  }

  class RenderPipeline extends GPUObject {
    constructor(id, descriptor) {
      super(id);
      this.descriptor = descriptor;
    }
  }

  class ComputePipeline extends GPUObject {
    constructor(id, descriptor) {
      super(id);
      this.descriptor = descriptor;
    }
  }

  class ObjectDatabase {
    constructor(port) {
      this.reset();

      this.onDeleteObject = new Signal();
      this.onResolvePendingObject = new Signal();
      this.onAddObject = new Signal();
      this.onBeginFrame = new Signal();
      this.onEndFrame = new Signal();
      this.onAdapterInfo = new Signal();
      this.onObjectLabelChanged = new Signal();

      this.totalTextureMemory = 0;
      this.totalBufferMemory = 0;

      const self = this;
      port.addListener((message) => {
        switch (message.action) {
          case "inspect_begin_frame":
            self._beginFrame();
            break;
          case "inspect_end_frame":
            self._endFrame();
            break;
          case "inspect_delete_object":
            self._deleteObject(message.id);
            break;
          case "inspect_resolve_async_object":
            self._resolvePendingObject(message.id);
            break;
          case "inspect_object_set_label":
            self._setObjectLabel(message.id, message.label);
            break;
          case "inspect_add_object": {
            const pending = !!message.pending;
            const id = message.id;
            const parent = message.parent;
            let descriptor = null;
            try {
              descriptor = message.descriptor ? JSON.parse(message.descriptor) : null;
            } catch (e) {
              break;
            }
            switch (message.type) {
              case "Adapter": {
                const obj = new Adapter(id, descriptor);
                self._addObject(obj, parent, pending);
                break;
              }
              case "Device": {
                const obj = new Device(id, descriptor);
                self._addObject(obj, parent, pending);
                break;
              }
              case "ShaderModule": {
                const obj = new ShaderModule(id, descriptor);
                self._addObject(obj, parent, pending);
                obj.size = descriptor?.code?.length ?? 0;
                break;
              }
              case "Buffer": {
                const obj = new Buffer(id, descriptor);
                self._addObject(obj, parent, pending);
                obj.size = descriptor?.size ?? 0;
                this.totalBufferMemory += obj.size;
                break;
              }
              case "Texture": {
                const prevTexture = self.textures.get(id);
                if (prevTexture) {
                  let size = prevTexture.getGpuSize();
                  if (size != -1) {
                    this.totalTextureMemory -= size;
                  }
                  prevTexture.descriptor = descriptor;
                  size = prevTexture.getGpuSize();
                  if (size != -1) {
                    this.totalTextureMemory += size;
                  }
                  return;
                }
                const obj = new Texture(id, descriptor);
                const size = obj.getGpuSize();
                if (size != -1) {
                  this.totalTextureMemory += size;
                }
                self._addObject(obj, parent, pending);
                break;
              }
              case "TextureView": {
                const prevView = self.textureViews.get(id);
                if (prevView) {
                  prevView.descriptor = descriptor;
                  return;
                }
                const obj = new TextureView(id, descriptor);
                self._addObject(obj, parent, pending);
                break;
              }
              case "Sampler": {
                const obj = new Sampler(id, descriptor);
                self._addObject(obj, parent, pending);
                break;
              }
              case "BindGroup": {
                const obj = new BindGroup(id, descriptor);
                self._addObject(obj, parent, pending);
                break;
              }
              case "BindGroupLayout": {
                const obj = new BindGroupLayout(id, descriptor);
                self._addObject(obj, parent, pending);
                break;
              }
              case "RenderPipeline": {
                const obj = new RenderPipeline(id, descriptor);
                self._addObject(obj, parent, pending);
                break;
              }
              case "ComputePipeline": {
                const obj = new ComputePipeline(id, descriptor);
                self._addObject(obj, parent, pending);
                break;
              }
              case "PipelineLayout": {
                const obj = new PipelineLayout(id, descriptor);
                self._addObject(obj, parent, pending);
                break;
              }
            }
            break;
          }
        }
      });
    }

    reset() {
      this.allObjects = new Map();
      this.adapters = new Map();
      this.devices = new Map();
      this.samplers = new Map();
      this.textures = new Map();
      this.textureViews = new Map();
      this.buffers = new Map();
      this.bindGroups = new Map();
      this.bindGroupLayouts = new Map();
      this.shaderModules = new Map();
      this.pipelineLayouts = new Map();
      this.renderPipelines = new Map();
      this.computePipelines = new Map();
      this.pendingRenderPipelines = new Map();
      this.pendingComputePipelines = new Map();
      this.frameTime = 0;
    }

    getObjectDependencies(object) {
      const dependencies = [];
      const id = object.id;

      if (object instanceof ShaderModule) {
        this.renderPipelines.forEach((rp) => {
          const descriptor = rp.descriptor;
          if (descriptor?.vertex?.module?.__id == id) {
            dependencies.push(rp);
          } else if (descriptor?.fragment?.module?.__id == id) {
            dependencies.push(rp);
          }
        });
        this.computePipelines.forEach((cp) => {
          const descriptor = cp.descriptor;
          if (descriptor?.compute?.module?.__id == id) {
            dependencies.push(cp);
          }
        });
      } else if (object instanceof Buffer || object instanceof Texture) {
        const isTexture = object instanceof Texture;
        this.bindGroups.forEach((bg) => {
          const entries = bg.descriptor?.entries;
          if (entries) {
            for (const entry of entries) {
              const resource = entry.resource;
              if (isTexture && resource instanceof String) {
                if (resource.__id == id) {
                  dependencies.push(bg);
                  break;
                }
              } else if (resource?.buffer) {
                const id = resource.buffer.__id;
                if (id == id) {
                  dependencies.push(bg);
                }
                break;
              }
            }
          }
        });
      }
      return dependencies;
    }

    _beginFrame() {
      this.startFrameTime = performance.now();
      this.onBeginFrame.emit();
    }

    _endFrame() {
      this.endFrameTime = performance.now();
      this.frameTime = this.endFrameTime - this.startFrameTime;
      this.onEndFrame.emit();
    }

    getObject(id) {
      return this.allObjects.get(id);
    }

    _setObjectLabel(id, label) {
      const object = this.getObject(id);
      if (object) {
        object.label = label;
        this.onObjectLabelChanged.emit(id, object, label);
      }
    }

    _addObject(object, parent, pending) {
      const id = object.id;
      this.allObjects.set(id, object);
      if (object instanceof Adapter) {
        this.adapters.set(id, object);
      } else if (object instanceof Device) {
        this.devices.set(id, object);
      } else if (object instanceof Sampler) {
        this.samplers.set(id, object);
      } else if (object instanceof Texture) {
        this.textures.set(id, object);
      } else if (object instanceof TextureView) {
        this.textureViews.set(id, object);
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

      if (parent) {
        const parentObject = this.getObject(parent);
        if (parentObject) {
          parentObject.children.push(object);
          object.parent = parentObject;
        }
      }

      this.onAddObject.emit(object, pending);
    }

    _resolvePendingObject(id) {
      const object = this.allObjects.get(id);
      if (object instanceof RenderPipeline) {
        this.pendingRenderPipelines.delete(id);
        this.renderPipelines.set(id, object);

        this.onResolvePendingObject.emit(id, object);
      } else if (object instanceof ComputePipeline) {
        this.pendingComputePipelines.delete(id);
        this.computePipelines.set(id, object);
      }
    }

    _deleteObject(id) {
      const object = this.allObjects.get(id);
      this.allObjects.delete(id);
      this.adapters.delete(id);
      this.devices.delete(id);
      this.samplers.delete(id);
      this.textures.delete(id);
      this.textureViews.delete(id);
      this.buffers.delete(id);
      this.bindGroups.delete(id);
      this.bindGroupLayouts.delete(id);
      this.shaderModules.delete(id);
      this.renderPipelines.delete(id);
      this.pipelineLayouts.delete(id);
      this.computePipelines.delete(id);
      this.pendingRenderPipelines.delete(id);
      this.pendingComputePipelines.delete(id);

      if (object) {
        if (object instanceof Texture) {
          const size = object.getGpuSize();
          if (size != -1) {
            this.totalTextureMemory -= size;
          }
        } else if (object instanceof Buffer) {
          const size = object.size;
          this.totalBufferMemory -= size ?? 0;
        }

        if (object.parent) {
          const parent = object.parent;
          const index = parent.children.indexOf(object);
          if (index != -1) {
            parent.children.splice(index, 1);
          }
        }

        if (object.children) {
          for (const child of object.children) {
            this._deleteObject(child.id);
          }
        }

        this.onDeleteObject.emit(id, object);
      }
    }
  }

  class MessagePort {
    constructor(name, tabId, listener) {
      this.name = name;
      this.tabId = tabId ?? 0;
      this.listeners = [];
      if (listener) {
        this.listeners.push(listener);
      }
      this._port = null;
      this.reset();
    }

    reset() {
      const self = this;
      this._port = chrome.runtime.connect({ name: this.name });
      this._port.onDisconnect.addListener(() => {
        self.reset();
      });
      this._port.onMessage.addListener((message) => {
        for (const listener of self.listeners) {
          listener(message);
        }
      });
    }

    addListener(listener) {
      this.listeners.push(listener);
    }

    postMessage(message) {
      if (this.tabId) {
        message.tabId = this.tabId;
      }
      this._port.postMessage(message);
    }
  }

  class Pointer {
    constructor(event) {
      this.event = event;
      this.pageX = event.pageX;
      this.pageY = event.pageY;
      this.clientX = event.clientX;
      this.clientY = event.clientY;
      this.id = event.pointerId;
      this.type = event.pointerType;
      this.buttons = event.buttons ?? -1;
    }

    getCoalesced() {
      return this.event.getCoalescedEvents().map((p) => new Pointer(p));
    }
  }

  /**
   * A Widget is a wrapper for a DOM element.
   */
  class Widget {
    constructor(element, parent, options) {
      this.id = `${this.constructor.name}${Widget.id++}`;
      if (element && element.constructor === String) {
        element = document.createElement(element);
      }

      this._element = element;
      if (element) {
        this._element.id = this.id;
        this._element.title = '';
      }

      if (parent && parent.constructor === Object) {
        options = parent;
        parent = null;
      }

      this._parent = null;
      this.hasFocus = false;
      this.mouseX = 0;
      this.mouseY = 0;
      this.mousePageX = 0;
      this.mousePageY = 0;
      this.children = [];

      this._mouseDownEnabled = false;
      this._mouseMoveEnabled = false;
      this._mouseUpEnabled = false;
      this._clickEnabled = false;
      this._contextMenuEnabled = false;
      this._doubleClickEnabled = false;
      this._mouseWheelEnabled = false;
      this._mouseOverEnabled = false;
      this._mouseOutEnabled = false;
      this._keyPressEnabled = false;
      this._keyReleaseEnabled = false;
      this._touchEventsEnabled = false;
      this._pointerEventsEnabled = false;
      this._isMouseDown = false;
      // The button that is down during the onMouseDown event.
      // This should be used during mouseMoveEvent, as MouseEvent.button isn't
      // going to work on anything but Chrome.
      this.mouseButton = -1;

      // Latest state of the tracked pointers.
      //this.currentPointers = [];

      this.enableContextMenuEvent();

      if (parent) {
        if (parent.constructor.isLayout) {
          const stretch = options && options.stretch ? options.stretch : 0;
          parent.add(this, stretch);
        } else {
          this.parent = parent;
        }
      }

      if (options) {
        this.configure(options);
      }

      if (this._element) {
        this._element.widget = this;
      }
    }

    configure(options) {
      if (options.id) {
        this._element.id = options.id;
      }

      if (options.class) {
        if (options.class.constructor === String) {
          this.classList.add(options.class);
        } else {
          this.classList.add(...options.class);
        }
      }

      if (options.text !== undefined) {
        this.text = options.text;
      }

      if (options.html !== undefined) {
        this.html = options.html;
      }

      if (options.style !== undefined) {
        this._element.style = options.style;
      }

      if (options.title !== undefined) {
        this._element.title = options.title;
      }

      if (options.backgroundColor !== undefined) {
        this._element.style.backgroundColor = options.backgroundColor;
      }

      if (options.color !== undefined) {
        this._element.style.color = options.color;
      }

      if (options.type !== undefined) {
        this._element.type = options.type;
      }

      if (options.children !== undefined) {
        for (const c of options.children) {
          this.appendChild(c);
        }
      }

      if (options.disabled !== undefined) {
        this._element.disabled = options.disabled;
      }

      if (options.tabIndex !== undefined) {
        this._element.tabindex = options.tabindex;
      }

      if (options.zIndex !== undefined) {
        this._element.style.zIndex = String(options.zIndex);
      }

      if (options.draggable !== undefined) {
        this.draggable = options.draggable;
      }

      if (options.onClick !== undefined) {
        this.addEventListener('click', options.onClick);
      }

      if (options.data !== undefined) {
        this.data = options.data;
      }

      if (options.tooltip !== undefined) {
        this.tooltip = options.tooltip;
      }
    }

    /**
     * @property {DOMElement?} element The HTML DOM element
     */
    get element() {
      return this._element;
    }

    /**
     * @property {Widget?} parent The parent widget of this widget.
     */
    get parent() {
      return this._parent;
    }

    set parent(p) {
      if (!p) {
        if (this._parent) {
          this._parent.removeChild(this);
          return;
        }
      } else {
        p.appendChild(this);
      }

      this.onResize();
    }

    /**
     * Insert a child widget before the given child widget.
     * @param {*} newChild
     * @param {*} refChild
     */
    insertBefore(newChild, refChild) {
      const index = this.children.indexOf(refChild);
      if (index === -1) {
        this.appendChild(newChild);
        return;
      }
      this.children.splice(index, 0, newChild);
      this._element.insertBefore(newChild._element, refChild._element);
    }

    /**
     * Add a child widget to this widget.
     * @param {Widget} child
     */
    appendChild(child) {
      if (child.parent === this) {
        return;
      }

      // Remove the widget from its current parent.
      if (child.parent) {
        child.parent.removeChild(child);
      }

      // Add the widget to the children list.
      child._parent = this;
      this.children.push(child);
      this._element.appendChild(child._element);

      const w = this.window;
      if (w) {
        child._addedToWindow(w);
      }

      child.onResize();
    }

    remove() {
      this.element.remove();
    }

    /**
     * Remove a child widget.
     * @param {Widget} child
     */
    removeChild(child) {
      const index = this.children.indexOf(child);
      if (index != -1) {
        this.children.splice(index, 1);
      }
      this._element.removeChild(child._element);
    }

    /**
     * Remove all children from this widget.
     */
    removeAllChildren() {
      this.children.length = 0;
      while (this._element.firstChild) {
        this._element.removeChild(this._element.lastChild);
      }
    }

    /**
     * Get the position of the element on the page.
     * @return {Array}
     */
    getPagePosition() {
      let lx = 0;
      let ly = 0;
      for (let el = this._element; el != null; el = el.offsetParent) {
        lx += el.offsetLeft;
        ly += el.offsetTop;
      }
      return [lx, ly];
    }

    /**
     * Parse out the value from a CSS string
     * @param {*} cssValue
     */
    static getCssValue(cssValue) {
      if (!cssValue) {
        cssValue = '0px';
      }
      if (cssValue.endsWith('%')) {
        cssValue = cssValue.substring(0, cssValue.length - 1);
      } else {
        cssValue = cssValue.substring(0, cssValue.length - 2);
      }
      if (cssValue.includes('.')) {
        return parseFloat(cssValue);
      }
      return parseInt(cssValue);
    }

    /**
     * Return the size of a CSS property, like "padding", "Left", "Right"
     * @param {*} style
     * @param {*} property
     * @param {*} d1
     * @param {*} d2
     */
    static getStyleSize(style, property, d1, d2) {
      const s1 = Widget.getCssValue(style[`${property}${d1}`]);
      const s2 = Widget.getCssValue(style[`${property}${d2}`]);
      return s1 + s2;
    }

    /**
     * @property {number} width The width of the widget.
     */
    get width() {
      return this._element.offsetWidth;
    }

    /**
     * @property {number} height The height of the widget.
     */
    get height() {
      return this._element.offsetHeight;
    }

    /**
     * Get the bounding rect of the widget.
     * @return {DOMRect}
     */
    getBoundingClientRect() {
      return this._element.getBoundingClientRect();
    }

    /**
     * @property {bool} visible Is the element visible?
     */
    get visible() {
      let e = this;
      while (e) {
        if (e._element.style.display == 'none') {
          return false;
        }
        e = e.parent;
      }
      return true;
    }

    onDomChanged() {}

    domChanged() {
      this.onDomChanged();
      for (const c of this.children) {
        c.domChanged();
      }
    }

    /**
     * @property {number} left The x position of the element.
     */
    get left() {
      return this._element ? this._element.offsetLeft : 0;
    }

    /**
     * @property {number} top The y position of the element.
     */
    get top() {
      return this._element ? this._element.offsetTop : 0;
    }

    /**
     * Set the position of the element.
     */
    setPosition(x, y, type) {
      type = type || 'absolute';
      this._element.style.position = type;
      this._element.style.left = `${x}px`;
      this._element.style.top = `${y}px`;
    }

    /**
     * Resize the element.
     */
    resize(w, h) {
      // style.width/height is only for the inner contents of the widget,
      // not the full size of the widget including border and padding.
      // Since the resize function wants to encompass the entire widget,
      // we need to subtract the border and padding sizes from the size set
      // to the style.
      const rect = this.getBoundingClientRect();
      const dx = this._element.offsetWidth - rect.width;
      const dy = this._element.offsetHeight - rect.height;
      this._element.style.width = `${w - dx}px`;
      this._element.style.height = `${h - dy}px`;
    }

    onResize() {
      for (const c of this.children) {
        c.onResize();
      }
    }

    /**
     * @property {String} style The CSS style of the element.
     */
    get style() {
      return this._element.style;
    }

    set style(v) {
      this._element.style = v;
    }

    /**
     * @property {Array} classList The CSS class set of the element.
     */
    get classList() {
      return this._element.classList;
    }

    /**
     * @property {String} text The inner text of the element.
     */
    get text() {
      return this._element.innerText;
    }

    set text(s) {
      this._element.innerText = s;
    }

    get textContent() {
      return this._element.textContent;
    }

    set textContent(s) {
      this._element.textContent = s;
    }

    get html() {
      return this._element.innerHTML;
    }

    set html(v) {
      this._element.innerHTML = v;
    }

    get title() {
      return this._element.title;
    }

    set title(v) {
      this._element.title = v;
    }

    get tooltip() {
      return this._element.title;
    }

    set tooltip(v) {
      this._element.title = v;
    }

    get disabled() {
      return this._element.disabled;
    }

    set disabled(v) {
      this._element.disabled = v;
    }

    get dataset() {
      return this._element.dataset;
    }

    get tabIndex() {
      return this._element.tabindex;
    }

    set tabIndex(v) {
      this._element.tabIndex = v;
    }

    get zIndex() {
      return parseInt(this._element.style.zorder);
    }

    set zIndex(v) {
      this._element.style.zorder = String(v);
    }

    get draggable() {
      return this._element.draggable;
    }

    set draggable(v) {
      this._element.draggable = v;
      if (v) {
        this._dragStartEvent = this.dragStartEvent.bind(this);
        this._dragEndEvent = this.dragEndEvent.bind(this);
        this._dragEvent = this.dragEvent.bind(this);
        this.addEventListener('drag', this._dragEvent);
        this.addEventListener('dragstart', this._dragStartEvent);
        this.addEventListener('dragend', this._dragEndEvent);
      } else {
        if (this._dragEvent) {
          this.removeEventListener('drag', this._dragEvent);
          this.removeEventListener('dragstart', this._dragStartEvent);
          this.removeEventListener('dragend', this._dragEndEvent);
        }
      }
    }

    querySelector() {
      return this._element.querySelector(...arguments);
    }

    addEventListener() {
      return this._element.addEventListener(...arguments);
    }

    removeEventListener() {
      return this._element.removeEventListener(...arguments);
    }

    dispatchEvent() {
      return this._element.dispatchEvent(...arguments);
    }

    /**
     * Repaint the widget.
     * @param {bool} allDecendents
     */
    repaint(allDecendents = true) {
      if (this.paintEvent) this.paintEvent();
      if (allDecendents) {
        for (const c of this.children) {
          c.repaint(allDecendents);
        }
      }
    }

    _startResize() {
      if (this.startResize) {
        this.startResize();
      }
      for (const c of this.children) {
        c._startResize();
      }
    }

    _addedToWindow(w) {
      if (this.onAddedToWindow) {
        this.onAddedToWindow(w);
      }
      for (const c of this.children) {
        c._addedToWindow(w);
      }
    }

    get window() {
      return Widget.window;
    }

    /**
     * Start listening for mousePressEvent, mouseMoveEvent, and mouseReleaseEvent.
     */
    enableMouseEvents() {
      if (!this._mouseDownEnabled && this._element) {
        this._mouseDownEnabled = true;
        this._element.addEventListener('mousedown', this._onMouseDown.bind(this));
      }
      if (!this._mouseMoveEnabled && this._element) {
        this.__mouseMoveEnabled = true;
        this._element.addEventListener('mousemove', this._onMouseMove.bind(this));
      }
      if (!this._mouseUpEnabled && this._element) {
        this._mouseUpEnabled = true;
        this._element.addEventListener('mouseup', this._onMouseUp.bind(this));
      }
    }

    /**
     * Start listening for mouseMoveEvent.
     */
    enableMouseMoveEvent() {
      if (!this._mouseMoveEnabled && this._element) {
        this.__mouseMoveEnabled = true;
        this._element.addEventListener('mousemove', this._onMouseMove.bind(this));
      }
    }

    /**
     * Start listening for ContextMenu events.
     */
    enableContextMenuEvent() {
      this.enableMouseMoveEvent();
      if (!this._contextMenuEnabled && this._element) {
        this._contextMenuEnabled = true;
        this._element.addEventListener(
          'contextmenu',
          this._onContextMenu.bind(this)
        );
      }
    }

    /**
     * Start listenening for Click events.
     */
    enableClickEvent() {
      if (!this._clickEnabled && this._element) {
        this.__clickEnabled = true;
        this._element.addEventListener('click', this._onClick.bind(this));
      }
    }

    /**
     * Start listening for DoubleClick events.
     */
    enableDoubleClickEvent() {
      //this.enableMouseMoveEvent();
      if (!this._doubleClickEnabled && this._element) {
        this._doubleClickEnabled = true;
        this._element.addEventListener(
          'dblclick',
          this._onDoubleClick.bind(this)
        );
      }
    }

    /**
     * Start listening for MouseWheel events.
     */
    enableMouseWheelEvent() {
      if (!this._mouseWheelEnabled && this._element) {
        this._mouseWheelEnabled = true;
        this._element.addEventListener(
          'mousewheel',
          this._onMouseWheel.bind(this)
        );
      }
    }

    /**
     * Start listening for when the mouse enters the widget.
     */
    enableEnterEvent() {
      this.enableMouseMoveEvent();
      if (!this._mouseOverEnabled && this._element) {
        this._mouseOverEnabled = true;
        this._element.addEventListener('mouseover', this._onMouseOver.bind(this));
      }
    }

    /**
     * Start listening for when the mouse leaves the widget.
     */
    enableLeaveEvent() {
      this.enableMouseMoveEvent();
      if (!this._mouseOutEnabled && this._element) {
        this._mouseOutEnabled = true;
        this._element.addEventListener('mouseout', this._onMouseOut.bind(this));
      }
    }

    /**
     * Enable listening for touch events.
     */
    enableTouchEvents() {
      if (!this._touchEventsEnabled) {
        this._touchEventsEnabled = true;
        this._element.addEventListener(
          'touchstart',
          this._onTouchStart.bind(this)
        );
        this._element.addEventListener('touchend', this._onTouchEnd.bind(this));
        this._element.addEventListener(
          'touchcancel',
          this._onTouchCancel.bind(this)
        );
        this._element.addEventListener('touchmove', this._onTouchMove.bind(this));
        // Without this, Android Chrome will hijack touch events.
        this.style.touchAction = 'none';
      }
    }

    enablePointerEvents(bindToWindow) {
      if (!this._pointerEventsEnabled) {
        this._pointerEventsEnabled = true;
        this._element.addEventListener(
          'pointerdown',
          this._onPointerDown.bind(this)
        );
        if (bindToWindow) {
          window.addEventListener('pointermove', this._onPointerMove.bind(this));
          window.addEventListener('pointerup', this._onPointerUp.bind(this));
        } else {
          this._element.addEventListener(
            'pointermove',
            this._onPointerMove.bind(this)
          );
          this._element.addEventListener(
            'pointerup',
            this._onPointerUp.bind(this)
          );
        }
        // Without this, Android Chrome will hijack touch events.
        this.style.touchAction = 'none';
      }
    }

    _onPointerDown(e) {
      this.hasFocus = true;
      const pointer = new Pointer(e);
      if (Widget.currentPointers.some((p) => p.id === pointer.id)) return;
      Widget.currentPointers.push(pointer);
      //this.element.setPointerCapture(e.pointerId);
      const res = this.pointerDownEvent(e, Widget.currentPointers, pointer);
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    releasePointers() {
      //for (let p of Widget.currentPointers)
      //this.element.releasePointerCapture(p.id);
      Widget.currentPointers.length = 0;
    }

    _onPointerMove(e) {
      const pointer = new Pointer(e);

      const index = Widget.currentPointers.findIndex((p) => p.id === pointer.id);
      if (index !== -1) Widget.currentPointers[index] = pointer;

      this.hasFocus = true;
      const res = this.pointerMoveEvent(e, Widget.currentPointers, pointer);
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    _onPointerUp(e) {
      const pointer = new Pointer(e);
      //if (Widget.currentPointers.some((p) => p.id === pointer.id))
      //this.element.releasePointerCapture(e.pointerId);
      const index = Widget.currentPointers.findIndex((p) => p.id === pointer.id);
      if (index != -1) {
        Widget.currentPointers.splice(index, 1);
      }

      this.hasFocus = true;
      const res = this.pointerUpEvent(e, Widget.currentPointers, pointer);
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    pointerDownEvent() {
      return true;
    }

    pointerMoveEvent() {
      return true;
    }

    pointerUpEvent() {
      return true;
    }

    /**
     * Start listening for KeyPress events.
     */
    enableKeyPressEvent() {
      this.enableEnterEvent();
      this.enableLeaveEvent();
      this.enableMouseMoveEvent();
      if (!this._keyPressEnabled) {
        this._keyPressEnabled = true;
        // key events seem to only work on the document level. That's
        // why we enable enter/leave events, to filter the events to only
        // accept events for the widget if the mouse is over the widget.
        document.addEventListener('keydown', this._onKeyPress.bind(this));
        //this.element.addEventListener("keydown", this._onKeyPress.bind(this));
      }
    }

    /**
     * Start listening for KeyRelease events.
     */
    enableKeyReleaseEvent() {
      this.enableEnterEvent();
      this.enableLeaveEvent();
      this.enableMouseMoveEvent();
      if (!this._keyReleaseEnabled) {
        this._keyReleaseEnabled = true;
        // key events seem to only work on the document level. That's
        // why we enable enter/leave events, to filter the events to only
        // accept events for the widget if the mouse is over the widget.
        document.addEventListener('keyup', this._onKeyRelease.bind(this));
        //this.element.addEventListener("keyup", this._onKeyRelease.bind(this));
      }
    }

    /**
     * Event called when the widget is to be drawn
     */
    //paintEvent() { }

    /**
     * Event called when a mouse button is pressed on the wdiget.
     */
    mousePressEvent() {
      return false;
    }

    /**
     * Event called when the mouse is moved over the widget.
     * @param {*} e
     */
    mouseMoveEvent(e) {
      this.updatePositionFromEvent(e);
      return false;
    }

    /**
     * Event called when a mouse button is released over the widget.
     */
    mouseReleaseEvent() {
      return false;
    }

    /**
     * Event called when the widget recieves a ContextMenu event, usually from
     * the right mouse button.
     */
    contextMenuEvent() {
      return true;
    }

    /**
     * Event called when a mouse button is clicked.
     */
    clickEvent() {
      return true;
    }

    /**
     * Event called when a mouse button is double clicked.
     */
    doubleClickEvent() {
      return true;
    }

    /**
     * Event called when a mouse wheel is scrolled.
     */
    mouseWheelEvent() {
      return true;
    }

    /**
     * Event called when the mouse enters the widget.
     */
    enterEvent() {
      return true;
    }

    /**
     * Event called when the mouse leaves the widget.
     */
    leaveEvent() {
      return true;
    }

    /**
     * Event called when a key is pressed on the widget.
     */
    keyPressEvent() {
      return true;
    }

    /**
     * Event called when a key is released on the widget.
     */
    keyReleaseEvent() {
      return true;
    }

    /**
     * Event called when a touch has started.
     */
    touchStartEvent() {}

    /**
     * Event called when a touch has ended.
     */
    touchEndEvent() {}

    /**
     * Event called when a touch has been canceled.
     */
    touchCancelEvent() {}

    /**
     * Event called when a touch has moved.
     */
    touchMoveEvent() {}

    /**
     * Event called when the element starts dragging.
     */
    dragStartEvent() {}

    /**
     * Event called when the element ends dragging.
     */
    dragEndEvent() {}

    /**
     * Event called when the element is dragging.
     */
    dragEvent() {}

    /**
     * Called to update the current tracked mouse position on the widget.
     * @param {Event} e
     */
    updatePositionFromEvent(e) {
      if (!this._element) {
        return;
      }

      if (this.startMouseEvent) {
        e.targetX = Math.max(
          0,
          Math.min(
            this.element.clientWidth,
            this.startMouseX + e.pageX - this.startMouseEvent.pageX
          )
        );

        e.targetY = Math.max(
          0,
          Math.min(
            this.element.clientHeight,
            this.startMouseY + e.pageY - this.startMouseEvent.pageY
          )
        );
      } else {
        e.targetX = e.offsetX;
        e.targetY = e.offsetY;
      }

      this.mouseX = e.offsetX;
      this.mouseY = e.offsetY;
      this.mousePageX = e.clientX;
      this.mousePageY = e.clientY;

      if (e.movementX === undefined) {
        e.movementX = e.clientX - this.lastMouseX;
        e.movementY = e.clientY - this.lastMouseY;
      }

      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
    }

    /**
     * Event called when the mouse is pressed on the widget.
     * @param {Event} e
     */
    _onMouseDown(e) {
      this.startMouseEvent = e;
      this.startMouseX = e.offsetX;
      this.startMouseY = e.offsetY;
      this.lastMouseX = e.clientX;
      this.lastMouseY = e.clientY;
      this.updatePositionFromEvent(e);
      this._isMouseDown = true;
      this.mouseButton = e.button;
      const res = this.mousePressEvent(e);
      // If true is returned, prevent the event from propagating up and capture the mouse.
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
        //this.beginMouseCapture();
      }
      return res;
    }

    /**
     * Event called when the mouse moves on the widget.
     * @param {Event} e
     */
    _onMouseMove(e) {
      this.updatePositionFromEvent(e);
      return this.mouseMoveEvent(e);
    }

    /**
     * Event called when the mosue is released on the widget.
     * @param {Event} e
     */
    _onMouseUp(e) {
      this.updatePositionFromEvent(e);
      this.startMouseEvent = null;
      if (!this._isMouseDown) {
        return true;
      }

      this._isMouseDown = false;
      const res = this.mouseReleaseEvent(e);

      // if false is returned, prevent the event from propagating up.
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }

      //this.endMouseCapture();
      return res;
    }

    /**
     * Called for a ContextMenu event.
     * @param {Event} e
     */
    _onContextMenu(e) {
      const res = this.contextMenuEvent(e);
      // if false is returned, prevent the event from propagating up.
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
      return false;
    }

    /**
     * Called fora  Click event.
     * @param {Event} e
     */
    _onClick(e) {
      const res = this.clickEvent(e);
      // if false is returned, prevent the event from propagating up.
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    /**
     * Called for a DoubleClick event.
     * @param {Event} e
     */
    _onDoubleClick(e) {
      const res = this.doubleClickEvent(e);
      // if false is returned, prevent the event from propagating up.
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    /**
     * Called for mouseWheel event.
     * @param {Event} e
     */
    _onMouseWheel(e) {
      if (e.type === 'wheel') {
        e.wheel = -e.deltaY;
      } else {
        // in firefox deltaY is 1 while in Chrome is 120
        e.wheel = e.wheelDeltaY != null ? e.wheelDeltaY : e.detail * -60;
      }

      // from stack overflow
      // firefox doesnt have wheelDelta
      e.delta =
        e.wheelDelta !== undefined
          ? e.wheelDelta / 40
          : e.deltaY
          ? -e.deltaY / 3
          : 0;

      const res = this.mouseWheelEvent(e);

      // if false is returned, prevent the event from propagating up.
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    /**
     * Called for a MouseOver event.
     * @param {Event} e
     */
    _onMouseOver(e) {
      this.hasFocus = true;
      const res = this.enterEvent(e);
      // if false is returned, prevent the event from propagating up.
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    /**
     * Called for a MouseOut event.
     * @param {Event} e
     */
    _onMouseOut(e) {
      this.hasFocus = false;
      const res = this.leaveEvent(e);
      // if false is returned, prevent the event from propagating up.
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    /**
     * Called for a KeyPress event.
     * @param {Event} e
     */
    _onKeyPress(e) {
      if (!this.hasFocus) {
        return;
      }
      const res = this.keyPressEvent(e);
      // if false is returned, prevent the event from propagating up.
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    /**
     * Called for a KeyRelease event.
     * @param {Event} e
     */
    _onKeyRelease(e) {
      if (!this.hasFocus) {
        return;
      }
      const res = this.keyReleaseEvent(e);
      // if false is returned, prevent the event from propagating up.
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    /**
     * Called for a touchstart event.
     * @param {Event} e
     */
    _onTouchStart(e) {
      this.hasFocus = true;
      const res = this.touchStartEvent(e);
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    /**
     * Called for a touchend event.
     * @param {Event} e
     */
    _onTouchEnd(e) {
      this.hasFocus = true;
      const res = this.touchEndEvent(e);
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    /**
     * Called for a touchcancel event.
     * @param {Event} e
     */
    _onTouchCancel(e) {
      this.hasFocus = true;
      const res = this.touchCancelEvent(e);
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    /**
     * Called for a touchmove event.
     * @param {Event} e
     */
    _onTouchMove(e) {
      this.hasFocus = true;
      const res = this.touchMoveEvent(e);
      if (!res) {
        e.stopPropagation();
        e.preventDefault();
      }
    }

    trigger(eventName, params) {
      const event = new CustomEvent(eventName, {
        bubbles: true,
        cancelable: true,
        detail: params,
      });

      if (this.dispatchEvent) {
        this.dispatchEvent(event);
      }

      return event;
    }

    disableDropEvents() {
      if (!this._onDragEvent) {
        return;
      }

      this.removeEventListener('dragenter', this._onDragEvent);
      this.removeEventListener('drop', this._onDropEvent);
      this.addEventListener('dragleave', this._onDragEvent);
      this.addEventListener('dragover', this._onDragEvent);
      this.addEventListener('drop', this._onDropEvent);

      this._onDragEvent = null;
      this._onDropEvent = null;
    }

    enableDropEvents() {
      if (this._onDragEvent) {
        return;
      }

      this._onDragEvent = this.onDragEvent.bind(this);
      this._onDropEvent = this.onDropEvent.bind(this);

      this.addEventListener('dragenter', this._onDragEvent);
    }

    onDragEvent(event) {
      const element = this.element;

      if (event.type == 'dragenter') {
        element.addEventListener('dragleave', this._onDragEvent);
        element.addEventListener('dragover', this._onDragEvent);
        element.addEventListener('drop', this._onDropEvent);
      }
      if (event.type == 'dragenter' && this.dragEnterEvent) {
        this.dragEnterEvent(event);
      }
      if (event.type == 'dragleave' && this.dragLeaveEvent) {
        this.dragLeaveEvent(event);
      }
      if (event.type == 'dragover' && this.dragOverEvent) {
        this.dragOverEvent(event);
      }
    }

    onDropEvent(event) {
      this.removeEventListener('dragleave', this._onDragEvent);
      this.removeEventListener('dragover', this._onDragEvent);
      this.removeEventListener('drop', this._onDropEvent);

      if (this.dropEvent) {
        this.dropEvent(event);
      }
    }
  }

  Widget.window = null;
  Widget.currentPointers = [];
  Widget.disablePaintingOnResize = false;
  Widget.id = 0;

  /**
   * A generic DIV element, usually used as a container for other widgets.
   */
  class Div extends Widget {
    constructor(parent, options) {
      super('div', parent, options);
    }
  }

  Div._idPrefix = 'DIV';

  /**
   * The handle widget for a tab panel.
   */
  class TabHandle extends Div {
    constructor(title, page, parentWidget, parent, options) {
      super(parent);

      this.title = title;
      this.page = page;
      this.parentWidget = parentWidget;

      this.classList.add('tab-handle', 'disable-selection');

      this.textElement = new Div(this, {
        class: 'tab-handle-text',
        text: title,
      });

      this.draggable = true;

      this.enableMouseEvents();
      this.enableDoubleClickEvent();

      this.configure(options);

      this.enableDropEvents();
    }

    dragStartEvent() {
      TabHandle.DragWidget = this;
    }

    dragEndEvent() {
      TabHandle.DragWidget = null;
    }

    dragOverEvent(e) {
      if (!TabHandle.DragWidget) return;

      if (
        e.srcElement.classList.contains('tab-handle') &&
        this !== TabHandle.DragWidget
      ) {
        if (e.layerX < this.width * 0.5) {
          e.preventDefault();
          this.style.borderRight = '';
          this.style.borderLeft = '4px solid #fff';
        } else {
          e.preventDefault();
          this.style.borderLeft = '';
          this.style.borderRight = '4px solid #fff';
        }
      }
    }

    dropEvent(e) {
      this.style.borderLeft = '';
      this.style.borderRight = '';
      if (e.srcElement.classList.contains('tab-handle')) {
        if (e.layerX < this.width * 0.5) {
          console.log('Insert Before');
        } else {
          console.log('Insert After');
        }
      }
    }

    dragEnterEvent() {
      this.style.borderLeft = '';
      this.style.borderRight = '';
    }

    dragLeaveEvent() {
      this.style.borderLeft = '';
      this.style.borderRight = '';
    }

    configure(options) {
      if (!options) return;
      super.configure(options);
      if (options.displayCloseButton) {
        this.closeButton = new Div(this, {
          class: 'tab-handle-close-button',
        });

        // Set the close button text
        const closeIcon = 'icon-remove-sign';
        this.closeButton.element.innerHTML = `<i class="${closeIcon}">x</i>`;
      }
    }

    /**
     * Is this tab currently active?
     */
    get isActive() {
      return this.classList.contains('tab-handle-selected');
    }

    /**
     * Set the active state of the tab (does not affect other tabs, which should
     * be set as inactive).
     */
    set isActive(a) {
      if (a == this.isActive) {
        return;
      }

      if (a) {
        this.classList.add('tab-handle-selected');
        this.page.style.display = 'block';
        this.style.zIndex = '10';
      } else {
        this.classList.remove('tab-handle-selected');
        this.page.style.display = 'none';
        this.style.zIndex = '0';
      }
    }

    mousePressEvent(e) {
      this.parentWidget.setHandleActive(this);
    }

    doubleClickEvent() {
      this.maximizePanel();
    }

    maximizePanel() {
      Widget.window.maximizePanelToggle(this.title, this.page.panel);
    }
  }

  TabHandle._idPrefix = 'TAB';

  /**
   * A single content area with multiple panels, each associated with a header in a list.
   */
  class TabPage extends Div {
    constructor(panel, parent, options) {
      super(parent, options);
      this.classList.add('tab-page');
      this.style.display = 'none';
      this.panel = panel;
      if (panel) {
        panel.parent = this;
        //panel.style.width = '100%';
      }
    }
  }

  TabPage._idPrefix = 'TABPAGE';
  TabPage.isTabPage = true;

  /**
   * A TabWidget has multiple children widgets, only one of which is visible at a time. Selecting
   * the active child is done via a header of tab handles.
   */
  class TabWidget extends Div {
    constructor(parent, options) {
      super(parent);

      this._activeTab = -1;
      this.displayCloseButton = false;

      this._element.classList.add('tab-widget');

      this.headerElement = new Div(this);
      this.headerElement.classList.add('tab-header');

      this.iconsElement = new Div(this.headerElement);
      this.iconsElement.classList.add('tab-icons');

      this.tabListElement = new Div(this.headerElement);
      this.tabListElement.classList.add('tab-handle-list-container');

      this.contentElement = new Div(this);
      this.contentElement.classList.add('tab-content');
      this.contentElement.style.height = `calc(100% - ${this.headerElement.height}px)`;

      if (options) {
        this.configure(options);
      }
    }

    configure(options) {
      super.configure(options);

      if (options.displayCloseButton !== undefined) {
        this.displayCloseButton = options.displayCloseButton;
      }

      if (options.tabs !== undefined) {
        for (const tab of options.tabs) {
          this.addTab(tab.label, tab.contents);
        }
      }
    }

    /**
     * Remove all of the icons.
     */
    clearIcons() {
      this.iconsElement.children.length = 0;
    }

    /**
     * Add a tab.
     * @param {String} label
     * @param {Widget} panel
     */
    addTab(label, panel) {
      panel._tabLabel = label;
      const page = new TabPage(panel, this.contentElement);
      const handle = new TabHandle(label, page, this, this.tabListElement, {
        displayCloseButton: this.displayCloseButton,
      });

      if (this.tabListElement.children.length == 1) {
        this._activeTab = 0;
        handle.isActive = true;
        if (page) {
          page.repaint(true);
        }
      }

      panel.domChanged();
    }

    /**
     * @property {number} numTabs Return the number of tabs.
     */
    get numTabs() {
      return this.tabListElement.children.length;
    }

    /**
     * @property {number} activeTab Get the index of the active tab.
     */
    get activeTab() {
      return this._activeTab;
    }

    /**
     * Set the current active tab.
     */
    set activeTab(index) {
      if (index < 0 || index > this.tabListElement.children.length) {
        return;
      }

      for (let i = 0, l = this.tabListElement.children.length; i < l; ++i) {
        const handle = this.tabListElement.children[i];
        handle.isActive = i == index;
      }

      this._activeTab = index;

      const page = this.contentElement.children[this._activeTab].children[0];
      if (page) {
        page.repaint(true);
      }
    }

    isPanelVisible(panel) {
      for (let i = 0, l = this.numTabs; i < l; ++i) {
        const h = this.tabListElement.children[i];
        const p = h.page.children[0];
        if (panel === p) return this._activeTab == i;
      }
      return false;
    }

    setActivePanel(panel) {
      for (let i = 0, l = this.numTabs; i < l; ++i) {
        const h = this.tabListElement.children[i];
        const p = h.page.children[0];
        if (panel === p) this.activeTab = i;
      }
    }

    /**
     * Set the tab with the given [handle] has active.
     * @param {TabHandle} handle
     */
    setHandleActive(handle) {
      for (let i = 0, l = this.numTabs; i < l; ++i) {
        const h = this.tabListElement.children[i];
        if (h === handle) this.activeTab = i;
      }
    }

    /**
     * Find the TabWidget that contains the given widget, if any.
     * If a TabWidget is found, then an array with the tab wiget and the actual tab panel
     * is returned.
     * @param {Widget} panel
     * @return {Array?}
     */
    static findParentTabWidget(panel) {
      let p = panel._parent;
      while (p) {
        if (p.constructor.isTabPage) {
          return [p._parent._parent, p];
        }
        p = p._parent;
      }
      return null;
    }
  }

  TabWidget._idPrefix = 'TABWIDGET';

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

  /**
   * A window widget fills the entire browser window. It will resize with the
   * browser. A Window can have an Overlay, which is a [Widget] that will be
   * resized to fill the entire window, and can be used to create full screen
   * modal editors.
   */
  class Window extends Widget {
    constructor(options) {
      super(document.body, options);
      this._overlay = null;
      this._onResizeCB = this.windowResized.bind(this);
      window.addEventListener('resize', this._onResizeCB);
      this.onWindowResized = new Signal();
      Widget.window = this;
    }

    windowResized() {
      this._onResize(window.innerWidth, window.innerHeight);
    }

    /**
     * @property {number} width The width of the widget.
     */
    get width() {
      return window.innerWidth;
    }

    /**
     * @property {number} heihgt The height of the widget.
     */
    get height() {
      return window.innerHeight;
    }

    /**
     * @property {Widget?} overlay The active overlay widget, which covers the entire window
     * temporarily.
     */
    get overlay() {
      return this._overlay;
    }

    set overlay(v) {
      if (this._overlay === v) {
        return;
      }

      if (this._overlay !== null) {
        this._element.removeChild(this._overlay._element);
      }

      this._overlay = v;

      if (this._overlay) {
        this._element.appendChild(this._overlay._element);
        this._overlay.setPosition(0, 0, 'absolute');
        this._overlay.resize(window.innerWidth, window.innerHeight);
      }
    }

    /**
     * The widget has been resized.
     * @param {number} width
     * @param {number} height
     */
    _onResize(width, height) {
      this.onWindowResized.emit();
      this.repaint();
      if (this._element) {
        if (this._overlay) {
          this._overlay.resize(width, height);
        }
      }
      this.onResize();
    }
  }

  Window.isWindow = true;
  Window._idPrefix = 'WINDOW';

  class Button extends Widget {
    constructor(parent, options) {
      super('button', parent);
      this.classList.add('button');

      this.callback = null;
      this.onMouseDown = null;
      this.onMouseUp = null;

      this._click = this.click.bind(this);
      this._mouseDown = this.mouseDown.bind(this);
      this._mouseUp = this.mouseUp.bind(this);

      this.element.addEventListener('click', this._click);
      this.element.addEventListener('mousedown', this._mouseDown);
      this.element.addEventListener('mouseup', this._mouseUp);

      if (options) {
        this.configure(options);
      }
    }

    configure(options) {
      super.configure(options);
      if (options.callback) {
        this.callback = options.callback;
      }
      if (options.mouseDown) {
        this.onMouseDown = options.mouseDown;
      }
      if (options.mouseUp) {
        this.onMouseUp = options.mouseUp;
      }
      if (options.label) {
        this.text = options.label;
      }
    }

    click(event) {
      if (this.callback) {
        this.callback.call(this, event);
      }
    }

    mouseDown(event) {
      if (this.onMouseDown) {
        this.onMouseDown.call(this, event);
      }
    }

    mouseUp(event) {
      if (this.onMouseUp) {
        this.onMouseUp.call(this, event);
      }
    }
  }

  /**
   * A SPAN element widget.
   */
  class Span extends Widget {
    constructor(parent, options) {
      super('span', parent, options);
    }
  }

  Span._idPrefix = 'SPAN';

  /**
   * A collapsable widget with a header and a body.
   */
  class Collapsable extends Widget {
    constructor(parent, options) {
      super('div', parent, options);

      const collapsed = options.collapsed ?? false;

      this.titleBar = new Div(this, { class: "title_bar" });
      this.collapseButton = new Span(this.titleBar, { class: "object_list_collapse", text: collapsed ? "+" : "-", style: "margin-right: 10px;" });
      this.label = new Span(this.titleBar, { class: "object_type", text: options?.label ?? "" });

      this.body = new Div(this, { class: ["object_list"] });
      if (collapsed) {
        this.body.element.className = "object_list collapsed";
      }

      const self = this;

      this.titleBar.element.onclick = function() {
        if (self.collapseButton.text == "-") {
          self.collapseButton.text = "+";
          self.body.element.className = "object_list collapsed";
        } else {
          self.collapseButton.text = "-";
          self.body.element.className = "object_list";
        }
      };
    }
  }

  function getFlagString(value, flags) {
    function _addFlagString(flags, flag) {
      return flags === "" ? flag : `${flags} | ${flag}`;
    }
    let flagStr = "";
    for (const flagName in flags) {
      const flag = flags[flagName];
      if (value & flag) {
        flagStr = _addFlagString(flagStr, flagName);
      }
    }
    return flagStr;
  }

  class CapturePanel {
    constructor(window, parent) {
      this.window = window;

      const self = this;
      const port = window.port;

      const controlBar = new Div(parent, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px;" });

      new Button(controlBar, { label: "Capture", style: "background-color: #557;", callback: () => { 
        try {
          self.port.postMessage({ action: "inspector_capture" });
        } catch (e) {}
      } });

      this._captureFrame = new Span(controlBar, { text: ``, style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });

      this._capturePanel = new Div(parent, { style: "overflow: hidden; white-space: nowrap; height: calc(-100px + 100vh); display: flex;" });

      window.onTextureLoaded.addListener(this._textureLoaded, this);

      port.addListener((message) => {
        switch (message.action) {
          case "inspect_capture_frame_results": {
            const commands = message.commands;
            const frame = message.frame;
            self._captureFrameResults(frame, commands);
            break;
          }
        }
      });
    }

    get database() {
      return this.window.database;
    }

    get port() {
      return this.window.port;
    }

    get textureUtils() {
      return this.window.textureUtils;
    }

    _processCommandArgs(object) {
      if (!object) {
        return object;
      }
      if (object.__id !== undefined) {
        const obj = this.database.getObject(object.__id);
        if (obj) {
          return `${obj.constructor.name} ID:${object.__id}`;
        }
        return `${object.__class || "Object"}.${object.__id}`;
      }
      if (object instanceof Array) {
        const newArray = [];
        for (const i in object) {
          newArray[i] = this._processCommandArgs(object[i]);
        }
        return newArray;
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

    _captureFrameResults(frame, commands) {
      const contents = this._capturePanel;

      this._captureFrame.text = `Frame ${frame}`;

      contents.html = "";   

      this._frameImages = new Span(contents, { class: "capture_frameImages" });
      const frameContents = new Span(contents, { class: "capture_frame" });
      const commandInfo = new Span(contents, { class: "capture_commandInfo" });
      
      let currentPass = new Div(frameContents, { class: "capture_commandBlock" });
      let renderPassIndex = 0;

      this._lastSelectedCommand = null;

      let first = true;
      for (let commandIndex = 0, numCommands = commands.length; commandIndex < numCommands; ++commandIndex) {
        const command = commands[commandIndex];
        const className = command.class;
        const method = command.method;
        const args = command.args;
        const name = `${className ?? "__"}`;

        if (method == "beginRenderPass") {
          currentPass = new Div(frameContents, { class: "capture_renderpass" });
          new Div(currentPass, { text: `Render Pass ${renderPassIndex}`, id: `RenderPass_${renderPassIndex}`, style: "padding-left: 20px; font-size: 12pt; color: #ddd; margin-bottom: 5px; background-color: #553; line-height: 30px;" });
          renderPassIndex++;
        } else if (method == "beginComputePass") {
          currentPass = new Div(frameContents, { class: "capture_computepass" });
        }

        const cmdType = ["capture_command"];
        if (method == "draw" || method == "drawIndexed" || method == "drawIndirect" || method == "drawIndexedIndirect" ||
            method == "dispatchWorkgroups" || method == "dispatchWorkgroupsIndirect") {
          cmdType.push("capture_drawcall");
        }

        const cmd = new Div(currentPass, { class: cmdType });
        if (method == "beginRenderPass") {
          cmd.element.id = `RenderPass_${renderPassIndex - 1}_begin`;
        }
        new Span(cmd, { class: "capture_callnum", text: `${commandIndex}.` });
        new Span(cmd, { class: "capture_methodName", text: `${method}` });

        if (method === "setViewport") {
          new Span(cmd, { class: "capture_method_args", text: `x:${args[0]} y:${args[1]} w:${args[2]} h:${args[3]} minZ:${args[4]} maxZ:${args[5]}` });
        } else if (method === "setScissorRect") {
          new Span(cmd, { class: "capture_method_args", text: `x:${args[0]} y:${args[1]} w:${args[2]} h:${args[3]}` });
        } else if (method === "setBindGroup") {
          new Span(cmd, { class: "capture_method_args", text: `index:${args[0]} bindGroup:${args[1].__id}` });
        } else if (method === "writeBuffer") {
          const data = args[2];
          if (data.constructor === String) {
            const s = data.split(" ")[2];
            new Span(cmd, { class: "capture_method_args", text: `buffer:${args[0].__id} offset:${args[1]} data:${s} Bytes` });
          } else {
            new Span(cmd, { class: "capture_method_args", text: `buffer:${args[0].__id} offset:${args[1]} data:${args[2].length} Bytes` });
          }
        } else if (method === "setPipeline") {
          new Span(cmd, { class: "capture_method_args", text: `renderPipeline:${args[0].__id}` });
        } else if (method === "setVertexBuffer") {
          new Span(cmd, { class: "capture_method_args", text: `slot:${args[0]} buffer:${args[1].__id} offset:${args[2] ?? 0}` });
        } else if (method === "setIndexBuffer") {
          new Span(cmd, { class: "capture_method_args", text: `buffer:${args[0].__id} indexFormat:${args[1]} offset:${args[2] ?? 0}` });
        } else if (method === "drawIndexed") {
          new Span(cmd, { class: "capture_method_args", text: `indexCount:${args[0]} instanceCount:${args[1] ?? 1} firstIndex:${args[2] ?? 0} baseVertex:${args[3] ?? 0} firstInstance:${args[4] ?? 0}` });
        } else if (method === "draw") {
          new Span(cmd, { class: "capture_method_args", text: `vertexCount:${args[0]} instanceCount:${args[1] ?? 1} firstVertex:${args[2] ?? 0} firstInstance:${args[3] ?? 0}` });
        } else if (method === "dispatchWorkgroups") {
          new Span(cmd, { class: "capture_method_args", text: `countX:${args[0]} countY:${args[1] ?? 1} countZ:${args[2] ?? 1}` });
        } else if (method === "dispatchWorkgroupsIndirect") {
          new Span(cmd, { class: "capture_method_args", text: `indirectBuffer:${args[0].__id} offset:${args[1]}` });
        }

        const self = this;
        cmd.element.onclick = () => {
          if (self._lastSelectedCommand !== cmd) {
            if (self._lastSelectedCommand) {
              self._lastSelectedCommand.classList.remove("capture_command_selected");
            }
            cmd.classList.add("capture_command_selected");
            self._lastSelectedCommand = cmd;
          }
          
          self._showCaptureCommandInfo(name, method, args, commandInfo, commandIndex, commands);
        };

        if (first) {
          // Start off selecting the first command.
          cmd.element.click();
          first = false;
        }

        if (method == "end") {
          currentPass = new Div(frameContents, { class: "capture_commandBlock" });
        }
      }
    }

    _showCaptureCommandInfo_beginRenderPass(args, commandInfo) {
      const colorAttachments = args[0].colorAttachments;
      for (const i in colorAttachments) {
        const attachment = colorAttachments[i];
        const texture = attachment.view.__id
            ? this.database.getObject(attachment.view.__id).parent
            : attachment.view.__texture
                ? this.database.getObject(attachment.view.__texture.__id)
                : null;
        if (texture) {
          const format = texture.descriptor.format;
          if (texture.gpuTexture) {
            const colorAttachmentGrp = new Collapsable(commandInfo, { label: `Color Attachment ${i}: ${format}` });

            const viewWidth = 256;
            const viewHeight = Math.round(viewWidth * (texture.height / texture.width));
            const canvas = new Widget("canvas", colorAttachmentGrp, { style: "margin-left: 20px; margin-top: 10px;" });
            canvas.element.width = viewWidth;
            canvas.element.height = viewHeight;
            const context = canvas.element.getContext('webgpu');
            const dstFormat = navigator.gpu.getPreferredCanvasFormat();
            context.configure({"device":this.window.device, "format":navigator.gpu.getPreferredCanvasFormat()});
            const canvasTexture = context.getCurrentTexture();
            this.textureUtils.blitTexture(texture.gpuTexture.createView(), texture.descriptor.format, canvasTexture.createView(), dstFormat);
          } else {
            const colorAttachmentGrp = new Collapsable(commandInfo, { label: `Color Attachment ${i}: ${format}` });
            new Widget("pre", colorAttachmentGrp.body, { text: JSON.stringify(attachment.view.descriptor, undefined, 4) });
            const texDesc = this._processCommandArgs(texture.descriptor);
            if (texDesc.usage) {
              texDesc.usage = getFlagString(texDesc.usage, GPUTextureUsage);
            }
            new Widget("pre", colorAttachmentGrp.body, { text: JSON.stringify(texDesc, undefined, 4) });
          }
        }
      }
      const depthStencilAttachment = args[0].depthStencilAttachment;
      if (depthStencilAttachment) {
        const texture = depthStencilAttachment.view.__id
            ? this.database.getObject(depthStencilAttachment.view.__id).parent
            : depthStencilAttachment.view.__texture
                ? this.database.getObject(depthStencilAttachment.view.__texture.__id)
                : null;
        if (texture) {
          if (texture.gpuTexture) {
            const format = texture.descriptor.format;
            const depthStencilAttachmentGrp = new Collapsable(commandInfo, { label: `Depth-Stencil Attachment ${format}` });
            const viewWidth = 256;
            const viewHeight = Math.round(viewWidth * (texture.height / texture.width));
            const canvas = new Widget("canvas", depthStencilAttachmentGrp, { style: "margin-left: 20px; margin-top: 10px;" });
            canvas.element.width = viewWidth;
            canvas.element.height = viewHeight;
            const context = canvas.element.getContext('webgpu');
            const dstFormat = navigator.gpu.getPreferredCanvasFormat();
            context.configure({"device":this.window.device, "format":navigator.gpu.getPreferredCanvasFormat()});
            const canvasTexture = context.getCurrentTexture();
            this.textureUtils.blitTexture(texture.gpuTexture.createView(), texture.descriptor.format, canvasTexture.createView(), dstFormat);
          } else {
            const depthStencilAttachmentGrp = new Collapsable(commandInfo, { label: `Depth-Stencil Attachment: ${texture?.descriptor?.format ?? "<unknown format>"}` });
            new Widget("pre", depthStencilAttachmentGrp.body, { text: JSON.stringify(depthStencilAttachment.view.descriptor, undefined, 4) });
            const texDesc = this._processCommandArgs(texture.descriptor);
            if (texDesc.usage) {
              texDesc.usage = getFlagString(texDesc.usage, GPUTextureUsage);
            }
            new Widget("pre", depthStencilAttachmentGrp.body, { text: JSON.stringify(texDesc, undefined, 4) });
          }
        }
      }
    }

    _showCaptureCommandInfo_setBindGroup(args, commandInfo, index, collapsed) {
      const id = args[1].__id;
      const bindGroup = this.database.getObject(id);
      if (bindGroup) {
        const bindGroupGrp = new Collapsable(commandInfo, { collapsed, label: `BindGroup ${index ?? ""} ID:${id}` });
        const bindGroupDesc = bindGroup.descriptor;
        const newDesc = this._processCommandArgs(bindGroupDesc);
        const descStr = JSON.stringify(newDesc, undefined, 4);
        new Widget("pre", bindGroupGrp.body, { text: descStr });

        const self = this;
        function getResourceType(resource) {
          if (resource.__id !== undefined) {
            const obj = self.database.getObject(resource.__id);
            if (obj) {
              return obj.constructor.name;
            }
          }
          if (resource.buffer) {
            return "Buffer";
          }
          return "<unknown resource type>";
        }
        function getResourceId(resource) {
          if (resource.__id !== undefined) {
            return resource.__id;
          }
          if (resource.buffer?.__id !== undefined) {
            return resource.buffer.__id;
          }
          return 0;
        }

        for (const entry of bindGroupDesc.entries) {
          const binding = entry.binding;
          const resource = entry.resource;
          const groupLabel = index !== undefined ? `Group ${index} ` : "";
          const resourceGrp = new Collapsable(commandInfo, { collapsed, label: `${groupLabel}Binding ${binding}: ${getResourceType(resource)} ID:${getResourceId(resource)}` });
          if (resource.__id !== undefined) {
            const obj = this.database.getObject(resource.__id);
            if (obj) {
              if (obj instanceof Sampler) {
                new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
                new Widget("pre", resourceGrp.body, { text: JSON.stringify(obj.descriptor, undefined, 4) });
              } else if (obj instanceof TextureView) {
                const texture = obj.parent;
                if (texture && texture.gpuTexture) {
                  const viewWidth = 256;
                  const viewHeight = Math.round(viewWidth * (texture.height / texture.width));
                  const canvas = new Widget("canvas", resourceGrp.body, { style: "margin-left: 20px; margin-top: 10px;" });
                  canvas.element.width = viewWidth;
                  canvas.element.height = viewHeight;
                  const context = canvas.element.getContext('webgpu');
                  const dstFormat = navigator.gpu.getPreferredCanvasFormat();
                  context.configure({"device":this.window.device, "format":navigator.gpu.getPreferredCanvasFormat()});
                  const canvasTexture = context.getCurrentTexture();
                  this.textureUtils.blitTexture(texture.gpuTexture.createView(), texture.descriptor.format, canvasTexture.createView(), dstFormat);
                } else {
                  new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
                  new Widget("pre", resourceGrp.body, { text: JSON.stringify(obj.descriptor, undefined, 4) });
                  if (texture) {
                    new Div(resourceGrp.body, { text: `GPUTexture ID:${texture.id}` });
                    const newDesc = this._processCommandArgs(texture.descriptor);
                    if (newDesc.usage) {
                      newDesc.usage = getFlagString(newDesc.usage, GPUTextureUsage);
                    }
                    new Widget("pre", resourceGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
                  }
                }
              } else {
                new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
                new Widget("pre", resourceGrp.body, { text: JSON.stringify(obj.descriptor, undefined, 4) });
              }
            } else {
              new Div(resourceGrp.body, { text: `${resource.__class} ID:${resource.__id}` });
            }
          } else {
            if (resource.buffer) {
              const bufferId = resource.buffer.__id;
              const buffer = this.database.getObject(bufferId);
              if (buffer) {
                const bufferDesc = buffer.descriptor;
                const newDesc = this._processCommandArgs(bufferDesc);
                if (newDesc.usage) {
                  newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
                }
                new Widget("pre", resourceGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
              } else {
                new Div(resourceGrp.body, { text: `Buffer ID:${bufferId}` });
              }
            } else {
              new Widget("pre", resourceGrp.body, { text: JSON.stringify(resource, undefined, 4) });
            }
          }
        }
      }
    }

    _showCaptureCommandInfo_setPipeline(args, commandInfo, collapsed) {
      const id = args[0].__id;
      const pipeline = this.database.getObject(id);
      if (pipeline) {
        const pipelineGrp = new Collapsable(commandInfo, { collapsed, label: `Pipeline ID:${id}` });
        const desc = pipeline.descriptor;
        const newDesc = this._processCommandArgs(desc);
        const descStr = JSON.stringify(newDesc, undefined, 4);
        new Widget("pre", pipelineGrp.body, { text: descStr });

        const vertexId = desc.vertex?.module?.__id;
        const fragmentId = desc.fragment?.module?.__id;

        if (vertexId !== undefined && vertexId === fragmentId) {
          const module = this.database.getObject(vertexId);
          if (module) {
            const vertexEntry = desc.vertex?.entryPoint;
            const fragmentEntry = desc.fragment?.entryPoint;
            const grp = new Collapsable(commandInfo, { collapsed, label: `Module ID:${vertexId} Vertex: ${vertexEntry} Fragment: ${fragmentEntry}` });
            const code = module.descriptor.code;
            new Widget("pre", grp.body, { text: code });
          }
        } else {
          if (vertexId !== undefined) {
            const vertexModule = this.database.getObject(vertexId);
            if (vertexModule) {
              const vertexEntry = desc.vertex?.entryPoint;

              const vertexGrp = new Collapsable(commandInfo, { collapsed, label: `Vertex Module ID:${vertexId} Entry: ${vertexEntry}` });
              const code = vertexModule.descriptor.code;
              new Widget("pre", vertexGrp.body, { text: code });
            }
          }
          
          if (fragmentId !== undefined) {
            const fragmentModule = this.database.getObject(fragmentId);
            if (fragmentModule) {
              const fragmentEntry = desc.fragment?.entryPoint;
              const fragmentGrp = new Collapsable(commandInfo, { collapsed, label: `Fragment Module ID:${fragmentId} Entry: ${fragmentEntry}` });
              const code = fragmentModule.descriptor.code;
              new Widget("pre", fragmentGrp.body, { text: code });
            }
          }
        }

        const computeId = desc.compute?.module?.__id;
        if (computeId !== undefined) {
          const computeModule = this.database.getObject(computeId);
          if (computeModule) {
            const computeEntry = desc.compute?.entryPoint;
            const computeGrp = new Collapsable(commandInfo, { collapsed, label: `Compute Module ID:${computeId} Entry: ${computeEntry}` });
            const code = computeModule.descriptor.code;
            new Widget("pre", computeGrp.body, { text: code });
          }
        }
      }
    }

    _showCaptureCommandInfo_writeBuffer(args, commandInfo) {
      const id = args[0].__id;
      const buffer = this.database.getObject(id);
      if (buffer) {
        const bufferGrp = new Collapsable(commandInfo, { label: `Buffer ID:${id}` });
        const desc = buffer.descriptor;
        const newDesc = this._processCommandArgs(desc);
        if (newDesc.usage) {
          newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
        }
        new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
      }
    }

    _showCaptureCommandInfo_setIndexBuffer(args, commandInfo, collapsed) {
      const id = args[0].__id;
      const buffer = this.database.getObject(id);
      if (buffer) {
        const bufferGrp = new Collapsable(commandInfo, { collapsed, label: `Index Buffer ID:${id}` });
        const desc = buffer.descriptor;
        const newDesc = this._processCommandArgs(desc);
        if (newDesc.usage) {
          newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
        }
        new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
      }
    }

    _showCaptureCommandInfo_setVertexBuffer(args, commandInfo, collapsed) {
      const id = args[1]?.__id;
      const buffer = this.database.getObject(id);
      if (buffer) {
        const bufferGrp = new Collapsable(commandInfo, { collapsed, label: `Vertex Buffer ID:${id}` });
        const desc = buffer.descriptor;
        const newDesc = this._processCommandArgs(desc);
        if (newDesc.usage) {
          newDesc.usage = getFlagString(newDesc.usage, GPUBufferUsage);
        }
        new Widget("pre", bufferGrp.body, { text: JSON.stringify(newDesc, undefined, 4) });
      }
    }

    _showCaptureCommandInfo_draw(args, commandInfo, commandIndex, commands) {
      let pipeline = null;
      let vertexBuffer = null;
      let bindGroups = [];
      for (let ci = commandIndex - 1; ci >= 0; --ci) {
        const cmd = commands[ci];
        if (cmd.method == "beginRenderPass") {
          break;
        }
        if (cmd.method == "setVertexBuffer" && !vertexBuffer) {
          vertexBuffer = cmd;
        }
        if (cmd.method == "setPipeline" && !pipeline) {
          pipeline = cmd;
        }
        if (cmd.method == "setBindGroup") {
          const bindGroupIndex = cmd.args[0];
          if (!bindGroups[bindGroupIndex]) {
            bindGroups[bindGroupIndex] = cmd;
          }
        }
      }

      if (pipeline) {
        this._showCaptureCommandInfo_setPipeline(pipeline.args, commandInfo, true);
      }
      if (vertexBuffer) {
        this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer.args, commandInfo, true);
      }
      for (const index in bindGroups) {
        this._showCaptureCommandInfo_setBindGroup(bindGroups[index].args, commandInfo, index, true);
      }
    }

    _showCaptureCommandInfo_drawIndexed(args, commandInfo, commandIndex, commands) {
      let pipeline = null;
      let vertexBuffer = null;
      let indexBuffer = null;
      let bindGroups = [];
      for (let ci = commandIndex - 1; ci >= 0; --ci) {
        const cmd = commands[ci];
        if (cmd.method == "beginRenderPass") {
          break;
        }
        if (cmd.method == "setIndexBuffer" && !indexBuffer) {
          indexBuffer = cmd;
        }
        if (cmd.method == "setVertexBuffer" && !vertexBuffer) {
          vertexBuffer = cmd;
        }
        if (cmd.method == "setPipeline" && !pipeline) {
          pipeline = cmd;
        }
        if (cmd.method == "setBindGroup") {
          const bindGroupIndex = cmd.args[0];
          if (!bindGroups[bindGroupIndex]) {
            bindGroups[bindGroupIndex] = cmd;
          }
        }
      }

      if (pipeline) {
        this._showCaptureCommandInfo_setPipeline(pipeline.args, commandInfo, true);
      }
      if (indexBuffer) {
        this._showCaptureCommandInfo_setIndexBuffer(indexBuffer.args, commandInfo, true);
      }
      if (vertexBuffer) {
        this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer.args, commandInfo, true);
      }
      for (const index in bindGroups) {
        this._showCaptureCommandInfo_setBindGroup(bindGroups[index].args, commandInfo, index, true);
      }
    }

    _showCaptureCommandInfo_drawIndirect(args, commandInfo, commandIndex, commands) {
      let pipeline = null;
      let vertexBuffer = null;
      let bindGroups = [];
      for (let ci = commandIndex - 1; ci >= 0; --ci) {
        const cmd = commands[ci];
        if (cmd.method == "beginRenderPass") {
          break;
        }
        if (cmd.method == "setVertexBuffer" && !vertexBuffer) {
          vertexBuffer = cmd;
        }
        if (cmd.method == "setPipeline" && !pipeline) {
          pipeline = cmd;
        }
        if (cmd.method == "setBindGroup") {
          const bindGroupIndex = cmd.args[0];
          if (!bindGroups[bindGroupIndex]) {
            bindGroups[bindGroupIndex] = cmd;
          }
        }
      }

      if (pipeline) {
        this._showCaptureCommandInfo_setPipeline(pipeline.args, commandInfo, true);
      }
      if (vertexBuffer) {
        this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer.args, commandInfo, true);
      }
      for (const index in bindGroups) {
        this._showCaptureCommandInfo_setBindGroup(bindGroups[index].args, commandInfo, index, true);
      }
    }

    _showCaptureCommandInfo_drawIndexedIndirect(args, commandInfo, commandIndex, commands) {
      let pipeline = null;
      let vertexBuffer = null;
      let indexBuffer = null;
      let bindGroups = [];
      for (let ci = commandIndex - 1; ci >= 0; --ci) {
        const cmd = commands[ci];
        if (cmd.method == "beginRenderPass") {
          break;
        }
        if (cmd.method == "setIndexBuffer" && !indexBuffer) {
          indexBuffer = cmd;
        }
        if (cmd.method == "setVertexBuffer" && !vertexBuffer) {
          vertexBuffer = cmd;
        }
        if (cmd.method == "setPipeline" && !pipeline) {
          pipeline = cmd;
        }
        if (cmd.method == "setBindGroup") {
          const bindGroupIndex = cmd.args[0];
          if (!bindGroups[bindGroupIndex]) {
            bindGroups[bindGroupIndex] = cmd;
          }
        }
      }

      if (pipeline) {
        this._showCaptureCommandInfo_setPipeline(pipeline.args, commandInfo, true);
      }
      if (indexBuffer) {
        this._showCaptureCommandInfo_setIndexBuffer(indexBuffer.args, commandInfo, true);
      }
      if (vertexBuffer) {
        this._showCaptureCommandInfo_setVertexBuffer(vertexBuffer.args, commandInfo, true);
      }
      for (const index in bindGroups) {
        this._showCaptureCommandInfo_setBindGroup(bindGroups[index].args, commandInfo, index, true);
      }
    }

    _showCaptureCommandInfo_dispatchWorkgroups(args, commandInfo, commandIndex, commands) {
      let pipeline = null;
      let bindGroups = [];
      for (let ci = commandIndex - 1; ci >= 0; --ci) {
        const cmd = commands[ci];
        if (cmd.method == "beginComputePass") {
          break;
        }
        if (cmd.method == "setPipeline" && !pipeline) {
          pipeline = cmd;
        }
        if (cmd.method == "setBindGroup") {
          const bindGroupIndex = cmd.args[0];
          if (!bindGroups[bindGroupIndex]) {
            bindGroups[bindGroupIndex] = cmd;
          }
        }
      }

      if (pipeline) {
        this._showCaptureCommandInfo_setPipeline(pipeline.args, commandInfo, true);
      }
      for (const index in bindGroups) {
        this._showCaptureCommandInfo_setBindGroup(bindGroups[index].args, commandInfo, index, true);
      }
    }

    _showCaptureCommandInfo(name, method, args, commandInfo, commandIndex, commands) {
      commandInfo.html = "";

      new Div(commandInfo, { text: `${name} ${method}`, style: "background-color: #575; padding-left: 20px; line-height: 40px;" });

      if (method == "beginRenderPass") {
        const desc = args[0];
        const colorAttachments = desc.colorAttachments;
        for (const i in colorAttachments) {
          const attachment = colorAttachments[i];
          const textureView = this.database.getObject(attachment.view.__id);
          if (textureView) {
            const texture = textureView.parent;
            if (texture) {
              const format = texture.descriptor.format;
              new Div(commandInfo, { text: `Color ${i}: ${format}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
            }
          }
        }
        const depthStencilAttachment = desc.depthStencilAttachment;
        if (depthStencilAttachment) {
          const textureView = this.database.getObject(depthStencilAttachment.view.__id);
          if (textureView) {
            const texture = textureView.parent;
            if (texture) {
              const format = texture.descriptor.format;
              new Div(commandInfo, { text: `Depth-Stencil: ${format}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
            }
          }
        }
      }

      const argsGroup = new Collapsable(commandInfo, { label: "Arguments" });
      const newArgs = this._processCommandArgs(args);
      if (CapturePanel._commandArgs[method]) {
        const args = CapturePanel._commandArgs[method];
        for (let i = 0, l = newArgs.length; i < l; ++i) {
          const arg = args[i];
          const value = newArgs[i];
          const valueStr = value instanceof Array ? `[${value.length}]: ${value}` : JSON.stringify(value, undefined, 4);
          if (arg !== undefined) {
            new Widget("pre", argsGroup.body, { text: `${arg}: ${valueStr}`, style: "margin-left: 10px;" });
          } else {
            new Widget("pre", argsGroup.body, { text: `[${i}]: ${valueStr}`, style: "margin-left: 10px;" });
          }
        }
      } else {
        new Widget("pre", argsGroup.body, { text: JSON.stringify(newArgs, undefined, 4) });
      }

      if (method == "beginRenderPass") {
        this._showCaptureCommandInfo_beginRenderPass(args, commandInfo);
      } else if (method == "setBindGroup") {
        this._showCaptureCommandInfo_setBindGroup(args, commandInfo);
      } else if (method == "setPipeline") {
        this._showCaptureCommandInfo_setPipeline(args, commandInfo);
      } else if (method == "writeBuffer") {
        this._showCaptureCommandInfo_writeBuffer(args, commandInfo);
      } else if (method == "setIndexBuffer") {
        this._showCaptureCommandInfo_setIndexBuffer(args, commandInfo);
      } else if (method == "setVertexBuffer") {
        this._showCaptureCommandInfo_setVertexBuffer(args, commandInfo);
      } else if (method == "drawIndexed") {
        this._showCaptureCommandInfo_drawIndexed(args, commandInfo, commandIndex, commands);
      } else if (method == "draw") {
        this._showCaptureCommandInfo_draw(args, commandInfo, commandIndex, commands);
      } else if (method == "drawIndirect") {
        this._showCaptureCommandInfo_drawIndirect(args, commandInfo, commandIndex, commands);
      } else if (method == "drawIndexedIndirect") {
        this._showCaptureCommandInfo_drawIndexedIndirect(args, commandInfo, commandIndex, commands);
      } else if (method == "dispatchWorkgroups") {
        this._showCaptureCommandInfo_dispatchWorkgroups(args, commandInfo, commandIndex, commands);
      }
    }

    _textureLoaded(texture, passId) {
      if (passId == -1) {
        return;
      }

      const frameImages = this._frameImages;
      if (frameImages) {
        const aspect = texture.height / texture.width;
        const viewWidth = 256;
        const viewHeight = Math.round(viewWidth * aspect);

        const passFrame = new Div(frameImages, { class: "capture_pass_texture" });

        new Div(passFrame, { text: `Render Pass ${passId}`, style: "color: #ddd; margin-bottom: 5px;" });
        const textureId = texture.id < 0 ? "CANVAS" : texture.id;
        new Div(passFrame, { text: `${texture.name} ID:${textureId}`, style: "color: #ddd; margin-bottom: 10px;" });
        
        const canvas = new Widget("canvas", passFrame);
        canvas.element.width = viewWidth;
        canvas.element.height = viewHeight;
        const context = canvas.element.getContext('webgpu');
        const dstFormat = navigator.gpu.getPreferredCanvasFormat();
        context.configure({"device":this.window.device, "format":navigator.gpu.getPreferredCanvasFormat()});
        const canvasTexture = context.getCurrentTexture();
        this.textureUtils.blitTexture(texture.gpuTexture.createView(), texture.descriptor.format, canvasTexture.createView(), dstFormat);

        canvas.element.onclick = () => {
          const element = document.getElementById(`RenderPass_${passId}`);
          if (element) {
            element.scrollIntoView();

            const beginElement = document.getElementById(`RenderPass_${passId}_begin`);
            if (beginElement) {
              beginElement.click();
            }
          }
        };
      }
    }
  }

  CapturePanel._commandArgs = {
    "beginComputePass": ["descriptor"],
    "beginOcclusionQuery": ["queryIndex"],
    "beginRenderPass": ["descriptor"],
    "configure": ["configuration"],
    "clearBuffer": ["buffer", "offset", "size"],
    "copyBufferToBuffer": ["source", "sourceOffset", "destination", "destinationOffset", "size"],
    "copyBufferToTexture": ["source", "destination", "copySize"],
    "copyTextureToBuffer": ["source", "destination", "copySize"],
    "copyTextureToTexture": ["source", "destination", "copySize"],
    "createBindGroup": ["descriptor"],
    "createBindGroupLayout": ["descriptor"],
    "createBuffer": ["descriptor"],
    "createCommandEncoder": ["descriptor"],
    "createComputePipeline": ["descriptor"],
    "createComputePipelineAsync": ["descriptor"],
    "createPipelineLayout": ["descriptor"],
    "createQuerySet": ["descriptor"],
    "createRenderBundleEncoder": ["descriptor"],
    "createRenderPipeline": ["descriptor"],
    "createRenderPipelineAsync": ["descriptor"],
    "createSampler": ["descriptor"],
    "createShaderModule": ["descriptor"],
    "createTexture": ["descriptor"],
    "createView": ["descriptor"],
    "destroy": [],
    "dispatchWorkgroups": ["workgroupCountX", "workgroupCountY", "workgroupCountZ"],
    "dispatchWorkgroupsIndirect": ["indirectBuffer", "indirectOffset"],
    "draw": ["vertexCount", "instanceCount", "firstVertex", "firstInstance"],
    "drawIndexed": ["indexCount", "instanceCount", "firstIndex", "baseVertex", "firstInstance"],
    "drawIndirect": ["indirectBuffer", "indirectOffset"],
    "drawIndexedIndirect": ["indirectBuffer", "indirectOffset"],
    "end": [],
    "endOcclusionQuery": [],
    "executeBundles": ["bundles"],
    "finish": ["descriptor"],
    "getCompilationInfo": [],
    "getCurrentTexture": [],
    "getMappedRange": ["offset", "size"],
    "importExternalTexture": ["descriptor"],
    "insertDebugMarker": ["markerLabel"],
    "mapAsync": ["mode", "offset", "size"],
    "onSubmittedWorkDone": ["workDonePromise", "callback"],
    "pushDebugGroup": ["groupLabel"],
    "popDebugGroup": [],
    "resolveQuerySet": ["querySet", "firstQuery", "queryCount", "destination", "destinationOffset"],
    "setBindGroup": ["index", "bindGroup", "dynamicOffsets"],
    "setBlendColor": ["color"],
    "setIndexBuffer": ["buffer", "indexFormat", "offset", "size"],
    "setVertexBuffer": ["slot", "buffer", "offset", "size"],
    "setPipeline": ["pipeline"],
    "setScissorRect": ["x", "y", "width", "height"],
    "setStencilReference": ["reference"],
    "setViewport": ["x", "y", "width", "height", "minDepth", "maxDepth"],
    "submit": ["commandBuffers"],
    "unmap": [],
    "writeBuffer": ["buffer", "bufferOffset", "data", "dataOffset", "size"],
    "writeTexture": ["destination", "data", "dataLayout", "size", "bytesPerRow"],
    "copyExternalImageToTexture": ["source", "destination", "copySize"],
  };

  class Label extends Widget {
    constructor(text, parent, options) {
      super('label', parent, options);
      this.classList.add('label');
      this.text = text;
    }

    configure(options) {
      if (!options) {
        return;
      }
      super.configure(options);
      if (options.for) {
        this.for = options.for;
      }
    }

    get for() {
      return this._element.htmlFor;
    }

    set for(v) {
      if (!v) {
        this._element.htmlFor = '';
      } else if (v.constructor === String) {
        this._element.htmlFor = v;
      } else {
        this._element.htmlFor = v.id;
      }
    }
  }

  class Input extends Widget {
    constructor(parent, options) {
      super('input', parent, options);
      this.onChange = new Signal();
      this.onEdit = new Signal();
      const self = this;

      this.element.addEventListener('change', function () {
        let v = self.type === 'checkbox' ? self.checked : self.value;
        self.onChange.emit(v);
        if (self._onChange) {
          self._onChange(v);
        }
      });

      this.element.addEventListener('input', function () {
        let v = self.type === 'checkbox' ? self.checked : self.value;
        self.onEdit.emit(v);
        if (self._onEdit) {
          self._onEdit(v);
        }
      });
    }

    configure(options) {
      if (!options) {
        return;
      }
      super.configure(options);

      if (options.type !== undefined) {
        this.type = options.type;
      }

      if (options.checked !== undefined) {
        this.checked = options.checked;
      }

      if (options.value !== undefined) {
        this.value = options.value;
      }

      if (options.label !== undefined) {
        if (options.label.constructor === String) {
          this.label = new Label(options.label, this.parent, {
            for: this,
          });
        } else {
          this.label = options.label;
          this.label.for = this.id;
        }
      }

      if (options.readOnly !== undefined) {
        this.readOnly = options.readOnly;
      }

      if (options.onChange !== undefined) {
        this._onChange = options.onChange;
      }

      if (options.onEdit !== undefined) {
        this._onEdit = options.onEdit;
      }
    }

    get type() {
      return this._element.type;
    }

    set type(v) {
      this._element.type = v;
    }

    get checked() {
      return this._element.checked;
    }

    set checked(v) {
      this._element.checked = v;
    }

    get indeterminate() {
      return this._element.indeterminate;
    }

    set indeterminate(v) {
      this._element.indeterminate = v;
    }

    get value() {
      return this._element.value;
    }

    set value(v) {
      this._element.value = v;
    }

    get readOnly() {
      return this._element.readOnly;
    }

    set readOnly(v) {
      this._element.readOnly = v;
    }

    focus() {
      this._element.focus();
    }

    blur() {
      this._element.blur();
    }

    select() {
      this._element.select();
    }
  }

  class RecorderPanel {
    constructor(window, parent) {
      this.window = window;
      this._recordingData = [];
      
      const self = this;
      const port = window.port;

      const recorderBar = new Div(parent, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 5px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px; width: calc(-60px + 100vw);" });

      this.recordButton = new Button(recorderBar, { label: "Record", style: "background-color: #755;", callback: () => {
        const frames = self.recordFramesInput.value || 1;
        const filename = self.recordNameInput.value;
        self._recordingData.length = 0;
        port.postMessage({ action: "initialize_recorder", frames, filename });
      }});

      new Span(recorderBar, { text: "Frames:", style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });
      this.recordFramesInput = new Input(recorderBar, { id: "record_frames", type: "number", value: 10 });

      new Span(recorderBar, { text: "Name:", style: "margin-left: 20px; margin-right: 10px;  vertical-align: middle;" });
      this.recordNameInput = new Input(recorderBar, { id: "record_frames", type: "text", value: "webgpu_record" });

      this.recorderDataPanel = new Div(parent);

      port.addListener((message) => {
        switch (message.action) {
          case "webgpu_recording": {
            if (message.index !== undefined && message.count !== undefined && message.data !== undefined) {
              self._addRecordingData(message.data, message.index, message.count);
            }
            break;
          }
        }
      });
    }

    _addRecordingData(data, index, count) {
      try {
        index = parseInt(index);
        count = parseInt(count);
      } catch (e) {
        return;
      }

      if (this._recordingData.length == 0) {
        this._recordingData.length = count;
      }

      if (this._recordingData.length != count) {
        console.log("Invalid Recording Chunk count", count, this._recordingData.length);
        return;
      }

      if (index >= count) {
        console.log("Invalid Recording Chunk index", index, count);
        return;
      }

      this._recordingData[index] = data;

      let pending = false;
      for (let i = 0; i < count; ++i) {
        if (this._recordingData[i] === undefined) {
          pending = true;
          break;
        }
      }
      if (pending) {
        return;
      }

      this.recorderDataPanel.html = "";

      // TODO: How to display the recording file?

      const html = this._recordingData.join();
      new Widget("pre", this.recorderDataPanel, { text: html });

      //const nonceData = new Uint8Array(16);
      //const nonce = encodeBase64(crypto.getRandomValues(nonceData));
      //const html = this._recordingData.join().replace("<script>", `<script nonce="${nonce}">`).replace("script-src *", `script-src * 'nonce-${nonce}' strict-dynamic`);

      /*const f = document.createElement("iframe");
      f.sandbox = "allow-scripts";
      //const url = 'data:text/html;charset=utf-8,' + encodeURI(html);
      const url = URL.createObjectURL(new Blob([html], {type: 'text/html'}));
      f.src = url;

      new Widget(f, this.recorderDataPanel, { style: "width: calc(100% - 10px);" });*/

      //f.contentWindow.document.open();
      //f.contentWindow.document.write(html);
      //f.contentWindow.document.close();
    }
  }

  class InspectPanel {
    constructor(window, parent) {
      this.window = window;

      const self = this;
      const controlBar = new Div(parent, { style: "background-color: #333; box-shadow: #000 0px 3px 3px; border-bottom: 1px solid #000; margin-bottom: 10px; padding-left: 20px; padding-top: 10px; padding-bottom: 10px; font-size: 10pt;" });

      this.inspectButton = new Button(controlBar, { label: "Start", callback: () => { 
        try {
          self.database.reset();
          self._reset();
          self.port.postMessage({ action: "initialize_inspector" });
        } catch (e) {}
      } });

      const stats = new Span(controlBar, { style: "border-left: 1px solid #aaa; padding-left: 10px; margin-left: 20px; height: 20px; padding-top: 5px; color: #ddd;" });
      this.uiFrameTime = new Span(stats);
      this.uiTotalTextureMemory = new Span(stats, { style: "margin-left: 20px;" });
      this.uiTotalBufferMemory = new Span(stats, { style: "margin-left: 20px;" });

      this.inspectorGUI = new Div(parent, { style: "overflow: hidden; white-space: nowrap; height: calc(-85px + 100vh); display: flex;" });

      this.database.onObjectLabelChanged.addListener(this._objectLabelChanged, this);
      this.database.onAddObject.addListener(this._addObject, this);
      this.database.onDeleteObject.addListener(this._deleteObject, this);
      this.database.onEndFrame.addListener(this._updateFrameStats, this);

      window.onTextureLoaded.addListener(this._textureLoaded, this);

      this._reset();
    }

    get database() {
      return this.window.database;
    }

    get port() {
      return this.window.port;
    }

    get textureUtils() {
      return this.window.textureUtils;
    }

    _reset() {
      this._selectedObject = null;
      this._selectedGroup = null;
      this.inspectorGUI.html = "";

      const pane1 = new Span(this.inspectorGUI);

      const objectsTab = new TabWidget(pane1);
      const objectsPanel = new Div(null, { style: "font-size: 11pt; overflow: auto; height: calc(-115px + 100vh);" });
      objectsTab.addTab("Objects", objectsPanel);

      const pane3 = new Span(this.inspectorGUI, { style: "padding-left: 20px; flex-grow: 1; overflow: hidden;" });

      const inspectTab = new TabWidget(pane3);
      this.inspectPanel = new Div(null, { class: "inspector_panel_content" });
      inspectTab.addTab("Inspect", this.inspectPanel);

      this.uiAdapters = this._createObjectListUI(objectsPanel, "Adapters");
      this.uiDevices = this._createObjectListUI(objectsPanel, "Devices");
      this.uiRenderPipelines = this._createObjectListUI(objectsPanel, "Render Pipelines");
      this.uiComputePipelines = this._createObjectListUI(objectsPanel, "Compute Pipelines");
      this.uiShaderModules = this._createObjectListUI(objectsPanel, "Shader Modules");
      this.uiBuffers = this._createObjectListUI(objectsPanel, "Buffers");
      this.uiTextures = this._createObjectListUI(objectsPanel, "Textures");
      this.uiTextureViews = this._createObjectListUI(objectsPanel, "Texture Views");
      this.uiSamplers = this._createObjectListUI(objectsPanel, "Samplers");
      this.uiBindGroups = this._createObjectListUI(objectsPanel, "BindGroups");
      this.uiBindGroupLayouts = this._createObjectListUI(objectsPanel, "BindGroupLayouts");
      this.uiPipelineLayouts = this._createObjectListUI(objectsPanel, "PipelineLayouts");
      this.uiPendingAsyncRenderPipelines = this._createObjectListUI(objectsPanel, "Pending Async Render Pipelines");
      this.uiPendingAsyncComputePipelines = this._createObjectListUI(objectsPanel, "Pending Async Compute Pipelines");
    }

    _textureLoaded(texture) {
      if (this._inspectedObject == texture) {
        this._inspectObject(texture);
      }
    }

    _updateFrameStats() {
      this.uiFrameTime.text = `Frame Time: ${this.database.frameTime.toFixed(2)}ms`;
      const totalTextureMemory = this.database.totalTextureMemory.toLocaleString("en-US");
      this.uiTotalTextureMemory.text = `Texture Memory: ${totalTextureMemory} Bytes`;
      const totalBufferMemory = this.database.totalBufferMemory.toLocaleString("en-US");
      this.uiTotalBufferMemory.text = `Buffer Memory: ${totalBufferMemory} Bytes`;
    }

    _objectLabelChanged(id, object, label) {
      if (object && object.widget) {
        object.nameWidget.text = label || object.constructor.name;
      }
    }

    _deleteObject(id, object) {
      object?.widget?.remove();
      this._updateObjectStat(object);
    }

    _updateObjectStat(object) {
      if (object instanceof Adapter) {
        this.uiAdapters.count.text = `${this.database.adapters.size}`;
      } else if (object instanceof Device) {
        this.uiDevices.count.text = `${this.database.devices.size}`;
      } else if (object instanceof Buffer) {
        this.uiBuffers.count.text = `${this.database.buffers.size}`;
      } else if (object instanceof Sampler) {
        this.uiSamplers.count.text = `${this.database.samplers.size}`;
      } else if (object instanceof Texture) {
        this.uiTextures.count.text = `${this.database.textures.size}`;
      } else if (object instanceof ShaderModule) {
        this.uiShaderModules.count.text = `${this.database.shaderModules.size}`;
      } else if (object instanceof BindGroupLayout) {
        this.uiBindGroupLayouts.count.text = `${this.database.bindGroupLayouts.size}`;
      } else if (object instanceof PipelineLayout) {
        this.uiPipelineLayouts.count.text = `${this.database.pipelineLayouts.size}`;
      } else if (object instanceof BindGroup) {
        this.uiBindGroups.count.text = `${this.database.bindGroups.size}`;
      } else if (object instanceof RenderPipeline) {
        this.uiPendingAsyncRenderPipelines.count.text = `${this.database.pendingRenderPipelines.size}`;
        this.uiRenderPipelines.count.text = `${this.database.renderPipelines.size}`;
      } else if (object instanceof ComputePipeline) {
        this.uiPendingAsyncComputePipelines.count.text = `${this.database.pendingComputePipelines.size}`;
        this.uiComputePipelines.count.text = `${this.database.computePipelines.size}`;
      }
    }

    _addObject(object, pending) {
      this._updateObjectStat(object);
      if (object instanceof Adapter) {
        this._addObjectToUI(object, this.uiAdapters);
        this.uiAdapters.count.text = `${this.database.adapters.size}`;
      } else if (object instanceof Device) {
        this._addObjectToUI(object, this.uiDevices);
        this.uiDevices.count.text = `${this.database.devices.size}`;
      } else if (object instanceof Buffer) {
        this._addObjectToUI(object, this.uiBuffers);
        this.uiBuffers.count.text = `${this.database.buffers.size}`;
      } else if (object instanceof Sampler) {
        this._addObjectToUI(object, this.uiSamplers);
        this.uiSamplers.count.text = `${this.database.samplers.size}`;
      } else if (object instanceof Texture) {
        this._addObjectToUI(object, this.uiTextures);
        this.uiTextures.count.text = `${this.database.textures.size}`;
      } else if (object instanceof TextureView) {
          this._addObjectToUI(object, this.uiTextureViews);
          this.uiTextureViews.count.text = `${this.database.textureViews.size}`;
      } else if (object instanceof ShaderModule) {
        this._addObjectToUI(object, this.uiShaderModules);
        this.uiShaderModules.count.text = `${this.database.shaderModules.size}`;
      } else if (object instanceof BindGroupLayout) {
        this._addObjectToUI(object, this.uiBindGroupLayouts);
        this.uiBindGroupLayouts.count.text = `${this.database.bindGroupLayouts.size}`;
      } else if (object instanceof PipelineLayout) {
        this._addObjectToUI(object, this.uiPipelineLayouts);
        this.uiPipelineLayouts.count.text = `${this.database.pipelineLayouts.size}`;
      } else if (object instanceof BindGroup) {
        this._addObjectToUI(object, this.uiBindGroups);
        this.uiBindGroups.count.text = `${this.database.bindGroups.size}`;
      } else if (object instanceof RenderPipeline) {
        this._addObjectToUI(object, pending ? this.uiPendingAsyncRenderPipelines : this.uiRenderPipelines);
        if (pending) {
          this.uiPendingAsyncRenderPipelines.count.text = `${this.database.pendingRenderPipelines.size}`;
        } else {
          this.uiRenderPipelines.count.text = `${this.database.renderPipelines.size}`;
        }
      } else if (object instanceof ComputePipeline) {
        this._addObjectToUI(object, pending ? this.uiPendingAsyncComputePipelines : this.uiComputePipelines);
        if (pending) {
          this.uiPendingAsyncComputePipelines.count.text = `${this.database.pendingComputePipelines.size}`;
        } else {
          this.uiComputePipelines.count.text = `${this.database.computePipelines.size}`;
        }
      }
    }

    _createObjectListUI(parent, name) {
      const div = new Div(parent);

      const titleBar = new Div(div, { class: "title_bar" });
      
      const collapse = new Span(titleBar, { class: "object_list_collapse", text: "+", style: "margin-right: 10px;" });

      new Span(titleBar, { class: "object_type", text: name });
      const objectCount = new Span(titleBar, { class: "object_type", text: "0", style: "margin-left: 10px;" });

      const objectList = new Widget("ol", div, { class: ["object_list", "collapsed"] });
      objectList.collapse = collapse;
      objectList.count = objectCount;

      const self = this;

      titleBar.element.onclick = function() {
        if (self._selectedGroup && self._selectedGroup != objectList) {
          self._selectedGroup.collapse.text = "+";
          self._selectedGroup.element.className = "object_list collapsed";
          self._selectedGroup = null;
        }
        if (collapse.text == "-") {
          collapse.text = "+";
          objectList.element.className = "object_list collapsed";
        } else {
          collapse.text = "-";
          objectList.element.className = "object_list";
          self._selectedGroup = objectList;
        }
      };

      return objectList;
    }

    _addObjectToUI(object, ui) {
      const name = `${object.name}`;
      let type = "";
      if (object instanceof ShaderModule) {
        if (object.hasVertexEntries) {
          type += " VERTEX";
        }
        if (object.hasFragmentEntries) {
          type += " FRAGMENT";
        }
        if (object.hasComputeEntries) {
          type += " COMPUTE";
        }
      } else if (object instanceof Texture) {
        const depth = object.depthOrArrayLayers > 1 ? `x${object.depthOrArrayLayers}` : "";
        type += ` ${object.width}x${object.height}${depth} ${object.descriptor.format}`;
      }

      object.widget = new Widget("li", ui);

      object.nameWidget = new Span(object.widget, { text: name });
      const idName = object.id < 0 ? "CANVAS" : object.id;
      new Span(object.widget, { text: `ID: ${idName}`, style: "margin-left: 10px; vertical-align: baseline; font-size: 10pt; color: #ddd; font-style: italic;" });
      if (type) {
        new Span(object.widget, { text: type, style: "margin-left: 10px; vertical-align: baseline; font-size: 10pt; color: #ddd; font-style: italic;" });
      }

      const self = this;
      object.widget.element.onclick = () => {
        if (self._selectedObject) {
          self._selectedObject.widget.element.classList.remove("selected");
        }
        object.widget.element.classList.add("selected");
        self._selectedObject = object;
        self._inspectObject(object);
      };
    }

    _inspectObject(object) {
      this.inspectPanel.html = "";

      this._inspectedObject = object;

      const infoBox = new Div(this.inspectPanel, { style: "background-color: #353; padding: 10px;" });
      const idName = object.id < 0 ? "CANVAS" : object.id;
      new Div(infoBox, { text: `${object.name} ID: ${idName}` });

      if (object instanceof Texture) {
        const gpuSize = object.getGpuSize();
        const sizeStr = gpuSize < 0 ? "<unknown>" : gpuSize.toLocaleString("en-US");
        new Div(infoBox, { text: `GPU Size: ${sizeStr} Bytes`, style: "font-size: 10pt; margin-top: 5px;" });
      }

      const dependencies = this.database.getObjectDependencies(object);
      new Div(infoBox, { text: `Used By: ${dependencies.length} Objects`, style: "font-size: 10pt; color: #aaa;"});
      const depGrp = new Div(infoBox, { style: "font-size: 10pt; color: #aaa; padding-left: 20px; max-height: 50px; overflow: auto;" });
      for (const dep of dependencies) {
        new Div(depGrp, { text: `${dep.name} ${dep.id}` });
      }

      const descriptionBox = new Div(this.inspectPanel, { style: "height: calc(-200px + 100vh); overflow: auto;" });

      if (object instanceof ShaderModule) {
        const text = object.descriptor.code;
        new Widget("pre", descriptionBox, { text });
      } else {
        const desc = this._getDescriptorInfo(object, object.descriptor);
        const text = JSON.stringify(desc, undefined, 4);
        new Widget("pre", descriptionBox, { text });
      }

      if (object instanceof Texture) {
        const self = this;
        const loadButton = new Button(descriptionBox, { label: "Load", callback: () => {
          self.port.postMessage({ action: "inspect_request_texture", id: object.id });
        }});
        if (TextureFormatInfo[object.descriptor.format]?.isDepthStencil) {
          loadButton.disabled = true;
          loadButton.tooltip = "Previewing depth-stencil textures is currently disabled.";
        }
        if (object.gpuTexture) {
          this._createTexturePreview(object, descriptionBox);
        }
      }
    }

    _createTexturePreview(texture, parent, width, height) {
      width ??= texture.width;
      height ??= texture.height;
      const canvas = new Widget("canvas", parent);
      canvas.element.width = width;
      canvas.element.height = height;
      const context = canvas.element.getContext('webgpu');
      const format = navigator.gpu.getPreferredCanvasFormat();
      const device = this.window.device;
      context.configure({ device, format });
      const canvasTexture = context.getCurrentTexture();
      const formatInfo = TextureFormatInfo[texture.descriptor.format];
      let srcView;
      if (formatInfo.isDepthStencil) {
        if (formatInfo.hasDepth) {
          srcView = texture.gpuTexture.createView({ aspect: "depth-only" });
        } else {
          srcView = texture.gpuTexture.createView({ aspect: "depth-only" });
        }
        srcView = formatInfo.isDepthStencil
          ? texture.gpuTexture.createView({ aspect: "depth-only" })
          : texture.gpuTexture.createView();
      } else {
        srcView = texture.gpuTexture.createView();
      }
      this.textureUtils.blitTexture(srcView, texture.descriptor.format, canvasTexture.createView(), format);
    }

    _getDescriptorArray(object, array) {
      const newArray = [];
      for (const item of array) {
        if (item instanceof Array) {
          newArray.push(this._getDescriptorArray(object, item));
        } else if (item instanceof Object) {
          newArray.push(this._getDescriptorInfo(object, item));
        } else {
          newArray.push(item);
        }
      }
      return newArray;
    }

    _getDescriptorInfo(object, descriptor) {
      const info = {};
      if (descriptor === null) {
        return null;
      }
      if (descriptor["__id"] !== undefined) {
        const obj = this.database.getObject(descriptor["__id"]);
        if (obj) {
          return `${obj.constructor.name} ${descriptor["__id"]}`;
        }
        return `Object ${descriptor["__id"]}`;
      }

      for (const key in descriptor) {
        const value = descriptor[key];
        if (object instanceof Buffer && key == "usage") {
          const usage = getFlagString(value, GPUBufferUsage);
          info[key] = usage || "NONE";
        } else if (object instanceof Texture && key == "usage") {
          let usage = getFlagString(value, GPUTextureUsage);
          info[key] = usage || "NONE";
        } else if (value instanceof Array) {
          info[key] = this._getDescriptorArray(object, value);
        } else if (value instanceof Object) {
          if (value["__id"] !== undefined) {
            const obj = this.database.getObject(value["__id"]);
            if (obj) {
              info[key] = `${obj.constructor.name} ${value["__id"]}`;
            } else {
              info[key] = `Object ${value["__id"]}`;
            }
          } else {
            info[key] = this._getDescriptorInfo(object, value);
          }
        } else {
          info[key] = value;
        }
      }
      return info;
    }
  }

  async function decodeDataUrl(dataUrl) {
    const res = await fetch(dataUrl);
    return new Uint8Array(await res.arrayBuffer());
  }

  class InspectorWindow extends Window {
    constructor() {
      super();

      const tabId = chrome.devtools.inspectedWindow.tabId;
      this.port = new MessagePort("webgpu-inspector-panel", tabId);
      this.database = new ObjectDatabase(this.port);
      this.classList.add("main-window");
      this._selectedObject = null;
      this._inspectedObject = null;
      this.objectDatabase = new ObjectDatabase(this.port);

      this.adapter = null;
      this.device = null;

      this.onTextureLoaded = new Signal();

      this._tabs = new TabWidget(this);

      const inspectorPanel = new Div(null, { class: "inspector_panel" });
      this._tabs.addTab("Inspect", inspectorPanel);
      this._inspectPanel = new InspectPanel(this, inspectorPanel);

      const capturePanel = new Div(null, { class: "capture_panel" });
      this._tabs.addTab("Capture", capturePanel);
      this._capturePanel = new CapturePanel(this, capturePanel);

      const recorderPanel = new Div(null, { class: "recorder_panel" });
      this._tabs.addTab("Record", recorderPanel);
      this._recorderPanel = new RecorderPanel(this, recorderPanel);

      const self = this;
      this.port.addListener((message) => {
        switch (message.action) {
          case "inspect_capture_texture_data": {
            const id = message.id;
            const passId = message.passId;
            const offset = message.offset;
            const size = message.size;
            const index = message.index;
            const count = message.count;
            const chunk = message.chunk;
            self._captureTextureData(id, passId, offset, size, index, count, chunk);
            break;
          }
        }
      });

      this.initialize();
    }

    async initialize() {
      if (!navigator.gpu) {
        return;
      }
      this.adapter = await navigator.gpu.requestAdapter();
      if (!this.adapter) {
        return;
      }

      const features = [];
      const limits = {};
      for (const key of this.adapter.features) {
        features.push(key);
      }
      const exclude = new Set(["minSubgroupSize", "maxSubgroupSize"]);
      for (const key in this.adapter.limits) {
        if (!exclude.has(key)) {
          limits[key] = this.adapter.limits[key];
        }
      }

      this.device = await this.adapter.requestDevice({requiredFeatures: features, requiredLimits: limits});

      this.textureUtils = new TextureUtils(this.device);

      this.port.postMessage({action: "PanelLoaded"});
    }

    _captureTextureData(id, passId, offset, size, index, count, chunk) {
      const object = this.database.getObject(id);
      if (!object || !(object instanceof Texture)) {
        return;
      }

      if (object.loadedImageDataChunks.length != count) {
        object.loadedImageDataChunks.length = count;
        object.isImageDataLoaded = false;
      }

      if (!(object.imageData instanceof Uint8Array) || (object.imageData.length != size)) {
        object.imageData = new Uint8Array(size);
      }

      decodeDataUrl(chunk).then((data) => {
        object.loadedImageDataChunks[index] = 1;
        try {
          object.imageData.set(data, offset);
        } catch (e) {
          console.log("TEXTURE IMAGE DATA SET ERROR", id, passId, offset, data.length, object.imageData.length);
          object.loadedImageDataChunks.length = 0;
          object.isImageDataLoaded = false;
        }
    
        let loaded = true;
        for (let i = 0; i < count; ++i) {
          if (!object.loadedImageDataChunks[i]) {
            loaded = false;
            break;
          }
        }
        object.isImageDataLoaded = loaded;
    
        if (object.isImageDataLoaded) {
          object.loadedImageDataChunks.length = 0;
          this._createTexture(object, passId);
        }
      });
    }

    _createTexture(texture, passId) {
      const usage = texture.descriptor.usage;
      const format = texture.descriptor.format;
      const formatInfo = TextureFormatInfo[format] ?? TextureFormatInfo["rgba8unorm"];

      // For depth textures we can't currently use writeTexture.
      // To load data into a depth texture, put the imageData into a storage buffer
      // then do a blit where the shader reads from the storage buffer and writes
      // to frag_depth. On the webgpu_inspector side, we should translate imageData
      // from depth24plus to depth32 so we can deal with floats and not weird depth24
      // data.

      // For now, we can't preview depth-stencil textures.
      if (formatInfo.isDepthStencil) {
        return;
      }

      const gpuFormat = formatInfo.depthOnlyFormat ?? format;
      texture.descriptor.format = gpuFormat;
      texture.descriptor.usage = (usage ?? GPUTextureUsage.RENDER_ATTACHMENT) | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
      texture.gpuTexture = this.window.device.createTexture(texture.descriptor);
      texture.descriptor.usage = usage;
      texture.descriptor.format = format;
      
      const width = texture.width;
      const texelByteSize = formatInfo.bytesPerBlock;
      const bytesPerRow = (width * texelByteSize + 255) & ~0xff;
      const rowsPerImage = texture.height;

      this.window.device.queue.writeTexture(
        {
          texture: texture.gpuTexture
        },
        texture.imageData,
        {
          offset: 0,
          bytesPerRow,
          rowsPerImage
        },
        texture.descriptor.size);

      this.onTextureLoaded.emit(texture, passId);
    }
  }


  async function main() {
    new InspectorWindow();
  }

  main();

  exports.InspectorWindow = InspectorWindow;

  Object.defineProperty(exports, '__esModule', { value: true });

  return exports;

})({});
