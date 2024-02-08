class WebGPURecorder {
  // public:
  constructor(options) {
    options = options || {};
    this.config = {
      maxFrameCount: Math.max((options.frames ?? 100) - 1, 1),
      exportName: options.export || "WebGPURecord",
      canvasWidth: options.width || 800,
      canvasHeight: options.height || 600,
      removeUnusedResources: !!options.removeUnusedResources,
      messageRecording: !!options.messageRecording
    };

    this._objectIndex = 1;
    this._initalized = false;
    this._initializeCommands = [];
    this._frameCommands = [];
    this._frameObjects = [];
    this._currentFrameCommands = null;
    this._currentFrameObjects = null;
    this._frameIndex = -1;
    this._isRecording = false;
    this._frameVariables = {};
    this._arrayCache = [];
    this._totalData = 0;
    this._isRecording = true;
    this._initalized = true;
    this._initializeObjects = [];
    this._frameVariables[-1] = new Set();
    this._adapter = null;
    this._unusedTextures = new Set();
    this._unusedTextureViews = new Map();
    this._unusedBuffers = new Set();
    this._dataCacheObjects = [];

    // Check if the browser supports WebGPU
    if (!navigator.gpu) {
      return;
    }

    this._gpuWrapper = new GPUObjectWrapper(this);
    this._gpuWrapper.onPromiseResolve = this._onAsyncResolve.bind(this);
    this._gpuWrapper.onPreCall = this._preMethodCall.bind(this);
    this._gpuWrapper.onPostCall = this._onMethodCall.bind(this);

    this._registerObject(navigator.gpu);
    this._recordLine(`${this._getObjectVariable(navigator.gpu)} = navigator.gpu;`, null);

    this._wrapCanvases();

    const self = this;

    // Capture any dynamically created canvases
    const __createElement = document.createElement;
    document.createElement = function (type) {
      const element = __createElement.call(document, type);
      if (type == "canvas") {
        self._wrapCanvas(element);
      }
      return element;
    };

    // Wrap requestAnimationFrame so it can keep track of per-frame recording and know when
    // the maximum number of frames has been reached.
    //
    // It would be nice to be able to arbitrarily start/stop recording. To do this,
    // we would need to keep track of things like shader creation/deletion that can happen
    // at arbitrary frames prior to the start, for any objects used within that recorded
    // duration.
    const __requestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = function (cb) {
      function callback() {
        self._frameStart();
        cb(performance.now());
        self._frameEnd();
      }
      __requestAnimationFrame(callback);
    };
  }

  getNextId() {
    return this._objectIndex++;
  }

  // private:
  _frameStart() {
    this._frameIndex++;
    this._frameVariables[this._frameIndex] = new Set();
    this._currentFrameCommands = [];
    this._frameCommands.push(this._currentFrameCommands);
    this._currentFrameObjects = [];
    this._frameObjects.push(this._currentFrameObjects);
  }

  _frameEnd() {
    if (this._frameIndex == this.config.maxFrameCount) {
      this.generateOutput();
    }
  }

  _removeUnusedCommands(objects, commands, unusedObjects) {
    const l = objects.length;
    for (let i = l - 1; i >= 0; --i) {
      const object = objects[i];
      if (!object) {
        continue;
      }
      if (unusedObjects.has(object.__id)) {
        commands[i] = "";
      }
    }
  }

  generateOutput() {
    const unusedObjects = new Set();
    this._isRecording = false;
    if (this.config.removeUnusedResources) {
      for (const object of this._unusedTextures) {
        unusedObjects.add(object);
      }
      for (const [key, value] of this._unusedTextureViews) {
        unusedObjects.add(key);
      }
      for (const object of this._unusedBuffers) {
        unusedObjects.add(object);
      }

      this._removeUnusedCommands(this._initializeObjects, this._initializeCommands, unusedObjects);
    }
    this._initializeCommands = this._initializeCommands.filter((cmd) => cmd != "");
    if (this.config.removeUnusedResources) {
      for (const obj of unusedObjects) {
        for (let di = 0, dl = this._dataCacheObjects.length; di < dl; ++di) {
          let dataObj = this._dataCacheObjects[di];
          if (dataObj) {
            for (let li = dataObj.length - 1; li >= 0; --li) {
              if (dataObj[li].__id == obj) {
                dataObj.splice(li, 1);
              }
            }
            if (dataObj.length == 0) {
              this._arrayCache[di].length = 0;
              this._arrayCache[di].type = "Uint8Array";
              this._arrayCache[di].array = new Uint8Array(0);
            }
          }
          /*if (dataObj && dataObj.__id == obj) {
              this._arrayCache[di].length = 0;
              this._arrayCache[di].type = "Uint8Array";
              this._arrayCache[di].array = new Uint8Array(0);
          }*/
        }
      }
    }
    let s =`
    <!DOCTYPE html>
    <html>
        <body style="text-align: center;">
            <canvas id="#webgpu" width=${this.config.canvasWidth} height=${this.config.canvasHeight}></canvas>
            <script>
    let D = new Array(${this._arrayCache.length});
    async function main() {
      await loadData();

      let canvas = document.getElementById("#webgpu");
      let context = canvas.getContext("webgpu");
      let frameLabel = document.createElement("div");
      frameLabel.style = "position: absolute; top: 10px; left: 10px; font-size: 24pt; color: #f00;";
      document.body.append(frameLabel);
      ${this._getVariableDeclarations(-1)}
      ${this._initializeCommands.join("\n  ")}\n`;
    for (let fi = 0, fl = this._frameCommands.length; fi < fl; ++fi) {
      if (this.config.removeUnusedResources) {
        this._removeUnusedCommands(this._frameObjects[fi], this._frameCommands[fi], unusedObjects);
        this._frameCommands[fi] = this._frameCommands[fi].filter((cmd) => cmd != "");
      }
      s += `
      async function f${fi}() {
          ${this._getVariableDeclarations(fi)}
          ${this._frameCommands[fi].join("\n  ")}
      }\n`;
    }
    s += "    let frames=[";
    for (let fi = 0, fl = this._frameCommands.length; fi < fl; ++fi) {
      s += `f${fi},`;
    }
    s += "];";
    s += `
        let frame = 0;
        let lastFrame = -1;
        let t0 = performance.now();
        async function renderFrame() {
            if (frame > ${this._frameCommands.length - 1}) return;
            requestAnimationFrame(renderFrame);
            if (frame == lastFrame) return;
            lastFrame = frame;
            let t1 = performance.now();
            frameLabel.innerText = "F: " + (frame + 1) + "  T:" + (t1 - t0).toFixed(2);
            t0 = t1;
            try {
                await frames[frame]();
            } catch (err) {
                console.log("Error Frame:", frame);
                console.error(err);
            }
            frame++;
        }
        requestAnimationFrame(renderFrame);
    }
    
    function setCanvasSize(canvas, width, height) {
        if (canvas.width !== width || canvas.height !== height) {
            canvas.width = width;
            canvas.height = height;
        }
    }
    
    async function B64ToA(s, type, length) {
        const res = await fetch(s);
        const x = new Uint8Array(await res.arrayBuffer());
        if (type == "Uint32Array")
            return new Uint32Array(x.buffer, 0, x.length/4);
        return new Uint8Array(x.buffer, 0, x.length);
    }
    
    async function loadData() {\n`;
    let promises = [];
    for (let ai = 0; ai < this._arrayCache.length; ++ai) {
      let a = this._arrayCache[ai];
      //let b64 = this._arrayToBase64(a.array);
      promises.push(new Promise((resolve) => {
        this._encodeDataUrl(a.array).then((b64) => {
          s += `D[${ai}] = await B64ToA("${b64}", "${a.type}", ${a.length});\n`;
          resolve();
        });
      }));
    }

    Promise.all(promises).then(() => {
      s += `
      }
      main();
              </script>
          </body>
      </html>\n`;
      this._downloadFile(s, (this.config.exportName || "WebGpuRecord") + ".html");
    });   
  }

  async _encodeDataUrl(a, type = "application/octet-stream") {
    const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
    return await new Promise((resolve, reject) => {
      const reader = Object.assign(new FileReader(), {
        onload: () => resolve(reader.result),
        onerror: () => reject(reader.error),
      });
      reader.readAsDataURL(new File([bytes], "", { type }));
    });
  }

  _downloadFile(data, filename) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([data], { type: "text/html" }));
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);

    if (this.config.messageRecording) {
      const maxMessageSize = 1024 * 1024; // Break message up into chunks
      if (data.length <= maxMessageSize) {
        window.postMessage({ "action": "webgpu_recording", data, "index": 0, "count": 1 });
      } else {
        let startIndex = 0;
        const dataLength = data.length;
        let messageIndex = 0;
        let messageCount = Math.ceil(dataLength / maxMessageSize);
        while (startIndex < dataLength) {
          const remainder = dataLength - startIndex;
          const size = remainder > maxMessageSize ? maxMessageSize : remainder;
          const dataChunk = data.substr(startIndex, size);
          window.postMessage({ "action": "webgpu_recording", "data": dataChunk, "index": messageIndex, "count": messageCount });
          messageIndex++;
          startIndex += size;
        }
      }
    }
  }

  _wrapCanvas(c) {
    if (c.__id) {
      return;
    }
    this._registerObject(c);
    let self = this;
    let __getContext = c.getContext;
    c.getContext = function (a1, a2) {
      let ret = __getContext.call(c, a1, a2);
      if (a1 == "webgpu") {
        if (ret) {
          self._wrapContext(ret);
        }
      }
      return ret;
    };
  }

  _wrapCanvases() {
    const canvases = document.getElementsByTagName("canvas");
    for (let i = 0; i < canvases.length; ++i) {
      const c = canvases[i];
      this._wrapCanvas(c);
    }
  }

  _registerObject(object) {
    const id = this.getNextId(object);
    object.__id = id;
    object.__frame = this._frameIndex;
  }

  _isFrameVariable(frame, name) {
    return this._frameVariables[frame] && this._frameVariables[frame].has(name);
  }

  _removeVariable(name) {
    for (const f in this._frameVariables) {
      const fs = this._frameVariables[f];
      fs.delete(name);
    }
  }

  _addVariable(frame, name) {
    this._frameVariables[frame].add(name);
  }

  _getVariableDeclarations(frame) {
    const s = this._frameVariables[frame];
    if (!s.size) {
      return "";
    }
    return `let ${[...s].join(",")};`;
  }

  _getObjectVariable(object) {
    if (object instanceof GPUCanvasContext) {
      return "context";
    }

    if (object.__id === undefined) {
      this._registerObject(object);
    }

    const name = `x${object.constructor.name.replace(/^GPU/, "")}${(object.__id || 0)}`;

    if (this._frameIndex != object.__frame) {
      if (!this._isFrameVariable(-1, name)) {
        this._removeVariable(name);
        this._addVariable(-1, name);
      }
    } else {
      this._addVariable(this._frameIndex, name);
    }

    return name;
  }

  _wrapContext(ctx) {
    this._recordLine(`${this._getObjectVariable(ctx)} = canvas.getContext("webgpu");`, null);
  }

  _getBytesFromImageSource(src) {
    let canvas = document.createElement("canvas");
    canvas.width = src.width;
    canvas.height = src.height;
    let c2d = canvas.getContext("2d");
    c2d.drawImage(src, 0, 0);
    let data = c2d.getImageData(0, 0, src.width, src.height);
    return data.data;
  }

  _onAsyncResolve(object, method, args, id, result) {
    if (method === "requestDevice") {
      const adapter = object;
      if (adapter.__id === undefined) {
        this._recordCommand(true, navigator.gpu, "requestAdapter", adapter, []);
      }
    }

    this._recordCommand(true, object, method, result, args);
  }

  _preMethodCall(object, method, args) {
    // We can"t track every change made to a mappedRange buffer since that all happens 
    // outside the scope of what WebGPU is in control of. So we keep track of all the
    // mapped buffer ranges, and when unmap is called, we record the content of their data
    // so that they have their correct data for the unmap.
    if (method === "unmap") {
      if (object.__mappedRanges) {
        for (const buffer of object.__mappedRanges) {
          // Make a copy of the mappedRange buffer data as it is when unmap
          // is called.
          const cacheIndex = this._getDataCache(buffer, 0, buffer.byteLength, buffer);
          // Set the mappedRange buffer data in the recording to what is in the buffer
          // at the time unmap is called.
          this._recordLine(`new Uint8Array(${this._getObjectVariable(buffer)}).set(D[${cacheIndex}]);`, null);
        }
        delete object.__mappedRanges;
      }
    } else if (method === "getCurrentTexture") {
      this._recordLine(`setCanvasSize(${this._getObjectVariable(object)}.canvas, ${object.canvas.width}, ${object.canvas.height})`, null);
    }
  }

  _onMethodCall(object, method, args, result) {
    if (method == "copyExternalImageToTexture") {
      // copyExternalImageToTexture uses ImageBitmap (or canvas or offscreenCanvas) as
      // its source, which we can"t record. ConvertcopyExternalImageToTexture to
      // writeTexture, and record the bytes from the ImageBitmap. To do that, we need
      // to draw the ImageBitmap into a canvas, and record the bytes from that.
      // A very heavy process, but not sure what else to do.
      const bytes = this._getBytesFromImageSource(args[0].source);
      const bytesPerPixel = 4;
      const bytesPerRow = args[0].source.width * bytesPerPixel;
      const texture = args[1]["texture"];
      const cacheIndex = this._getDataCache(bytes, bytes.byteOffset, bytes.byteLength, texture);
      this._recordLine(`${this._getObjectVariable(object)}.writeTexture(${this._stringifyObject(method, args[1])}, D[${cacheIndex}], {bytesPerRow:${bytesPerRow}}, ${this._stringifyObject(method, args[2])});`, object);
    } else {
      this._recordCommand(false, object, method, result, args);
    }

    if (method == "getMappedRange") {
      // Keep track of the mapped ranges for the buffer object. The recording will set their
      // data when unmap is called.
      if (!object.__mappedRanges) {
        object.__mappedRanges = [];
      }
      object.__mappedRanges.push(result);
    } else if (method == "submit") {
      // just to give the file some structure
      this._recordLine("", null);
    }
  }

  _stringifyObject(method, object) {
    let s = "";
    let first = true;
    for (let key in object) {
      let value = object[key];
      if (value === undefined) {
        continue;
      }
      if (!first) {
        s += ",";
      }
      first = false;
      s += `"${key}":`;
      if (method == "requestDevice") {
        if (key == "requiredFeatures") {
          s += "requiredFeatures";
          continue;
        } else if (key == "requiredLimits") {
          s += "requiredLimits";
          continue;
        }
      }
      if (method == "createBindGroup") {
        if (key == "resource") {
          if (this._unusedTextureViews.has(value.__id)) {
            const texture = this._unusedTextureViews.get(value.__id);
            this._unusedTextures.delete(texture);
          }
        }
      } else if (method == "beginRenderPass") {
        if (key == "colorAttachments") {
          for (const desc of value) {
            if (desc["view"]) {
              const view = desc["view"];
              if (this._unusedTextureViews.has(view.__id)) {
                const texture = this._unusedTextureViews.get(view.__id);
                this._unusedTextures.delete(texture);
                this._unusedTextureViews.delete(view.__id);
              }
            }
          }
        }
      }
      if (value === null) {
        s += "null";
      } else if (typeof (value) == "string") {
        s += `\`${value}\``;
      } else if (value.__id !== undefined) {
        s += this._getObjectVariable(value);
      } else if (value.__data !== undefined) {
        s += `D[${value.__data}]`;
      } else if (value.constructor == Array) {
        s += this._stringifyArray(value);
      } else if (typeof (value) == "object") {
        s += this._stringifyObject(method, value);
      } else {
        s += `${value}`;
      }
    }
    s = `{${s}}`;
    return s;
  }

  _stringifyArray(a) {
    let s = "[";
    s += this._stringifyArgs("", a);
    s += "]";
    return s;
  }

  _getDataCache(heap, offset, length, object) {
    let self = this;

    function _heapAccessShiftForWebGPUHeap(heap) {
      if (!heap.BYTES_PER_ELEMENT) {
        return 0;
      }
      return 31 - Math.clz32(heap.BYTES_PER_ELEMENT);
    }

    function _compareCacheData(ai, view) {
      const a = self._arrayCache[ai].array;
      if (a.length != view.length) {
        return false;
      }
      for (let i = 0, l = a.length; i < l; ++i) {
        if (a[i] != view[i]) {
          return false;
        }
      }
      return true;
    }

    const byteOffset = (heap.byteOffset ?? 0) + ((offset ?? 0) << _heapAccessShiftForWebGPUHeap(heap));
    const byteLength = length === undefined ? heap.byteLength : (length << _heapAccessShiftForWebGPUHeap(heap));

    this._totalData += byteLength;
    const view = new Uint8Array(heap.buffer ?? heap, byteOffset, byteLength);

    let cacheIndex = -1;
    for (let ai = 0; ai < self._arrayCache.length; ++ai) {
      const c = self._arrayCache[ai];
      if (c.length == length) {
        if (_compareCacheData(ai, view)) {
          cacheIndex = ai;
          break;
        }
      }
    }

    if (cacheIndex == -1) {
      cacheIndex = self._arrayCache.length;
      const arrayCopy = Uint8Array.from(view);
      self._arrayCache.push({
        length: byteLength,
        type: heap.constructor === "ArrayBuffer" ? Uint8Array : heap.constructor.name,
        array: arrayCopy
      });
    }

    if (object) {
      if (!this._dataCacheObjects[cacheIndex]) {
        this._dataCacheObjects[cacheIndex] = [];
      }
      this._dataCacheObjects[cacheIndex].push(object);
    }

    return cacheIndex;
  }

  _stringifyArgs(method, args) {
    if (args.length == 0 || (args.length == 1 && args[0] === undefined)) {
      return "";
    }

    args = [...args];

    // In order to capture buffer data, we need to know the offset and size of the data,
    // which are arguments of specific methods. So we need to special case those methods to
    // properly capture the buffer data passed to them.
    if (method == "writeBuffer") {
      const buffer = args[2];
      const offset = args[3];
      const size = args[4];
      const cacheIndex = this._getDataCache(buffer, offset, size, buffer);
      args[2] = { __data: cacheIndex };
      args[3] = 0;
    } else if (method == "writeTexture") {
      const texture = args[0].texture;
      const buffer = args[1];
      const bytesPerRow = args[2].bytesPerRow;
      const width = args[3].width || args[3][0];
      const { blockWidth, blockHeight, bytesPerBlock } = WebGPURecorder._formatInfo[texture.format];
      const widthInBlocks = width / blockWidth;
      const rows = args[2].rowsPerImage || (args[3].height || args[3][1] || 1) / blockHeight;
      const layers = args[3].depthOrArrayLayers || args[3][2] || 1;
      const totalRows = rows * layers;
      const size = totalRows > 0
        ? bytesPerRow * (totalRows - 1) + widthInBlocks * bytesPerBlock
        : 0;
        const offset = args[2].offset;
      // offset is in bytes but source can be any TypedArray
      // getDataCache assumes offset is in TypedArray.BYTES_PER_ELEMENT size
      // so view the data as bytes.
      const cacheIndex = this._getDataCache(new Uint8Array(buffer.buffer || buffer, buffer.byteOffset, buffer.byteLength), offset, size, texture);
      args[1] = { __data: cacheIndex };
      args[2].offset = 0;
    } else if (method == "setBindGroup") {
      if (args.length == 5) {
        const buffer = args[2];
        const offset = args[3];
        const size = args[4];
        const offsets = this._getDataCache(buffer, offset, size, buffer);
        args[2] = { __data: offsets };
        args.length = 3;
      } else if (args.length == 3) {
        const buffer = args[2];
        const offsets = this._getDataCache(buffer, 0, buffer.length, buffer);
        args[2] = { __data: offsets };
        args.length = 3;
      }
    } else if (method == "createBindGroup") {
      if (args[0]["entries"]) {
        const entries = args[0]["entries"];
        for (const entry of entries) {
          const value = entry["resource"];
          if (value && value.__id) {
            if (this._unusedTextureViews.has(value.__id)) {
              const texture = this._unusedTextureViews.get(value.__id);
              this._unusedTextures.delete(texture);
            }
          } else if (value && value["buffer"]) {
            const buffer = value["buffer"];
            if (this._unusedBuffers.has(buffer.__id)) {
              this._unusedBuffers.delete(buffer.__id);
            }
          }
        }
      }
    } else if (method == "copyBufferToBuffer") {
      if (this._unusedBuffers.has(args[0].__id)) {
        this._unusedBuffers.delete(args[0].__id);
      }
      if (this._unusedBuffers.has(args[2].__id)) {
        this._unusedBuffers.delete(args[2].__id);
      }
    } else if (method == "setVertexBuffer") {
      const buffer = args[1];
      if (this._unusedBuffers.has(buffer.__id)) {
        this._unusedBuffers.delete(buffer.__id);
      }
    } else if (method == "setIndexBuffer") {
      const buffer = args[0];
      if (this._unusedBuffers.has(buffer.__id)) {
        this._unusedBuffers.delete(buffer.__id);
      }
    } else if (method == "beginRenderPass") {
      if (args[0]["colorAttachments"]) {
        const value = args[0]["colorAttachments"];
        for (const desc of value) {
          if (desc["view"]) {
            const view = desc["view"];
            if (this._unusedTextureViews.has(view.__id)) {
              const texture = this._unusedTextureViews.get(view.__id);
              this._unusedTextures.delete(texture);
              this._unusedTextureViews.delete(view.__id);
            }
          }
        }
      }
      if (args[0]["depthStencilAttachment"]) {
        const value = args[0]["depthStencilAttachment"];
        if (value["view"]) {
          const view = value["view"];
          if (this._unusedTextureViews.has(view.__id)) {
            const texture = this._unusedTextureViews.get(view.__id);
            this._unusedTextures.delete(texture);
            this._unusedTextureViews.delete(view.__id);
          }
        }
      }
    }

    const argStrings = [];
    for (let a of args) {
      if (a === undefined) {
        argStrings.push("undefined");
      } else if (a === null) {
        argStrings.push("null");
      } else if (a.__data !== undefined) {
        argStrings.push(`D[${a.__data}]`); // This is a captured data buffer.
      } else if (a.__id) {
        argStrings.push(this._getObjectVariable(a));
      } else if (a.constructor === Array) {
        argStrings.push(this._stringifyArray(a));
      } else if (typeof (a) == "object") {
        argStrings.push(this._stringifyObject(method, a));
      } else if (typeof (a) == "string") {
        argStrings.push(`\`${a}\``);
      } else {
        argStrings.push(a);
      }
    }
    return argStrings.join();
  }

  _recordLine(line, object) {
    if (this._isRecording) {
      if (this._frameIndex == -1) {
        this._initializeCommands.push(line);
        this._initializeObjects.push(object);
      } else {
        this._currentFrameCommands.push(line);
        this._currentFrameObjects.push(object);
      }
    }
  }

  _recordCommand(async, object, method, result, args) {
    if (this._isRecording) {
      if (result) {
        if (typeof (result) === "string") {
          return;
        }

        this._registerObject(result);
      }

      async = async ? "await " : "";

      let obj = object;
      const hasAdapter = !!this._adapter;

      if (!hasAdapter && method == "requestAdapter") {
        this._adapter = result;
      } else if (method == "createTexture") {
        this._unusedTextures.add(result.__id);
        obj = result;
      } else if (method == "createView") {
        this._unusedTextureViews.set(result.__id, object.__id);
      } else if (method == "writeTexture") {
        obj = args[0].texture;
      } else if (method == "createBuffer") {
        this._unusedBuffers.add(result.__id);
        obj = result;
      } else if (method == "writeBuffer") {
        obj = args[0];
      }

      // Add a blank line before render and compute passes to make them easier to
      // identify in the recording file.
      if (method == "beginRenderPass" || method == "beginComputePass") {
        this._recordLine("\n", null);
      }

      if (result) {
        this._recordLine(`${this._getObjectVariable(result)} = ${async}${this._getObjectVariable(object)}.${method}(${this._stringifyArgs(method, args)});`, obj);
      } else {
        this._recordLine(`${async}${this._getObjectVariable(object)}.${method}(${this._stringifyArgs(method, args)});`, obj);
      }

      // Add a blank line after ending render and compute passes to make them easier
      // to identify in the recording file.
      if (method == "end") {
        this._recordLine("\n", null);
      }

      if (!hasAdapter && method == "requestAdapter") {
        const adapter = this._getObjectVariable(result);
        this._recordLine(`const requiredFeatures = [];
          for (const x of ${adapter}.features) {
              requiredFeatures.push(x);
          }`, obj);
        this._recordLine(`const requiredLimits = {};
          const exclude = new Set(["minSubgroupSize", "maxSubgroupSize"]);
          for (const x in ${adapter}.limits) {
            if (!exclude.has(x)) {
              requiredLimits[x] = ${adapter}.limits[x];
            }
          }`, obj);
      }

      if (result instanceof GPUDevice) {
        const q = result.queue;
        if (q.__id === undefined) {
          this._recordLine(`${this._getObjectVariable(q)} = ${this._getObjectVariable(result)}.queue;`, result);
        }
      }
    }
  }
}

