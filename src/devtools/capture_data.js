
import { decodeBase64 } from "../utils/base64.js";
import { Signal } from "../utils/signal.js";

/*interface CaptureTextureFramesMessage {
    chunkCount: number;
    count: number;
    textures: number[];
}*/

/*interface CaptureFrameResultsMessage {
    frame: number;
    count: number;
    batches: number;
}*/

/*interface CaptureFrameCommandsMessage {
    frame: number;
    index: number;
    count: number;
    commands: Object[];
}*/

/*interface CaptureBuffersMessage {
    chunkCount: number;
    count: number;
}*/

/*interface CaptureBufferDataMessage {
    commandId: number;
    entryIndex: number;
    offset: number;
    size: number;
    index: number;
    count: number;
    chunk: string;
}*/

/*interface Command {
    id: number;
    method: string;
    args: any[];
}*/

export class CaptureData {
  /**
   * @param {ObjectDatabase} objectDatabase 
   */
  constructor(objectDatabase) {
    this.database = objectDatabase;

    this.frameIndex = 0;
    this.commands = [];
    this.renderPassTextures = new Map(); // Map of render pass IDs to their associated textures <number, [Texture]>

    // Emitted when frame results are captured and processed, providing the frame index and the list of commands.
    // (frame: number, commands: Object[])
    this.onCaptureFrameResults = new Signal();
    this.onUpdateCaptureStatus = new Signal();
    // Emitted once the GPU timestamp buffer for the captured frame has been decoded and
    // each beginRenderPass/beginComputePass command has been annotated with startTime,
    // endTime, and duration. Carries the chronologically-sorted list of pass commands.
    // ({ commands: Object[], firstTime: number })
    this.onTimestampDataReady = new Signal();

    this._loadedDataChunks = 0;
    this._loadingImages = 0;
    this._loadingBuffers = 0;
    this._captureCount = 0;
    this._pendingCommandBufferData = new Map();
    this._timestampBuffer = null;
    this._timestampChunkCount = 0;
    // Cached result of the latest onTimestampDataReady emit. Held on the instance so
    // late subscribers (e.g. a TimelineWidget built after the readback finished) can
    // pick up the data without depending on listener-registration ordering.
    this.timestampData = null;
  }

  /**
   * Called from the frontend with information about captured texture frames, 
   * updating the internal state to track loading progress.
   * @param {CaptureTextureFramesMessage} message 
   */
  captureTextureFrames(message) {
    this._loadedDataChunks += message.chunkCount;
    this._loadingImages += message.count ?? 0;
    const textures = message.textures;
    if (textures) {
      for (const textureId of textures) {
        const texture = this._getObject(textureId);
        if (texture) {
          texture.imageDataPending[0] = true;
        }
      }
    }
  }

  /**
   * Called when a chunk of texture data is loaded, updating the loading state and emitting status updates.
   */
  captureTextureDataChunk() {
    this._loadedDataChunks--;
  }

  /**
   * Called when a captured texture is fully loaded, decrementing the loading image count and emitting status updates.
   */
  captureTextureLoaded() {
    this._loadingImages--;
  }

  /**
   * Called when frame results are captured, updating the internal state with the new frame data.
   * @param {CaptureFrameResultsMessage} message 
   */
  captureFrameResults(message) {
    const frame = message.frame;
    const count = message.count;
    const batches = message.batches;
    this.commands.length = count;
    this.frameIndex = frame;
    this._captureCount = batches;
    // Reset any timestamp buffer left over from a previous capture so this
    // capture allocates a fresh buffer sized for its own timestamp data.
    this._timestampBuffer = null;
    this._timestampChunkCount = 0;
  }

  /**
   * Called when frame commands are captured, updating the internal state with the new command data.
   * @param {CaptureFrameCommandsMessage} message 
   */
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

  /**
   * Called when buffer data is captured, updating the internal state with the new buffer data.
   * @param {CaptureBuffersMessage} message 
   */
  captureBuffers(message) {
    this._loadingBuffers += message.count ?? 0;
    this._loadedDataChunks += message.chunkCount;
  }

  /**
   * Called when buffer data is captured, updating the internal state with the new buffer data.
   * @param {CaptureBufferDataMessage} message 
   */
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

