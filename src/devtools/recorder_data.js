import { Signal } from "../utils/signal.js";
import { TextureUtils } from "../utils/texture_utils.js";

export class RecorderData {
  constructor(window) {
    this.window = window;
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
    this._device = null;
    this._textureUtils = null;
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
    if (data === undefined) {
      this.data[index] = new Uint8Array(count);
      this._dataCount++;
      if (this._dataCount >= count) {
        this._dataReady = true;
        if (this.ready) {
          this.onReady.emit();
        }
      } else {
        this._dataReady = false;
      }
      return;
    }
    async function B64ToA(s, type, length) {
      try {
        const res = await fetch(s);
        const x = new Uint8Array(await res.arrayBuffer());
        if (type == "Uint32Array") {
          return new Uint32Array(x.buffer, 0, x.length/4);
        }
        return new Uint8Array(x.buffer, 0, x.length);
      } catch (e) {
        console.log(e.message);
      }
      return new Uint8Array(length);
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
      if (command.method === "requestDevice") {
        const adapter = this.window.adapter;
        const requiredFeatures = [];
        for (const x of adapter.features) {
          requiredFeatures.push(x);
        }
        const requiredLimits = {};
        const exclude = new Set(["minSubgroupSize", "maxSubgroupSize"]);
        for (const x in adapter.limits) {
          if (!exclude.has(x)) {
            requiredLimits[x] = adapter.limits[x];
          }
        }
        command.args = [{
          requiredFeatures,
          requiredLimits
        }];
      } else {
        command.args = JSON.parse(command.args);
      }
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

  // if commandIndex is provided, it is the last command to be executed
  // on the given frameIndex.
  async executeCommands(canvas, frameIndex, commandIndex) {
    commandIndex ??= -1;

    this._objectMap.forEach((value) => {
      if (value instanceof GPUDevice) {
        value.destroy();
      }
    });

    this._objectMap.clear();
    this._canvas = canvas;
    this._context = null;
    this._device = null;
    this._textureUtils = null;

    let ci = 0;
    for (const command of this.initiazeCommands) {
      await this._executeCommand(command, -1, ci);
      ci++;
    }

    frameIndex = Math.max(0, Math.min(frameIndex, this.frames.length - 1));
    const hasCommandIndex = commandIndex >= 0;

    const commandEncoders = new Set();
    const passes = new Set();
    const commandBuffers = new Set();
    let debugGroups = 0;
    let lastPass = null;

    for (let fi = 0; fi <= frameIndex; ++fi) {
      const frame = this.frames[fi];
      ci = 0;
      const hasFrameCommandIndex = hasCommandIndex && fi === frameIndex;
      for (const command of frame) {
        // If the current command is after the requested last command to be executed,
        // then skip the command. We do want to close the current render or compute pass,
        // debug group, and commandEncoder, so we do want to execute those commands.
        if (hasFrameCommandIndex && ci > commandIndex) {
          if (passes.size > 0 && command.method === "end") {
            await this._executeCommand(command, fi, ci);
            const object = this._getObject(command.object);
            if (object) {
              passes.delete(object);
            }
            lastPass = object;
          }

          if (commandEncoders.size > 0 && command.method === "finish") {
            await this._executeCommand(command, fi, ci);
            const object = this._getObject(command.object);
            if (object) {
              commandEncoders.delete(object);
            }
            commandBuffers.add(command.result);
          }

          if (command.method === "popDebugGroup" && debugGroups > 0) {
            this._executeCommand(command, fi, ci);
            debugGroups--;
          }

          if (command.method === "submit") {
            let found = false;
            if (commandBuffers.size > 0) {
              for (const cb of command.args[0]) {
                for (const commandBuffer of commandBuffers) {
                  if (commandBuffer === cb.__id) {
                    found = true;
                    commandBuffers.delete(commandBuffer);
                    break;
                  }
                }
              }
              if (found) {
                await this._executeCommand(command, fi, ci);
              }
            }
          }

          ci++;
          continue;
        }

        const result = await this._executeCommand(command, fi, ci);
        ci++;

        if (fi === frameIndex) {
          if (command.method === "pushDebugGroup") {
            debugGroups++;
          } else if (command.method === "popDebugGroup") {
            debugGroups--;
          } else if (command.method === "createCommandEncoder") {
            commandEncoders.add(result);
          } else if (command.method === "beginRenderPass" || command.method === "beginComputePass") {
            result.__descriptor = command.args[0];
            passes.add(result);
          } else if (command.method === "end") {
            const object = this._getObject(command.object);
            if (object) {
              passes.delete(object);
            }
          } else if (command.method === "finish") {
            const object = this._getObject(command.object);
            if (object) {
              commandEncoders.delete(object);
            }
          }
        }
      }
    }

    if (lastPass instanceof GPURenderPassEncoder) {
      if (lastPass.__descriptor.colorAttachments.length > 0) {
        const colorOutput0 = this._getObject(
          lastPass.__descriptor.colorAttachments[0].resolveTarget?.__id ??
          lastPass.__descriptor.colorAttachments[0].view?.__id);
        const colorOutputTexture = colorOutput0.texture;
        if (!colorOutputTexture.isCanvasTexture) {
          const canvasTexture = this._context.getCurrentTexture();
          const canvasView = canvasTexture.createView();

          if (!this._textureUtils) {
            if (this._device) {
              this._textureUtils = new TextureUtils(this._device);
            }
          }
          
          if (this._textureUtils) {
            this._textureUtils.blitTexture(colorOutput0, colorOutput0.texture.format, 1, canvasView, canvasTexture.format, null);
          }
        }
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

  async _executeCommand(command, frameIndex, commandIndex) {
    const object = this._getObject(command.object);
    let method = command.method;

    if (method === "pushDebugGroup" || method === "popDebugGroup") {
      return;
    }

    if (!object) {
      //console.log("!!!!!!!!!!!!!!!!", command.object, command.method);
      return;
    }

    if (object instanceof GPUDevice) {
      this._device = object;
    }

    if (method === "__writeTexture") {
      method = "writeTexture";
    }

    const args = this._prepareArgs(command.args);

    if (method === "__setCanvasSize") {
      this._canvas.element.width = args[0];
      this._canvas.element.height = args[1];
      return;
    } else if (method === "__writeData") {
      const dataIndex = args[0];
      const data = this.data[dataIndex];
      new Uint8Array(object).set(data);
      return;
    } else if (method === "__getQueue") {
      this._objectMap.set(command.result, object.queue);
      return;
    } else if (method === "createTexture") {
      args[0].usage |= GPUTextureUsage.TEXTURE_BINDING;
    }
    
    if (command.async) {
      if (this._device) {
        this._device.pushErrorScope("validation");
      }

      let result = undefined;
      try {
        result = await object[method](...args);
      } catch (e) {
        console.log(`EXCEPTION frame:${frameIndex} command:${commandIndex} ${object?.constructor.name} ${method}: ${e.message}`);
      }

      if (this._device) {
        this._device.popErrorScope().then((error) => {
          if (error) {
            console.log(`ERROR frame:${frameIndex} command:${commandIndex} ${object?.constructor.name} ${method}: ${error.message}`);
          }
        });
      }

      if (command.result) {
        this._objectMap.set(command.result, result);
      }

      if (result instanceof GPUDevice) {
        this._device = result;
      }
      return result;  
    } else {
      if (this._device) {
        this._device.pushErrorScope("validation");
      }

      let result = undefined;

      try {
        result = object[method](...args);
      } catch (e) {
        console.log(`EXCEPTION frame:${frameIndex} command:${commandIndex} ${object?.constructor.name} ${method}: ${e.message}`);
      }

      if (method === "createView") {
        result.texture = object;
      } else if (method === "getCurrentTexture") {
        result.isCanvasTexture = true;
      }

      if (this._device) {
        this._device.popErrorScope().then((error) => {
          if (error) {
            console.log(`ERROR frame:${frameIndex} command:${commandIndex} ${object?.constructor.name} ${method}: ${error.message}`);
          }
        });
      }

      if (command.result) {
        this._objectMap.set(command.result, result);
      }

      return result;
    }
  }
}