WebGPURecorder._asyncMethods = new Set([
  "requestAdapter",
  "requestDevice",
  "createComputePipelineAsync",
  "createRenderPipelineAsync",
  "mapAsync",
]);

WebGPURecorder._skipMethods = new Set([
  "toString",
  "entries",
  "getContext",
  "forEach",
  "has",
  "keys",
  "values",
  "getPreferredFormat",
  "requestAdapterInfo",
  "pushErrorScope",
  "popErrorScope"
]);

WebGPURecorder._formatInfo = {
  "r8unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 1 },
  "r8snorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 1 },
  "r8uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 1 },
  "r8sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 1 },
  "rg8unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
  "rg8snorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
  "rg8uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
  "rg8sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
  "rgba8unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "rgba8unorm-srgb": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "rgba8snorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "rgba8uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "rgba8sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "bgra8unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "bgra8unorm-srgb": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "r16uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
  "r16sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
  "r16float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
  "rg16uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "rg16sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "rg16float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "rgba16uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
  "rgba16sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
  "rgba16float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
  "r32uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "r32sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "r32float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "rg32uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
  "rg32sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
  "rg32float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 8 },
  "rgba32uint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 16 },
  "rgba32sint": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 16 },
  "rgba32float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 16 },
  "rgb10a2unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "rg11b10ufloat": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "rgb9e5ufloat": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "stencil8": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 1 },
  "depth16unorm": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 2 },
  "depth32float": { "blockWidth": 1, "blockHeight": 1, "bytesPerBlock": 4 },
  "depth24plus": { "blockWidth": 1, "blockHeight": 1 },
  "depth24plus-stencil8": { "blockWidth": 1, "blockHeight": 1 },
  "depth32float-stencil8": { "blockWidth": 1, "blockHeight": 1 },
  "bc1-rgba-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
  "bc1-rgba-unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
  "bc2-rgba-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "bc2-rgba-unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "bc3-rgba-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "bc3-rgba-unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "bc4-r-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
  "bc4-r-snorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
  "bc5-rg-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "bc5-rg-snorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "bc6h-rgb-ufloat": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "bc6h-rgb-float": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "bc7-rgba-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "bc7-rgba-unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "etc2-rgb8unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
  "etc2-rgb8unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
  "etc2-rgb8a1unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
  "etc2-rgb8a1unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
  "etc2-rgba8unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "etc2-rgba8unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "eac-r11unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
  "eac-r11snorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 8 },
  "eac-rg11unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "eac-rg11snorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "astc-4x4-unorm": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "astc-4x4-unorm-srgb": { "blockWidth": 4, "blockHeight": 4, "bytesPerBlock": 16 },
  "astc-5x4-unorm": { "blockWidth": 5, "blockHeight": 4, "bytesPerBlock": 16 },
  "astc-5x4-unorm-srgb": { "blockWidth": 5, "blockHeight": 4, "bytesPerBlock": 16 },
  "astc-5x5-unorm": { "blockWidth": 5, "blockHeight": 5, "bytesPerBlock": 16 },
  "astc-5x5-unorm-srgb": { "blockWidth": 5, "blockHeight": 5, "bytesPerBlock": 16 },
  "astc-6x5-unorm": { "blockWidth": 6, "blockHeight": 5, "bytesPerBlock": 16 },
  "astc-6x5-unorm-srgb": { "blockWidth": 6, "blockHeight": 5, "bytesPerBlock": 16 },
  "astc-6x6-unorm": { "blockWidth": 6, "blockHeight": 6, "bytesPerBlock": 16 },
  "astc-6x6-unorm-srgb": { "blockWidth": 6, "blockHeight": 6, "bytesPerBlock": 16 },
  "astc-8x5-unorm": { "blockWidth": 8, "blockHeight": 5, "bytesPerBlock": 16 },
  "astc-8x5-unorm-srgb": { "blockWidth": 8, "blockHeight": 5, "bytesPerBlock": 16 },
  "astc-8x6-unorm": { "blockWidth": 8, "blockHeight": 6, "bytesPerBlock": 16 },
  "astc-8x6-unorm-srgb": { "blockWidth": 8, "blockHeight": 6, "bytesPerBlock": 16 },
  "astc-8x8-unorm": { "blockWidth": 8, "blockHeight": 8, "bytesPerBlock": 16 },
  "astc-8x8-unorm-srgb": { "blockWidth": 8, "blockHeight": 8, "bytesPerBlock": 16 },
  "astc-10x5-unorm": { "blockWidth": 10, "blockHeight": 5, "bytesPerBlock": 16 },
  "astc-10x5-unorm-srgb": { "blockWidth": 10, "blockHeight": 5, "bytesPerBlock": 16 },
  "astc-10x6-unorm": { "blockWidth": 10, "blockHeight": 6, "bytesPerBlock": 16 },
  "astc-10x6-unorm-srgb": { "blockWidth": 10, "blockHeight": 6, "bytesPerBlock": 16 },
  "astc-10x8-unorm": { "blockWidth": 10, "blockHeight": 8, "bytesPerBlock": 16 },
  "astc-10x8-unorm-srgb": { "blockWidth": 10, "blockHeight": 8, "bytesPerBlock": 16 },
  "astc-10x10-unorm": { "blockWidth": 10, "blockHeight": 10, "bytesPerBlock": 16 },
  "astc-10x10-unorm-srgb": { "blockWidth": 10, "blockHeight": 10, "bytesPerBlock": 16 },
  "astc-12x10-unorm": { "blockWidth": 12, "blockHeight": 10, "bytesPerBlock": 16 },
  "astc-12x10-unorm-srgb": { "blockWidth": 12, "blockHeight": 10, "bytesPerBlock": 16 },
  "astc-12x12-unorm": { "blockWidth": 12, "blockHeight": 12, "bytesPerBlock": 16 },
  "astc-12x12-unorm-srgb": { "blockWidth": 12, "blockHeight": 12, "bytesPerBlock": 16 },
};