  /**
   * Returns the current capture status as a string.
   * @returns {string}
   */
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
  }

  /**
   * Adds a texture to a render pass.
   * @param {number} passId - The ID of the render pass.
   * @param {Texture} texture - The texture to add.
   */
  addRenderPassTexture(passId, texture) {
    if (!this.renderPassTextures.has(passId)) {
      this.renderPassTextures.set(passId, []);
    }
    this.renderPassTextures.get(passId).push(texture);
  }

  /**
   * Retrieves an object from the database by its ID.
   * @param {number} id - The ID of the object to retrieve.
   * @returns {Object} The object with the specified ID.
   */
  _getObject(id) {
    return this.database.getObject(id);
  }

  /**
   * Handles the capture of buffer data, updating the internal state with the new buffer data and loading status.
   * @param {number} id - The ID of the command associated with the buffer data.
   * @param {number} entryIndex - The index of the buffer entry.
   * @param {number} offset - The offset within the buffer data.
   * @param {number} size - The size of the buffer data chunk.
   * @param {number} index - The index of the chunk within the entry.
   * @param {number} count - The total number of chunks for the entry.
   * @param {string} chunk - The base64-encoded buffer data chunk (plain base64, no data: prefix).
   */
  _captureBufferData(id, entryIndex, offset, size, index, count, chunk) {
    if (id === -1000) {
      // Timestamp buffer
      if (this._timestampBuffer === null) {
        this._timestampBuffer = new Uint8Array(size);
        this._timestampChunkCount = count;
      }
      let chunkData;
      try {
        chunkData = decodeBase64(chunk);
      } catch (error) {
        console.error(error.message);
        this.onUpdateCaptureStatus.emit();
        return;
      }
      if (offset + chunkData.length > this._timestampBuffer.length) {
        // Stale or oversized chunk (e.g. from a previous capture); ignore it
        // rather than throwing an out-of-bounds RangeError.
        console.error("Timestamp buffer chunk out of bounds; ignoring.");
        this.onUpdateCaptureStatus.emit();
        return;
      }
      this._timestampBuffer.set(chunkData, offset);
      this._timestampChunkCount--;
      if (this._timestampChunkCount === 0) {
        let renderPassIndex = 0;
        let computePassIndex = 0;

        const timestampMap = new Array();

        const timestampData = new BigInt64Array(this._timestampBuffer.buffer);

        const firstTime = Number(timestampData[0]) / 1000000.0;

        for (let i = 0, k = 0; i < timestampData.length; i += 2) {
          const start = timestampData[i];
          const end = timestampData[i + 1];
          const duration = Number(end - start) / 1000000.0; // convert ns to ms
          for (; k < this.commands.length; k++) {
            const command = this.commands[k];
            if (command.method === "beginRenderPass" ||
                command.method === "beginComputePass") {
              command.duration = duration;
              command.startTime = Number(start) / 1000000.0;
              command.endTime = Number(end) / 1000000.0;

              timestampMap.push(command);

              if (command.header) {
                const passLabel = command.args?.[0]?.label;
                if (command.method === "beginRenderPass") {
                  let headerText = `Render Pass ${renderPassIndex}`;
                  if (passLabel) {
                    headerText += ` "${passLabel}"`;
                  }
                  headerText += ` Duration: ${command.duration}ms`;
                  command.header.text = headerText;
                  renderPassIndex++;
                } else {
                  let headerText = `Compute Pass ${computePassIndex}`;
                  if (passLabel) {
                    headerText += ` "${passLabel}"`;
                  }
                  headerText += ` Duration: ${command.duration}ms`;
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

        this.timestampData = { commands: timestampMap, firstTime };
        this.onTimestampDataReady.emit(this.timestampData);
        this.onUpdateCaptureStatus.emit();

        this._timestampBuffer = null;
      }
      return;
    }

    let command = this.commands[id];
    if (!command) {
      command = this._pendingCommandBufferData[id] ?? {};
      this._pendingCommandBufferData[id] = command;
    }

    let chunkData;
    try {
      chunkData = decodeBase64(chunk);
    } catch (error) {
      console.error(error);
      this._loadedDataChunks--;
      this._addDataMembersToCommand(command, entryIndex, size, count);
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
        this._loadingBuffers--;
        command.loadedDataChunks[entryIndex].length = 0;
      }
      this.onUpdateCaptureStatus.emit();
      return;
    }

    command = this.commands[id] ?? this._pendingCommandBufferData[id];
    this._addDataMembersToCommand(command, entryIndex, size, count);
    this._loadedDataChunks--;
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
      this._loadingBuffers--;
      command.loadedDataChunks[entryIndex].length = 0;
    }

    this.onUpdateCaptureStatus.emit();
  }

  /**
   * Adds data members to a command for buffer management.
   * @param {Object} command - The command object to update.
   * @param {number} entryIndex - The index of the buffer entry.
   * @param {number} size - The size of the buffer data.
   * @param {number} count - The number of chunks for the buffer entry.
   */
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
