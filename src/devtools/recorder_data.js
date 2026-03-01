import { Signal } from "../utils/signal.js";
import { TextureUtils } from "../utils/texture_utils.js";

async function fetchArrayBuffer(url, type, length) {
  try {
    const res = await fetch(url);
    const buffer = await res.arrayBuffer();
    if (type === "Uint32Array") {
      return new Uint32Array(buffer, 0, buffer.byteLength / 4);
    }
    return new Uint8Array(buffer, 0, buffer.byteLength);
  } catch (e) {
    console.error(`Failed to fetch data: ${e.message}`);
  }
  return new Uint8Array(length);
}

export class RecorderData {
  constructor(window) {
    this.window = window;
    this.data = [];
    this.initializeCommands = [];
    this.frames = [];
    this._dataCount = 0;
    this._commandCount = 0;
    this.dataReady = false;
    this._commandsReady = false;
    this.onReady = new Signal();

    this._objectMap = new Map();
    this._canvas = null;
    this._context = null;
    this._device = null;
    this._textureUtils = null;
  }

  get ready() {
    return this.dataReady && this._commandsReady;
  }

  clear() {
    for (const value of this._objectMap.values()) {
      if (value instanceof GPUDevice) {
        value.destroy();
      }
    }
    this._objectMap.clear();
    this.data = [];
    this.initializeCommands = [];
    this.frames = [];
    this._dataCount = 0;
    this._commandCount = 0;
    this.dataReady = false;
    this._commandsReady = false;
  }

  _checkReady() {
    if (this.ready) {
      this.onReady.emit();
    }
  }

  addData(data, type, index, count) {
    if (data === undefined) {
      this.data[index] = new Uint8Array(count);
      this._dataCount++;
      this.dataReady = this._dataCount >= count;
      this._checkReady();
      return;
    }

    fetchArrayBuffer(data, type, 0).then((x) => {
      this.data[index] = x;
      this._dataCount++;
      this.dataReady = this._dataCount >= count;
      this._checkReady();
    });
  }

  addCommand(command, commandIndex, frame, index, count) {
    try {
      if (command.method === "requestDevice") {
        const adapter = this.window.adapter;
        const requiredFeatures = [...adapter.features];
        const requiredLimits = {};
        const exclude = new Set(["minSubgroupSize", "maxSubgroupSize"]);
        for (const key in adapter.limits) {
          if (!exclude.has(key)) {
            requiredLimits[key] = adapter.limits[key];
          }
        }
        command.args = [{ requiredFeatures, requiredLimits }];
      } else {
        command.args = JSON.parse(command.args);
      }

      if (frame < 0) {
        this.initializeCommands[commandIndex] = command;
      } else {
        if (this.frames[frame] === undefined) {
          this.frames[frame] = [];
        }
        this.frames[frame][commandIndex] = command;
      }

      this._commandCount++;
      this._commandsReady = this._commandCount >= count;
      this._checkReady();
    } catch (e) {
      console.error(`Error adding command: ${command.method}`, e.message);
    }
  }

  _getObject(id) {
    if (id === "x1") {
      return navigator.gpu;
    }
    if (id === "context") {
      if (!this._context && this._canvas) {
        this._context = this._canvas.element.getContext("webgpu");
      }
      return this._context;
    }
    return this._objectMap.get(id);
  }

  async executeCommands(canvas, frameIndex, commandIndex = -1) {
    this.clear();

    this._canvas = canvas;
    this._device = null;
    this._textureUtils = null;

    let ci = 0;
    for (const command of this.initializeCommands) {
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
      if (!frame) {
        continue;
      }
      ci = 0;
      const hasFrameCommandIndex = hasCommandIndex && fi === frameIndex;
      for (const command of frame) {
        if (hasFrameCommandIndex && ci > commandIndex) {
          if (passes.size > 0 && command.method === "end") {
            const object = await this._executeCommand(command, fi, ci);
            if (object) {
              passes.delete(object);
            }
            lastPass = object;
          }

          if (commandEncoders.size > 0 && command.method === "finish") {
            const object = await this._executeCommand(command, fi, ci);
            if (object) {
              commandEncoders.delete(object);
            }
            commandBuffers.add(command.result);
          }

          if (command.method === "popDebugGroup" && debugGroups > 0) {
            await this._executeCommand(command, fi, ci);
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

          if (!this._textureUtils && this._device) {
            this._textureUtils = new TextureUtils(this._device);
          }

          if (this._textureUtils) {
            this._textureUtils.blitTexture(colorOutput0, colorOutput0.texture.format, 1, canvasView, canvasTexture.format, null);
          }
        }
      }
    }
  }

  _prepareValue(value) {
    if (value && typeof value !== 'string' && value.length !== undefined) {
      return this._prepareArgs(value);
    }
    if (value instanceof Object) {
      if (value.__id !== undefined) {
        return this._getObject(value.__id);
      }
      if (value.__data !== undefined) {
        return this.data[value.__data];
      }
      return this._prepareObject(value);
    }
    return value;
  }

  _prepareObject(obj) {
    const newObj = {};
    for (const key in obj) {
      newObj[key] = this._prepareValue(obj[key]);
    }
    return newObj;
  }

  _prepareArgs(args) {
    return [...args].map(arg => this._prepareValue(arg));
  }

  async _executeCommand(command, frameIndex, commandIndex) {
    const object = this._getObject(command.object);
    if (!object) {
      return null;
    }

    const method = command.method;
    if (method === "pushDebugGroup" || method === "popDebugGroup") {
      return null;
    }

    if (object instanceof GPUDevice) {
      this._device = object;
    }

    if (method === "__writeTexture") {
      method = "writeTexture";
    }

    const args = this._prepareArgs(command.args);
    let result = null;

    if (method === "__setCanvasSize") {
      this._canvas.element.width = args[0];
      this._canvas.element.height = args[1];
      return null;
    }

    if (method === "__writeData") {
      const dataIndex = args[0];
      const data = this.data[dataIndex];
      new Uint8Array(object).set(data);
      return null;
    }

    if (method === "__getQueue") {
      this._objectMap.set(command.result, object.queue);
      return null;
    }

    if (method === "createTexture") {
      args[0].usage |= GPUTextureUsage.TEXTURE_BINDING;
    }

    const isAsync = command.async;
    if (this._device) {
      this._device.pushErrorScope("validation");
    }

    try {
      result = isAsync ? await object[method](...args) : object[method](...args);
    } catch (e) {
      console.error(`EXCEPTION frame:${frameIndex} command:${commandIndex} ${object?.constructor.name} ${method}: ${e.message}`);
    }

    if (this._device) {
      this._device.popErrorScope().then((error) => {
        if (error) {
          console.error(`ERROR frame:${frameIndex} command:${commandIndex} ${object?.constructor.name} ${method}: ${error.message}`);
        }
      }).catch((e) => {
        console.error(`ERROR frame:${frameIndex} command:${commandIndex} ${object?.constructor.name} ${method}: ${e.message}`);
      });
    }

    if (method === "createView") {
      result.texture = object;
    } else if (method === "getCurrentTexture") {
      result.isCanvasTexture = true;
    }

    if (command.result) {
      this._objectMap.set(command.result, result);
    }

    if (result instanceof GPUDevice) {
      this._device = result;
    }

    return result;
  }
}
