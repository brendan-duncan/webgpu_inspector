import { Signal } from "../utils/signal.js";

export class RecorderData {
  constructor() {
    this.data = [];
    this.initiazeCommands = [];
    this.frames = [];
    this._dataCount = 0;
    this._commandCount = 0;
    this._dataReady = false;
    this._commandsReady = false;
    this.onReady = new Signal();

    this._objectMap = new Map();
    this._canvas = null;
    this._context = null;
  }

  get ready() {
    return this._dataReady && this._commandsReady;
  }

  clear() {
    this.data = [];
    this.initiazeCommands = [];
    this.frames = [];
    this._dataCount = 0;
    this._commandCount = 0;
    this._dataReady = false;
    this._commandsReady = false;
  }

  addData(data, type, index, count) {
    async function B64ToA(s, type, length) {
      const res = await fetch(s);
      const x = new Uint8Array(await res.arrayBuffer());
      if (type == "Uint32Array") {
        return new Uint32Array(x.buffer, 0, x.length/4);
      }
      return new Uint8Array(x.buffer, 0, x.length);
    }

    const self = this;
    B64ToA(data, type, 0).then((x) => {
      self.data[index] = x;
      self._dataCount++;
      if (self._dataCount >= count) {
        self._dataReady = true;
        if (self.ready) {
          self.onReady.emit();
        }
      } else {
        self._dataReady = false;
      }
    });
  }

  addCommand(command, commandIndex, frame, index, count) {
    try {
      command.args = JSON.parse(command.args);
      if (frame < 0) {
        this.initiazeCommands[commandIndex] = command;
      } else {
        if (this.frames[frame] === undefined) {
          this.frames[frame] = [];
        }
        this.frames[frame][commandIndex] = command;
      }
      this._commandCount++;
      if (this._commandCount >= count) {
        this._commandsReady = true;
        if (self.ready) {
          this.onReady.emit();
        }
      } else {
        this._commandsReady = false;
      }
    } catch (e) {
      console.log(e.message, command.method, command.args);
    }
  }

  _getObject(id) {
    if (id === "x1") {
      return navigator.gpu;
    }
    if (id === "context") {
      if (this._context) {
        return this._context;
      }
      this._context = this._canvas.element.getContext("webgpu");
      return this._context;
    }
    return this._objectMap.get(id);
  }

  async executeCommands(canvas, frameIndex) {
    this._objectMap.forEach((value) => {
      if (value instanceof GPUDevice) {
        value.destroy();
      }
    });

    this._objectMap.clear();
    this._canvas = canvas;
    this._context = null;

    for (const command of this.initiazeCommands) {
      await this._executeCommand(command);
    }

    frameIndex = Math.max(0, Math.min(frameIndex, this.frames.length - 1));

    for (let i = 0; i <= frameIndex; ++i) {
      const frame = this.frames[i];
      for (const command of frame) {
        await this._executeCommand(command);
      }
    }
  }

  _prepareObject(obj) {
    const newObj = {};
    for (const key in obj) {
      if (typeof(obj[key]) !== "string" && obj[key].length !== undefined) {
        newObj[key] = this._prepareArgs(obj[key]);
      } else if (obj[key] instanceof Object) {
        if (obj[key].__id !== undefined) {
          newObj[key] = this._getObject(obj[key].__id);
        } else if (obj[key].__data !== undefined) {
          newObj[key] = this.data[obj[key].__data];
        } else {
          newObj[key] = this._prepareObject(obj[key]);
        }
      } else {
        newObj[key] = obj[key];
      }
    }
    return newObj;
  }

  _prepareArgs(args) {
    const newArgs = [...args];
    for (let i = 0; i < newArgs.length; ++i) {
      if (typeof(newArgs[i]) !== "string" && newArgs[i].length !== undefined) {
        newArgs[i] = this._prepareArgs(newArgs[i]);
      } else if (newArgs[i] instanceof Object) {
        if (newArgs[i].__id !== undefined) {
          newArgs[i] = this._getObject(newArgs[i].__id);
        } else if (newArgs[i].__data !== undefined) {
          newArgs[i] = this.data[newArgs[i].__data];
        } else {
          newArgs[i] = this._prepareObject(newArgs[i]);
        }
      }
    }
    return newArgs;
  }

  async _executeCommand(command) {
    const object = this._getObject(command.object);
    if (!object) {
      //console.log("!!!!!!!!!!!!!!!!", command.object, command.method);
      return;
    }

    const args = this._prepareArgs(command.args);

    if (command.method === "__setCanvasSize") {
      this._canvas.element.width = args[0];
      this._canvas.element.height = args[1];
      return;
    } else if (command.method === "__writeData") {
      const dataIndex = args[0];
      const data = this.data[dataIndex];
      new Uint8Array(object).set(data);
      return;
    } else if (command.method === "__getQueue") {
      this._objectMap.set(command.result, object.queue);
      return;
    } else if (command.method === "__writeTexture") {
      command.method = "writeTexture";
    }

    if (command.async) {
      const result = await object[command.method](...args);
      if (command.result) {
        this._objectMap.set(command.result, result);
      }  
    } else {
      const result = object[command.method](...args);
      if (command.result) {
        this._objectMap.set(command.result, result);
      }
    }
  }
}
