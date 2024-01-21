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

    const self = this;
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
      if (!isDragging) {
        return;
      }

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

    const contentArea = document.createElement("div");
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

    if (object instanceof ShaderModule) {
      title = document.createElement("span");
      div.appendChild(title);
      title.innerHTML = "Code: ";
      let descriptor = document.createElement("span");
      div.appendChild(descriptor);
      const code = object.descriptor.code;
      descriptor.innerHTML = `<pre>${code}</pre>`
    } else {
      title = document.createElement("span");
      div.appendChild(title);
      title.innerHTML = "Descriptor: ";
      let descriptor = document.createElement("span");
      div.appendChild(descriptor);
      descriptor.innerHTML = JSON.stringify(object.descriptor, undefined, 4);
    }
  }
}

class ObjectsPanel {
  constructor(database) {
    this.database = database;

    this.inspector = new InspectorPanel(database);

    const self = this;
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
      if (!isDragging) {
        return;
      }

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
    //console.log("ENABLE");
    this.enabled = true;
    this.debugPanel.style.display = "block";
    this.inspector.enable();
  }

  disable() {
    //console.log("DISABLE");
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
      o.innerHTML = `ShaderModule ${id} Size:${object.descriptor.code.length.toLocaleString(
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

    const self = this;
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
      object.descriptor.vertex.module.__id
    );
    const fs = this.database.getObject(
      object.descriptor.fragment.module.__id
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
    this.computePassCount = 0;
  }

  initGui() {
    this.objectsPanel = new ObjectsPanel(this);
  }

  get enabled() {
    return this.objectsPanel?.enabled ?? false;
  }

  enable() {
    try {
      if (!this.objectsPanel) {
        this.initGui();
      }
      this.objectsPanel?.enable();
    } catch (e) {
      console.log("@@@@ EXCEPTION", e);
    }
  }

  disable() {
    this.objectsPanel?.disable();
    this.objectsPanel = null;
  }

  beginFrame() {
    this.startFrameTime = performance.now();
    this.renderPassCount = 0;
  }

  endFrame() {
    this.endFrameTime = performance.now();
    this.frameTime = this.endFrameTime - this.startFrameTime;
    this.objectsPanel?.updateFrameStats();
  }

  beginRenderPass() {
    this.renderPassCount++;
  }

  beginComputePass() {
    this.computePassCount++;
  }

  end() { }

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
      if (pending) {
        this.pendingRenderPipelines.set(id, object);
      } else {
        this.renderPipelines.set(id, object);
      }
    } else if (object instanceof ComputePipeline) {
      this.computePipelines.set(id, object);
    }

    if (this.objectsPanel) {
      this.objectsPanel.addObject(id, object, pending);
    }
  }

  resolvePendingObject(id) {
    const object = this.allObjects.get(id);
    if (object instanceof RenderPipeline) {
      this.pendingRenderPipelines.delete(id);
      this.renderPipelines.set(id, object);

      if (this.objectsPanel) {
        this.objectsPanel.resolvePendingObject(id, object);
      }
    } else if (object instanceof ComputePipeline) {
      this.pendingComputePipelines.delete(id);
      this.computePipelines.set(id, object);
    }
  }

  deleteObject(id) {
    const object = this.allObjects.get(id);
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

    if (this.objectsPanel) {
      this.objectsPanel.deleteObject(id, object);
    }
  }
}



async function main() {
  const port = chrome.runtime.connect({ name: "webgpu-inspector-panel" });
  const tabId = chrome.devtools.inspectedWindow.tabId;
  const objectDatabase = new ObjectDatabase();

  const recordForm = document.getElementById("record");
  recordForm.addEventListener("submit", () => {
    const frames = document.getElementById("record_frames").value;
    const filename = document.getElementById("record_filename").value;
    port.postMessage({ action: "initialize_recorder", frames, filename, tabId });
  });

  
  const inspectForm = document.getElementById("inspect");
  inspectForm.addEventListener("submit", () => {
    try {
      port.postMessage({ action: "initialize_inspector", tabId });
    } catch (e) {
      console.log("@@@@ EXCEPTION", e);
    }
  });

  port.onMessage.addListener((message) => {
    if (!objectDatabase.enabled) {
      objectDatabase.enable();
    }
    switch (message.action) {
      case "inspect_begin_frame":
        objectDatabase.beginFrame();
        break;
      case "inspect_end_frame":
        objectDatabase.endFrame();
        break;
      case "inspect_begin_render_pass":
        objectDatabase.beginRenderPass();
        break;
      case "inspect_begin_compute_pass":
        objectDatabase.beginComputePass();
        break;
      case "inspect_end":
        objectDatabase.end();
        break;
      case "inspect_delete_object":
        objectDatabase.deleteObject(message.id);
        break;
      case "inspect_add_object":
        const id = message.id;
        let descriptor = null;
        try {
          descriptor = message.descriptor ? JSON.parse(message.descriptor) : null;
        } catch (e) {
          console.log("@@@@ EXCEPTION", e);
          break;
        }
        switch (message.type) {
          case "ShaderModule": {
            const obj = new ShaderModule(descriptor);
            objectDatabase.addObject(id, obj);
            obj.size = descriptor?.code?.length ?? 0;
            break;
          }
          case "Buffer": {
            const obj = new Buffer(descriptor);
            objectDatabase.addObject(id, obj);
            obj.size = descriptor?.size ?? 0;
            break;
          }
          case "Texture": {
            const obj = new Texture(descriptor);
            objectDatabase.addObject(id, obj);
            break;
          }
          case "Sampler": {
            const obj = new Sampler(descriptor);
            objectDatabase.addObject(id, obj);
            break;
          }
          case "BindGroup": {
            const obj = new BindGroup(descriptor);
            objectDatabase.addObject(id, obj);
            break;
          }
          case "BindGroupLayout": {
            const obj = new BindGroupLayout(descriptor);
            objectDatabase.addObject(id, obj);
            break;
          }
          case "RenderPipeline": {
            const obj = new RenderPipeline(descriptor);
            objectDatabase.addObject(id, obj);
            break;
          }
          case "ComputePipeline": {
            const obj = new ComputePipeline(descriptor);
            objectDatabase.addObject(id, obj);
            break;
          }
        }
        break;
    }
  });

  port.postMessage({action: "PanelLoaded", tabId});
}

main();