const GPUObjectTypes = new Set([
  GPUAdapter,
  GPUDevice,
  GPUBuffer,
  GPUTexture,
  GPUTextureView,
  GPUExternalTexture,
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
  GPUQueue,
  GPUQuerySet,
  GPUCanvasContext
]);

class GPUObjectWrapper {
  constructor(idGenerator) {
    this._idGenerator = idGenerator;
    this.onPreCall = null;
    this.onPostCall = null;
    this.onPromise = null;
    this.onPromiseResolve = null;
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
  }

  _wrapMethod(method, origMethod) {
    const self = this;
    return function () {
      const object = this;

      const args = [...arguments];

      // Allow the arguments to be modified before the method is called.
      if (self.onPreCall) {
        self.onPreCall(object, method, args);
      }

      // Call the original method
      const result = origMethod.call(object, ...args);

      // If it was an async method it will have returned a Promise
      if (result instanceof Promise) {
        const id = self._idGenerator.getNextId(object);
        if (self.onPromise) {
          self.onPromise(object, method, args, id);
        }
        const promise = result;
        const wrappedPromise = new Promise((resolve) => {
          promise.then((result) => {
            if (self.onPromiseResolve) {
              self.onPromiseResolve(object, method, args, id, result);
            }
            resolve(result);
          });
        });
        return wrappedPromise;
      }

      // Otherwise it"s a synchronous method
      if (self.onPostCall) {
        self.onPostCall(object, method, args, result);
      }

      return result;
    };
  }
}


function main() {
  // If the script tag has a filename attribute, then auto start recording.
  const script = document.getElementById("__webgpu_recorder");
  if (script) {
    const filename = script.getAttribute("filename");
    const frames = script.getAttribute("frames");
    const messageRecording = script.getAttribute("messageRecording");
    const removeUnusedResources = script.getAttribute("removeUnusedResources");
    if (filename) {
      new WebGPURecorder({
        "frames": frames || 1,
        "export": filename,
        "removeUnusedResources": !!removeUnusedResources,
        "messageRecording": !!messageRecording
      });
    }
  }
}

main();
