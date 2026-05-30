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
    // Per-data-blob TypedArray type name ("Uint8Array" / "Uint32Array"), kept in parallel with
    // `data` so a loaded recording can be re-serialized back to a faithful .wgpu / .html.
    this.dataTypes = [];
    this.initializeCommands = [];
    this.frames = [];
    // Canvas size and root-object variable names, recovered when a binary recording is loaded so
    // the recording can be exported again. Defaults match the live-record object ids ("x1" is the
    // navigator.gpu id used by webgpu_recorder; the canvas context is always "context").
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.gpuVar = "x1";
    this.contextVar = "context";
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

  // Reset the runtime GPU state used while replaying (object map, device, context, texture utils),
  // without discarding the recorded commands/data. Called before each replay so commands re-create
  // their objects from scratch. Frees the previous replay's GPU resources, but never the panel's
  // shared device/adapter, which replays run on.
  _resetExecutionState() {
    for (const value of this._objectMap.values()) {
      if (value === this.window.device || value === this.window.adapter) {
        continue;
      }
      if (value instanceof GPUTexture || value instanceof GPUBuffer) {
        try {
          value.destroy();
        } catch (e) {
          // Ignore: the resource may already be destroyed by a replayed destroy() command.
        }
      }
    }
    this._objectMap.clear();
    this._context = null;
    this._device = null;
    this._textureUtils = null;
  }

  // Discard everything: runtime state and the recorded commands/data. Used when starting a new
  // recording.
  clear() {
    this._resetExecutionState();
    this.data = [];
    this.dataTypes = [];
    this.initializeCommands = [];
    this.frames = [];
    this.canvasWidth = 0;
    this.canvasHeight = 0;
    this.gpuVar = "x1";
    this.contextVar = "context";
    this._dataCount = 0;
    this._commandCount = 0;
    this.dataReady = false;
    this._commandsReady = false;
  }

  // Canvas dimensions for export/preview. Prefer values recovered from a loaded binary; otherwise
  // recover them from the recording's own __setCanvasSize command (which may sit in the init block
  // or in a frame, depending on when configure() ran); otherwise fall back.
  getCanvasSize() {
    if (this.canvasWidth > 0 && this.canvasHeight > 0) {
      return { width: this.canvasWidth, height: this.canvasHeight };
    }
    const fromCommands = (commands) => {
      for (const command of commands || []) {
        if (command && command.method === "__setCanvasSize" && Array.isArray(command.args)) {
          const width = command.args[0] | 0;
          const height = command.args[1] | 0;
          if (width > 0 && height > 0) {
            return { width, height };
          }
        }
      }
      return null;
    };
    let size = fromCommands(this.initializeCommands);
    for (let f = 0; !size && f < this.frames.length; ++f) {
      size = fromCommands(this.frames[f]);
    }
    return size || { width: 800, height: 600 };
  }

  _checkReady() {
    if (this.ready) {
      this.onReady.emit();
    }
  }

  addData(data, type, index, count) {
    this.dataTypes[index] = type || "Uint8Array";
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

  // Parse a recorded command's args (a JSON string) in place. requestDevice/requestAdapter reuse
  // the panel's existing adapter/device at replay (see _executeCommand), so their recorded args
  // aren't needed. Never throws — on malformed args it logs and falls back to an empty arg list so
  // the command stays in sequence (a hole would break the replay loop).
  _parseCommandArgs(command) {
    if (command.method === "requestDevice" || command.method === "requestAdapter") {
      command.args = [];
    } else {
      try {
        command.args = JSON.parse(command.args);
      } catch (e) {
        console.error(`Error parsing args for command ${command.method}:`, e.message);
        command.args = [];
      }
    }
    return command;
  }

  addCommand(command, commandIndex, frame, index, count) {
    try {
      this._parseCommandArgs(command);

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

  // Load a binary (.wgpu) recording produced by webgpu_recorder, replacing any current recording.
  // Container layout (see webgpu_recorder._buildBinaryRecording):
  //   "WGPR" | version u32 | headerLen u32 | header(JSON utf8) | rawData
  // header = { canvasWidth, canvasHeight, init:[cmd], frames:[[cmd]], data:[{type,length,offset}] }
  // where each cmd has its args as a JSON string and the data table offsets index into rawData.
  loadBinary(arrayBuffer) {
    this.clear();

    try {
      const u8 = new Uint8Array(arrayBuffer);
      if (u8.length < 12 || u8[0] !== 0x57 || u8[1] !== 0x47 || u8[2] !== 0x50 || u8[3] !== 0x52) {
        console.error("Invalid binary recording: missing WGPR header.");
        return;
      }

      const view = new DataView(arrayBuffer);
      const headerLength = view.getUint32(8, true);
      const dataStart = 12 + headerLength;
      const header = JSON.parse(new TextDecoder().decode(new Uint8Array(arrayBuffer, 12, headerLength)));

      // Preserve the metadata needed to export this recording again.
      this.canvasWidth = header.canvasWidth | 0;
      this.canvasHeight = header.canvasHeight | 0;
      this.gpuVar = header.gpuVar || "x1";
      this.contextVar = header.contextVar || "context";

      // Raw data blobs, sliced into typed arrays matching the recorded type.
      const dataTable = header.data || [];
      for (let i = 0; i < dataTable.length; ++i) {
        const d = dataTable[i];
        this.dataTypes[i] = (d && d.type) || "Uint8Array";
        if (!d || !d.type || !d.length) {
          this.data[i] = new Uint8Array(0);
          continue;
        }
        const slice = arrayBuffer.slice(dataStart + d.offset, dataStart + d.offset + d.length);
        this.data[i] = d.type === "Uint32Array" ? new Uint32Array(slice) : new Uint8Array(slice);
      }

      const init = header.init || [];
      for (let i = 0; i < init.length; ++i) {
        this.initializeCommands[i] = this._parseCommandArgs(init[i]);
      }

      const frames = header.frames || [];
      for (let f = 0; f < frames.length; ++f) {
        this.frames[f] = [];
        const commands = frames[f] || [];
        for (let i = 0; i < commands.length; ++i) {
          this.frames[f][i] = this._parseCommandArgs(commands[i]);
        }
      }

      this.dataReady = true;
      this._commandsReady = true;
      this.onReady.emit();
    } catch (e) {
      console.error(`Failed to load binary recording: ${e.message}`);
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
    // Reset only the runtime GPU state, not the recorded commands/data we're about to replay.
    this._resetExecutionState();

    this._canvas = canvas;
    // Replay onto the panel's shared device so the canvas context, replayed resources, and the
    // preview blit all use one device.
    this._device = this.window.device ?? null;
    this._textureUtils = this.window.textureUtils ?? null;

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
            // _executeCommand returns the method's result (end() returns undefined), so resolve
            // the pass encoder from the command's object, not from the return value.
            const passObject = this._getObject(command.object);
            await this._executeCommand(command, fi, ci);
            if (passObject) {
              passes.delete(passObject);
              if (passObject instanceof GPURenderPassEncoder) {
                lastPass = passObject;
              }
            }
          }

          if (commandEncoders.size > 0 && command.method === "finish") {
            const encoderObject = this._getObject(command.object);
            await this._executeCommand(command, fi, ci);
            if (encoderObject) {
              commandEncoders.delete(encoderObject);
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
              // Remember the most recent render pass so it can be previewed even when the
              // selected command is at/after the pass end (e.g. finish or submit).
              if (object instanceof GPURenderPassEncoder) {
                lastPass = object;
              }
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
      if (lastPass.__descriptor?.colorAttachments?.length > 0) {
        const colorOutput0 = this._getObject(
          lastPass.__descriptor.colorAttachments[0].resolveTarget?.__id ??
          lastPass.__descriptor.colorAttachments[0].view?.__id);
        const colorOutputTexture = colorOutput0?.texture;
        if (colorOutputTexture && !colorOutputTexture.isCanvasTexture) {
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
    if (!command) {
      return null;
    }
    let method = command.method;

    // Reuse the panel's existing adapter/device rather than creating new ones during replay. This
    // keeps the canvas context, replayed resources, and the preview blit all on a single device,
    // and avoids the recorded device-setup commands leaving configure()'s device undefined.
    if (method === "requestAdapter") {
      if (command.result) {
        this._objectMap.set(command.result, this.window.adapter);
      }
      return this.window.adapter;
    }
    if (method === "requestDevice") {
      this._device = this.window.device;
      if (command.result) {
        this._objectMap.set(command.result, this.window.device);
      }
      return this.window.device;
    }

    const object = this._getObject(command.object);
    if (!object) {
      return null;
    }

    if (method === "pushDebugGroup" || method === "popDebugGroup") {
      return null;
    }

    // Never destroy the panel's shared device/adapter during replay.
    if (method === "destroy" && (object === this.window.device || object === this.window.adapter)) {
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
