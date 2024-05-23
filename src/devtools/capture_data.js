
import { decodeDataUrl } from "../utils/base64.js";
import { Signal } from "../utils/signal.js";

export class CaptureData {
  constructor(objectDatabase) {
    this.database = objectDatabase;

    this.frameIndex = 0;
    this.commands = [];
    this.frameImageList = [];

    this.onCaptureFrameResults = new Signal();
    this.onUpdateCaptureStatus = new Signal();
    
    this._loadedDataChunks = 0;
    this._loadingImages = 0;
    this._loadingBuffers = 0;
    this._captureCount = 0;
    this._pendingCommandBufferData = new Map();
    this._timestampBuffer = null;
    this._timestampChunkCount = 0;
  }

  captureTextureFrames(message) {
    this._loadedDataChunks += message.chunkCount;
    this._loadingImages += message.count ?? 0;
    const textures = message.textures;
    if (textures) {
      for (const textureId of textures) {
        const texture = this._getObject(textureId);
        if (texture) {
          texture.imageDataPending = true;
        }
      }
    }
  }

  captureTextureDataChunk() {
    this._loadedDataChunks--;
  }
  
  captureTextureLoaded() {
    this._loadingImages--;
  }

  captureFrameResults(message) {
    const frame = message.frame;
    const count = message.count;
    const batches = message.batches;
    this.commands.length = count;
    this.frameIndex = frame;
    this._captureCount = batches;
  }

  captureFrameCommands(message) {
    const commands = message.commands;
    const index = message.index;
    const count = message.count;
    const frame = message.frame;
    const pendingCommandBuffers = this._pendingCommandBufferData;
    for (const ci in pendingCommandBuffers) {
      const cmdData = pendingCommandBuffers[ci];
      const cmd = commands[ci];
      for (const m in cmdData) {
        cmd[m] = cmdData[m];
      }
    }
    this._pendingCommandBufferData.clear();
    for (let i = 0, j = index; i < count; ++i, ++j) {
      this.commands[j] = commands[i];
    }
    this._captureCount--;
    if (this._captureCount === 0) {
      this.onCaptureFrameResults.emit(frame, this.commands);
    }
  }

  captureBuffers(message) {
    this._loadingBuffers += message.count ?? 0;
    this._loadedDataChunks += message.chunkCount;
  }

  captureBufferData(message) {
    const id = message.commandId;
    const entryIndex = message.entryIndex;
    const offset = message.offset;
    const size = message.size;
    const index = message.index;
    const count = message.count;
    const chunk = message.chunk;
    this._captureBufferData(id, entryIndex, offset, size, index, count, chunk);
  }

  getCaptureStatus() {
    let text = "";
    if (this._loadingImages || this._loadingBuffers || this._loadedDataChunks) {
      text = "Loading ";

      if (this._loadingImages) {
        text += `Images: ${this._loadingImages} `;
      }
      if (this._loadingBuffers) {
        text += `Buffers: ${this._loadingBuffers} `;
      }
      if (this._loadedDataChunks) {
        text += `Data Chunks: ${this._loadedDataChunks} `;
      }
    }
    return text;
    //this._captureStatus.text = text;
  }

  _getObject(id) {
    return this.database.getObject(id);
  }

