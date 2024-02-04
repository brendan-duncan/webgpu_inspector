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

  // Cache stacktraces since many objects will have the same stacktrace.
  class StacktraceCache {
    constructor() {
      this._cache = [];
    }

    getStacktrace(id) {
      return id < 0 ? "" : this._cache[id] ?? "";
    }

    setStacktrace(stacktrace) {
      if (!stacktrace) {
        return -1;
      }
      const id = this._cache.indexOf(stacktrace);
      if (id !== -1) {
        return id;
      }
      this._cache.push(stacktrace);
      return this._cache.length - 1;
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

  class ParseContext {
      constructor() {
          this.constants = new Map();
          this.aliases = new Map();
          this.structs = new Map();
      }
  }
  /**
   * @class Node
   * @category AST
   * Base class for AST nodes parsed from a WGSL shader.
   */
  class Node {
      constructor() { }
      get isAstNode() {
          return true;
      }
      get astNodeType() {
          return "";
      }
      evaluate(context) {
          throw new Error("Cannot evaluate node");
      }
      evaluateString(context) {
          return this.evaluate(context).toString();
      }
      search(callback) { }
      searchBlock(block, callback) {
          if (block) {
              callback(_BlockStart.instance);
              for (const node of block) {
                  if (node instanceof Array) {
                      this.searchBlock(node, callback);
                  }
                  else {
                      node.search(callback);
                  }
              }
              callback(_BlockEnd.instance);
          }
      }
  }
  // For internal use only
  class _BlockStart extends Node {
  }
  _BlockStart.instance = new _BlockStart();
  // For internal use only
  class _BlockEnd extends Node {
  }
  _BlockEnd.instance = new _BlockEnd();
  /**
   * @class Statement
   * @extends Node
   * @category AST
   */
  class Statement extends Node {
      constructor() {
          super();
      }
  }
  /**
   * @class Function
   * @extends Statement
   * @category AST
   */
  class Function extends Statement {
      constructor(name, args, returnType, body) {
          super();
          this.name = name;
          this.args = args;
          this.returnType = returnType;
          this.body = body;
      }
      get astNodeType() {
          return "function";
      }
      search(callback) {
          this.searchBlock(this.body, callback);
      }
  }
  /**
   * @class StaticAssert
   * @extends Statement
   * @category AST
   */
  class StaticAssert extends Statement {
      constructor(expression) {
          super();
          this.expression = expression;
      }
      get astNodeType() {
          return "staticAssert";
      }
      search(callback) {
          this.expression.search(callback);
      }
  }
  /**
   * @class While
   * @extends Statement
   * @category AST
   */
  class While extends Statement {
      constructor(condition, body) {
          super();
          this.condition = condition;
          this.body = body;
      }
      get astNodeType() {
          return "while";
      }
      search(callback) {
          this.condition.search(callback);
          this.searchBlock(this.body, callback);
      }
  }
  /**
   * @class Continuing
   * @extends Statement
   * @category AST
   */
  class Continuing extends Statement {
      constructor(body) {
          super();
          this.body = body;
      }
      get astNodeType() {
          return "continuing";
      }
      search(callback) {
          this.searchBlock(this.body, callback);
      }
  }
  /**
   * @class For
   * @extends Statement
   * @category AST
   */
  class For extends Statement {
      constructor(init, condition, increment, body) {
          super();
          this.init = init;
          this.condition = condition;
          this.increment = increment;
          this.body = body;
      }
      get astNodeType() {
          return "for";
      }
      search(callback) {
          var _a, _b, _c;
          (_a = this.init) === null || _a === void 0 ? void 0 : _a.search(callback);
          (_b = this.condition) === null || _b === void 0 ? void 0 : _b.search(callback);
          (_c = this.increment) === null || _c === void 0 ? void 0 : _c.search(callback);
          this.searchBlock(this.body, callback);
      }
  }
  /**
   * @class Var
   * @extends Statement
   * @category AST
   */
  class Var extends Statement {
      constructor(name, type, storage, access, value) {
          super();
          this.name = name;
          this.type = type;
          this.storage = storage;
          this.access = access;
          this.value = value;
      }
      get astNodeType() {
          return "var";
      }
      search(callback) {
          var _a;
          callback(this);
          (_a = this.value) === null || _a === void 0 ? void 0 : _a.search(callback);
      }
  }
  /**
   * @class Override
   * @extends Statement
   * @category AST
   */
  class Override extends Statement {
      constructor(name, type, value) {
          super();
          this.name = name;
          this.type = type;
          this.value = value;
      }
      get astNodeType() {
          return "override";
      }
      search(callback) {
          var _a;
          (_a = this.value) === null || _a === void 0 ? void 0 : _a.search(callback);
      }
  }
  /**
   * @class Let
   * @extends Statement
   * @category AST
   */
  class Let extends Statement {
      constructor(name, type, storage, access, value) {
          super();
          this.name = name;
          this.type = type;
          this.storage = storage;
          this.access = access;
          this.value = value;
      }
      get astNodeType() {
          return "let";
      }
      search(callback) {
          var _a;
          (_a = this.value) === null || _a === void 0 ? void 0 : _a.search(callback);
      }
  }
  /**
   * @class Const
   * @extends Statement
   * @category AST
   */
  class Const extends Statement {
      constructor(name, type, storage, access, value) {
          super();
          this.name = name;
          this.type = type;
          this.storage = storage;
          this.access = access;
          this.value = value;
      }
      get astNodeType() {
          return "const";
      }
      evaluate(context) {
          return this.value.evaluate(context);
      }
      search(callback) {
          var _a;
          (_a = this.value) === null || _a === void 0 ? void 0 : _a.search(callback);
      }
  }
  var IncrementOperator;
  (function (IncrementOperator) {
      IncrementOperator["increment"] = "++";
      IncrementOperator["decrement"] = "--";
  })(IncrementOperator || (IncrementOperator = {}));
  (function (IncrementOperator) {
      function parse(val) {
          const key = val;
          if (key == "parse")
              throw new Error("Invalid value for IncrementOperator");
          return IncrementOperator[key];
      }
      IncrementOperator.parse = parse;
  })(IncrementOperator || (IncrementOperator = {}));
  /**
   * @class Increment
   * @extends Statement
   * @category AST
   */
  class Increment extends Statement {
      constructor(operator, variable) {
          super();
          this.operator = operator;
          this.variable = variable;
      }
      get astNodeType() {
          return "increment";
      }
      search(callback) {
          this.variable.search(callback);
      }
  }
  var AssignOperator;
  (function (AssignOperator) {
      AssignOperator["assign"] = "=";
      AssignOperator["addAssign"] = "+=";
      AssignOperator["subtractAssin"] = "-=";
      AssignOperator["multiplyAssign"] = "*=";
      AssignOperator["divideAssign"] = "/=";
      AssignOperator["moduloAssign"] = "%=";
      AssignOperator["andAssign"] = "&=";
      AssignOperator["orAssign"] = "|=";
      AssignOperator["xorAssign"] = "^=";
      AssignOperator["shiftLeftAssign"] = "<<=";
      AssignOperator["shiftRightAssign"] = ">>=";
  })(AssignOperator || (AssignOperator = {}));
  (function (AssignOperator) {
      function parse(val) {
          const key = val;
          if (key == "parse") {
              throw new Error("Invalid value for AssignOperator");
          }
          //return AssignOperator[key];
          return key;
      }
      AssignOperator.parse = parse;
  })(AssignOperator || (AssignOperator = {}));
  /**
   * @class Assign
   * @extends Statement
   * @category AST
   */
  class Assign extends Statement {
      constructor(operator, variable, value) {
          super();
          this.operator = operator;
          this.variable = variable;
          this.value = value;
      }
      get astNodeType() {
          return "assign";
      }
      search(callback) {
          this.value.search(callback);
      }
  }
  /**
   * @class Call
   * @extends Statement
   * @category AST
   */
  class Call extends Statement {
      constructor(name, args) {
          super();
          this.name = name;
          this.args = args;
      }
      get astNodeType() {
          return "call";
      }
  }
  /**
   * @class Loop
   * @extends Statement
   * @category AST
   */
  class Loop extends Statement {
      constructor(body, continuing) {
          super();
          this.body = body;
          this.continuing = continuing;
      }
      get astNodeType() {
          return "loop";
      }
  }
  /**
   * @class Switch
   * @extends Statement
   * @category AST
   */
  class Switch extends Statement {
      constructor(condition, body) {
          super();
          this.condition = condition;
          this.body = body;
      }
      get astNodeType() {
          return "body";
      }
  }
  /**
   * @class If
   * @extends Statement
   * @category AST
   */
  class If extends Statement {
      constructor(condition, body, elseif, _else) {
          super();
          this.condition = condition;
          this.body = body;
          this.elseif = elseif;
          this.else = _else;
      }
      get astNodeType() {
          return "if";
      }
      search(callback) {
          this.condition.search(callback);
          this.searchBlock(this.body, callback);
          this.searchBlock(this.elseif, callback);
          this.searchBlock(this.else, callback);
      }
  }
  /**
   * @class Return
   * @extends Statement
   * @category AST
   */
  class Return extends Statement {
      constructor(value) {
          super();
          this.value = value;
      }
      get astNodeType() {
          return "return";
      }
      search(callback) {
          var _a;
          (_a = this.value) === null || _a === void 0 ? void 0 : _a.search(callback);
      }
  }
  /**
   * @class Enable
   * @extends Statement
   * @category AST
   */
  class Enable extends Statement {
      constructor(name) {
          super();
          this.name = name;
      }
      get astNodeType() {
          return "enable";
      }
  }
  /**
   * @class Diagnostic
   * @extends Statement
   * @category AST
   */
  class Diagnostic extends Statement {
      constructor(severity, rule) {
          super();
          this.severity = severity;
          this.rule = rule;
      }
      get astNodeType() {
          return "diagnostic";
      }
  }
  /**
   * @class Alias
   * @extends Statement
   * @category AST
   */
  class Alias extends Statement {
      constructor(name, type) {
          super();
          this.name = name;
          this.type = type;
      }
      get astNodeType() {
          return "alias";
      }
  }
  /**
   * @class Discard
   * @extends Statement
   * @category AST
   */
  class Discard extends Statement {
      constructor() {
          super();
      }
      get astNodeType() {
          return "discard";
      }
  }
  /**
   * @class Break
   * @extends Statement
   * @category AST
   */
  class Break extends Statement {
      constructor() {
          super();
      }
      get astNodeType() {
          return "break";
      }
  }
  /**
   * @class Continue
   * @extends Statement
   * @category AST
   */
  class Continue extends Statement {
      constructor() {
          super();
      }
      get astNodeType() {
          return "continue";
      }
  }
  /**
   * @class Type
   * @extends Statement
   * @category AST
   */
  class Type extends Statement {
      constructor(name) {
          super();
          this.name = name;
      }
      get astNodeType() {
          return "type";
      }
      get isStruct() {
          return false;
      }
      get isArray() {
          return false;
      }
  }
  /**
   * @class StructType
   * @extends Type
   * @category AST
   */
  class Struct extends Type {
      constructor(name, members) {
          super(name);
          this.members = members;
      }
      get astNodeType() {
          return "struct";
      }
      get isStruct() {
          return true;
      }
      /// Return the index of the member with the given name, or -1 if not found.
      getMemberIndex(name) {
          for (let i = 0; i < this.members.length; i++) {
              if (this.members[i].name == name)
                  return i;
          }
          return -1;
      }
  }
  /**
   * @class TemplateType
   * @extends Type
   * @category AST
   */
  class TemplateType extends Type {
      constructor(name, format, access) {
          super(name);
          this.format = format;
          this.access = access;
      }
      get astNodeType() {
          return "template";
      }
  }
  /**
   * @class PointerType
   * @extends Type
   * @category AST
   */
  class PointerType extends Type {
      constructor(name, storage, type, access) {
          super(name);
          this.storage = storage;
          this.type = type;
          this.access = access;
      }
      get astNodeType() {
          return "pointer";
      }
  }
  /**
   * @class ArrayType
   * @extends Type
   * @category AST
   */
  class ArrayType extends Type {
      constructor(name, attributes, format, count) {
          super(name);
          this.attributes = attributes;
          this.format = format;
          this.count = count;
      }
      get astNodeType() {
          return "array";
      }
      get isArray() {
          return true;
      }
  }
  /**
   * @class SamplerType
   * @extends Type
   * @category AST
   */
  class SamplerType extends Type {
      constructor(name, format, access) {
          super(name);
          this.format = format;
          this.access = access;
      }
      get astNodeType() {
          return "sampler";
      }
  }
  /**
   * @class Expression
   * @extends Node
   * @category AST
   */
  class Expression extends Node {
      constructor() {
          super();
      }
  }
  /**
   * @class StringExpr
   * @extends Expression
   * @category AST
   */
  class StringExpr extends Expression {
      constructor(value) {
          super();
          this.value = value;
      }
      get astNodeType() {
          return "stringExpr";
      }
      toString() {
          return this.value;
      }
      evaluateString() {
          return this.value;
      }
  }
  /**
   * @class CreateExpr
   * @extends Expression
   * @category AST
   */
  class CreateExpr extends Expression {
      constructor(type, args) {
          super();
          this.type = type;
          this.args = args;
      }
      get astNodeType() {
          return "createExpr";
      }
  }
  /**
   * @class CallExpr
   * @extends Expression
   * @category AST
   */
  class CallExpr extends Expression {
      constructor(name, args) {
          super();
          this.name = name;
          this.args = args;
      }
      get astNodeType() {
          return "callExpr";
      }
      evaluate(context) {
          switch (this.name) {
              case "abs":
                  return Math.abs(this.args[0].evaluate(context));
              case "acos":
                  return Math.acos(this.args[0].evaluate(context));
              case "acosh":
                  return Math.acosh(this.args[0].evaluate(context));
              case "asin":
                  return Math.asin(this.args[0].evaluate(context));
              case "asinh":
                  return Math.asinh(this.args[0].evaluate(context));
              case "atan":
                  return Math.atan(this.args[0].evaluate(context));
              case "atan2":
                  return Math.atan2(this.args[0].evaluate(context), this.args[1].evaluate(context));
              case "atanh":
                  return Math.atanh(this.args[0].evaluate(context));
              case "ceil":
                  return Math.ceil(this.args[0].evaluate(context));
              case "clamp":
                  return Math.min(Math.max(this.args[0].evaluate(context), this.args[1].evaluate(context)), this.args[2].evaluate(context));
              case "cos":
                  return Math.cos(this.args[0].evaluate(context));
              //case "cross":
              //TODO: (x[i] * y[j] - x[j] * y[i])
              case "degrees":
                  return (this.args[0].evaluate(context) * 180) / Math.PI;
              //case "determinant":
              //TODO implement
              case "distance":
                  return Math.sqrt(Math.pow(this.args[0].evaluate(context) - this.args[1].evaluate(context), 2));
              case "dot":
              //TODO: (x[i] * y[i])
              case "exp":
                  return Math.exp(this.args[0].evaluate(context));
              case "exp2":
                  return Math.pow(2, this.args[0].evaluate(context));
              //case "extractBits":
              //TODO: implement
              //case "firstLeadingBit":
              //TODO: implement
              case "floor":
                  return Math.floor(this.args[0].evaluate(context));
              case "fma":
                  return (this.args[0].evaluate(context) * this.args[1].evaluate(context) +
                      this.args[2].evaluate(context));
              case "fract":
                  return (this.args[0].evaluate(context) -
                      Math.floor(this.args[0].evaluate(context)));
              //case "frexp":
              //TODO: implement
              case "inverseSqrt":
                  return 1 / Math.sqrt(this.args[0].evaluate(context));
              //case "length":
              //TODO: implement
              case "log":
                  return Math.log(this.args[0].evaluate(context));
              case "log2":
                  return Math.log2(this.args[0].evaluate(context));
              case "max":
                  return Math.max(this.args[0].evaluate(context), this.args[1].evaluate(context));
              case "min":
                  return Math.min(this.args[0].evaluate(context), this.args[1].evaluate(context));
              case "mix":
                  return (this.args[0].evaluate(context) *
                      (1 - this.args[2].evaluate(context)) +
                      this.args[1].evaluate(context) * this.args[2].evaluate(context));
              case "modf":
                  return (this.args[0].evaluate(context) -
                      Math.floor(this.args[0].evaluate(context)));
              case "pow":
                  return Math.pow(this.args[0].evaluate(context), this.args[1].evaluate(context));
              case "radians":
                  return (this.args[0].evaluate(context) * Math.PI) / 180;
              case "round":
                  return Math.round(this.args[0].evaluate(context));
              case "sign":
                  return Math.sign(this.args[0].evaluate(context));
              case "sin":
                  return Math.sin(this.args[0].evaluate(context));
              case "sinh":
                  return Math.sinh(this.args[0].evaluate(context));
              case "saturate":
                  return Math.min(Math.max(this.args[0].evaluate(context), 0), 1);
              case "smoothstep":
                  return (this.args[0].evaluate(context) *
                      this.args[0].evaluate(context) *
                      (3 - 2 * this.args[0].evaluate(context)));
              case "sqrt":
                  return Math.sqrt(this.args[0].evaluate(context));
              case "step":
                  return this.args[0].evaluate(context) < this.args[1].evaluate(context)
                      ? 0
                      : 1;
              case "tan":
                  return Math.tan(this.args[0].evaluate(context));
              case "tanh":
                  return Math.tanh(this.args[0].evaluate(context));
              case "trunc":
                  return Math.trunc(this.args[0].evaluate(context));
              default:
                  throw new Error("Non const function: " + this.name);
          }
      }
      search(callback) {
          for (const node of this.args) {
              node.search(callback);
          }
          callback(this);
      }
  }
  /**
   * @class VariableExpr
   * @extends Expression
   * @category AST
   */
  class VariableExpr extends Expression {
      constructor(name) {
          super();
          this.name = name;
      }
      get astNodeType() {
          return "varExpr";
      }
      search(callback) {
          callback(this);
      }
  }
  /**
   * @class ConstExpr
   * @extends Expression
   * @category AST
   */
  class ConstExpr extends Expression {
      constructor(name, initializer) {
          super();
          this.name = name;
          this.initializer = initializer;
      }
      get astNodeType() {
          return "constExpr";
      }
      evaluate(context) {
          var _a, _b;
          if (this.initializer instanceof CreateExpr) {
              // This is a struct constant
              const property = (_a = this.postfix) === null || _a === void 0 ? void 0 : _a.evaluateString(context);
              const type = (_b = this.initializer.type) === null || _b === void 0 ? void 0 : _b.name;
              const struct = context.structs.get(type);
              const memberIndex = struct === null || struct === void 0 ? void 0 : struct.getMemberIndex(property);
              if (memberIndex != -1) {
                  const value = this.initializer.args[memberIndex].evaluate(context);
                  return value;
              }
              console.log(memberIndex);
          }
          return this.initializer.evaluate(context);
      }
      search(callback) {
          this.initializer.search(callback);
      }
  }
  /**
   * @class LiteralExpr
   * @extends Expression
   * @category AST
   */
  class LiteralExpr extends Expression {
      constructor(value) {
          super();
          this.value = value;
      }
      get astNodeType() {
          return "literalExpr";
      }
      evaluate() {
          return this.value;
      }
  }
  /**
   * @class BitcastExpr
   * @extends Expression
   * @category AST
   */
  class BitcastExpr extends Expression {
      constructor(type, value) {
          super();
          this.type = type;
          this.value = value;
      }
      get astNodeType() {
          return "bitcastExpr";
      }
      search(callback) {
          this.value.search(callback);
      }
  }
  /**
   * @class TypecastExpr
   * @extends Expression
   * @category AST
   */
  class TypecastExpr extends Expression {
      constructor(type, args) {
          super();
          this.type = type;
          this.args = args;
      }
      get astNodeType() {
          return "typecastExpr";
      }
      evaluate(context) {
          return this.args[0].evaluate(context);
      }
      search(callback) {
          this.searchBlock(this.args, callback);
      }
  }
  /**
   * @class GroupingExpr
   * @extends Expression
   * @category AST
   */
  class GroupingExpr extends Expression {
      constructor(contents) {
          super();
          this.contents = contents;
      }
      get astNodeType() {
          return "groupExpr";
      }
      evaluate(context) {
          return this.contents[0].evaluate(context);
      }
      search(callback) {
          this.searchBlock(this.contents, callback);
      }
  }
  /**
   * @class Operator
   * @extends Expression
   * @category AST
   */
  class Operator extends Expression {
      constructor() {
          super();
      }
  }
  /**
   * @class UnaryOperator
   * @extends Operator
   * @category AST
   * @property {string} operator +, -, !, ~
   */
  class UnaryOperator extends Operator {
      constructor(operator, right) {
          super();
          this.operator = operator;
          this.right = right;
      }
      get astNodeType() {
          return "unaryOp";
      }
      evaluate(context) {
          switch (this.operator) {
              case "+":
                  return this.right.evaluate(context);
              case "-":
                  return -this.right.evaluate(context);
              case "!":
                  return this.right.evaluate(context) ? 0 : 1;
              case "~":
                  return ~this.right.evaluate(context);
              default:
                  throw new Error("Unknown unary operator: " + this.operator);
          }
      }
      search(callback) {
          this.right.search(callback);
      }
  }
  /**
   * @class BinaryOperator
   * @extends Operator
   * @category AST
   * @property {string} operator +, -, *, /, %, ==, !=, <, >, <=, >=, &&, ||
   */
  class BinaryOperator extends Operator {
      constructor(operator, left, right) {
          super();
          this.operator = operator;
          this.left = left;
          this.right = right;
      }
      get astNodeType() {
          return "binaryOp";
      }
      evaluate(context) {
          switch (this.operator) {
              case "+":
                  return this.left.evaluate(context) + this.right.evaluate(context);
              case "-":
                  return this.left.evaluate(context) - this.right.evaluate(context);
              case "*":
                  return this.left.evaluate(context) * this.right.evaluate(context);
              case "/":
                  return this.left.evaluate(context) / this.right.evaluate(context);
              case "%":
                  return this.left.evaluate(context) % this.right.evaluate(context);
              case "==":
                  return this.left.evaluate(context) == this.right.evaluate(context)
                      ? 1
                      : 0;
              case "!=":
                  return this.left.evaluate(context) != this.right.evaluate(context)
                      ? 1
                      : 0;
              case "<":
                  return this.left.evaluate(context) < this.right.evaluate(context)
                      ? 1
                      : 0;
              case ">":
                  return this.left.evaluate(context) > this.right.evaluate(context)
                      ? 1
                      : 0;
              case "<=":
                  return this.left.evaluate(context) <= this.right.evaluate(context)
                      ? 1
                      : 0;
              case ">=":
                  return this.left.evaluate(context) >= this.right.evaluate(context)
                      ? 1
                      : 0;
              case "&&":
                  return this.left.evaluate(context) && this.right.evaluate(context)
                      ? 1
                      : 0;
              case "||":
                  return this.left.evaluate(context) || this.right.evaluate(context)
                      ? 1
                      : 0;
              default:
                  throw new Error(`Unknown operator ${this.operator}`);
          }
      }
      search(callback) {
          this.left.search(callback);
          this.right.search(callback);
      }
  }
  /**
   * @class SwitchCase
   * @extends Node
   * @category AST
   */
  class SwitchCase extends Node {
      constructor() {
          super();
      }
  }
  /**
   * @class Case
   * @extends SwitchCase
   * @category AST
   */
  class Case extends SwitchCase {
      constructor(selector, body) {
          super();
          this.selector = selector;
          this.body = body;
      }
      get astNodeType() {
          return "case";
      }
      search(callback) {
          this.searchBlock(this.body, callback);
      }
  }
  /**
   * @class Default
   * @extends SwitchCase
   * @category AST
   */
  class Default extends SwitchCase {
      constructor(body) {
          super();
          this.body = body;
      }
      get astNodeType() {
          return "default";
      }
      search(callback) {
          this.searchBlock(this.body, callback);
      }
  }
  /**
   * @class Argument
   * @extends Node
   * @category AST
   */
  class Argument extends Node {
      constructor(name, type, attributes) {
          super();
          this.name = name;
          this.type = type;
          this.attributes = attributes;
      }
      get astNodeType() {
          return "argument";
      }
  }
  /**
   * @class ElseIf
   * @extends Node
   * @category AST
   */
  class ElseIf extends Node {
      constructor(condition, body) {
          super();
          this.condition = condition;
          this.body = body;
      }
      get astNodeType() {
          return "elseif";
      }
      search(callback) {
          this.condition.search(callback);
          this.searchBlock(this.body, callback);
      }
  }
  /**
   * @class Member
   * @extends Node
   * @category AST
   */
  class Member extends Node {
      constructor(name, type, attributes) {
          super();
          this.name = name;
          this.type = type;
          this.attributes = attributes;
      }
      get astNodeType() {
          return "member";
      }
  }
  /**
   * @class Attribute
   * @extends Node
   * @category AST
   */
  class Attribute extends Node {
      constructor(name, value) {
          super();
          this.name = name;
          this.value = value;
      }
      get astNodeType() {
          return "attribute";
      }
  }

  var _a;
  var TokenClass;
  (function (TokenClass) {
      TokenClass[TokenClass["token"] = 0] = "token";
      TokenClass[TokenClass["keyword"] = 1] = "keyword";
      TokenClass[TokenClass["reserved"] = 2] = "reserved";
  })(TokenClass || (TokenClass = {}));
  class TokenType {
      constructor(name, type, rule) {
          this.name = name;
          this.type = type;
          this.rule = rule;
      }
      toString() {
          return this.name;
      }
  }
  /// Catalog of defined token types, keywords, and reserved words.
  class TokenTypes {
  }
  _a = TokenTypes;
  TokenTypes.none = new TokenType("", TokenClass.reserved, "");
  TokenTypes.eof = new TokenType("EOF", TokenClass.token, "");
  TokenTypes.reserved = {
      asm: new TokenType("asm", TokenClass.reserved, "asm"),
      bf16: new TokenType("bf16", TokenClass.reserved, "bf16"),
      do: new TokenType("do", TokenClass.reserved, "do"),
      enum: new TokenType("enum", TokenClass.reserved, "enum"),
      f16: new TokenType("f16", TokenClass.reserved, "f16"),
      f64: new TokenType("f64", TokenClass.reserved, "f64"),
      handle: new TokenType("handle", TokenClass.reserved, "handle"),
      i8: new TokenType("i8", TokenClass.reserved, "i8"),
      i16: new TokenType("i16", TokenClass.reserved, "i16"),
      i64: new TokenType("i64", TokenClass.reserved, "i64"),
      mat: new TokenType("mat", TokenClass.reserved, "mat"),
      premerge: new TokenType("premerge", TokenClass.reserved, "premerge"),
      regardless: new TokenType("regardless", TokenClass.reserved, "regardless"),
      typedef: new TokenType("typedef", TokenClass.reserved, "typedef"),
      u8: new TokenType("u8", TokenClass.reserved, "u8"),
      u16: new TokenType("u16", TokenClass.reserved, "u16"),
      u64: new TokenType("u64", TokenClass.reserved, "u64"),
      unless: new TokenType("unless", TokenClass.reserved, "unless"),
      using: new TokenType("using", TokenClass.reserved, "using"),
      vec: new TokenType("vec", TokenClass.reserved, "vec"),
      void: new TokenType("void", TokenClass.reserved, "void"),
  };
  TokenTypes.keywords = {
      array: new TokenType("array", TokenClass.keyword, "array"),
      atomic: new TokenType("atomic", TokenClass.keyword, "atomic"),
      bool: new TokenType("bool", TokenClass.keyword, "bool"),
      f32: new TokenType("f32", TokenClass.keyword, "f32"),
      i32: new TokenType("i32", TokenClass.keyword, "i32"),
      mat2x2: new TokenType("mat2x2", TokenClass.keyword, "mat2x2"),
      mat2x3: new TokenType("mat2x3", TokenClass.keyword, "mat2x3"),
      mat2x4: new TokenType("mat2x4", TokenClass.keyword, "mat2x4"),
      mat3x2: new TokenType("mat3x2", TokenClass.keyword, "mat3x2"),
      mat3x3: new TokenType("mat3x3", TokenClass.keyword, "mat3x3"),
      mat3x4: new TokenType("mat3x4", TokenClass.keyword, "mat3x4"),
      mat4x2: new TokenType("mat4x2", TokenClass.keyword, "mat4x2"),
      mat4x3: new TokenType("mat4x3", TokenClass.keyword, "mat4x3"),
      mat4x4: new TokenType("mat4x4", TokenClass.keyword, "mat4x4"),
      ptr: new TokenType("ptr", TokenClass.keyword, "ptr"),
      sampler: new TokenType("sampler", TokenClass.keyword, "sampler"),
      sampler_comparison: new TokenType("sampler_comparison", TokenClass.keyword, "sampler_comparison"),
      struct: new TokenType("struct", TokenClass.keyword, "struct"),
      texture_1d: new TokenType("texture_1d", TokenClass.keyword, "texture_1d"),
      texture_2d: new TokenType("texture_2d", TokenClass.keyword, "texture_2d"),
      texture_2d_array: new TokenType("texture_2d_array", TokenClass.keyword, "texture_2d_array"),
      texture_3d: new TokenType("texture_3d", TokenClass.keyword, "texture_3d"),
      texture_cube: new TokenType("texture_cube", TokenClass.keyword, "texture_cube"),
      texture_cube_array: new TokenType("texture_cube_array", TokenClass.keyword, "texture_cube_array"),
      texture_multisampled_2d: new TokenType("texture_multisampled_2d", TokenClass.keyword, "texture_multisampled_2d"),
      texture_storage_1d: new TokenType("texture_storage_1d", TokenClass.keyword, "texture_storage_1d"),
      texture_storage_2d: new TokenType("texture_storage_2d", TokenClass.keyword, "texture_storage_2d"),
      texture_storage_2d_array: new TokenType("texture_storage_2d_array", TokenClass.keyword, "texture_storage_2d_array"),
      texture_storage_3d: new TokenType("texture_storage_3d", TokenClass.keyword, "texture_storage_3d"),
      texture_depth_2d: new TokenType("texture_depth_2d", TokenClass.keyword, "texture_depth_2d"),
      texture_depth_2d_array: new TokenType("texture_depth_2d_array", TokenClass.keyword, "texture_depth_2d_array"),
      texture_depth_cube: new TokenType("texture_depth_cube", TokenClass.keyword, "texture_depth_cube"),
      texture_depth_cube_array: new TokenType("texture_depth_cube_array", TokenClass.keyword, "texture_depth_cube_array"),
      texture_depth_multisampled_2d: new TokenType("texture_depth_multisampled_2d", TokenClass.keyword, "texture_depth_multisampled_2d"),
      texture_external: new TokenType("texture_external", TokenClass.keyword, "texture_external"),
      u32: new TokenType("u32", TokenClass.keyword, "u32"),
      vec2: new TokenType("vec2", TokenClass.keyword, "vec2"),
      vec3: new TokenType("vec3", TokenClass.keyword, "vec3"),
      vec4: new TokenType("vec4", TokenClass.keyword, "vec4"),
      bitcast: new TokenType("bitcast", TokenClass.keyword, "bitcast"),
      block: new TokenType("block", TokenClass.keyword, "block"),
      break: new TokenType("break", TokenClass.keyword, "break"),
      case: new TokenType("case", TokenClass.keyword, "case"),
      continue: new TokenType("continue", TokenClass.keyword, "continue"),
      continuing: new TokenType("continuing", TokenClass.keyword, "continuing"),
      default: new TokenType("default", TokenClass.keyword, "default"),
      discard: new TokenType("discard", TokenClass.keyword, "discard"),
      else: new TokenType("else", TokenClass.keyword, "else"),
      enable: new TokenType("enable", TokenClass.keyword, "enable"),
      diagnostic: new TokenType("diagnostic", TokenClass.keyword, "diagnostic"),
      fallthrough: new TokenType("fallthrough", TokenClass.keyword, "fallthrough"),
      false: new TokenType("false", TokenClass.keyword, "false"),
      fn: new TokenType("fn", TokenClass.keyword, "fn"),
      for: new TokenType("for", TokenClass.keyword, "for"),
      function: new TokenType("function", TokenClass.keyword, "function"),
      if: new TokenType("if", TokenClass.keyword, "if"),
      let: new TokenType("let", TokenClass.keyword, "let"),
      const: new TokenType("const", TokenClass.keyword, "const"),
      loop: new TokenType("loop", TokenClass.keyword, "loop"),
      while: new TokenType("while", TokenClass.keyword, "while"),
      private: new TokenType("private", TokenClass.keyword, "private"),
      read: new TokenType("read", TokenClass.keyword, "read"),
      read_write: new TokenType("read_write", TokenClass.keyword, "read_write"),
      return: new TokenType("return", TokenClass.keyword, "return"),
      storage: new TokenType("storage", TokenClass.keyword, "storage"),
      switch: new TokenType("switch", TokenClass.keyword, "switch"),
      true: new TokenType("true", TokenClass.keyword, "true"),
      alias: new TokenType("alias", TokenClass.keyword, "alias"),
      type: new TokenType("type", TokenClass.keyword, "type"),
      uniform: new TokenType("uniform", TokenClass.keyword, "uniform"),
      var: new TokenType("var", TokenClass.keyword, "var"),
      override: new TokenType("override", TokenClass.keyword, "override"),
      workgroup: new TokenType("workgroup", TokenClass.keyword, "workgroup"),
      write: new TokenType("write", TokenClass.keyword, "write"),
      r8unorm: new TokenType("r8unorm", TokenClass.keyword, "r8unorm"),
      r8snorm: new TokenType("r8snorm", TokenClass.keyword, "r8snorm"),
      r8uint: new TokenType("r8uint", TokenClass.keyword, "r8uint"),
      r8sint: new TokenType("r8sint", TokenClass.keyword, "r8sint"),
      r16uint: new TokenType("r16uint", TokenClass.keyword, "r16uint"),
      r16sint: new TokenType("r16sint", TokenClass.keyword, "r16sint"),
      r16float: new TokenType("r16float", TokenClass.keyword, "r16float"),
      rg8unorm: new TokenType("rg8unorm", TokenClass.keyword, "rg8unorm"),
      rg8snorm: new TokenType("rg8snorm", TokenClass.keyword, "rg8snorm"),
      rg8uint: new TokenType("rg8uint", TokenClass.keyword, "rg8uint"),
      rg8sint: new TokenType("rg8sint", TokenClass.keyword, "rg8sint"),
      r32uint: new TokenType("r32uint", TokenClass.keyword, "r32uint"),
      r32sint: new TokenType("r32sint", TokenClass.keyword, "r32sint"),
      r32float: new TokenType("r32float", TokenClass.keyword, "r32float"),
      rg16uint: new TokenType("rg16uint", TokenClass.keyword, "rg16uint"),
      rg16sint: new TokenType("rg16sint", TokenClass.keyword, "rg16sint"),
      rg16float: new TokenType("rg16float", TokenClass.keyword, "rg16float"),
      rgba8unorm: new TokenType("rgba8unorm", TokenClass.keyword, "rgba8unorm"),
      rgba8unorm_srgb: new TokenType("rgba8unorm_srgb", TokenClass.keyword, "rgba8unorm_srgb"),
      rgba8snorm: new TokenType("rgba8snorm", TokenClass.keyword, "rgba8snorm"),
      rgba8uint: new TokenType("rgba8uint", TokenClass.keyword, "rgba8uint"),
      rgba8sint: new TokenType("rgba8sint", TokenClass.keyword, "rgba8sint"),
      bgra8unorm: new TokenType("bgra8unorm", TokenClass.keyword, "bgra8unorm"),
      bgra8unorm_srgb: new TokenType("bgra8unorm_srgb", TokenClass.keyword, "bgra8unorm_srgb"),
      rgb10a2unorm: new TokenType("rgb10a2unorm", TokenClass.keyword, "rgb10a2unorm"),
      rg11b10float: new TokenType("rg11b10float", TokenClass.keyword, "rg11b10float"),
      rg32uint: new TokenType("rg32uint", TokenClass.keyword, "rg32uint"),
      rg32sint: new TokenType("rg32sint", TokenClass.keyword, "rg32sint"),
      rg32float: new TokenType("rg32float", TokenClass.keyword, "rg32float"),
      rgba16uint: new TokenType("rgba16uint", TokenClass.keyword, "rgba16uint"),
      rgba16sint: new TokenType("rgba16sint", TokenClass.keyword, "rgba16sint"),
      rgba16float: new TokenType("rgba16float", TokenClass.keyword, "rgba16float"),
      rgba32uint: new TokenType("rgba32uint", TokenClass.keyword, "rgba32uint"),
      rgba32sint: new TokenType("rgba32sint", TokenClass.keyword, "rgba32sint"),
      rgba32float: new TokenType("rgba32float", TokenClass.keyword, "rgba32float"),
      static_assert: new TokenType("static_assert", TokenClass.keyword, "static_assert"),
      // WGSL grammar has a few keywords that have different token names than the strings they
      // represent. Aliasing them here.
      /*int32: new TokenType("i32", TokenClass.keyword, "i32"),
          uint32: new TokenType("u32", TokenClass.keyword, "u32"),
          float32: new TokenType("f32", TokenClass.keyword, "f32"),
          pointer: new TokenType("ptr", TokenClass.keyword, "ptr"),*/
  };
  TokenTypes.tokens = {
      decimal_float_literal: new TokenType("decimal_float_literal", TokenClass.token, /((-?[0-9]*\.[0-9]+|-?[0-9]+\.[0-9]*)((e|E)(\+|-)?[0-9]+)?f?)|(-?[0-9]+(e|E)(\+|-)?[0-9]+f?)|([0-9]+f)/),
      hex_float_literal: new TokenType("hex_float_literal", TokenClass.token, /-?0x((([0-9a-fA-F]*\.[0-9a-fA-F]+|[0-9a-fA-F]+\.[0-9a-fA-F]*)((p|P)(\+|-)?[0-9]+f?)?)|([0-9a-fA-F]+(p|P)(\+|-)?[0-9]+f?))/),
      int_literal: new TokenType("int_literal", TokenClass.token, /-?0x[0-9a-fA-F]+|0i?|-?[1-9][0-9]*i?/),
      uint_literal: new TokenType("uint_literal", TokenClass.token, /0x[0-9a-fA-F]+u|0u|[1-9][0-9]*u/),
      ident: new TokenType("ident", TokenClass.token, /[a-zA-Z][0-9a-zA-Z_]*/),
      and: new TokenType("and", TokenClass.token, "&"),
      and_and: new TokenType("and_and", TokenClass.token, "&&"),
      arrow: new TokenType("arrow ", TokenClass.token, "->"),
      attr: new TokenType("attr", TokenClass.token, "@"),
      attr_left: new TokenType("attr_left", TokenClass.token, "[["),
      attr_right: new TokenType("attr_right", TokenClass.token, "]]"),
      forward_slash: new TokenType("forward_slash", TokenClass.token, "/"),
      bang: new TokenType("bang", TokenClass.token, "!"),
      bracket_left: new TokenType("bracket_left", TokenClass.token, "["),
      bracket_right: new TokenType("bracket_right", TokenClass.token, "]"),
      brace_left: new TokenType("brace_left", TokenClass.token, "{"),
      brace_right: new TokenType("brace_right", TokenClass.token, "}"),
      colon: new TokenType("colon", TokenClass.token, ":"),
      comma: new TokenType("comma", TokenClass.token, ","),
      equal: new TokenType("equal", TokenClass.token, "="),
      equal_equal: new TokenType("equal_equal", TokenClass.token, "=="),
      not_equal: new TokenType("not_equal", TokenClass.token, "!="),
      greater_than: new TokenType("greater_than", TokenClass.token, ">"),
      greater_than_equal: new TokenType("greater_than_equal", TokenClass.token, ">="),
      shift_right: new TokenType("shift_right", TokenClass.token, ">>"),
      less_than: new TokenType("less_than", TokenClass.token, "<"),
      less_than_equal: new TokenType("less_than_equal", TokenClass.token, "<="),
      shift_left: new TokenType("shift_left", TokenClass.token, "<<"),
      modulo: new TokenType("modulo", TokenClass.token, "%"),
      minus: new TokenType("minus", TokenClass.token, "-"),
      minus_minus: new TokenType("minus_minus", TokenClass.token, "--"),
      period: new TokenType("period", TokenClass.token, "."),
      plus: new TokenType("plus", TokenClass.token, "+"),
      plus_plus: new TokenType("plus_plus", TokenClass.token, "++"),
      or: new TokenType("or", TokenClass.token, "|"),
      or_or: new TokenType("or_or", TokenClass.token, "||"),
      paren_left: new TokenType("paren_left", TokenClass.token, "("),
      paren_right: new TokenType("paren_right", TokenClass.token, ")"),
      semicolon: new TokenType("semicolon", TokenClass.token, ";"),
      star: new TokenType("star", TokenClass.token, "*"),
      tilde: new TokenType("tilde", TokenClass.token, "~"),
      underscore: new TokenType("underscore", TokenClass.token, "_"),
      xor: new TokenType("xor", TokenClass.token, "^"),
      plus_equal: new TokenType("plus_equal", TokenClass.token, "+="),
      minus_equal: new TokenType("minus_equal", TokenClass.token, "-="),
      times_equal: new TokenType("times_equal", TokenClass.token, "*="),
      division_equal: new TokenType("division_equal", TokenClass.token, "/="),
      modulo_equal: new TokenType("modulo_equal", TokenClass.token, "%="),
      and_equal: new TokenType("and_equal", TokenClass.token, "&="),
      or_equal: new TokenType("or_equal", TokenClass.token, "|="),
      xor_equal: new TokenType("xor_equal", TokenClass.token, "^="),
      shift_right_equal: new TokenType("shift_right_equal", TokenClass.token, ">>="),
      shift_left_equal: new TokenType("shift_left_equal", TokenClass.token, "<<="),
  };
  TokenTypes.storage_class = [
      _a.keywords.function,
      _a.keywords.private,
      _a.keywords.workgroup,
      _a.keywords.uniform,
      _a.keywords.storage,
  ];
  TokenTypes.access_mode = [
      _a.keywords.read,
      _a.keywords.write,
      _a.keywords.read_write,
  ];
  TokenTypes.sampler_type = [
      _a.keywords.sampler,
      _a.keywords.sampler_comparison,
  ];
  TokenTypes.sampled_texture_type = [
      _a.keywords.texture_1d,
      _a.keywords.texture_2d,
      _a.keywords.texture_2d_array,
      _a.keywords.texture_3d,
      _a.keywords.texture_cube,
      _a.keywords.texture_cube_array,
  ];
  TokenTypes.multisampled_texture_type = [
      _a.keywords.texture_multisampled_2d,
  ];
  TokenTypes.storage_texture_type = [
      _a.keywords.texture_storage_1d,
      _a.keywords.texture_storage_2d,
      _a.keywords.texture_storage_2d_array,
      _a.keywords.texture_storage_3d,
  ];
  TokenTypes.depth_texture_type = [
      _a.keywords.texture_depth_2d,
      _a.keywords.texture_depth_2d_array,
      _a.keywords.texture_depth_cube,
      _a.keywords.texture_depth_cube_array,
      _a.keywords.texture_depth_multisampled_2d,
  ];
  TokenTypes.texture_external_type = [_a.keywords.texture_external];
  TokenTypes.any_texture_type = [
      ..._a.sampled_texture_type,
      ..._a.multisampled_texture_type,
      ..._a.storage_texture_type,
      ..._a.depth_texture_type,
      ..._a.texture_external_type,
  ];
  TokenTypes.texel_format = [
      _a.keywords.r8unorm,
      _a.keywords.r8snorm,
      _a.keywords.r8uint,
      _a.keywords.r8sint,
      _a.keywords.r16uint,
      _a.keywords.r16sint,
      _a.keywords.r16float,
      _a.keywords.rg8unorm,
      _a.keywords.rg8snorm,
      _a.keywords.rg8uint,
      _a.keywords.rg8sint,
      _a.keywords.r32uint,
      _a.keywords.r32sint,
      _a.keywords.r32float,
      _a.keywords.rg16uint,
      _a.keywords.rg16sint,
      _a.keywords.rg16float,
      _a.keywords.rgba8unorm,
      _a.keywords.rgba8unorm_srgb,
      _a.keywords.rgba8snorm,
      _a.keywords.rgba8uint,
      _a.keywords.rgba8sint,
      _a.keywords.bgra8unorm,
      _a.keywords.bgra8unorm_srgb,
      _a.keywords.rgb10a2unorm,
      _a.keywords.rg11b10float,
      _a.keywords.rg32uint,
      _a.keywords.rg32sint,
      _a.keywords.rg32float,
      _a.keywords.rgba16uint,
      _a.keywords.rgba16sint,
      _a.keywords.rgba16float,
      _a.keywords.rgba32uint,
      _a.keywords.rgba32sint,
      _a.keywords.rgba32float,
  ];
  TokenTypes.const_literal = [
      _a.tokens.int_literal,
      _a.tokens.uint_literal,
      _a.tokens.decimal_float_literal,
      _a.tokens.hex_float_literal,
      _a.keywords.true,
      _a.keywords.false,
  ];
  TokenTypes.literal_or_ident = [
      _a.tokens.ident,
      _a.tokens.int_literal,
      _a.tokens.uint_literal,
      _a.tokens.decimal_float_literal,
      _a.tokens.hex_float_literal,
  ];
  TokenTypes.element_count_expression = [
      _a.tokens.int_literal,
      _a.tokens.uint_literal,
      _a.tokens.ident,
  ];
  TokenTypes.template_types = [
      _a.keywords.vec2,
      _a.keywords.vec3,
      _a.keywords.vec4,
      _a.keywords.mat2x2,
      _a.keywords.mat2x3,
      _a.keywords.mat2x4,
      _a.keywords.mat3x2,
      _a.keywords.mat3x3,
      _a.keywords.mat3x4,
      _a.keywords.mat4x2,
      _a.keywords.mat4x3,
      _a.keywords.mat4x4,
      _a.keywords.atomic,
      _a.keywords.bitcast,
      ..._a.any_texture_type,
  ];
  // The grammar calls out 'block', but attribute grammar is defined to use a 'ident'.
  // The attribute grammar should be ident | block.
  TokenTypes.attribute_name = [_a.tokens.ident, _a.keywords.block];
  TokenTypes.assignment_operators = [
      _a.tokens.equal,
      _a.tokens.plus_equal,
      _a.tokens.minus_equal,
      _a.tokens.times_equal,
      _a.tokens.division_equal,
      _a.tokens.modulo_equal,
      _a.tokens.and_equal,
      _a.tokens.or_equal,
      _a.tokens.xor_equal,
      _a.tokens.shift_right_equal,
      _a.tokens.shift_left_equal,
  ];
  TokenTypes.increment_operators = [
      _a.tokens.plus_plus,
      _a.tokens.minus_minus,
  ];
  /// A token parsed by the WgslScanner.
  class Token {
      constructor(type, lexeme, line) {
          this.type = type;
          this.lexeme = lexeme;
          this.line = line;
      }
      toString() {
          return this.lexeme;
      }
      isTemplateType() {
          return TokenTypes.template_types.indexOf(this.type) != -1;
      }
      isArrayType() {
          return this.type == TokenTypes.keywords.array;
      }
      isArrayOrTemplateType() {
          return this.isArrayType() || this.isTemplateType();
      }
  }
  /// Lexical scanner for the WGSL language. This takes an input source text and generates a list
  /// of Token objects, which can then be fed into the WgslParser to generate an AST.
  class WgslScanner {
      constructor(source) {
          this._tokens = [];
          this._start = 0;
          this._current = 0;
          this._line = 1;
          this._source = source !== null && source !== void 0 ? source : "";
      }
      /// Scan all tokens from the source.
      scanTokens() {
          while (!this._isAtEnd()) {
              this._start = this._current;
              if (!this.scanToken())
                  throw `Invalid syntax at line ${this._line}`;
          }
          this._tokens.push(new Token(TokenTypes.eof, "", this._line));
          return this._tokens;
      }
      /// Scan a single token from the source.
      scanToken() {
          // Find the longest consecutive set of characters that match a rule.
          let lexeme = this._advance();
          // Skip line-feed, adding to the line counter.
          if (lexeme == "\n") {
              this._line++;
              return true;
          }
          // Skip whitespace
          if (this._isWhitespace(lexeme)) {
              return true;
          }
          if (lexeme == "/") {
              // If it's a // comment, skip everything until the next line-feed.
              if (this._peekAhead() == "/") {
                  while (lexeme != "\n") {
                      if (this._isAtEnd())
                          return true;
                      lexeme = this._advance();
                  }
                  // skip the linefeed
                  this._line++;
                  return true;
              }
              else if (this._peekAhead() == "*") {
                  // If it's a / * block comment, skip everything until the matching * /,
                  // allowing for nested block comments.
                  this._advance();
                  let commentLevel = 1;
                  while (commentLevel > 0) {
                      if (this._isAtEnd())
                          return true;
                      lexeme = this._advance();
                      if (lexeme == "\n") {
                          this._line++;
                      }
                      else if (lexeme == "*") {
                          if (this._peekAhead() == "/") {
                              this._advance();
                              commentLevel--;
                              if (commentLevel == 0) {
                                  return true;
                              }
                          }
                      }
                      else if (lexeme == "/") {
                          if (this._peekAhead() == "*") {
                              this._advance();
                              commentLevel++;
                          }
                      }
                  }
                  return true;
              }
          }
          let matchType = TokenTypes.none;
          for (;;) {
              let matchedType = this._findType(lexeme);
              // An exception to "longest lexeme" rule is '>>'. In the case of 1>>2, it's a
              // shift_right.
              // In the case of array<vec4<f32>>, it's two greater_than's (one to close the vec4,
              // and one to close the array).
              // Another ambiguity is '>='. In the case of vec2<i32>=vec2(1,2),
              // it's a greather_than and an equal, not a greater_than_equal.
              // WGSL requires context sensitive parsing to resolve these ambiguities. Both of these cases
              // are predicated on it the > either closing a template, or being part of an operator.
              // The solution here is to check if there was a less_than up to some number of tokens
              // previously, and the token prior to that is a keyword that requires a '<', then it will be
              // split into two operators; otherwise it's a single operator.
              const nextLexeme = this._peekAhead();
              if (lexeme == ">" && (nextLexeme == ">" || nextLexeme == "=")) {
                  let foundLessThan = false;
                  let ti = this._tokens.length - 1;
                  for (let count = 0; count < 5 && ti >= 0; ++count, --ti) {
                      if (this._tokens[ti].type === TokenTypes.tokens.less_than) {
                          if (ti > 0 && this._tokens[ti - 1].isArrayOrTemplateType()) {
                              foundLessThan = true;
                          }
                          break;
                      }
                  }
                  // If there was a less_than in the recent token history, then this is probably a
                  // greater_than.
                  if (foundLessThan) {
                      this._addToken(matchedType);
                      return true;
                  }
              }
              // The current lexeme may not match any rule, but some token types may be invalid for
              // part of the string but valid after a few more characters.
              // For example, 0x.5 is a hex_float_literal. But as it's being scanned,
              // "0" is a int_literal, then "0x" is invalid. If we stopped there, it would return
              // the int_literal "0", but that's incorrect. So if we look forward a few characters,
              // we'd get "0x.", which is still invalid, followed by "0x.5" which is the correct
              // hex_float_literal. So that means if we hit an non-matching string, we should look
              // ahead up to two characters to see if the string starts matching a valid rule again.
              if (matchedType === TokenTypes.none) {
                  let lookAheadLexeme = lexeme;
                  let lookAhead = 0;
                  const maxLookAhead = 2;
                  for (let li = 0; li < maxLookAhead; ++li) {
                      lookAheadLexeme += this._peekAhead(li);
                      matchedType = this._findType(lookAheadLexeme);
                      if (matchedType !== TokenTypes.none) {
                          lookAhead = li;
                          break;
                      }
                  }
                  if (matchedType === TokenTypes.none) {
                      if (matchType === TokenTypes.none)
                          return false;
                      this._current--;
                      this._addToken(matchType);
                      return true;
                  }
                  lexeme = lookAheadLexeme;
                  this._current += lookAhead + 1;
              }
              matchType = matchedType;
              if (this._isAtEnd())
                  break;
              lexeme += this._advance();
          }
          // We got to the end of the input stream. Then the token we've ready so far is it.
          if (matchType === TokenTypes.none)
              return false;
          this._addToken(matchType);
          return true;
      }
      _findType(lexeme) {
          for (const name in TokenTypes.keywords) {
              const type = TokenTypes.keywords[name];
              if (this._match(lexeme, type.rule)) {
                  return type;
              }
          }
          for (const name in TokenTypes.tokens) {
              const type = TokenTypes.tokens[name];
              if (this._match(lexeme, type.rule)) {
                  return type;
              }
          }
          return TokenTypes.none;
      }
      _match(lexeme, rule) {
          if (typeof rule === "string") {
              if (rule == lexeme) {
                  return true;
              }
          }
          else {
              // regex
              const match = rule.exec(lexeme);
              if (match && match.index == 0 && match[0] == lexeme)
                  return true;
          }
          return false;
      }
      _isAtEnd() {
          return this._current >= this._source.length;
      }
      _isWhitespace(c) {
          return c == " " || c == "\t" || c == "\r";
      }
      _advance(amount = 0) {
          let c = this._source[this._current];
          amount = amount || 0;
          amount++;
          this._current += amount;
          return c;
      }
      _peekAhead(offset = 0) {
          offset = offset || 0;
          if (this._current + offset >= this._source.length)
              return "\0";
          return this._source[this._current + offset];
      }
      _addToken(type) {
          const text = this._source.substring(this._start, this._current);
          this._tokens.push(new Token(type, text, this._line));
      }
  }

  /**
   * @author Brendan Duncan / https://github.com/brendan-duncan
   */
  /// Parse a sequence of tokens from the WgslScanner into an Abstract Syntax Tree (AST).
  class WgslParser {
      constructor() {
          this._tokens = [];
          this._current = 0;
          this._context = new ParseContext();
      }
      parse(tokensOrCode) {
          this._initialize(tokensOrCode);
          let statements = [];
          while (!this._isAtEnd()) {
              const statement = this._global_decl_or_directive();
              if (!statement)
                  break;
              statements.push(statement);
          }
          return statements;
      }
      _initialize(tokensOrCode) {
          if (tokensOrCode) {
              if (typeof tokensOrCode == "string") {
                  const scanner = new WgslScanner(tokensOrCode);
                  this._tokens = scanner.scanTokens();
              }
              else {
                  this._tokens = tokensOrCode;
              }
          }
          else {
              this._tokens = [];
          }
          this._current = 0;
      }
      _error(token, message) {
          console.error(token, message);
          return {
              token,
              message,
              toString: function () {
                  return `${message}`;
              },
          };
      }
      _isAtEnd() {
          return (this._current >= this._tokens.length ||
              this._peek().type == TokenTypes.eof);
      }
      _match(types) {
          if (types instanceof TokenType) {
              if (this._check(types)) {
                  this._advance();
                  return true;
              }
              return false;
          }
          for (let i = 0, l = types.length; i < l; ++i) {
              const type = types[i];
              if (this._check(type)) {
                  this._advance();
                  return true;
              }
          }
          return false;
      }
      _consume(types, message) {
          if (this._check(types))
              return this._advance();
          throw this._error(this._peek(), message);
      }
      _check(types) {
          if (this._isAtEnd())
              return false;
          const tk = this._peek();
          if (types instanceof Array) {
              let t = tk.type;
              let index = types.indexOf(t);
              return index != -1;
          }
          return tk.type == types;
      }
      _advance() {
          if (!this._isAtEnd())
              this._current++;
          return this._previous();
      }
      _peek() {
          return this._tokens[this._current];
      }
      _previous() {
          return this._tokens[this._current - 1];
      }
      _global_decl_or_directive() {
          // semicolon
          // global_variable_decl semicolon
          // global_constant_decl semicolon
          // type_alias semicolon
          // struct_decl
          // function_decl
          // enable_directive
          // Ignore any stand-alone semicolons
          while (this._match(TokenTypes.tokens.semicolon) && !this._isAtEnd())
              ;
          if (this._match(TokenTypes.keywords.alias)) {
              const type = this._type_alias();
              this._consume(TokenTypes.tokens.semicolon, "Expected ';'");
              return type;
          }
          if (this._match(TokenTypes.keywords.diagnostic)) {
              const directive = this._diagnostic();
              this._consume(TokenTypes.tokens.semicolon, "Expected ';'");
              return directive;
          }
          if (this._match(TokenTypes.keywords.enable)) {
              const enable = this._enable_directive();
              this._consume(TokenTypes.tokens.semicolon, "Expected ';'");
              return enable;
          }
          // The following statements have an optional attribute*
          const attrs = this._attribute();
          if (this._check(TokenTypes.keywords.var)) {
              const _var = this._global_variable_decl();
              if (_var != null)
                  _var.attributes = attrs;
              this._consume(TokenTypes.tokens.semicolon, "Expected ';'.");
              return _var;
          }
          if (this._check(TokenTypes.keywords.override)) {
              const _override = this._override_variable_decl();
              if (_override != null)
                  _override.attributes = attrs;
              this._consume(TokenTypes.tokens.semicolon, "Expected ';'.");
              return _override;
          }
          if (this._check(TokenTypes.keywords.let)) {
              const _let = this._global_let_decl();
              if (_let != null)
                  _let.attributes = attrs;
              this._consume(TokenTypes.tokens.semicolon, "Expected ';'.");
              return _let;
          }
          if (this._check(TokenTypes.keywords.const)) {
              const _const = this._global_const_decl();
              if (_const != null)
                  _const.attributes = attrs;
              this._consume(TokenTypes.tokens.semicolon, "Expected ';'.");
              return _const;
          }
          if (this._check(TokenTypes.keywords.struct)) {
              const _struct = this._struct_decl();
              if (_struct != null)
                  _struct.attributes = attrs;
              return _struct;
          }
          if (this._check(TokenTypes.keywords.fn)) {
              const _fn = this._function_decl();
              if (_fn != null)
                  _fn.attributes = attrs;
              return _fn;
          }
          return null;
      }
      _function_decl() {
          // attribute* function_header compound_statement
          // function_header: fn ident paren_left param_list? paren_right (arrow attribute* type_decl)?
          if (!this._match(TokenTypes.keywords.fn))
              return null;
          const name = this._consume(TokenTypes.tokens.ident, "Expected function name.").toString();
          this._consume(TokenTypes.tokens.paren_left, "Expected '(' for function arguments.");
          const args = [];
          if (!this._check(TokenTypes.tokens.paren_right)) {
              do {
                  if (this._check(TokenTypes.tokens.paren_right))
                      break;
                  const argAttrs = this._attribute();
                  const name = this._consume(TokenTypes.tokens.ident, "Expected argument name.").toString();
                  this._consume(TokenTypes.tokens.colon, "Expected ':' for argument type.");
                  const typeAttrs = this._attribute();
                  const type = this._type_decl();
                  if (type != null) {
                      type.attributes = typeAttrs;
                      args.push(new Argument(name, type, argAttrs));
                  }
              } while (this._match(TokenTypes.tokens.comma));
          }
          this._consume(TokenTypes.tokens.paren_right, "Expected ')' after function arguments.");
          let _return = null;
          if (this._match(TokenTypes.tokens.arrow)) {
              const attrs = this._attribute();
              _return = this._type_decl();
              if (_return != null)
                  _return.attributes = attrs;
          }
          const body = this._compound_statement();
          return new Function(name, args, _return, body);
      }
      _compound_statement() {
          // brace_left statement* brace_right
          const statements = [];
          this._consume(TokenTypes.tokens.brace_left, "Expected '{' for block.");
          while (!this._check(TokenTypes.tokens.brace_right)) {
              const statement = this._statement();
              if (statement !== null)
                  statements.push(statement);
          }
          this._consume(TokenTypes.tokens.brace_right, "Expected '}' for block.");
          return statements;
      }
      _statement() {
          // semicolon
          // return_statement semicolon
          // if_statement
          // switch_statement
          // loop_statement
          // for_statement
          // func_call_statement semicolon
          // variable_statement semicolon
          // break_statement semicolon
          // continue_statement semicolon
          // continuing_statement compound_statement
          // discard semicolon
          // assignment_statement semicolon
          // compound_statement
          // increment_statement semicolon
          // decrement_statement semicolon
          // static_assert_statement semicolon
          // Ignore any stand-alone semicolons
          while (this._match(TokenTypes.tokens.semicolon) && !this._isAtEnd())
              ;
          if (this._check(TokenTypes.keywords.if))
              return this._if_statement();
          if (this._check(TokenTypes.keywords.switch))
              return this._switch_statement();
          if (this._check(TokenTypes.keywords.loop))
              return this._loop_statement();
          if (this._check(TokenTypes.keywords.for))
              return this._for_statement();
          if (this._check(TokenTypes.keywords.while))
              return this._while_statement();
          if (this._check(TokenTypes.keywords.continuing))
              return this._continuing_statement();
          if (this._check(TokenTypes.keywords.static_assert))
              return this._static_assert_statement();
          if (this._check(TokenTypes.tokens.brace_left))
              return this._compound_statement();
          let result = null;
          if (this._check(TokenTypes.keywords.return))
              result = this._return_statement();
          else if (this._check([
              TokenTypes.keywords.var,
              TokenTypes.keywords.let,
              TokenTypes.keywords.const,
          ]))
              result = this._variable_statement();
          else if (this._match(TokenTypes.keywords.discard))
              result = new Discard();
          else if (this._match(TokenTypes.keywords.break))
              result = new Break();
          else if (this._match(TokenTypes.keywords.continue))
              result = new Continue();
          else
              result =
                  this._increment_decrement_statement() ||
                      this._func_call_statement() ||
                      this._assignment_statement();
          if (result != null)
              this._consume(TokenTypes.tokens.semicolon, "Expected ';' after statement.");
          return result;
      }
      _static_assert_statement() {
          if (!this._match(TokenTypes.keywords.static_assert))
              return null;
          let expression = this._optional_paren_expression();
          return new StaticAssert(expression);
      }
      _while_statement() {
          if (!this._match(TokenTypes.keywords.while))
              return null;
          let condition = this._optional_paren_expression();
          const block = this._compound_statement();
          return new While(condition, block);
      }
      _continuing_statement() {
          if (!this._match(TokenTypes.keywords.continuing))
              return null;
          const block = this._compound_statement();
          return new Continuing(block);
      }
      _for_statement() {
          // for paren_left for_header paren_right compound_statement
          if (!this._match(TokenTypes.keywords.for))
              return null;
          this._consume(TokenTypes.tokens.paren_left, "Expected '('.");
          // for_header: (variable_statement assignment_statement func_call_statement)? semicolon short_circuit_or_expression? semicolon (assignment_statement func_call_statement)?
          const init = !this._check(TokenTypes.tokens.semicolon)
              ? this._for_init()
              : null;
          this._consume(TokenTypes.tokens.semicolon, "Expected ';'.");
          const condition = !this._check(TokenTypes.tokens.semicolon)
              ? this._short_circuit_or_expression()
              : null;
          this._consume(TokenTypes.tokens.semicolon, "Expected ';'.");
          const increment = !this._check(TokenTypes.tokens.paren_right)
              ? this._for_increment()
              : null;
          this._consume(TokenTypes.tokens.paren_right, "Expected ')'.");
          const body = this._compound_statement();
          return new For(init, condition, increment, body);
      }
      _for_init() {
          // (variable_statement assignment_statement func_call_statement)?
          return (this._variable_statement() ||
              this._func_call_statement() ||
              this._assignment_statement());
      }
      _for_increment() {
          // (assignment_statement func_call_statement increment_statement)?
          return (this._func_call_statement() ||
              this._increment_decrement_statement() ||
              this._assignment_statement());
      }
      _variable_statement() {
          // variable_decl
          // variable_decl equal short_circuit_or_expression
          // let (ident variable_ident_decl) equal short_circuit_or_expression
          // const (ident variable_ident_decl) equal short_circuit_or_expression
          if (this._check(TokenTypes.keywords.var)) {
              const _var = this._variable_decl();
              if (_var === null)
                  throw this._error(this._peek(), "Variable declaration expected.");
              let value = null;
              if (this._match(TokenTypes.tokens.equal))
                  value = this._short_circuit_or_expression();
              return new Var(_var.name, _var.type, _var.storage, _var.access, value);
          }
          if (this._match(TokenTypes.keywords.let)) {
              const name = this._consume(TokenTypes.tokens.ident, "Expected name for let.").toString();
              let type = null;
              if (this._match(TokenTypes.tokens.colon)) {
                  const typeAttrs = this._attribute();
                  type = this._type_decl();
                  if (type != null)
                      type.attributes = typeAttrs;
              }
              this._consume(TokenTypes.tokens.equal, "Expected '=' for let.");
              const value = this._short_circuit_or_expression();
              return new Let(name, type, null, null, value);
          }
          if (this._match(TokenTypes.keywords.const)) {
              const name = this._consume(TokenTypes.tokens.ident, "Expected name for const.").toString();
              let type = null;
              if (this._match(TokenTypes.tokens.colon)) {
                  const typeAttrs = this._attribute();
                  type = this._type_decl();
                  if (type != null)
                      type.attributes = typeAttrs;
              }
              this._consume(TokenTypes.tokens.equal, "Expected '=' for const.");
              const value = this._short_circuit_or_expression();
              return new Const(name, type, null, null, value);
          }
          return null;
      }
      _increment_decrement_statement() {
          const savedPos = this._current;
          const _var = this._unary_expression();
          if (_var == null)
              return null;
          if (!this._check(TokenTypes.increment_operators)) {
              this._current = savedPos;
              return null;
          }
          const token = this._consume(TokenTypes.increment_operators, "Expected increment operator");
          return new Increment(token.type === TokenTypes.tokens.plus_plus
              ? IncrementOperator.increment
              : IncrementOperator.decrement, _var);
      }
      _assignment_statement() {
          // (unary_expression underscore) equal short_circuit_or_expression
          let _var = null;
          if (this._check(TokenTypes.tokens.brace_right)) {
              return null;
          }
          let isUnderscore = this._match(TokenTypes.tokens.underscore);
          if (!isUnderscore) {
              _var = this._unary_expression();
          }
          if (!isUnderscore && _var == null) {
              return null;
          }
          const type = this._consume(TokenTypes.assignment_operators, "Expected assignment operator.");
          const value = this._short_circuit_or_expression();
          return new Assign(AssignOperator.parse(type.lexeme), _var, value);
      }
      _func_call_statement() {
          // ident argument_expression_list
          if (!this._check(TokenTypes.tokens.ident))
              return null;
          const savedPos = this._current;
          const name = this._consume(TokenTypes.tokens.ident, "Expected function name.");
          const args = this._argument_expression_list();
          if (args === null) {
              this._current = savedPos;
              return null;
          }
          return new Call(name.lexeme, args);
      }
      _loop_statement() {
          // loop brace_left statement* continuing_statement? brace_right
          if (!this._match(TokenTypes.keywords.loop))
              return null;
          this._consume(TokenTypes.tokens.brace_left, "Expected '{' for loop.");
          // statement*
          const statements = [];
          let statement = this._statement();
          while (statement !== null) {
              if (Array.isArray(statement)) {
                  for (let s of statement) {
                      statements.push(s);
                  }
              }
              else {
                  statements.push(statement);
              }
              statement = this._statement();
          }
          // continuing_statement: continuing compound_statement
          let continuing = null;
          if (this._match(TokenTypes.keywords.continuing))
              continuing = this._compound_statement();
          this._consume(TokenTypes.tokens.brace_right, "Expected '}' for loop.");
          return new Loop(statements, continuing);
      }
      _switch_statement() {
          // switch optional_paren_expression brace_left switch_body+ brace_right
          if (!this._match(TokenTypes.keywords.switch))
              return null;
          const condition = this._optional_paren_expression();
          this._consume(TokenTypes.tokens.brace_left, "Expected '{' for switch.");
          const body = this._switch_body();
          if (body == null || body.length == 0)
              throw this._error(this._previous(), "Expected 'case' or 'default'.");
          this._consume(TokenTypes.tokens.brace_right, "Expected '}' for switch.");
          return new Switch(condition, body);
      }
      _switch_body() {
          // case case_selectors colon brace_left case_body? brace_right
          // default colon brace_left case_body? brace_right
          const cases = [];
          if (this._match(TokenTypes.keywords.case)) {
              const selector = this._case_selectors();
              this._match(TokenTypes.tokens.colon); // colon is optional
              this._consume(TokenTypes.tokens.brace_left, "Exected '{' for switch case.");
              const body = this._case_body();
              this._consume(TokenTypes.tokens.brace_right, "Exected '}' for switch case.");
              cases.push(new Case(selector, body));
          }
          if (this._match(TokenTypes.keywords.default)) {
              this._match(TokenTypes.tokens.colon); // colon is optional
              this._consume(TokenTypes.tokens.brace_left, "Exected '{' for switch default.");
              const body = this._case_body();
              this._consume(TokenTypes.tokens.brace_right, "Exected '}' for switch default.");
              cases.push(new Default(body));
          }
          if (this._check([TokenTypes.keywords.default, TokenTypes.keywords.case])) {
              const _cases = this._switch_body();
              cases.push(_cases[0]);
          }
          return cases;
      }
      _case_selectors() {
          var _a, _b, _c, _d;
          // const_literal (comma const_literal)* comma?
          const selectors = [
              (_b = (_a = this._shift_expression()) === null || _a === void 0 ? void 0 : _a.evaluate(this._context).toString()) !== null && _b !== void 0 ? _b : "",
          ];
          while (this._match(TokenTypes.tokens.comma)) {
              selectors.push((_d = (_c = this._shift_expression()) === null || _c === void 0 ? void 0 : _c.evaluate(this._context).toString()) !== null && _d !== void 0 ? _d : "");
          }
          return selectors;
      }
      _case_body() {
          // statement case_body?
          // fallthrough semicolon
          if (this._match(TokenTypes.keywords.fallthrough)) {
              this._consume(TokenTypes.tokens.semicolon, "Expected ';'");
              return [];
          }
          let statement = this._statement();
          if (statement == null)
              return [];
          if (!(statement instanceof Array)) {
              statement = [statement];
          }
          const nextStatement = this._case_body();
          if (nextStatement.length == 0)
              return statement;
          return [...statement, nextStatement[0]];
      }
      _if_statement() {
          // if optional_paren_expression compound_statement elseif_statement? else_statement?
          if (!this._match(TokenTypes.keywords.if))
              return null;
          const condition = this._optional_paren_expression();
          const block = this._compound_statement();
          let elseif = [];
          if (this._match_elseif()) {
              elseif = this._elseif_statement(elseif);
          }
          let _else = null;
          if (this._match(TokenTypes.keywords.else))
              _else = this._compound_statement();
          return new If(condition, block, elseif, _else);
      }
      _match_elseif() {
          if (this._tokens[this._current].type === TokenTypes.keywords.else &&
              this._tokens[this._current + 1].type === TokenTypes.keywords.if) {
              this._advance();
              this._advance();
              return true;
          }
          return false;
      }
      _elseif_statement(elseif = []) {
          // else_if optional_paren_expression compound_statement elseif_statement?
          const condition = this._optional_paren_expression();
          const block = this._compound_statement();
          elseif.push(new ElseIf(condition, block));
          if (this._match_elseif()) {
              this._elseif_statement(elseif);
          }
          return elseif;
      }
      _return_statement() {
          // return short_circuit_or_expression?
          if (!this._match(TokenTypes.keywords.return))
              return null;
          const value = this._short_circuit_or_expression();
          return new Return(value);
      }
      _short_circuit_or_expression() {
          // short_circuit_and_expression
          // short_circuit_or_expression or_or short_circuit_and_expression
          let expr = this._short_circuit_and_expr();
          while (this._match(TokenTypes.tokens.or_or)) {
              expr = new BinaryOperator(this._previous().toString(), expr, this._short_circuit_and_expr());
          }
          return expr;
      }
      _short_circuit_and_expr() {
          // inclusive_or_expression
          // short_circuit_and_expression and_and inclusive_or_expression
          let expr = this._inclusive_or_expression();
          while (this._match(TokenTypes.tokens.and_and)) {
              expr = new BinaryOperator(this._previous().toString(), expr, this._inclusive_or_expression());
          }
          return expr;
      }
      _inclusive_or_expression() {
          // exclusive_or_expression
          // inclusive_or_expression or exclusive_or_expression
          let expr = this._exclusive_or_expression();
          while (this._match(TokenTypes.tokens.or)) {
              expr = new BinaryOperator(this._previous().toString(), expr, this._exclusive_or_expression());
          }
          return expr;
      }
      _exclusive_or_expression() {
          // and_expression
          // exclusive_or_expression xor and_expression
          let expr = this._and_expression();
          while (this._match(TokenTypes.tokens.xor)) {
              expr = new BinaryOperator(this._previous().toString(), expr, this._and_expression());
          }
          return expr;
      }
      _and_expression() {
          // equality_expression
          // and_expression and equality_expression
          let expr = this._equality_expression();
          while (this._match(TokenTypes.tokens.and)) {
              expr = new BinaryOperator(this._previous().toString(), expr, this._equality_expression());
          }
          return expr;
      }
      _equality_expression() {
          // relational_expression
          // relational_expression equal_equal relational_expression
          // relational_expression not_equal relational_expression
          const expr = this._relational_expression();
          if (this._match([TokenTypes.tokens.equal_equal, TokenTypes.tokens.not_equal])) {
              return new BinaryOperator(this._previous().toString(), expr, this._relational_expression());
          }
          return expr;
      }
      _relational_expression() {
          // shift_expression
          // relational_expression less_than shift_expression
          // relational_expression greater_than shift_expression
          // relational_expression less_than_equal shift_expression
          // relational_expression greater_than_equal shift_expression
          let expr = this._shift_expression();
          while (this._match([
              TokenTypes.tokens.less_than,
              TokenTypes.tokens.greater_than,
              TokenTypes.tokens.less_than_equal,
              TokenTypes.tokens.greater_than_equal,
          ])) {
              expr = new BinaryOperator(this._previous().toString(), expr, this._shift_expression());
          }
          return expr;
      }
      _shift_expression() {
          // additive_expression
          // shift_expression shift_left additive_expression
          // shift_expression shift_right additive_expression
          let expr = this._additive_expression();
          while (this._match([TokenTypes.tokens.shift_left, TokenTypes.tokens.shift_right])) {
              expr = new BinaryOperator(this._previous().toString(), expr, this._additive_expression());
          }
          return expr;
      }
      _additive_expression() {
          // multiplicative_expression
          // additive_expression plus multiplicative_expression
          // additive_expression minus multiplicative_expression
          let expr = this._multiplicative_expression();
          while (this._match([TokenTypes.tokens.plus, TokenTypes.tokens.minus])) {
              expr = new BinaryOperator(this._previous().toString(), expr, this._multiplicative_expression());
          }
          return expr;
      }
      _multiplicative_expression() {
          // unary_expression
          // multiplicative_expression star unary_expression
          // multiplicative_expression forward_slash unary_expression
          // multiplicative_expression modulo unary_expression
          let expr = this._unary_expression();
          while (this._match([
              TokenTypes.tokens.star,
              TokenTypes.tokens.forward_slash,
              TokenTypes.tokens.modulo,
          ])) {
              expr = new BinaryOperator(this._previous().toString(), expr, this._unary_expression());
          }
          return expr;
      }
      _unary_expression() {
          // singular_expression
          // minus unary_expression
          // bang unary_expression
          // tilde unary_expression
          // star unary_expression
          // and unary_expression
          if (this._match([
              TokenTypes.tokens.minus,
              TokenTypes.tokens.bang,
              TokenTypes.tokens.tilde,
              TokenTypes.tokens.star,
              TokenTypes.tokens.and,
          ])) {
              return new UnaryOperator(this._previous().toString(), this._unary_expression());
          }
          return this._singular_expression();
      }
      _singular_expression() {
          // primary_expression postfix_expression ?
          const expr = this._primary_expression();
          const p = this._postfix_expression();
          if (p)
              expr.postfix = p;
          return expr;
      }
      _postfix_expression() {
          // bracket_left short_circuit_or_expression bracket_right postfix_expression?
          if (this._match(TokenTypes.tokens.bracket_left)) {
              const expr = this._short_circuit_or_expression();
              this._consume(TokenTypes.tokens.bracket_right, "Expected ']'.");
              const p = this._postfix_expression();
              if (p)
                  expr.postfix = p;
              return expr;
          }
          // period ident postfix_expression?
          if (this._match(TokenTypes.tokens.period)) {
              const name = this._consume(TokenTypes.tokens.ident, "Expected member name.");
              const p = this._postfix_expression();
              const expr = new StringExpr(name.lexeme);
              if (p)
                  expr.postfix = p;
              return expr;
          }
          return null;
      }
      _getStruct(name) {
          if (this._context.aliases.has(name)) {
              const alias = this._context.aliases.get(name).type;
              return alias;
          }
          if (this._context.structs.has(name)) {
              const struct = this._context.structs.get(name);
              return struct;
          }
          return null;
      }
      _primary_expression() {
          // ident argument_expression_list?
          if (this._match(TokenTypes.tokens.ident)) {
              const name = this._previous().toString();
              if (this._check(TokenTypes.tokens.paren_left)) {
                  const args = this._argument_expression_list();
                  const struct = this._getStruct(name);
                  if (struct != null) {
                      return new CreateExpr(struct, args);
                  }
                  return new CallExpr(name, args);
              }
              if (this._context.constants.has(name)) {
                  const c = this._context.constants.get(name);
                  return new ConstExpr(name, c.value);
              }
              return new VariableExpr(name);
          }
          // const_literal
          if (this._match(TokenTypes.const_literal)) {
              return new LiteralExpr(parseFloat(this._previous().toString()));
          }
          // paren_expression
          if (this._check(TokenTypes.tokens.paren_left)) {
              return this._paren_expression();
          }
          // bitcast less_than type_decl greater_than paren_expression
          if (this._match(TokenTypes.keywords.bitcast)) {
              this._consume(TokenTypes.tokens.less_than, "Expected '<'.");
              const type = this._type_decl();
              this._consume(TokenTypes.tokens.greater_than, "Expected '>'.");
              const value = this._paren_expression();
              return new BitcastExpr(type, value);
          }
          // type_decl argument_expression_list
          const type = this._type_decl();
          const args = this._argument_expression_list();
          return new TypecastExpr(type, args);
      }
      _argument_expression_list() {
          // paren_left ((short_circuit_or_expression comma)* short_circuit_or_expression comma?)? paren_right
          if (!this._match(TokenTypes.tokens.paren_left))
              return null;
          const args = [];
          do {
              if (this._check(TokenTypes.tokens.paren_right))
                  break;
              const arg = this._short_circuit_or_expression();
              args.push(arg);
          } while (this._match(TokenTypes.tokens.comma));
          this._consume(TokenTypes.tokens.paren_right, "Expected ')' for agument list");
          return args;
      }
      _optional_paren_expression() {
          // [paren_left] short_circuit_or_expression [paren_right]
          this._match(TokenTypes.tokens.paren_left);
          const expr = this._short_circuit_or_expression();
          this._match(TokenTypes.tokens.paren_right);
          return new GroupingExpr([expr]);
      }
      _paren_expression() {
          // paren_left short_circuit_or_expression paren_right
          this._consume(TokenTypes.tokens.paren_left, "Expected '('.");
          const expr = this._short_circuit_or_expression();
          this._consume(TokenTypes.tokens.paren_right, "Expected ')'.");
          return new GroupingExpr([expr]);
      }
      _struct_decl() {
          // attribute* struct ident struct_body_decl
          if (!this._match(TokenTypes.keywords.struct))
              return null;
          const name = this._consume(TokenTypes.tokens.ident, "Expected name for struct.").toString();
          // struct_body_decl: brace_left (struct_member comma)* struct_member comma? brace_right
          this._consume(TokenTypes.tokens.brace_left, "Expected '{' for struct body.");
          const members = [];
          while (!this._check(TokenTypes.tokens.brace_right)) {
              // struct_member: attribute* variable_ident_decl
              const memberAttrs = this._attribute();
              const memberName = this._consume(TokenTypes.tokens.ident, "Expected variable name.").toString();
              this._consume(TokenTypes.tokens.colon, "Expected ':' for struct member type.");
              const typeAttrs = this._attribute();
              const memberType = this._type_decl();
              if (memberType != null)
                  memberType.attributes = typeAttrs;
              if (!this._check(TokenTypes.tokens.brace_right))
                  this._consume(TokenTypes.tokens.comma, "Expected ',' for struct member.");
              else
                  this._match(TokenTypes.tokens.comma); // trailing comma optional.
              members.push(new Member(memberName, memberType, memberAttrs));
          }
          this._consume(TokenTypes.tokens.brace_right, "Expected '}' after struct body.");
          const structNode = new Struct(name, members);
          this._context.structs.set(name, structNode);
          return structNode;
      }
      _global_variable_decl() {
          // attribute* variable_decl (equal const_expression)?
          const _var = this._variable_decl();
          if (_var && this._match(TokenTypes.tokens.equal))
              _var.value = this._const_expression();
          return _var;
      }
      _override_variable_decl() {
          // attribute* override_decl (equal const_expression)?
          const _override = this._override_decl();
          if (_override && this._match(TokenTypes.tokens.equal))
              _override.value = this._const_expression();
          return _override;
      }
      _global_const_decl() {
          // attribute* const (ident variable_ident_decl) global_const_initializer?
          if (!this._match(TokenTypes.keywords.const))
              return null;
          const name = this._consume(TokenTypes.tokens.ident, "Expected variable name");
          let type = null;
          if (this._match(TokenTypes.tokens.colon)) {
              const attrs = this._attribute();
              type = this._type_decl();
              if (type != null)
                  type.attributes = attrs;
          }
          let value = null;
          if (this._match(TokenTypes.tokens.equal)) {
              const valueExpr = this._short_circuit_or_expression();
              if (valueExpr instanceof CreateExpr) {
                  value = valueExpr;
              }
              else if (valueExpr instanceof ConstExpr &&
                  valueExpr.initializer instanceof CreateExpr) {
                  value = valueExpr.initializer;
              }
              else {
                  try {
                      const constValue = valueExpr.evaluate(this._context);
                      value = new LiteralExpr(constValue);
                  }
                  catch (_a) {
                      value = valueExpr;
                  }
              }
          }
          const c = new Const(name.toString(), type, "", "", value);
          this._context.constants.set(c.name, c);
          return c;
      }
      _global_let_decl() {
          // attribute* let (ident variable_ident_decl) global_const_initializer?
          if (!this._match(TokenTypes.keywords.let))
              return null;
          const name = this._consume(TokenTypes.tokens.ident, "Expected variable name");
          let type = null;
          if (this._match(TokenTypes.tokens.colon)) {
              const attrs = this._attribute();
              type = this._type_decl();
              if (type != null)
                  type.attributes = attrs;
          }
          let value = null;
          if (this._match(TokenTypes.tokens.equal)) {
              value = this._const_expression();
          }
          return new Let(name.toString(), type, "", "", value);
      }
      _const_expression() {
          // type_decl paren_left ((const_expression comma)* const_expression comma?)? paren_right
          // const_literal
          if (this._match(TokenTypes.const_literal))
              return new StringExpr(this._previous().toString());
          const type = this._type_decl();
          this._consume(TokenTypes.tokens.paren_left, "Expected '('.");
          let args = [];
          while (!this._check(TokenTypes.tokens.paren_right)) {
              args.push(this._const_expression());
              if (!this._check(TokenTypes.tokens.comma))
                  break;
              this._advance();
          }
          this._consume(TokenTypes.tokens.paren_right, "Expected ')'.");
          return new CreateExpr(type, args);
      }
      _variable_decl() {
          // var variable_qualifier? (ident variable_ident_decl)
          if (!this._match(TokenTypes.keywords.var))
              return null;
          // variable_qualifier: less_than storage_class (comma access_mode)? greater_than
          let storage = "";
          let access = "";
          if (this._match(TokenTypes.tokens.less_than)) {
              storage = this._consume(TokenTypes.storage_class, "Expected storage_class.").toString();
              if (this._match(TokenTypes.tokens.comma))
                  access = this._consume(TokenTypes.access_mode, "Expected access_mode.").toString();
              this._consume(TokenTypes.tokens.greater_than, "Expected '>'.");
          }
          const name = this._consume(TokenTypes.tokens.ident, "Expected variable name");
          let type = null;
          if (this._match(TokenTypes.tokens.colon)) {
              const attrs = this._attribute();
              type = this._type_decl();
              if (type != null)
                  type.attributes = attrs;
          }
          return new Var(name.toString(), type, storage, access, null);
      }
      _override_decl() {
          // override (ident variable_ident_decl)
          if (!this._match(TokenTypes.keywords.override))
              return null;
          const name = this._consume(TokenTypes.tokens.ident, "Expected variable name");
          let type = null;
          if (this._match(TokenTypes.tokens.colon)) {
              const attrs = this._attribute();
              type = this._type_decl();
              if (type != null)
                  type.attributes = attrs;
          }
          return new Override(name.toString(), type, null);
      }
      _diagnostic() {
          // diagnostic(severity_control_name, diagnostic_rule_name)
          this._consume(TokenTypes.tokens.paren_left, "Expected '('");
          const severity = this._consume(TokenTypes.tokens.ident, "Expected severity control name.");
          this._consume(TokenTypes.tokens.comma, "Expected ','");
          const rule = this._consume(TokenTypes.tokens.ident, "Expected diagnostic rule name.");
          this._consume(TokenTypes.tokens.paren_right, "Expected ')'");
          return new Diagnostic(severity.toString(), rule.toString());
      }
      _enable_directive() {
          // enable ident semicolon
          const name = this._consume(TokenTypes.tokens.ident, "identity expected.");
          return new Enable(name.toString());
      }
      _type_alias() {
          // type ident equal type_decl
          const name = this._consume(TokenTypes.tokens.ident, "identity expected.");
          this._consume(TokenTypes.tokens.equal, "Expected '=' for type alias.");
          let aliasType = this._type_decl();
          if (aliasType === null) {
              throw this._error(this._peek(), "Expected Type for Alias.");
          }
          if (this._context.aliases.has(aliasType.name)) {
              aliasType = this._context.aliases.get(aliasType.name).type;
          }
          const aliasNode = new Alias(name.toString(), aliasType);
          this._context.aliases.set(aliasNode.name, aliasNode);
          return aliasNode;
      }
      _type_decl() {
          // ident
          // bool
          // float32
          // int32
          // uint32
          // vec2 less_than type_decl greater_than
          // vec3 less_than type_decl greater_than
          // vec4 less_than type_decl greater_than
          // mat2x2 less_than type_decl greater_than
          // mat2x3 less_than type_decl greater_than
          // mat2x4 less_than type_decl greater_than
          // mat3x2 less_than type_decl greater_than
          // mat3x3 less_than type_decl greater_than
          // mat3x4 less_than type_decl greater_than
          // mat4x2 less_than type_decl greater_than
          // mat4x3 less_than type_decl greater_than
          // mat4x4 less_than type_decl greater_than
          // atomic less_than type_decl greater_than
          // pointer less_than storage_class comma type_decl (comma access_mode)? greater_than
          // array_type_decl
          // texture_sampler_types
          if (this._check([
              TokenTypes.tokens.ident,
              ...TokenTypes.texel_format,
              TokenTypes.keywords.bool,
              TokenTypes.keywords.f32,
              TokenTypes.keywords.i32,
              TokenTypes.keywords.u32,
          ])) {
              const type = this._advance();
              const typeName = type.toString();
              if (this._context.structs.has(typeName)) {
                  return this._context.structs.get(typeName);
              }
              if (this._context.aliases.has(typeName)) {
                  return this._context.aliases.get(typeName).type;
              }
              return new Type(type.toString());
          }
          // texture_sampler_types
          let type = this._texture_sampler_types();
          if (type)
              return type;
          if (this._check(TokenTypes.template_types)) {
              let type = this._advance().toString();
              let format = null;
              let access = null;
              if (this._match(TokenTypes.tokens.less_than)) {
                  format = this._type_decl();
                  access = null;
                  if (this._match(TokenTypes.tokens.comma))
                      access = this._consume(TokenTypes.access_mode, "Expected access_mode for pointer").toString();
                  this._consume(TokenTypes.tokens.greater_than, "Expected '>' for type.");
              }
              return new TemplateType(type, format, access);
          }
          // pointer less_than storage_class comma type_decl (comma access_mode)? greater_than
          if (this._match(TokenTypes.keywords.ptr)) {
              let pointer = this._previous().toString();
              this._consume(TokenTypes.tokens.less_than, "Expected '<' for pointer.");
              const storage = this._consume(TokenTypes.storage_class, "Expected storage_class for pointer");
              this._consume(TokenTypes.tokens.comma, "Expected ',' for pointer.");
              const decl = this._type_decl();
              let access = null;
              if (this._match(TokenTypes.tokens.comma))
                  access = this._consume(TokenTypes.access_mode, "Expected access_mode for pointer").toString();
              this._consume(TokenTypes.tokens.greater_than, "Expected '>' for pointer.");
              return new PointerType(pointer, storage.toString(), decl, access);
          }
          // The following type_decl's have an optional attribyte_list*
          const attrs = this._attribute();
          // attribute* array
          // attribute* array less_than type_decl (comma element_count_expression)? greater_than
          if (this._match(TokenTypes.keywords.array)) {
              let format = null;
              let countInt = -1;
              const array = this._previous();
              if (this._match(TokenTypes.tokens.less_than)) {
                  format = this._type_decl();
                  if (this._context.aliases.has(format.name)) {
                      format = this._context.aliases.get(format.name).type;
                  }
                  let count = "";
                  if (this._match(TokenTypes.tokens.comma)) {
                      let c = this._shift_expression();
                      count = c.evaluate(this._context).toString();
                  }
                  this._consume(TokenTypes.tokens.greater_than, "Expected '>' for array.");
                  countInt = count ? parseInt(count) : 0;
              }
              return new ArrayType(array.toString(), attrs, format, countInt);
          }
          return null;
      }
      _texture_sampler_types() {
          // sampler_type
          if (this._match(TokenTypes.sampler_type))
              return new SamplerType(this._previous().toString(), null, null);
          // depth_texture_type
          if (this._match(TokenTypes.depth_texture_type))
              return new SamplerType(this._previous().toString(), null, null);
          // sampled_texture_type less_than type_decl greater_than
          // multisampled_texture_type less_than type_decl greater_than
          if (this._match(TokenTypes.sampled_texture_type) ||
              this._match(TokenTypes.multisampled_texture_type)) {
              const sampler = this._previous();
              this._consume(TokenTypes.tokens.less_than, "Expected '<' for sampler type.");
              const format = this._type_decl();
              this._consume(TokenTypes.tokens.greater_than, "Expected '>' for sampler type.");
              return new SamplerType(sampler.toString(), format, null);
          }
          // storage_texture_type less_than texel_format comma access_mode greater_than
          if (this._match(TokenTypes.storage_texture_type)) {
              const sampler = this._previous();
              this._consume(TokenTypes.tokens.less_than, "Expected '<' for sampler type.");
              const format = this._consume(TokenTypes.texel_format, "Invalid texel format.").toString();
              this._consume(TokenTypes.tokens.comma, "Expected ',' after texel format.");
              const access = this._consume(TokenTypes.access_mode, "Expected access mode for storage texture type.").toString();
              this._consume(TokenTypes.tokens.greater_than, "Expected '>' for sampler type.");
              return new SamplerType(sampler.toString(), format, access);
          }
          return null;
      }
      _attribute() {
          // attr ident paren_left (literal_or_ident comma)* literal_or_ident paren_right
          // attr ident
          let attributes = [];
          while (this._match(TokenTypes.tokens.attr)) {
              const name = this._consume(TokenTypes.attribute_name, "Expected attribute name");
              const attr = new Attribute(name.toString(), null);
              if (this._match(TokenTypes.tokens.paren_left)) {
                  // literal_or_ident
                  attr.value = this._consume(TokenTypes.literal_or_ident, "Expected attribute value").toString();
                  if (this._check(TokenTypes.tokens.comma)) {
                      this._advance();
                      do {
                          const v = this._consume(TokenTypes.literal_or_ident, "Expected attribute value").toString();
                          if (!(attr.value instanceof Array)) {
                              attr.value = [attr.value];
                          }
                          attr.value.push(v);
                      } while (this._match(TokenTypes.tokens.comma));
                  }
                  this._consume(TokenTypes.tokens.paren_right, "Expected ')'");
              }
              attributes.push(attr);
          }
          // Deprecated:
          // attr_left (attribute comma)* attribute attr_right
          while (this._match(TokenTypes.tokens.attr_left)) {
              if (!this._check(TokenTypes.tokens.attr_right)) {
                  do {
                      const name = this._consume(TokenTypes.attribute_name, "Expected attribute name");
                      const attr = new Attribute(name.toString(), null);
                      if (this._match(TokenTypes.tokens.paren_left)) {
                          // literal_or_ident
                          attr.value = [
                              this._consume(TokenTypes.literal_or_ident, "Expected attribute value").toString(),
                          ];
                          if (this._check(TokenTypes.tokens.comma)) {
                              this._advance();
                              do {
                                  const v = this._consume(TokenTypes.literal_or_ident, "Expected attribute value").toString();
                                  attr.value.push(v);
                              } while (this._match(TokenTypes.tokens.comma));
                          }
                          this._consume(TokenTypes.tokens.paren_right, "Expected ')'");
                      }
                      attributes.push(attr);
                  } while (this._match(TokenTypes.tokens.comma));
              }
              // Consume ]]
              this._consume(TokenTypes.tokens.attr_right, "Expected ']]' after attribute declarations");
          }
          if (attributes.length == 0)
              return null;
          return attributes;
      }
  }

  /**
   * @author Brendan Duncan / https://github.com/brendan-duncan
   */
  class TypeInfo {
      constructor(name, attributes) {
          this.name = name;
          this.attributes = attributes;
          this.size = 0;
      }
      get isArray() {
          return false;
      }
      get isStruct() {
          return false;
      }
      get isTemplate() {
          return false;
      }
  }
  class MemberInfo {
      constructor(name, type, attributes) {
          this.name = name;
          this.type = type;
          this.attributes = attributes;
          this.offset = 0;
          this.size = 0;
      }
      get isArray() {
          return this.type.isArray;
      }
      get isStruct() {
          return this.type.isStruct;
      }
      get isTemplate() {
          return this.type.isTemplate;
      }
      get align() {
          return this.type.isStruct ? this.type.align : 0;
      }
      get members() {
          return this.type.isStruct ? this.type.members : null;
      }
      get format() {
          return this.type.isArray
              ? this.type.format
              : this.type.isTemplate
                  ? this.type.format
                  : null;
      }
      get count() {
          return this.type.isArray ? this.type.count : 0;
      }
      get stride() {
          return this.type.isArray ? this.type.stride : this.size;
      }
  }
  class StructInfo extends TypeInfo {
      constructor(name, attributes) {
          super(name, attributes);
          this.members = [];
          this.align = 0;
      }
      get isStruct() {
          return true;
      }
  }
  class ArrayInfo extends TypeInfo {
      constructor(name, attributes) {
          super(name, attributes);
          this.count = 0;
          this.stride = 0;
      }
      get isArray() {
          return true;
      }
  }
  class TemplateInfo extends TypeInfo {
      constructor(name, format, attributes, access) {
          super(name, attributes);
          this.format = format;
          this.access = access;
      }
      get isTemplate() {
          return true;
      }
  }
  var ResourceType;
  (function (ResourceType) {
      ResourceType[ResourceType["Uniform"] = 0] = "Uniform";
      ResourceType[ResourceType["Storage"] = 1] = "Storage";
      ResourceType[ResourceType["Texture"] = 2] = "Texture";
      ResourceType[ResourceType["Sampler"] = 3] = "Sampler";
      ResourceType[ResourceType["StorageTexture"] = 4] = "StorageTexture";
  })(ResourceType || (ResourceType = {}));
  class VariableInfo {
      constructor(name, type, group, binding, attributes, resourceType, access) {
          this.name = name;
          this.type = type;
          this.group = group;
          this.binding = binding;
          this.attributes = attributes;
          this.resourceType = resourceType;
          this.access = access;
      }
      get isArray() {
          return this.type.isArray;
      }
      get isStruct() {
          return this.type.isStruct;
      }
      get isTemplate() {
          return this.type.isTemplate;
      }
      get size() {
          return this.type.size;
      }
      get align() {
          return this.type.isStruct ? this.type.align : 0;
      }
      get members() {
          return this.type.isStruct ? this.type.members : null;
      }
      get format() {
          return this.type.isArray
              ? this.type.format
              : this.type.isTemplate
                  ? this.type.format
                  : null;
      }
      get count() {
          return this.type.isArray ? this.type.count : 0;
      }
      get stride() {
          return this.type.isArray ? this.type.stride : this.size;
      }
  }
  class AliasInfo {
      constructor(name, type) {
          this.name = name;
          this.type = type;
      }
  }
  class _TypeSize {
      constructor(align, size) {
          this.align = align;
          this.size = size;
      }
  }
  class InputInfo {
      constructor(name, type, locationType, location) {
          this.name = name;
          this.type = type;
          this.locationType = locationType;
          this.location = location;
          this.interpolation = null;
      }
  }
  class OutputInfo {
      constructor(name, type, locationType, location) {
          this.name = name;
          this.type = type;
          this.locationType = locationType;
          this.location = location;
      }
  }
  class FunctionInfo {
      constructor(name, stage = null) {
          this.stage = null;
          this.inputs = [];
          this.outputs = [];
          this.resources = [];
          this.name = name;
          this.stage = stage;
      }
  }
  class EntryFunctions {
      constructor() {
          this.vertex = [];
          this.fragment = [];
          this.compute = [];
      }
  }
  class OverrideInfo {
      constructor(name, type, attributes, id) {
          this.name = name;
          this.type = type;
          this.attributes = attributes;
          this.id = id;
      }
  }
  class _FunctionResources {
      constructor(node) {
          this.resources = null;
          this.node = node;
      }
  }
  class WgslReflect {
      constructor(code) {
          /// All top-level uniform vars in the shader.
          this.uniforms = [];
          /// All top-level storage vars in the shader.
          this.storage = [];
          /// All top-level texture vars in the shader;
          this.textures = [];
          // All top-level sampler vars in the shader.
          this.samplers = [];
          /// All top-level type aliases in the shader.
          this.aliases = [];
          /// All top-level overrides in the shader.
          this.overrides = [];
          /// All top-level structs in the shader.
          this.structs = [];
          /// All entry functions in the shader: vertex, fragment, and/or compute.
          this.entry = new EntryFunctions();
          this._types = new Map();
          this._functions = new Map();
          if (code) {
              this.update(code);
          }
      }
      _isStorageTexture(type) {
          return (type.name == "texture_storage_1d" ||
              type.name == "texture_storage_2d" ||
              type.name == "texture_storage_2d_array" ||
              type.name == "texture_storage_3d");
      }
      update(code) {
          const parser = new WgslParser();
          const ast = parser.parse(code);
          for (const node of ast) {
              if (node instanceof Function) {
                  this._functions.set(node.name, new _FunctionResources(node));
              }
          }
          for (const node of ast) {
              if (node instanceof Struct) {
                  const info = this._getTypeInfo(node, null);
                  if (info instanceof StructInfo) {
                      this.structs.push(info);
                  }
                  continue;
              }
              if (node instanceof Alias) {
                  this.aliases.push(this._getAliasInfo(node));
                  continue;
              }
              if (node instanceof Override) {
                  const v = node;
                  const id = this._getAttributeNum(v.attributes, "id", 0);
                  const type = v.type != null ? this._getTypeInfo(v.type, v.attributes) : null;
                  this.overrides.push(new OverrideInfo(v.name, type, v.attributes, id));
                  continue;
              }
              if (this._isUniformVar(node)) {
                  const v = node;
                  const g = this._getAttributeNum(v.attributes, "group", 0);
                  const b = this._getAttributeNum(v.attributes, "binding", 0);
                  const type = this._getTypeInfo(v.type, v.attributes);
                  const varInfo = new VariableInfo(v.name, type, g, b, v.attributes, ResourceType.Uniform, v.access);
                  this.uniforms.push(varInfo);
                  continue;
              }
              if (this._isStorageVar(node)) {
                  const v = node;
                  const g = this._getAttributeNum(v.attributes, "group", 0);
                  const b = this._getAttributeNum(v.attributes, "binding", 0);
                  const type = this._getTypeInfo(v.type, v.attributes);
                  const isStorageTexture = this._isStorageTexture(type);
                  const varInfo = new VariableInfo(v.name, type, g, b, v.attributes, isStorageTexture ? ResourceType.StorageTexture : ResourceType.Storage, v.access);
                  this.storage.push(varInfo);
                  continue;
              }
              if (this._isTextureVar(node)) {
                  const v = node;
                  const g = this._getAttributeNum(v.attributes, "group", 0);
                  const b = this._getAttributeNum(v.attributes, "binding", 0);
                  const type = this._getTypeInfo(v.type, v.attributes);
                  const isStorageTexture = this._isStorageTexture(type);
                  const varInfo = new VariableInfo(v.name, type, g, b, v.attributes, isStorageTexture ? ResourceType.StorageTexture : ResourceType.Texture, v.access);
                  if (isStorageTexture) {
                      this.storage.push(varInfo);
                  }
                  else {
                      this.textures.push(varInfo);
                  }
                  continue;
              }
              if (this._isSamplerVar(node)) {
                  const v = node;
                  const g = this._getAttributeNum(v.attributes, "group", 0);
                  const b = this._getAttributeNum(v.attributes, "binding", 0);
                  const type = this._getTypeInfo(v.type, v.attributes);
                  const varInfo = new VariableInfo(v.name, type, g, b, v.attributes, ResourceType.Sampler, v.access);
                  this.samplers.push(varInfo);
                  continue;
              }
              if (node instanceof Function) {
                  const vertexStage = this._getAttribute(node, "vertex");
                  const fragmentStage = this._getAttribute(node, "fragment");
                  const computeStage = this._getAttribute(node, "compute");
                  const stage = vertexStage || fragmentStage || computeStage;
                  if (stage) {
                      const fn = new FunctionInfo(node.name, stage === null || stage === void 0 ? void 0 : stage.name);
                      fn.inputs = this._getInputs(node.args);
                      fn.outputs = this._getOutputs(node.returnType);
                      fn.resources = this._findResources(node);
                      this.entry[stage.name].push(fn);
                  }
                  continue;
              }
          }
      }
      _findResource(name) {
          for (const u of this.uniforms) {
              if (u.name == name) {
                  return u;
              }
          }
          for (const s of this.storage) {
              if (s.name == name) {
                  return s;
              }
          }
          for (const t of this.textures) {
              if (t.name == name) {
                  return t;
              }
          }
          for (const s of this.samplers) {
              if (s.name == name) {
                  return s;
              }
          }
          return null;
      }
      _findResources(fn) {
          const resources = [];
          const self = this;
          const varStack = [];
          fn.search((node) => {
              if (node instanceof _BlockStart) {
                  varStack.push({});
              }
              else if (node instanceof _BlockEnd) {
                  varStack.pop();
              }
              else if (node instanceof Var) {
                  if (varStack.length > 0) {
                      const v = node;
                      varStack[varStack.length - 1][v.name] = v;
                  }
              }
              else if (node instanceof Let) {
                  if (varStack.length > 0) {
                      const v = node;
                      varStack[varStack.length - 1][v.name] = v;
                  }
              }
              else if (node instanceof VariableExpr) {
                  const v = node;
                  // Check to see if the variable is a local variable before checking to see if it's
                  // a resource.
                  if (varStack.length > 0) {
                      const varInfo = varStack[varStack.length - 1][v.name];
                      if (varInfo) {
                          return;
                      }
                  }
                  const varInfo = self._findResource(v.name);
                  if (varInfo) {
                      resources.push(varInfo);
                  }
              }
              else if (node instanceof CallExpr) {
                  const c = node;
                  const fn = self._functions.get(c.name);
                  if (fn) {
                      if (fn.resources === null) {
                          fn.resources = self._findResources(fn.node);
                      }
                      resources.push(...fn.resources);
                  }
              }
          });
          return resources;
      }
      getBindGroups() {
          const groups = [];
          function _makeRoom(group, binding) {
              if (group >= groups.length)
                  groups.length = group + 1;
              if (groups[group] === undefined)
                  groups[group] = [];
              if (binding >= groups[group].length)
                  groups[group].length = binding + 1;
          }
          for (const u of this.uniforms) {
              _makeRoom(u.group, u.binding);
              const group = groups[u.group];
              group[u.binding] = u;
          }
          for (const u of this.storage) {
              _makeRoom(u.group, u.binding);
              const group = groups[u.group];
              group[u.binding] = u;
          }
          for (const t of this.textures) {
              _makeRoom(t.group, t.binding);
              const group = groups[t.group];
              group[t.binding] = t;
          }
          for (const t of this.samplers) {
              _makeRoom(t.group, t.binding);
              const group = groups[t.group];
              group[t.binding] = t;
          }
          return groups;
      }
      _getOutputs(type, outputs = undefined) {
          if (outputs === undefined)
              outputs = [];
          if (type instanceof Struct) {
              this._getStructOutputs(type, outputs);
          }
          else {
              const output = this._getOutputInfo(type);
              if (output !== null)
                  outputs.push(output);
          }
          return outputs;
      }
      _getStructOutputs(struct, outputs) {
          for (const m of struct.members) {
              if (m.type instanceof Struct) {
                  this._getStructOutputs(m.type, outputs);
              }
              else {
                  const location = this._getAttribute(m, "location") || this._getAttribute(m, "builtin");
                  if (location !== null) {
                      const typeInfo = this._getTypeInfo(m.type, m.type.attributes);
                      const locationValue = this._parseInt(location.value);
                      const info = new OutputInfo(m.name, typeInfo, location.name, locationValue);
                      outputs.push(info);
                  }
              }
          }
      }
      _getOutputInfo(type) {
          const location = this._getAttribute(type, "location") ||
              this._getAttribute(type, "builtin");
          if (location !== null) {
              const typeInfo = this._getTypeInfo(type, type.attributes);
              const locationValue = this._parseInt(location.value);
              const info = new OutputInfo("", typeInfo, location.name, locationValue);
              return info;
          }
          return null;
      }
      _getInputs(args, inputs = undefined) {
          if (inputs === undefined)
              inputs = [];
          for (const arg of args) {
              if (arg.type instanceof Struct) {
                  this._getStructInputs(arg.type, inputs);
              }
              else {
                  const input = this._getInputInfo(arg);
                  if (input !== null)
                      inputs.push(input);
              }
          }
          return inputs;
      }
      _getStructInputs(struct, inputs) {
          for (const m of struct.members) {
              if (m.type instanceof Struct) {
                  this._getStructInputs(m.type, inputs);
              }
              else {
                  const input = this._getInputInfo(m);
                  if (input !== null)
                      inputs.push(input);
              }
          }
      }
      _getInputInfo(node) {
          const location = this._getAttribute(node, "location") ||
              this._getAttribute(node, "builtin");
          if (location !== null) {
              const interpolation = this._getAttribute(node, "interpolation");
              const type = this._getTypeInfo(node.type, node.attributes);
              const locationValue = this._parseInt(location.value);
              const info = new InputInfo(node.name, type, location.name, locationValue);
              if (interpolation !== null) {
                  info.interpolation = this._parseString(interpolation.value);
              }
              return info;
          }
          return null;
      }
      _parseString(s) {
          if (s instanceof Array) {
              s = s[0];
          }
          return s;
      }
      _parseInt(s) {
          if (s instanceof Array) {
              s = s[0];
          }
          const n = parseInt(s);
          return isNaN(n) ? s : n;
      }
      _getAlias(name) {
          for (const a of this.aliases) {
              if (a.name == name)
                  return a.type;
          }
          return null;
      }
      _getAliasInfo(node) {
          return new AliasInfo(node.name, this._getTypeInfo(node.type, null));
      }
      _getTypeInfo(type, attributes) {
          if (this._types.has(type)) {
              return this._types.get(type);
          }
          if (type instanceof ArrayType) {
              const a = type;
              const t = this._getTypeInfo(a.format, a.attributes);
              const info = new ArrayInfo(a.name, attributes);
              info.format = t;
              info.count = a.count;
              this._types.set(type, info);
              this._updateTypeInfo(info);
              return info;
          }
          if (type instanceof Struct) {
              const s = type;
              const info = new StructInfo(s.name, attributes);
              for (const m of s.members) {
                  const t = this._getTypeInfo(m.type, m.attributes);
                  info.members.push(new MemberInfo(m.name, t, m.attributes));
              }
              this._types.set(type, info);
              this._updateTypeInfo(info);
              return info;
          }
          if (type instanceof SamplerType) {
              const s = type;
              const formatIsType = s.format instanceof Type;
              const format = s.format
                  ? formatIsType
                      ? this._getTypeInfo(s.format, null)
                      : new TypeInfo(s.format, null)
                  : null;
              const info = new TemplateInfo(s.name, format, attributes, s.access);
              this._types.set(type, info);
              this._updateTypeInfo(info);
              return info;
          }
          if (type instanceof TemplateType) {
              const t = type;
              const format = t.format ? this._getTypeInfo(t.format, null) : null;
              const info = new TemplateInfo(t.name, format, attributes, t.access);
              this._types.set(type, info);
              this._updateTypeInfo(info);
              return info;
          }
          const info = new TypeInfo(type.name, attributes);
          this._types.set(type, info);
          this._updateTypeInfo(info);
          return info;
      }
      _updateTypeInfo(type) {
          var _a, _b;
          const typeSize = this._getTypeSize(type);
          type.size = (_a = typeSize === null || typeSize === void 0 ? void 0 : typeSize.size) !== null && _a !== void 0 ? _a : 0;
          if (type instanceof ArrayInfo) {
              const formatInfo = this._getTypeSize(type["format"]);
              type.stride = (_b = formatInfo === null || formatInfo === void 0 ? void 0 : formatInfo.size) !== null && _b !== void 0 ? _b : 0;
              this._updateTypeInfo(type["format"]);
          }
          if (type instanceof StructInfo) {
              this._updateStructInfo(type);
          }
      }
      _updateStructInfo(struct) {
          var _a;
          let offset = 0;
          let lastSize = 0;
          let lastOffset = 0;
          let structAlign = 0;
          for (let mi = 0, ml = struct.members.length; mi < ml; ++mi) {
              const member = struct.members[mi];
              const sizeInfo = this._getTypeSize(member);
              if (!sizeInfo)
                  continue;
              (_a = this._getAlias(member.type.name)) !== null && _a !== void 0 ? _a : member.type;
              const align = sizeInfo.align;
              const size = sizeInfo.size;
              offset = this._roundUp(align, offset + lastSize);
              lastSize = size;
              lastOffset = offset;
              structAlign = Math.max(structAlign, align);
              member.offset = offset;
              member.size = size;
              this._updateTypeInfo(member.type);
          }
          struct.size = this._roundUp(structAlign, lastOffset + lastSize);
          struct.align = structAlign;
      }
      _getTypeSize(type) {
          var _a;
          if (type === null || type === undefined)
              return null;
          const explicitSize = this._getAttributeNum(type.attributes, "size", 0);
          const explicitAlign = this._getAttributeNum(type.attributes, "align", 0);
          if (type instanceof MemberInfo)
              type = type.type;
          if (type instanceof TypeInfo) {
              const alias = this._getAlias(type.name);
              if (alias !== null) {
                  type = alias;
              }
          }
          {
              const info = WgslReflect._typeInfo[type.name];
              if (info !== undefined) {
                  const divisor = type["format"] === "f16" ? 2 : 1;
                  return new _TypeSize(Math.max(explicitAlign, info.align / divisor), Math.max(explicitSize, info.size / divisor));
              }
          }
          {
              const info = WgslReflect._typeInfo[type.name.substring(0, type.name.length - 1)];
              if (info) {
                  const divisor = type.name[type.name.length - 1] === "h" ? 2 : 1;
                  return new _TypeSize(Math.max(explicitAlign, info.align / divisor), Math.max(explicitSize, info.size / divisor));
              }
          }
          if (type instanceof ArrayInfo) {
              let arrayType = type;
              let align = 8;
              let size = 8;
              // Type                 AlignOf(T)          Sizeof(T)
              // array<E, N>          AlignOf(E)          N * roundUp(AlignOf(E), SizeOf(E))
              // array<E>             AlignOf(E)          N * roundUp(AlignOf(E), SizeOf(E))  (N determined at runtime)
              //
              // @stride(Q)
              // array<E, N>          AlignOf(E)          N * Q
              //
              // @stride(Q)
              // array<E>             AlignOf(E)          Nruntime * Q
              //const E = type.format.name;
              const E = this._getTypeSize(arrayType.format);
              if (E !== null) {
                  size = E.size;
                  align = E.align;
              }
              const N = arrayType.count;
              const stride = this._getAttributeNum((_a = type === null || type === void 0 ? void 0 : type.attributes) !== null && _a !== void 0 ? _a : null, "stride", this._roundUp(align, size));
              size = N * stride;
              if (explicitSize)
                  size = explicitSize;
              return new _TypeSize(Math.max(explicitAlign, align), Math.max(explicitSize, size));
          }
          if (type instanceof StructInfo) {
              let align = 0;
              let size = 0;
              // struct S     AlignOf:    max(AlignOfMember(S, M1), ... , AlignOfMember(S, MN))
              //              SizeOf:     roundUp(AlignOf(S), OffsetOfMember(S, L) + SizeOfMember(S, L))
              //                          Where L is the last member of the structure
              let offset = 0;
              let lastSize = 0;
              let lastOffset = 0;
              for (const m of type.members) {
                  const mi = this._getTypeSize(m.type);
                  if (mi !== null) {
                      align = Math.max(mi.align, align);
                      offset = this._roundUp(mi.align, offset + lastSize);
                      lastSize = mi.size;
                      lastOffset = offset;
                  }
              }
              size = this._roundUp(align, lastOffset + lastSize);
              return new _TypeSize(Math.max(explicitAlign, align), Math.max(explicitSize, size));
          }
          return null;
      }
      _isUniformVar(node) {
          return node instanceof Var && node.storage == "uniform";
      }
      _isStorageVar(node) {
          return node instanceof Var && node.storage == "storage";
      }
      _isTextureVar(node) {
          return (node instanceof Var &&
              node.type !== null &&
              WgslReflect._textureTypes.indexOf(node.type.name) != -1);
      }
      _isSamplerVar(node) {
          return (node instanceof Var &&
              node.type !== null &&
              WgslReflect._samplerTypes.indexOf(node.type.name) != -1);
      }
      _getAttribute(node, name) {
          const obj = node;
          if (!obj || !obj["attributes"])
              return null;
          const attrs = obj["attributes"];
          for (let a of attrs) {
              if (a.name == name)
                  return a;
          }
          return null;
      }
      _getAttributeNum(attributes, name, defaultValue) {
          if (attributes === null)
              return defaultValue;
          for (let a of attributes) {
              if (a.name == name) {
                  let v = a !== null && a.value !== null ? a.value : defaultValue;
                  if (v instanceof Array) {
                      v = v[0];
                  }
                  if (typeof v === "number") {
                      return v;
                  }
                  if (typeof v === "string") {
                      return parseInt(v);
                  }
                  return defaultValue;
              }
          }
          return defaultValue;
      }
      _roundUp(k, n) {
          return Math.ceil(n / k) * k;
      }
  }
  // Type                 AlignOf(T)          Sizeof(T)
  // i32, u32, or f32     4                   4
  // atomic<T>            4                   4
  // vec2<T>              8                   8
  // vec3<T>              16                  12
  // vec4<T>              16                  16
  // mat2x2<f32>          8                   16
  // mat3x2<f32>          8                   24
  // mat4x2<f32>          8                   32
  // mat2x3<f32>          16                  32
  // mat3x3<f32>          16                  48
  // mat4x3<f32>          16                  64
  // mat2x4<f32>          16                  32
  // mat3x4<f32>          16                  48
  // mat4x4<f32>          16                  64
  WgslReflect._typeInfo = {
      f16: { align: 2, size: 2 },
      i32: { align: 4, size: 4 },
      u32: { align: 4, size: 4 },
      f32: { align: 4, size: 4 },
      atomic: { align: 4, size: 4 },
      vec2: { align: 8, size: 8 },
      vec3: { align: 16, size: 12 },
      vec4: { align: 16, size: 16 },
      mat2x2: { align: 8, size: 16 },
      mat3x2: { align: 8, size: 24 },
      mat4x2: { align: 8, size: 32 },
      mat2x3: { align: 16, size: 32 },
      mat3x3: { align: 16, size: 48 },
      mat4x3: { align: 16, size: 64 },
      mat2x4: { align: 16, size: 32 },
      mat3x4: { align: 16, size: 48 },
      mat4x4: { align: 16, size: 64 },
  };
  WgslReflect._textureTypes = TokenTypes.any_texture_type.map((t) => {
      return t.name;
  });
  WgslReflect._samplerTypes = TokenTypes.sampler_type.map((t) => {
      return t.name;
  });

  const stacktraceCache = new StacktraceCache();

  class GPUObject {
    constructor(id, stacktrace) {
      this.id = id;
      this.label = "";
      this._stacktrace = stacktraceCache.setStacktrace(stacktrace ?? "");
      this.parent = null;
      this.children = [];
      this._deletionTime = 0;
    }

    get name() {
      return this.label || this.constructor.name;
    }

    get stacktrace() {
      return stacktraceCache.getStacktrace(this._stacktrace);
    }
  }

  class Adapter extends GPUObject {
    constructor(id, descriptor, stacktrace) {
      super(id, stacktrace);
      this.descriptor = descriptor;
    }
  }

  class Device extends GPUObject {
    constructor(id, descriptor, stacktrace) {
      super(id, stacktrace);
      this.descriptor = descriptor;
    }
  }

  class Buffer extends GPUObject {
    constructor(id, descriptor, stacktrace) {
      super(id, stacktrace);
      this.descriptor = descriptor;
    }
  }

  class Sampler extends GPUObject {
    constructor(id, descriptor, stacktrace) {
      super(id, stacktrace);
      this.descriptor = descriptor;
    }
  }

  class Texture extends GPUObject {
    constructor(id, descriptor, stacktrace) {
      super(id, stacktrace);
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
    constructor(id, descriptor, stacktrace) {
      super(id, stacktrace);
      this.descriptor = descriptor;
    }
  }

  class ShaderModule extends GPUObject {
    constructor(id, descriptor, stacktrace) {
      super(id, stacktrace);
      this._reflection = null;
      this.descriptor = descriptor;
      this.hasVertexEntries = descriptor?.code ? descriptor.code.indexOf("@vertex") != -1 : false;
      this.hasFragmentEntries = descriptor?.code ? descriptor.code.indexOf("@fragment") != -1 : false;
      this.hasComputeEntries = descriptor?.code ? descriptor.code.indexOf("@compute") != -1 : false;
    }

    get code() {
      return this.descriptor?.code ?? "";
    }

    get reflection() {
      if (this._reflection === null) {
        this._reflection = new WgslReflect(this.code);
      }
      return this._reflection;
    }
  }

  class BindGroupLayout extends GPUObject {
    constructor(id, descriptor, stacktrace) {
      super(id, stacktrace);
      this.descriptor = descriptor;
    }
  }

  class PipelineLayout extends GPUObject {
    constructor(id, descriptor, stacktrace) {
      super(id, stacktrace);
      this.descriptor = descriptor;
    }
  }

  class BindGroup extends GPUObject {
    constructor(id, descriptor, stacktrace) {
      super(id, stacktrace);
      this.descriptor = descriptor;
    }
  }

  class RenderPipeline extends GPUObject {
    constructor(id, descriptor, stacktrace) {
      super(id, stacktrace);
      this.descriptor = descriptor;
    }

    get topology() {
      return this.descriptor?.primitive?.topology ?? "triangle-list";
    }
  }

  class ComputePipeline extends GPUObject {
    constructor(id, descriptor, stacktrace) {
      super(id, stacktrace);
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
          case "inspect_delete_objects": {
            const objects = message.idList;
            for (const id of objects) {
              self._deleteObject(id);
            }
            break;
          }
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
            const stacktrace = message.stacktrace ?? "";
            let descriptor = null;
            try {
              descriptor = message.descriptor ? JSON.parse(message.descriptor) : null;
            } catch (e) {
              break;
            }
            switch (message.type) {
              case "Adapter": {
                const obj = new Adapter(id, descriptor, stacktrace);
                self._addObject(obj, parent, pending);
                break;
              }
              case "Device": {
                const obj = new Device(id, descriptor, stacktrace);
                self._addObject(obj, parent, pending);
                break;
              }
              case "ShaderModule": {
                const obj = new ShaderModule(id, descriptor, stacktrace);
                self._addObject(obj, parent, pending);
                obj.size = descriptor?.code?.length ?? 0;
                break;
              }
              case "Buffer": {
                const obj = new Buffer(id, descriptor, stacktrace);
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
                const obj = new Texture(id, descriptor, stacktrace);
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
                const obj = new TextureView(id, descriptor, stacktrace);
                self._addObject(obj, parent, pending);
                break;
              }
              case "Sampler": {
                const obj = new Sampler(id, descriptor, stacktrace);
                self._addObject(obj, parent, pending);
                break;
              }
              case "BindGroup": {
                const obj = new BindGroup(id, descriptor, stacktrace);
                self._addObject(obj, parent, pending);
                break;
              }
              case "BindGroupLayout": {
                const obj = new BindGroupLayout(id, descriptor, stacktrace);
                self._addObject(obj, parent, pending);
                break;
              }
              case "RenderPipeline": {
                const obj = new RenderPipeline(id, descriptor, stacktrace);
                self._addObject(obj, parent, pending);
                break;
              }
              case "ComputePipeline": {
                const obj = new ComputePipeline(id, descriptor, stacktrace);
                self._addObject(obj, parent, pending);
                break;
              }
              case "PipelineLayout": {
                const obj = new PipelineLayout(id, descriptor, stacktrace);
                self._addObject(obj, parent, pending);
                break;
              }
            }
            break;
          }
        }
      });
    }

    _deleteOldRecycledObjects(objectList) {
      const recycleTime = 200;
      const time = performance.now();
      const numBindGroups = objectList.length;
      for (let i = numBindGroups - 1; i >= 0; --i) {
        const obj = objectList[i];
        if (!obj || (time - obj._deletionTime > recycleTime)) {
          objectList = objectList.splice(i, 1);
        }
      }
      return objectList;
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
          parentObject.children.push(new WeakRef(object));
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
      if (!object) {
        return;
      }

      this.allObjects.delete(id);

      if (object instanceof Adapter) {
        this.adapters.delete(id, object);
      } else if (object instanceof Device) {
        this.devices.delete(id, object);
      } else if (object instanceof Sampler) {
        this.samplers.delete(id, object);
      } else if (object instanceof Texture) {
        this.textures.delete(id, object);
        const size = object.getGpuSize();
        if (size != -1) {
          this.totalTextureMemory -= size;
        }
      } else if (object instanceof TextureView) {
        this.textureViews.delete(id, object);
        object._deletionTime = performance.now();
      } else if (object instanceof Buffer) {
        this.buffers.delete(id, object);
        const size = object.size;
        this.totalBufferMemory -= size ?? 0;
      } else if (object instanceof BindGroup) {
        this.bindGroups.delete(id, object);
        object._deletionTime = performance.now();
      } else if (object instanceof BindGroupLayout) {
        this.bindGroupLayouts.delete(id, object);
      } else if (object instanceof PipelineLayout) {
        this.pipelineLayouts.delete(id, object);
      } else if (object instanceof ShaderModule) {
        this.shaderModules.delete(id, object);
      } else if (object instanceof RenderPipeline) {
        this.pendingRenderPipelines.delete(id, object);
        this.renderPipelines.delete(id, object);
      } else if (object instanceof ComputePipeline) {
        this.computePipelines.set(id, object);
        this.pendingComputePipelines.delete(id, object);
      }

      if (object.parent) {
        const parent = object.parent;
        for (const ci in parent.children) {
          const child = parent.children[ci].deref();
          if (!child || child === object) {
            parent.children.splice(ci, 1);
            break;
          }
        }
      }

      for (const childRef of object.children) {
        const child = childRef.deref();
        if (child) {
          this._deleteObject(child.id);
        }
      }

      this.onDeleteObject.emit(id, object);
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
      try {
        this._port.postMessage(message);
      } catch (e) {
        this.reset();
      }
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
      this.onExpanded = new Signal();
      this.onCollapsed = new Signal();

      this.body = new Div(this, { class: ["object_list"] });
      if (collapsed) {
        this.body.element.className = "object_list collapsed";
      }

      const self = this;

      this.titleBar.element.onclick = function() {
        if (self.collapseButton.text == "-") {
          self.collapseButton.text = "+";
          self.body.element.className = "object_list collapsed";
          self.onCollapsed.emit();
        } else {
          self.collapseButton.text = "-";
          self.body.element.className = "object_list";
          self.onExpanded.emit();
        }
      };
    }

    get collapsed() {
      return this.collapseButton.text == "+";
    }

    set collapsed(value) {
      if (this.collapsed == value) {
        return;
      }
      if (value) {
        this.collapseButton.text = "+";
        this.body.element.className = "object_list collapsed";
        this.onCollapsed.emit();
      } else {
        this.collapseButton.text = "-";
        this.body.element.className = "object_list";
        this.onExpanded.emit();
      }
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

      this._captureFrame = new Span(controlBar, { style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });
      this._captureStatus = new Span(controlBar, { style: "margin-left: 20px; margin-right: 10px; vertical-align: middle;" });

      this._capturePanel = new Div(parent, { style: "overflow: hidden; white-space: nowrap; height: calc(-100px + 100vh); display: flex;" });

      window.onTextureLoaded.addListener(this._textureLoaded, this);

      this._loadingImages = 0;

      this._captureCommands = [];
      this._catpureFrameIndex = 0;
      this._captureCount = 0;

      port.addListener((message) => {
        switch (message.action) {
          case "inspect_capture_texture_frames": {
            self._loadingImages = message.count ?? 0;
            self._captureStatus.text = `Loading Images: ${self._loadingImages}`;
            break;
          }
          case "inspect_capture_frame_results": {
            const frame = message.frame;
            const count = message.count;
            const batches = message.batches;
            self._captureCommands.length = count;
            self._catpureFrameIndex = frame;
            self._captureCount = batches;
            break;
          }
          case "inspect_capture_frame_commands": {
            const commands = message.commands;
            const index = message.index;
            const count = message.count;
            const frame = message.frame;
            if (frame !== self._catpureFrameIndex) {
              return;
            }
            for (let i = 0, j = index; i < count; ++i, ++j) {
              self._captureCommands[j] = commands[i];
            }
            self._captureCount--;
            if (self._captureCount === 0) {
              self._captureFrameResults(frame, self._captureCommands);
            }
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
      
      let renderPassIndex = 0;

      const debugGroupStack = [frameContents];
      const debugGroupLabelStack = [];
      let debugGroupIndex = 0;

      let currentBlock = new Div(frameContents, { class: "capture_commandBlock" });

      this._lastSelectedCommand = null;

      let first = true;
      for (let commandIndex = 0, numCommands = commands.length; commandIndex < numCommands; ++commandIndex) {
        const command = commands[commandIndex];
        if (!command) {
          break;
        }
        const className = command.class;
        const method = command.method;
        const args = command.args;
        const name = `${className ?? "__"}`;

        let debugGroup = debugGroupStack[debugGroupStack.length - 1];

        if (method === "beginRenderPass") {
          currentBlock = new Div(debugGroup, { class: "capture_renderpass" });
          new Div(currentBlock, { text: `Render Pass ${renderPassIndex}`, id: `RenderPass_${renderPassIndex}`, style: "padding-left: 20px; font-size: 12pt; color: #ddd; margin-bottom: 5px; background-color: #553; line-height: 30px;" });
          renderPassIndex++;
        } else if (method === "beginComputePass") {
          currentBlock = new Div(debugGroup, { class: "capture_computepass" });
        } else if (method === "popDebugGroup") {
          debugGroupStack.pop();
          debugGroup = debugGroupStack[debugGroupStack.length - 1];
          currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
        }

        const cmdType = ["capture_command"];
        if (method === "draw" || method === "drawIndexed" || method === "drawIndirect" || method === "drawIndexedIndirect" ||
            method === "dispatchWorkgroups" || method == "dispatchWorkgroupsIndirect") {
          cmdType.push("capture_drawcall");
        }

        const cmd = new Div(currentBlock, { class: cmdType });
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
        } else if (method === "pushDebugGroup") {
          new Span(cmd, { class: "capture_method_args", text: args[0] });
          debugGroupLabelStack.push(args[0]);
        } else if (method === "popDebugGroup") {
          const label = debugGroupLabelStack.pop();
          new Span(cmd, { class: "capture_method_args", text: label });
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

        if (method === "pushDebugGroup") {
          const grp = new Div(debugGroup, { text: `Debug Group: ${args[0]}`, id: `DebugGroup_${debugGroupIndex}`,  class: "capture_debugGroup" });
          debugGroupStack.push(grp);
          debugGroupIndex++;
          debugGroup = grp;

          currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
        }

        if (method === "end") {
          currentBlock = new Div(debugGroup, { class: "capture_commandBlock" });
        }
      }
    }

    _getTextureFromAttachment(attachment) {
      if (!attachment.view) {
        return null;
      }
      if (attachment.view.__texture) {
        return this.database.getObject(attachment.view.__texture.__id);
      }
      const view = this.database.getObject(attachment.view.__id);
      if (!view) {
        return null;
      }
      return view.parent;
    }

    _showCaptureCommandInfo_beginRenderPass(args, commandInfo) {
      const colorAttachments = args[0].colorAttachments;
      for (const i in colorAttachments) {
        const attachment = colorAttachments[i];
        const texture = this._getTextureFromAttachment(attachment);

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
        const texture = this._getTextureFromAttachment(depthStencilAttachment);
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
        const bindGroupGrp = new Collapsable(commandInfo, { collapsed: true, label: `BindGroup ${index ?? ""} ID:${id}` });
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
          if (resource.__class) {
            return resource.__class;
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
          const resourceGrp = new Collapsable(commandInfo, { collapsed: true, label: `${groupLabel}Binding ${binding}: ${getResourceType(resource)} ID:${getResourceId(resource)}` });
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
        const pipelineGrp = new Collapsable(commandInfo, { collapsed: true, label: `Pipeline ID:${id}` });
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
            const grp = new Collapsable(commandInfo, { collapsed: true, label: `Module ID:${vertexId} Vertex: ${vertexEntry} Fragment: ${fragmentEntry}` });
            const code = module.descriptor.code;
            new Widget("pre", grp.body, { text: code });

            this._shaderInfo("Vertex+Fragment", module, commandInfo);
          }
        } else {
          if (vertexId !== undefined) {
            const vertexModule = this.database.getObject(vertexId);
            if (vertexModule) {
              const vertexEntry = desc.vertex?.entryPoint;

              const vertexGrp = new Collapsable(commandInfo, { collapsed: true, label: `Vertex Module ID:${vertexId} Entry: ${vertexEntry}` });
              const code = vertexModule.descriptor.code;
              new Widget("pre", vertexGrp.body, { text: code });

              this._shaderInfo("Vertex", vertexModule, commandInfo);
            }
          }
          
          if (fragmentId !== undefined) {
            const fragmentModule = this.database.getObject(fragmentId);
            if (fragmentModule) {
              const fragmentEntry = desc.fragment?.entryPoint;
              const fragmentGrp = new Collapsable(commandInfo, { collapsed: true, label: `Fragment Module ID:${fragmentId} Entry: ${fragmentEntry}` });
              const code = fragmentModule.descriptor.code;
              new Widget("pre", fragmentGrp.body, { text: code });

              this._shaderInfo("Fragment", fragmentModule, commandInfo);
            }
          }
        }

        const computeId = desc.compute?.module?.__id;
        if (computeId !== undefined) {
          const computeModule = this.database.getObject(computeId);
          if (computeModule) {
            const computeEntry = desc.compute?.entryPoint;
            const computeGrp = new Collapsable(commandInfo, { collapsed: true, label: `Compute Module ID:${computeId} Entry: ${computeEntry}` });
            const code = computeModule.descriptor.code;
            new Widget("pre", computeGrp.body, { text: code });

            this._shaderInfo("Compute", computeModule, commandInfo);
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

    _getDrawState(commandIndex, commands) {
      let pipeline = null;
      let vertexBuffer = null;
      let indexBuffer = null;
      let bindGroups = [];
      for (let ci = commandIndex - 1; ci >= 0; --ci) {
        const cmd = commands[ci];
        if (cmd.method === "beginRenderPass") {
          break;
        }
        if (cmd.method === "setIndexBuffer" && !indexBuffer) {
          indexBuffer = cmd;
        }
        if (cmd.method === "setVertexBuffer" && !vertexBuffer) {
          vertexBuffer = cmd;
        }
        if (cmd.method === "setPipeline" && !pipeline) {
          pipeline = cmd;
        }
        if (cmd.method === "setBindGroup") {
          const bindGroupIndex = cmd.args[0];
          if (!bindGroups[bindGroupIndex]) {
            bindGroups[bindGroupIndex] = cmd;
          }
        }
      }

      return { pipeline, vertexBuffer, indexBuffer, bindGroups };
    }

    _getTypeName(type) {
      let name = type.name;
      if (type.format) {
        name += `<${type.format.name}>`;
      }
      return name;
    }

    _shaderInfo(type, shader, commandInfo) {
      const reflect = shader.reflection;
      if (reflect) {
        const grp = new Collapsable(commandInfo, { collapsed: true, label: `${type} Shader Info` });
        new Div(grp.body, { text: `Uniforms: ${reflect.uniforms.length}` });
        const list = new Widget("ul", grp.body);
        for (const s of reflect.uniforms) {
          new Widget("li", list, { text: `Uniform: ${s.name}` });
          const l2 = new Widget("ul", list);
          new Widget("li", l2, { text: `Buffer Size: ${s.type.size}` });
          new Widget("li", l2, { text: `Bind Group: ${s.group}` });
          new Widget("li", l2, { text: `Bind Index: ${s.binding}` });
          new Widget("li", l2, { text: `Members:` });
          const l3 = new Widget("ul", l2);
          for (const m in s.type.members) {
            new Widget("li", l3, { text: `${s.type.members[m].name}: ${this._getTypeName(s.type.members[m].type)}` });
            const l4 = new Widget("ul", l3);
            new Widget("li", l4, { text: `Offset: ${s.type.members[m].offset}` });
            new Widget("li", l4, { text: `Size: ${s.type.members[m].size}` });
          }
        }
        /*new Div(grp.body, { text: `Storage: ${reflect.storage.length}` });
        for (const storage of reflect.storage) {
          new Widget("pre", grp.body, { text: JSON.stringify(storage, null, 4) });
        }
        new Div(grp.body, { text: `Textures: ${reflect.textures.length}` });
        for (const texture of reflect.textures) {
          new Widget("pre", grp.body, { text: JSON.stringify(texture, null, 4) });
        }
        new Div(grp.body, { text: `Samplers: ${reflect.samplers.length}` });
        for (const sampler of reflect.samplers) {
          new Widget("pre", grp.body, { text: JSON.stringify(sampler, null, 4) });
        }*/
      }
    }

    _showCaptureCommandInfo_draw(args, commandInfo, commandIndex, commands) {
      const state = this._getDrawState(commandIndex, commands);

      if (state.pipeline) {
        this._showCaptureCommandInfo_setPipeline(state.pipeline.args, commandInfo, true);
      }
      if (state.vertexBuffer) {
        this._showCaptureCommandInfo_setVertexBuffer(state.vertexBuffer.args, commandInfo, true);
      }
      for (const index in state.bindGroups) {
        this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index].args, commandInfo, index, true);
      }
    }

    _showCaptureCommandInfo_drawIndexed(args, commandInfo, commandIndex, commands) {
      const state = this._getDrawState(commandIndex, commands);

      if (state.pipeline) {
        this._showCaptureCommandInfo_setPipeline(state.pipeline.args, commandInfo, true);
      }
      if (state.indexBuffer) {
        this._showCaptureCommandInfo_setIndexBuffer(state.indexBuffer.args, commandInfo, true);
      }
      if (state.vertexBuffer) {
        this._showCaptureCommandInfo_setVertexBuffer(state.vertexBuffer.args, commandInfo, true);
      }
      for (const index in state.bindGroups) {
        this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index].args, commandInfo, index, true);
      }
    }

    _showCaptureCommandInfo_drawIndirect(args, commandInfo, commandIndex, commands) {
      const state = this._getDrawState(commandIndex, commands);

      if (state.pipeline) {
        this._showCaptureCommandInfo_setPipeline(state.pipeline.args, commandInfo, true);
      }
      if (state.vertexBuffer) {
        this._showCaptureCommandInfo_setVertexBuffer(state.vertexBuffer.args, commandInfo, true);
      }
      for (const index in state.bindGroups) {
        this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index].args, commandInfo, index, true);
      }
    }

    _showCaptureCommandInfo_drawIndexedIndirect(args, commandInfo, commandIndex, commands) {
      const state = this._getDrawState(commandIndex, commands);

      if (state.pipeline) {
        this._showCaptureCommandInfo_setPipeline(state.pipeline.args, commandInfo, true);
      }
      if (state.indexBuffer) {
        this._showCaptureCommandInfo_setIndexBuffer(state.indexBuffer.args, commandInfo, true);
      }
      if (state.vertexBuffer) {
        this._showCaptureCommandInfo_setVertexBuffer(state.vertexBuffer.args, commandInfo, true);
      }
      for (const index in state.bindGroups) {
        this._showCaptureCommandInfo_setBindGroup(state.bindGroups[index].args, commandInfo, index, true);
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

      if (method === "beginRenderPass") {
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
      } else if (method === "draw") {
        const state = this._getDrawState(commandIndex, commands);
        if (state.pipeline) {
          const topology = this.database.getObject(state.pipeline.args[0].__id)?.topology ?? "triangle-list";
          const vertexCount = args[0] ?? 0;
          if (topology === "triangle-list") {
            new Div(commandInfo, { text: `Triangles: ${vertexCount / 3}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
          } else if (topology === "triangle-strip") {
            new Div(commandInfo, { text: `Triangles: ${vertexCount - 2}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
          } else if (topology === "point-list") {
            new Div(commandInfo, { text: `Points: ${vertexCount}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
          } else if (topology === "line-list") {
            new Div(commandInfo, { text: `Lines: ${vertexCount / 2}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
          } else if (topology === "line-strip") {
            new Div(commandInfo, { text: `Lines: ${vertexCount - 1}`, style: "background-color: #353; padding-left: 40px; line-height: 20px;" });
          }
        }
      }

      const cmd = commands[commandIndex];
      if (cmd.stacktrace) {
        const stacktrace = new Collapsable(commandInfo, { collapsed: true, label: "Stacktrace" });
        new Div(stacktrace.body, { text: cmd.stacktrace, style: "font-size: 10pt;color: #ddd;overflow: auto;background-color: rgb(51, 51, 85);box-shadow: #000 0 3px 5px;padding: 5px;padding-left: 10px;" });
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

      this._loadingImages--;
      if (this._loadingImages <= 0) {
        this._captureStatus.text = "";
        this._loadingImages = 0;
      } else {
        this._captureStatus.text = `Loading Images: ${this._loadingImages}`;
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

      // Recycle DOM elements as objects are created and destroyed.
      // The DevTools panel will crash after a while if there is too much thrashing
      // of DOM elements.
      this._recycledWidgets = {
        Adapter: [],
        Device: [],
        Buffer: [],
        Sampler: [],
        Texture: [],
        TextureView: [],
        ShaderModule: [],
        BindGroupLayout: [],
        PipelineLayout: [],
        BindGroup: [],
        RenderPipeline: [],
        ComputePipeline: [],
      };

      // Periodically clean up old recycled widgets.
      setInterval(() => {
        const time = performance.now();
        for (const type in this._recycledWidgets) {
          const list = this._recycledWidgets[type];
          const length = list.length;
          for (let i = length - 1; i >= 0; --i) {
            const widget = list[i];
            if ((time - widget._destroyTime) > 1000) {
              widget.element.remove();
              list.splice(i, 1);
            }
          }
        }
      }, 1000);

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
      // Instead of deleting the objects widget from the DOM, recycle
      // it so the next time an object of this type is created, it will
      // use the recycled widget instead of creating a new one.
      const widget = object?.widget;
      if (widget) {
        this._recycledWidgets[object.constructor.name].push(widget);
        widget.element.style.display = "none";
        widget._destroyTime = performance.now();
        object.widget = null;
      }
      this._updateObjectStat(object);
    }

    _updateObjectStat(object) {
      if (object instanceof Adapter) {
        this.uiAdapters.label.text = `Adapters ${this.database.adapters.size}`;
      } else if (object instanceof Device) {
        this.uiDevices.label.text = `Devices ${this.database.devices.size}`;
      } else if (object instanceof Buffer) {
        this.uiBuffers.label.text = `Buffers ${this.database.buffers.size}`;
      } else if (object instanceof Sampler) {
        this.uiSamplers.label.text = `Samplers ${this.database.samplers.size}`;
      } else if (object instanceof Texture) {
        this.uiTextures.label.text = `Textures ${this.database.textures.size}`;
      } else if (object instanceof TextureView) {
        this.uiTextureViews.label.text = `TextureViews ${this.database.textureViews.size}`;
      } else if (object instanceof ShaderModule) {
        this.uiShaderModules.label.text = `ShaderModules ${this.database.shaderModules.size}`;
      } else if (object instanceof BindGroupLayout) {
        this.uiBindGroupLayouts.label.text = `BindGroupLayouts ${this.database.bindGroupLayouts.size}`;
      } else if (object instanceof PipelineLayout) {
        this.uiPipelineLayouts.label.text = `PipelineLayouts ${this.database.pipelineLayouts.size}`;
      } else if (object instanceof BindGroup) {
        this.uiBindGroups.label.text = `BindGroups ${this.database.bindGroups.size}`;
      } else if (object instanceof RenderPipeline) {
        this.uiPendingAsyncRenderPipelines.label.text = `Pending Async Render Pipelines ${this.database.pendingRenderPipelines.size}`;
        this.uiRenderPipelines.label.text = `Render Pipelines ${this.database.renderPipelines.size}`;
      } else if (object instanceof ComputePipeline) {
        this.uiPendingAsyncComputePipelines.label.text = `Pending Async Compute Pipelines ${this.database.pendingComputePipelines.size}`;
        this.uiComputePipelines.label.text = `Compute Pipelines ${this.database.computePipelines.size}`;
      }
    }

    _addObject(object, pending) {
      this._updateObjectStat(object);
      if (object instanceof Adapter) {
        this._addObjectToUI(object, this.uiAdapters);
      } else if (object instanceof Device) {
        this._addObjectToUI(object, this.uiDevices);
      } else if (object instanceof Buffer) {
        this._addObjectToUI(object, this.uiBuffers);
      } else if (object instanceof Sampler) {
        this._addObjectToUI(object, this.uiSamplers);
      } else if (object instanceof Texture) {
        this._addObjectToUI(object, this.uiTextures);
      } else if (object instanceof TextureView) {
        this._addObjectToUI(object, this.uiTextureViews);
      } else if (object instanceof ShaderModule) {
        this._addObjectToUI(object, this.uiShaderModules);
      } else if (object instanceof BindGroupLayout) {
        this._addObjectToUI(object, this.uiBindGroupLayouts);
      } else if (object instanceof PipelineLayout) {
        this._addObjectToUI(object, this.uiPipelineLayouts);
      } else if (object instanceof BindGroup) {
        this._addObjectToUI(object, this.uiBindGroups);
      } else if (object instanceof RenderPipeline) {
        this._addObjectToUI(object, pending ? this.uiPendingAsyncRenderPipelines : this.uiRenderPipelines);
      } else if (object instanceof ComputePipeline) {
        this._addObjectToUI(object, pending ? this.uiPendingAsyncComputePipelines : this.uiComputePipelines);
      }
    }

    _createObjectListUI(parent, name) {
      const panel = new Collapsable(parent, { collapsed: true, label: `${name} 0` });

      const self = this;
      panel.onExpanded.addListener(() => {
        if (self._selectedGroup && self._selectedGroup != panel) {
          self._selectedGroup.collapsed = true;
        }
        self._selectedGroup = panel;
      });

      const objectList = new Widget("ol", panel.body, { style: "margin-top: 10px; margin-bottom: 10px;"});
      panel.objectList = objectList;

      return panel;
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
      } else if (object instanceof Buffer) {
        const access = object.descriptor.usage;

        if (access & GPUBufferUsage.INDEX) {
          type += " INDEX";
        }
        if (access & GPUBufferUsage.VERTEX) {
          type += " VERTEX";
        }
        if (access & GPUBufferUsage.STORAGE) {
          type += " STORAGE";
        }
        if (access & GPUBufferUsage.INDIRECT) {
          type += " INDIRECT";
        }
        if (access & GPUBufferUsage.QUERY_RESOLVE) {
          type += " QUERY_RESOLVE";
        }

        type += ` ${object.descriptor.size.toLocaleString("en-US")} Bytes`;
      }

      const idName = object.id < 0 ? "CANVAS" : object.id;

      let widget = this._recycledWidgets[object.constructor.name].pop();
      if (widget) {
        widget.element.style.display = undefined;
        widget.nameWidget.text = name;
        widget.idWidget.text = `ID: ${idName}`;
        if (type) {
          widget.typeWidget.text = type;
        }
      } else {
        widget = new Widget("li", ui.objectList);

        widget.nameWidget = new Span(widget, { text: name });
        
        widget.idWidget = new Span(widget, { text: `ID: ${idName}`, style: "margin-left: 10px; vertical-align: baseline; font-size: 10pt; color: #ddd; font-style: italic;" });
        if (type) {
          widget.typeWidget = new Span(widget, { text: type, style: "margin-left: 10px; vertical-align: baseline; font-size: 10pt; color: #ddd; font-style: italic;" });
        }
      }

      object.widget = widget;

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
      if (object.stacktrace) {
        const stacktraceGrp = new Collapsable(infoBox, { collapsed: true, label: "Stacktrace", collapsed: true });
        new Div(stacktraceGrp.body, { text: object.stacktrace, style: "font-size: 10pt;color: #ddd;overflow: auto;background-color: rgb(51, 51, 85);box-shadow: #000 0 3px 5px;padding: 5px;padding-left: 10px;" });
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
//# sourceMappingURL=webgpu_inspector_window.js.map
