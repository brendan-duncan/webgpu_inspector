(() => {
  let webgpuInspector = null;

  class Buffer {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class Sampler {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class Texture {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class ShaderModule {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class BindGroupLayout {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class BindGroup {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class PipelineLayout {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class RenderPipeline {
    constructor(descriptor) {
      this.descriptor = descriptor;
      this.time = 0;
      this.element = null;
    }
  }

  class ComputePipeline {
    constructor(descriptor) {
      this.descriptor = descriptor;
    }
  }

  class InspectorPanel {
    constructor(database) {
      this.database = database;

      let self = this;
      let isDragging = false;
      let prevX = 0;
      let prevY = 0;

      this.panel = document.createElement("div");
      this.panel.className = "inspector_panel";
      document.body.appendChild(this.panel);
      this.panel.onmouseup = (e) => {
        e.preventDefault();
        e.stopPropagation();
        isDragging = false;
      };

      this.titleBar = document.createElement("div");
      this.titleBar.className = "inspector_panel_bar";
      this.titleBar.innerHTML = "Inspector";
      this.panel.appendChild(this.titleBar);

      this.titleBar.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        isDragging = true;
        prevX = e.clientX;
        prevY = e.clientY;
      };

      document.addEventListener("mousemove", function (e) {
        if (!isDragging) return;

        const dx = e.clientX - prevX;
        const dy = e.clientY - prevY;

        const rect = self.panel.getBoundingClientRect();
        let x = rect ? rect.left : 0;
        let y = rect ? rect.top : 0;
        x += dx;
        y += dy;

        prevX = e.clientX;
        prevY = e.clientY;
        self.panel.style.left = `${x}px`;
        self.panel.style.top = `${y}px`;
      });

      document.addEventListener("mouseup", function () {
        self.isDragging = false;
      });

      let contentArea = document.createElement("div");
      contentArea.style = "max-height: 600px; overflow-y: auto;";
      this.panel.appendChild(contentArea);

      this.content = document.createElement("pre");
      this.content.className = "inspector_panel_content";
      contentArea.appendChild(this.content);
    }

    enable() {
      this.panel.style.display = "block";
    }

    disable() {
      this.panel.style.display = "none";
    }

    inspectObject(id, object) {
      this.content.innerHTML = "";

      let div = document.createElement("div");
      this.content.appendChild(div);
      let title = document.createElement("span");
      div.appendChild(title);
      title.innerHTML = "Type: ";
      let type = document.createElement("span");
      div.appendChild(type);
      type.innerHTML = object.constructor.name;

      div = document.createElement("div");
      this.content.appendChild(div);
      title = document.createElement("span");
      div.appendChild(title);
      title.innerHTML = "Descriptor: ";
      let descriptor = document.createElement("span");
      div.appendChild(descriptor);
      descriptor.innerHTML = JSON.stringify(object.descriptor, undefined, 4);
    }
  }

  class ObjectsPanel {
    constructor(database) {
      this.database = database;

      this.inspector = new InspectorPanel(database);

      let self = this;
      let isDragging = false;
      let prevX = 0;
      let prevY = 0;

      this.debugPanel = document.createElement("div");
      this.debugPanel.className = "debug_panel";
      document.body.appendChild(this.debugPanel);
      this.debugPanel.onmouseup = (e) => {
        e.preventDefault();
        e.stopPropagation();
        isDragging = false;
      };

      this.objectPanelTitleBar = document.createElement("div");
      this.objectPanelTitleBar.className = "panel_bar";
      this.objectPanelTitleBar.innerHTML = "WebGPU Objects";
      this.debugPanel.appendChild(this.objectPanelTitleBar);

      this.objectPanelTitleBar.onmousedown = (e) => {
        e.preventDefault();
        e.stopPropagation();
        isDragging = true;
        prevX = e.clientX;
        prevY = e.clientY;
      };

      document.addEventListener("mousemove", function (e) {
        if (!isDragging) return;

        const dx = e.clientX - prevX;
        const dy = e.clientY - prevY;

        const rect = self.debugPanel.getBoundingClientRect();
        let x = rect ? rect.left : 0;
        let y = rect ? rect.top : 0;
        x += dx;
        y += dy;

        prevX = e.clientX;
        prevY = e.clientY;
        self.debugPanel.style.left = `${x}px`;
        self.debugPanel.style.top = `${y}px`;
      });

      document.addEventListener("mouseup", function () {
        self.isDragging = false;
      });

      this.statsArea = document.createElement("div");
      this.statsArea.className = "stats_area";
      this.debugPanel.appendChild(this.statsArea);

      let div = document.createElement("div");
      this.statsArea.appendChild(div);
      let title = document.createElement("span");
      div.appendChild(title);
      title.innerHTML = "Frame Duration: ";
      this.uiFrameTime = document.createElement("span");
      div.appendChild(this.uiFrameTime);

      div = document.createElement("div");
      this.statsArea.appendChild(div);
      title = document.createElement("span");
      div.appendChild(title);
      title.innerHTML = "Frame Render Passes: ";
      this.uiFrameRenderPasses = document.createElement("span");
      div.appendChild(this.uiFrameRenderPasses);

      div = document.createElement("div");
      this.statsArea.appendChild(div);
      title = document.createElement("span");
      div.appendChild(title);
      title.innerHTML = "Pending Async Render Pipelines: ";
      this.uiPendingRenderPipelinesStat = document.createElement("span");
      div.appendChild(this.uiPendingRenderPipelinesStat);

      div = document.createElement("div");
      this.statsArea.appendChild(div);
      title = document.createElement("span");
      div.appendChild(title);
      title.innerHTML = "Render Pipelines: ";
      this.uiRenderPipelinesStat = document.createElement("span");
      div.appendChild(this.uiRenderPipelinesStat);

      div = document.createElement("div");
      this.statsArea.appendChild(div);
      title = document.createElement("span");
      div.appendChild(title);
      title.innerHTML = "Shader Modules: ";
      this.uiShaderModulesStat = document.createElement("span");
      div.appendChild(this.uiShaderModulesStat);

      div = document.createElement("div");
      this.statsArea.appendChild(div);
      title = document.createElement("span");
      div.appendChild(title);
      title.innerHTML = "Buffers: ";
      this.uiBuffersStat = document.createElement("span");
      div.appendChild(this.uiBuffersStat);

      div = document.createElement("div");
      this.statsArea.appendChild(div);
      title = document.createElement("span");
      div.appendChild(title);
      title.innerHTML = "Textures: ";
      this.uiTexturesStat = document.createElement("span");
      div.appendChild(this.uiTexturesStat);

      div = document.createElement("div");
      this.statsArea.appendChild(div);
      title = document.createElement("span");
      div.appendChild(title);
      title.innerHTML = "Samplers: ";
      this.uiSamplersStat = document.createElement("span");
      div.appendChild(this.uiSamplersStat);

      div = document.createElement("div");
      this.statsArea.appendChild(div);
      title = document.createElement("span");
      div.appendChild(title);
      title.innerHTML = "BindGroups: ";
      this.uiBindGroupsStat = document.createElement("span");
      div.appendChild(this.uiBindGroupsStat);

      // Object lists
      this.uiPendingRenderPipelines = this._createObjectListUI(
        this.debugPanel,
        "Pending Async Render Pipelines"
      );
      this.uiRenderPipelines = this._createObjectListUI(
        this.debugPanel,
        "Render Pipelines"
      );
      this.uiComputePipelines = this._createObjectListUI(
        this.debugPanel,
        "Compute Pipelines"
      );
      this.uiShaderModules = this._createObjectListUI(
        this.debugPanel,
        "Shader Modules"
      );
      this.uiBuffers = this._createObjectListUI(this.debugPanel, "Buffers");
      this.uiTextures = this._createObjectListUI(this.debugPanel, "Textures");
      this.uiSamplers = this._createObjectListUI(this.debugPanel, "Samplers");
      this.uiBindGroups = this._createObjectListUI(
        this.debugPanel,
        "BindGroups"
      );
      this.uiBindGroupLayouts = this._createObjectListUI(
        this.debugPanel,
        "BindGroupLayouts"
      );
    }

    enable() {
      console.log("ENABLE");
      this.enabled = true;
      this.debugPanel.style.display = "block";
      this.inspector.enable();
    }

    disable() {
      console.log("DISABLE");
      this.enabled = false;
      this.debugPanel.style.display = "none";
      this.inspector.disable();
    }

    _createObjectListUI(parent, name) {
      const div = document.createElement("div");
      parent.appendChild(div);

      const titleBar = document.createElement("div");
      div.appendChild(titleBar);
      titleBar.className = "title_bar";

      const collapse = document.createElement("span");
      titleBar.appendChild(collapse);
      collapse.className = "collapse";
      collapse.innerHTML = "+";

      const title = document.createElement("span");
      titleBar.appendChild(title);
      title.innerHTML = name;
      title.className = "object_type";

      const objectList = document.createElement("ol");
      objectList.classList.add("object_list", "collapsed");
      div.appendChild(objectList);
      collapse.onclick = function () {
        if (this.innerHTML == "-") {
          this.innerHTML = "+";
          objectList.className = "object_list collapsed";
        } else {
          this.innerHTML = "-";
          objectList.className = "object_list";
        }
      };

      return objectList;
    }

    updateLabels() {
      this.uiPendingRenderPipelinesStat.innerHTML =
        this.database.pendingRenderPipelines.size.toLocaleString("en-US");
      this.uiRenderPipelinesStat.innerHTML =
        this.database.renderPipelines.size.toLocaleString("en-US");
      this.uiShaderModulesStat.innerHTML =
        this.database.shaderModules.size.toLocaleString("en-US");
      this.uiBindGroupsStat.innerHTML =
        this.database.bindGroups.size.toLocaleString("en-US");
      this.uiTexturesStat.innerHTML =
        this.database.textures.size.toLocaleString("en-US");
      this.uiSamplersStat.innerHTML =
        this.database.samplers.size.toLocaleString("en-US");

      let size = 0;
      for (const buffer of this.database.buffers.values()) {
        size += buffer.size;
      }
      this.uiBuffersStat.innerHTML = `${this.database.buffers.size.toLocaleString(
        "en-US"
      )} Size: ${size.toLocaleString("en-US")} Bytes`;
    }

    addObject(id, object, pending) {
      let o = null;
      if (object instanceof Sampler) {
        o = document.createElement("li");
        o.innerHTML = `Sampler ${id}`;
        this.uiSamplers.appendChild(o);
        object.element = o;
      } else if (object instanceof Texture) {
        o = document.createElement("li");
        o.innerHTML = `Texture ${id}`;
        this.uiTextures.appendChild(o);
        object.element = o;
      } else if (object instanceof Buffer) {
        o = document.createElement("li");
        o.innerHTML = `Buffer ${id}`;
        this.uiBuffers.appendChild(o);
        object.element = o;
      } else if (object instanceof BindGroup) {
        o = document.createElement("li");
        o.innerHTML = `BindGroup ${id}`;
        this.uiBindGroups.appendChild(o);
        object.element = o;
      } else if (object instanceof BindGroupLayout) {
        o = document.createElement("li");
        o.innerHTML = `BindGroupLayout ${id}`;
        this.uiBindGroupLayouts.appendChild(o);
        object.element = o;
      } else if (object instanceof ShaderModule) {
        o = document.createElement("li");
        o.innerHTML = `ShaderModule ${id} Size:${object.descriptor[0].code.length.toLocaleString(
          "en-US"
        )} bytes`;
        this.uiShaderModules.appendChild(o);
        object.element = o;
      } else if (object instanceof RenderPipeline) {
        o = document.createElement("li");
        o.innerHTML = `RenderPipeline ${id} time:${
          object.time?.toLocaleString("en-US") ?? "0"
        }ms`;
        object.element = o;
        if (pending) this.uiPendingRenderPipelines.appendChild(o);
        else this.uiRenderPipelines.appendChild(o);
      } else if (object instanceof ComputePipeline) {
        o = document.createElement("li");
        o.innerHTML = `ComputePipeline ${id}`;
        this.uiComputePipelines.appendChild(o);
        object.element = o;
      }

      let self = this;
      if (o) {
        o.onclick = (e) => {
          e.preventDefault();
          e.stopPropagation();
          self.onObjectSelected(id, object);
        };
      }

      this.updateLabels();
    }

    onObjectSelected(id, object) {
      this.inspector.inspectObject(id, object);
    }

    resolvePendingObject(id, object) {
      const vs = this.database.getObject(
        object.descriptor[0].vertex.module.__id
      );
      const fs = this.database.getObject(
        object.descriptor[0].fragment.module.__id
      );

      object.element.innerHTML = `RenderPipeline ${id} time:${object.time.toLocaleString(
        "en-US"
      )}ms vs_size:${vs.size.toLocaleString(
        "en-US"
      )} fs_size:${fs.size.toLocaleString("en-US")}`;

      this.uiRenderPipelines.appendChild(object.element);

      this.updateLabels();
    }

    deleteObject(id, object) {
      object.element?.remove();
      this.updateLabels();
    }

    updateFrameStats() {
      this.uiFrameTime.innerHTML = `${this.database.frameTime.toFixed(2)}ms`;
      this.uiFrameRenderPasses.innerHTML =
        this.database.renderPassCount.toLocaleString("en-US");
    }
  }

  class ObjectDatabase {
    constructor() {
      this.allObjects = new Map();
      this.samplers = new Map();
      this.textures = new Map();
      this.buffers = new Map();
      this.bindGroups = new Map();
      this.bindGroupLayouts = new Map();
      this.shaderModules = new Map();
      this.renderPipelines = new Map();
      this.computePipelines = new Map();
      this.pendingRenderPipelines = new Map();
      this.pendingComputePipelines = new Map();

      this.objectsPanel = null;
      this.renderPassCount = 0;
    }

    initGui() {
      this.objectsPanel = new ObjectsPanel(this);
    }

    enable() {
      if (!this.objectsPanel) {
        this.initGui();
      }
      this.objectsPanel?.enable();
    }

    disable() {
      this.objectsPanel?.disable();
      this.objectsPanel = null;
    }

    beginFrame() {
      this.startFrameTime = performance.now();
      this.renderPassCount = 0;
    }

    presentFrame() {
      this.endFrameTime = performance.now();
      this.frameTime = this.endFrameTime - this.startFrameTime;
      this.objectsPanel?.updateFrameStats();
    }

    beginRenderPass() {
      this.renderPassCount++;
    }

    getObject(id) {
      return this.allObjects.get(id);
    }

    addObject(id, object, pending) {
      this.allObjects.set(id, object);
      if (object instanceof Sampler) {
        this.samplers.set(id, object);
      } else if (object instanceof Texture) {
        this.textures.set(id, object);
      } else if (object instanceof Buffer) {
        this.buffers.set(id, object);
      } else if (object instanceof BindGroup) {
        this.bindGroups.set(id, object);
      } else if (object instanceof BindGroupLayout) {
        this.bindGroupLayouts.set(id, object);
      } else if (object instanceof ShaderModule) {
        this.shaderModules.set(id, object);
      } else if (object instanceof RenderPipeline) {
        if (pending) this.pendingRenderPipelines.set(id, object);
        else this.renderPipelines.set(id, object);
      } else if (object instanceof ComputePipeline) {
        this.computePipelines.set(id, object);
      }

      if (this.objectsPanel) this.objectsPanel.addObject(id, object, pending);
    }

    resolvePendingObject(id) {
      let object = this.allObjects.get(id);
      if (object instanceof RenderPipeline) {
        this.pendingRenderPipelines.delete(id);
        this.renderPipelines.set(id, object);

        if (this.objectsPanel)
          this.objectsPanel.resolvePendingObject(id, object);
      } else if (object instanceof ComputePipeline) {
        this.pendingComputePipelines.delete(id);
        this.computePipelines.set(id, object);
      }
    }

    deleteObject(id) {
      let object = this.allObjects.get(id);
      this.allObjects.delete(id);
      this.samplers.delete(id);
      this.textures.delete(id);
      this.buffers.delete(id);
      this.bindGroups.delete(id);
      this.bindGroupLayouts.delete(id);
      this.shaderModules.delete(id);
      this.renderPipelines.delete(id);
      this.computePipelines.delete(id);
      this.pendingRenderPipelines.delete(id);
      this.pendingComputePipelines.delete(id);

      if (this.objectsPanel) this.objectsPanel.deleteObject(id, object);
    }
  }

  class WebGPUInspector {
    constructor(options) {
      if (!window.navigator.gpu) return;

      this._frames = [];
      this._currentFrame = null;
      this._frameIndex = -1;
      this._isRecording = false;
      this._initalized = true;
      this._objectID = 1;
      this._frameStartTime = -1;
      this._timeSinceLastFrame = 0;
      this._maxFramesToRecord = 1000;
      this._recordRequest = false;

      this._objectDatabase = new ObjectDatabase();

      this._wrapObject(window.navigator.gpu);
      this._wrapCanvases();

      let self = this;

      // Capture any dynamically created canvases
      let __createElement = document.createElement;
      document.createElement = function (type) {
        let element = __createElement.call(document, type);
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
      let __requestAnimationFrame = window.requestAnimationFrame;
      window.requestAnimationFrame = function (cb) {
        function callback() {
          self._frameStart();
          cb(performance.now());
          self._frameEnd();
        }
        __requestAnimationFrame(callback);
      };

      if (options && options.recordOnStart) this.startRecord();
    }

    enable() {
      this._objectDatabase.enable();
    }

    disable() {
      this._objectDatabase.disable();
    }

    startRecord() {
      this.clear();
      this._recordRequest = true;
    }

    stopRecord() {
      this._recordRequest = false;
      this._isRecording = false;
    }

    get isRecording() {
      return this._isRecording;
    }

    clear() {
      this._frames.length = 0;
      this._currentFrame = null;
      this._frameIndex = 0;
    }

    _frameStart() {
      if (this._recordRequest) {
        this._recordRequest = false;
        this._isRecording = true;
      }

      if (this._isRecording) {
        let time = performance.now();
        if (this._frameStartTime != -1)
          this._timeSinceLastFrame = time - this._frameStartTime;
        this._frameStartTime = time;
        this._frameIndex++;
        this._currentFrame = [];
      }

      this._objectDatabase.beginFrame();
    }

    _frameEnd() {
      this._objectDatabase.presentFrame();

      if (this._isRecording) {
        let time = performance.now();
        let duration = time - this._frameStartTime;
        this._frames.push({
          timeSinceLastFrame: this._timeSinceLastFrame,
          duration,
          commands: Array.from(this._currentFrame),
        });
      }
    }

    _stringifyArgs(args, writeKeys = false) {
      let s = "";
      for (let key in args) {
        let a = args[key];
        if (s != "") s += ", ";

        if (writeKeys) s += `"${key}":`;

        if (!a) s += a;
        else if (typeof a == "string") s += `\`${a}\``;
        else if (a.length && a.length > 10)
          s += `${a.constructor.name}(${a.length})`;
        else if (a.length !== undefined)
          s += `[${this._stringifyArgs(a, false)}]`;
        else if (a.__id !== undefined) s += `${a.constructor.name}@${a.__id}`;
        else if (typeof a == "object")
          s += `{ ${this._stringifyArgs(a, true)} }`;
        else s += JSON.stringify(a);
      }
      return s;
    }

    _downloadFile(data, filename) {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(
        new Blob([data], { type: "application/javascript" })
      );
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    }

    _wrapCanvas(c) {
      if (c.__id) return;
      c.__id = this._objectID++;
      let self = this;
      let __getContext = c.getContext;

      c.getContext = function (a1, a2) {
        let ret = __getContext.call(c, a1, a2);
        if (a1 == "webgpu") {
          if (ret) {
            self._wrapObject(ret);
          }
        }
        return ret;
      };
    }

    _wrapCanvases() {
      let canvases = document.getElementsByTagName("canvas");
      for (let i = 0; i < canvases.length; ++i) {
        let c = canvases[i];
        this._wrapCanvas(c);
      }
    }

    _objectHasMethods(object) {
      for (const m in object) {
        if (
          typeof object[m] == "function" &&
          WebGPUInspector._skipMethods.indexOf(m) == -1
        ) {
          return true;
        }
      }
      return false;
    }

    _wrapObject(object) {
      if (object.__id) return;
      object.__id = this._objectID++;

      for (const m in object) {
        if (typeof object[m] == "function") {
          if (WebGPUInspector._skipMethods.indexOf(m) == -1) {
            if (WebGPUInspector._asyncMethods.indexOf(m) != -1)
              this._wrapAsync(object, m);
            else this._wrapMethod(object, m);
          }
        } else if (typeof object[m] == "object") {
          let o = object[m];
          if (!o || o.__id) continue;
          let hasMethod = this._objectHasMethods(o);
          if (!o.__id && hasMethod) {
            this._wrapObject(o);
          }
        }
      }
    }

    _wrapMethod(object, method) {
      if (WebGPUInspector._skipMethods.indexOf(method) != -1) return;
      let origMethod = object[method];
      let self = this;

      object[method] = function () {
        let t0 = performance.now();
        let result = origMethod.call(object, ...arguments);
        let t1 = performance.now();
        if (result && typeof result == "object") self._wrapObject(result);

        self._recordCommand(object, method, result, t1 - t0, arguments);
        return result;
      };
    }

    _wrapAsync(object, method) {
      let origMethod = object[method];
      let self = this;

      object[method] = function () {
        let t0 = performance.now();
        let id = self._objectID++;
        let promise = origMethod.call(object, ...arguments);
        self._recordAsyncCommand(object, method, id, arguments);
        let wrappedPromise = new Promise((resolve) => {
          promise.then((result) => {
            let t1 = performance.now();
            self._resolveAsyncCommand(id, t1 - t0, result);
            if (result && result.__id) {
              resolve(result);
              return;
            }
            if (result && typeof result == "object") self._wrapObject(result);
            resolve(result);
          });
        });
        return wrappedPromise;
      };
    }

    _recordCommand(object, method, result, time, ...args) {
      if (self._isRecording) {
        this._currentFrame.push([
          object.constructor.name,
          object.__id,
          method,
          time,
          args,
        ]);
      }

      if (method == "destroy") {
        let id = object.__id;
        let obj = this._objectDatabase.getObject(id);
        if (obj) {
          if (obj.element) {
            obj.element.remove();
          }
          this._objectDatabase.deleteObject(id);
        }
      } else if (method == "createShaderModule") {
        let id = result.__id;
        let obj = new ShaderModule(args[0]);
        this._objectDatabase.addObject(id, obj);
        obj.size = args[0][0].code.length;
      } else if (method == "createBuffer") {
        let id = result.__id;
        let obj = new Buffer(args[0]);
        this._objectDatabase.addObject(id, obj);
        obj.size = args[0][0].size;
      } else if (method == "createTexture") {
        let id = result.__id;
        let obj = new Texture(args[0]);
        this._objectDatabase.addObject(id, obj);
      } else if (method == "createSampler") {
        let id = result.__id;
        let obj = new Sampler(args[0]);
        this._objectDatabase.addObject(id, obj);
      } else if (method == "createBindGroup") {
        let id = result.__id;
        let obj = new BindGroup(args[0]);
        this._objectDatabase.addObject(id, obj);
        obj.size = args[0][0].size;
      } else if (method == "createBindGroupLayout") {
        let id = result.__id;
        let obj = new BindGroupLayout(args[0]);
        this._objectDatabase.addObject(id, obj);
      } else if (method == "createRenderPipeline") {
        let id = result.__id;
        let obj = new RenderPipeline(args[0]);
        obj.time = time;
        this._objectDatabase.addObject(id, obj);
      } else if (method == "setBindGroup") {
      } else if (method == "beginRenderPass") {
        this._objectDatabase.beginRenderPass();
      }
    }

    _recordAsyncCommand(object, method, id, ...args) {
      if (method == "createRenderPipelineAsync") {
        let obj = new RenderPipeline(args[0]);
        this._objectDatabase.addObject(id, obj, true);
      }
    }

    _resolveAsyncCommand(id, time, result) {
      let obj = this._objectDatabase.getObject(id);
      if (obj instanceof RenderPipeline) {
        obj.time = time;
        this._objectDatabase.resolvePendingObject(id);
      }
    }
  }

  WebGPUInspector._slowMethods = [
    "createBuffer",
    "createBindGroup",
    "createShaderModule",
    "createRenderPipeline",
    "createComputePipeline",
  ];

  WebGPUInspector._asyncMethods = [
    "requestAdapter",
    "requestDevice",
    "createComputePipelineAsync",
    "createRenderPipelineAsync",
  ];

  WebGPUInspector._skipMethods = [
    "toString",
    "entries",
    "getContext",
    "forEach",
    "has",
    "keys",
    "values",
    "getPreferredFormat",
    "pushErrorScope",
    "popErrorScope",
  ];

  webgpuInspector = new WebGPUInspector();
  webgpuInspector.enable();
})();