  _captureBufferData(id, entryIndex, offset, size, index, count, chunk) {
    if (id === -1000) {
      // Timestamp buffer
      if (this._timestampBuffer == null) {
        this._timestampBuffer = new Uint8Array(size);
        this._timestampChunkCount = count;
      }
      const self = this;
      decodeDataUrl(chunk).then((chunkData) => {
        self._timestampBuffer.set(chunkData, offset);
        self._timestampChunkCount--;
        if (self._timestampChunkCount === 0) {
          let renderPassIndex = 0;
          let computePassIndex = 0;

          const timestampMap = new Array();

          const timestampData = new BigInt64Array(self._timestampBuffer.buffer);
          console.log(timestampData.length / 2);

          const firstTime = Number(timestampData[0]) / 1000000.0;

          for (let i = 2, k = 0; i < timestampData.length; i += 2) {
            const start = timestampData[i];
            const end = timestampData[i + 1];
            const duration = Number(end - start) / 1000000.0; // convert ns to ms
            for (; k < self.commands.length; k++) {
              const command = self.commands[k];
              if (command.method === "beginRenderPass" ||
                  command.method === "beginComputePass") {
                command.duration = duration;
                command.startTime = Number(start) / 1000000.0;
                command.endTime = Number(end) / 1000000.0;

                timestampMap.push(command);

                if (command.header) {
                  if (command.method === "beginRenderPass") {
                    const headerText = `Render Pass ${renderPassIndex} Duration: ${command.duration}ms`;
                    command.header.text = headerText;
                    renderPassIndex++;
                  } else {
                    const headerText = `Compute Pass ${computePassIndex} Duration: ${command.duration}ms`;
                    command.header.text = headerText;
                    computePassIndex++;
                  }
                }

                k++;
                break;
              }
            }
          }

          timestampMap.sort((a, b) => { return a.startTime - b.startTime; });
          for (const command of timestampMap) {
            console.log(`${command.startTime - firstTime}: [${command.id}]: ${command.method} -> ${command.duration}ms`);
          }

          self.onUpdateCaptureStatus.emit();
        }
      }).catch((error) => {
        console.error(error.message);
        self.onUpdateCaptureStatus.emit();
      });
      return;
    }

    let command = this.commands[id];
    if (!command) {
      command = this._pendingCommandBufferData[id] ?? {};
      this._pendingCommandBufferData[id] = command;
    }

    const self = this;
    decodeDataUrl(chunk).then((chunkData) => {
      const command = self.commands[id] ?? self._pendingCommandBufferData[id];
      self._addDataMembersToCommand(command, entryIndex, size, count);
      self._loadedDataChunks--;
      try {
        command.bufferData[entryIndex].set(chunkData, offset);
        command.loadedDataChunks[entryIndex][index] = true;
      } catch (e) {
        console.log(e);
        command.loadedDataChunks[entryIndex].length = 0;
        command.isBufferDataLoaded[entryIndex] = false;
      }

      let loaded = true;
      for (let i = 0; i < count; ++i) {
        if (!command.loadedDataChunks[entryIndex][i]) {
          loaded = false;
          break;
        }
      }
      command.isBufferDataLoaded[entryIndex] = loaded;

      if (command.isBufferDataLoaded[entryIndex]) {     
        self._loadingBuffers--;
        command.loadedDataChunks[entryIndex].length = 0;
      }

      self.onUpdateCaptureStatus.emit();
    }).catch((error) => {
      console.error(error);
      self._loadedDataChunks--;
      command.loadedDataChunks[entryIndex][index] = true;
      let loaded = true;
      for (let i = 0; i < count; ++i) {
        if (!command.loadedDataChunks[entryIndex][i]) {
          loaded = false;
          break;
        }
      }
      command.isBufferDataLoaded[entryIndex] = loaded;
      if (command.isBufferDataLoaded[entryIndex]) {     
        self._loadingBuffers--;
        command.loadedDataChunks[entryIndex].length = 0;
      }

      self.onUpdateCaptureStatus.emit();
    });
  }

  _addDataMembersToCommand(command, entryIndex, size, count) {
    if (!command.bufferData) {
      command.bufferData = [];
    }

    if (!command.dataPending) {
      command.dataPending = [];
    }

    if (!command.bufferData[entryIndex]) {
      command.bufferData[entryIndex] = new Uint8Array(size);
      command.dataPending[entryIndex] = true;
    }

    /*const bufferData = command.bufferData[entryIndex];
    if (bufferData.length != size) {
      console.log("!!!!!!!!!!!!!!! INVALID BUFFER SIZE", bufferData.length, size);
      return;
    }*/

    if (!command.loadedDataChunks) {
      command.loadedDataChunks = [];
    }

    if (!command.loadedDataChunks[entryIndex]) {
      command.loadedDataChunks[entryIndex] = [];
    }

    if (command.loadedDataChunks[entryIndex].length !== count) {
      command.loadedDataChunks[entryIndex].length = count;
    }

    if (!command.isBufferDataLoaded) {
      command.isBufferDataLoaded = [];
    }
  }
}
