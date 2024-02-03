import { Signal } from "../utils/signal.js";
import { TextureFormatInfo } from "../utils/texture_format_info.js";
import { WgslReflect } from "./wgsl_reflect.module.js";

export class GPUObject {
  constructor(id, stacktrace) {
    this.id = id;
    this.label = "";
    this.stacktrace = stacktrace ?? "";
    this.parent = null;
    this.children = [];
  }

  get name() {
    return this.label || this.constructor.name;
  }
}

export class Adapter extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}

export class Device extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}

export class Buffer extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}

export class Sampler extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}

export class Texture extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
    this.imageData = null;
    this.loadedImageDataChunks = [];
    this.isImageDataLoaded = false;
  }

  get dimension() {
    return this.descriptor?.dimension ?? "2d";
  }

  get width() {
    const size = this.descriptor?.size;
    if (size instanceof Array && size.length > 0) {
      return size[0] ?? 0;
    } else if (size instanceof Object) {
      return size.width ?? 0;
    }
    return 0;
  }

  get height() {
    const size = this.descriptor?.size;
    if (size instanceof Array && size.length > 1) {
      return size[1] ?? 1;
    } else if (size instanceof Object) {
      return size.height ?? 1;
    }
    return 0;
  }

  get depthOrArrayLayers() {
    const size = this.descriptor?.size;
    if (size instanceof Array && size.length > 2) {
      return size[2] ?? 1;
    } else if (size instanceof Object) {
      return size.depthOrArrayLayers ?? 1;
    }
    return 0;
  }

  getGpuSize() {
    const format = this.descriptor?.format;
    const formatInfo = TextureFormatInfo[format];
    const width = this.width;
    if (!format || width <= 0 || !formatInfo) {
      return -1;
    }

    const height = this.height;
    const dimension = this.dimension;
    const blockWidth = width / formatInfo.blockWidth;
    const blockHeight = height / formatInfo.blockHeight;
    const bytesPerBlock = formatInfo.bytesPerBlock;

    if (dimension === "2d") {
      return blockWidth * blockHeight * bytesPerBlock;
    }

    // TODO other dimensions

    return -1;
  }
}

export class TextureView extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}

export class ShaderModule extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this._reflection = null;
    this.descriptor = descriptor;
    this.hasVertexEntries = descriptor?.code ? descriptor.code.indexOf("@vertex") != -1 : false;
    this.hasFragmentEntries = descriptor?.code ? descriptor.code.indexOf("@fragment") != -1 : false;
    this.hasComputeEntries = descriptor?.code ? descriptor.code.indexOf("@compute") != -1 : false;
  }

  get code() {
    return this.descriptor?.code ?? "";
  }

  get reflection() {
    if (this._reflection === null) {
      this._reflection = new WgslReflect(this.code);
    }
    return this._reflection;
  }
}

export class BindGroupLayout extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}

export class PipelineLayout extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}

export class BindGroup extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}

export class RenderPipeline extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }

  get topology() {
    return this.descriptor?.primitive?.topology ?? "triangle-list";
  }
}

export class ComputePipeline extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}

