/**
 * A Signal is like a proxy function that can have multiple "listeners" assigned to it, such that
 * when the Signal is executed (or "emitted"), it executes each of its associated listeners.
 * A listener is a callback function, object method, or another Signal.
 */
export class Signal {
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