export class ObjectDatabase {
  constructor(port) {
    this.reset();

    this.onDeleteObject = new Signal();
    this.onResolvePendingObject = new Signal();
    this.onAddObject = new Signal();
    this.onBeginFrame = new Signal();
    this.onEndFrame = new Signal();
    this.onAdapterInfo = new Signal();
    this.onObjectLabelChanged = new Signal();

    this.totalTextureMemory = 0;
    this.totalBufferMemory = 0;

    const self = this;
    port.addListener((message) => {
      switch (message.action) {
        case "inspect_begin_frame":
          self._beginFrame();
          break;
        case "inspect_end_frame":
          self._endFrame();
          break;
        case "inspect_delete_object":
          self._deleteObject(message.id);
          break;
        case "inspect_delete_objects": {
          const objects = message.idList;
          for (const id of objects) {
            self._deleteObject(id);
          }
          break;
        }
        case "inspect_resolve_async_object":
          self._resolvePendingObject(message.id);
          break;
        case "inspect_object_set_label":
          self._setObjectLabel(message.id, message.label);
          break;
        case "inspect_add_object": {
          const pending = !!message.pending;
          const id = message.id;
          const parent = message.parent;
          const stacktrace = message.stacktrace ?? "";
          let descriptor = null;
          try {
            descriptor = message.descriptor ? JSON.parse(message.descriptor) : null;
          } catch (e) {
            break;
          }
          switch (message.type) {
            case "Adapter": {
              const obj = new Adapter(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "Device": {
              const obj = new Device(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "ShaderModule": {
              const obj = new ShaderModule(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              obj.size = descriptor?.code?.length ?? 0;
              break;
            }
            case "Buffer": {
              const obj = new Buffer(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              obj.size = descriptor?.size ?? 0;
              this.totalBufferMemory += obj.size;
              break;
            }
            case "Texture": {
              const prevTexture = self.textures.get(id);
              if (prevTexture) {
                let size = prevTexture.getGpuSize();
                if (size != -1) {
                  this.totalTextureMemory -= size;
                }
                prevTexture.descriptor = descriptor;
                size = prevTexture.getGpuSize();
                if (size != -1) {
                  this.totalTextureMemory += size;
                }
                return;
              }
              const obj = new Texture(id, descriptor, stacktrace);
              const size = obj.getGpuSize();
              if (size != -1) {
                this.totalTextureMemory += size;
              }
              self._addObject(obj, parent, pending);
              break;
            }
            case "TextureView": {
              const prevView = self.textureViews.get(id);
              if (prevView) {
                prevView.descriptor = descriptor;
                return;
              }
              const obj = new TextureView(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "Sampler": {
              const obj = new Sampler(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "BindGroup": {
              const obj = new BindGroup(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "BindGroupLayout": {
              const obj = new BindGroupLayout(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "RenderPipeline": {
              const obj = new RenderPipeline(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "ComputePipeline": {
              const obj = new ComputePipeline(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "PipelineLayout": {
              const obj = new PipelineLayout(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
          }
          break;
        }
      }
    });
  }

  reset() {
    this.allObjects = new Map();
    this.adapters = new Map();
    this.devices = new Map();
    this.samplers = new Map();
    this.textures = new Map();
    this.textureViews = new Map();
    this.buffers = new Map();
    this.bindGroups = new Map();
    this.bindGroupLayouts = new Map();
    this.shaderModules = new Map();
    this.pipelineLayouts = new Map();
    this.renderPipelines = new Map();
    this.computePipelines = new Map();
    this.pendingRenderPipelines = new Map();
    this.pendingComputePipelines = new Map();
    this.frameTime = 0;
  }

  getObjectDependencies(object) {
    const dependencies = [];
    const id = object.id;

    if (object instanceof ShaderModule) {
      this.renderPipelines.forEach((rp) => {
        const descriptor = rp.descriptor;
        if (descriptor?.vertex?.module?.__id == id) {
          dependencies.push(rp);
        } else if (descriptor?.fragment?.module?.__id == id) {
          dependencies.push(rp);
        }
      });
      this.computePipelines.forEach((cp) => {
        const descriptor = cp.descriptor;
        if (descriptor?.compute?.module?.__id == id) {
          dependencies.push(cp);
        }
      });
    } else if (object instanceof Buffer || object instanceof Texture) {
      const isTexture = object instanceof Texture;
      this.bindGroups.forEach((bg) => {
        const entries = bg.descriptor?.entries;
        if (entries) {
          for (const entry of entries) {
            const resource = entry.resource;
            if (isTexture && resource instanceof String) {
              if (resource.__id == id) {
                dependencies.push(bg);
                break;
              }
            } else if (resource?.buffer) {
              const id = resource.buffer.__id;
              if (id == id) {
                dependencies.push(bg);
              }
              break;
            }
          }
        }
      });
    }
    return dependencies;
  }

  _beginFrame() {
    this.startFrameTime = performance.now();
    this.onBeginFrame.emit();
  }

  _endFrame() {
    this.endFrameTime = performance.now();
    this.frameTime = this.endFrameTime - this.startFrameTime;
    this.onEndFrame.emit();
  }

  getObject(id) {
    return this.allObjects.get(id);
  }

  _setObjectLabel(id, label) {
    const object = this.getObject(id);
    if (object) {
      object.label = label;
      this.onObjectLabelChanged.emit(id, object, label);
    }
  }

  _addObject(object, parent, pending) {
    const id = object.id;
    this.allObjects.set(id, object);
    if (object instanceof Adapter) {
      this.adapters.set(id, object);
    } else if (object instanceof Device) {
      this.devices.set(id, object);
    } else if (object instanceof Sampler) {
      this.samplers.set(id, object);
    } else if (object instanceof Texture) {
      this.textures.set(id, object);
    } else if (object instanceof TextureView) {
      this.textureViews.set(id, object);
    } else if (object instanceof Buffer) {
      this.buffers.set(id, object);
    } else if (object instanceof BindGroup) {
      this.bindGroups.set(id, object);
    } else if (object instanceof BindGroupLayout) {
      this.bindGroupLayouts.set(id, object);
    } else if (object instanceof PipelineLayout) {
      this.pipelineLayouts.set(id, object);
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

    if (parent) {
      const parentObject = this.getObject(parent);
      if (parentObject) {
        parentObject.children.push(object);
        object.parent = parentObject;
      }
    }

    this.onAddObject.emit(object, pending);
  }

  _resolvePendingObject(id) {
    const object = this.allObjects.get(id);
    if (object instanceof RenderPipeline) {
      this.pendingRenderPipelines.delete(id);
      this.renderPipelines.set(id, object);

      this.onResolvePendingObject.emit(id, object);
    } else if (object instanceof ComputePipeline) {
      this.pendingComputePipelines.delete(id);
      this.computePipelines.set(id, object);
    }
  }

  _deleteObject(id) {
    const object = this.allObjects.get(id);
    this.allObjects.delete(id);
    this.adapters.delete(id);
    this.devices.delete(id);
    this.samplers.delete(id);
    this.textures.delete(id);
    this.textureViews.delete(id);
    this.buffers.delete(id);
    this.bindGroups.delete(id);
    this.bindGroupLayouts.delete(id);
    this.shaderModules.delete(id);
    this.renderPipelines.delete(id);
    this.pipelineLayouts.delete(id);
    this.computePipelines.delete(id);
    this.pendingRenderPipelines.delete(id);
    this.pendingComputePipelines.delete(id);

    if (object) {
      if (object instanceof Texture) {
        const size = object.getGpuSize();
        if (size != -1) {
          this.totalTextureMemory -= size;
        }
      } else if (object instanceof Buffer) {
        const size = object.size;
        this.totalBufferMemory -= size ?? 0;
      }

      if (object.parent) {
        const parent = object.parent;
        const index = parent.children.indexOf(object);
        if (index != -1) {
          parent.children.splice(index, 1);
        }
      }

      if (object.children) {
        for (const child of object.children) {
          this._deleteObject(child.id);
        }
      }

      this.onDeleteObject.emit(id, object);
    }
  }
}
