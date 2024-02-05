import { Signal } from "../utils/signal.js";
import { StacktraceCache } from "../utils/stacktrace_cache.js";
import { TextureFormatInfo } from "../utils/texture_format_info.js";
import { WgslReflect } from "./wgsl_reflect.module.js";

const stacktraceCache = new StacktraceCache();

export class GPUObject {
  constructor(id, stacktrace) {
    this.id = id;
    this.label = "";
    this._stacktrace = stacktraceCache.setStacktrace(stacktrace ?? "");
    this._deletionTime = 0;
  }

  get name() {
    return this.label || this.constructor.className;
  }

  get stacktrace() {
    return stacktraceCache.getStacktrace(this._stacktrace);
  }
}

export class Adapter extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
Adapter.className = "Adapter";

export class Device extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
Device.className = "Device";

export class Buffer extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
Buffer.className = "Buffer";

export class Sampler extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
Sampler.className = "Sampler";

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
Texture.className = "Texture";

export class TextureView extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
TextureView.className = "TextureView";

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
ShaderModule.className = "ShaderModule";

export class BindGroupLayout extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
BindGroupLayout.className = "BindGroupLayout";

export class PipelineLayout extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
PipelineLayout.className = "PipelineLayout";

export class BindGroup extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
BindGroup.className = "BindGroup";

export class RenderPipeline extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }

  get topology() {
    return this.descriptor?.primitive?.topology ?? "triangle-list";
  }
}
RenderPipeline.className = "RenderPipeline";

export class ComputePipeline extends GPUObject {
  constructor(id, descriptor, stacktrace) {
    super(id, stacktrace);
    this.descriptor = descriptor;
  }
}
ComputePipeline.className = "ComputePipeline";

export class ValidationError extends GPUObject {
  constructor(id, object, message, stacktrace) {
    super(id, stacktrace);
    this.message = message;
    this.object = object ?? 0;
  }
}
ValidationError.className = "ValidationError";

export class ObjectDatabase {
  constructor(port) {
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
    this.validationErrors = new Map();
    this.frameTime = 0;
    this.errorCount = 0;

    this.onDeleteObject = new Signal();
    this.onResolvePendingObject = new Signal();
    this.onAddObject = new Signal();
    this.onBeginFrame = new Signal();
    this.onEndFrame = new Signal();
    this.onAdapterInfo = new Signal();
    this.onObjectLabelChanged = new Signal();
    this.onValidationError = new Signal();

    this.totalTextureMemory = 0;
    this.totalBufferMemory = 0;

    this.startFrameTime = -1;
    this.endFrameTime = -1;
    

    const self = this;
   
    port.addListener((message) => {
      switch (message.action) {
        case "inspect_begin_frame":
          self._beginFrame();
          break;
        case "inspect_end_frame":
          self._endFrame(message.commandCount);
          break;
        case "inspect_validation_error": {
          const errorMessage = message.message;
          const stacktrace = message.stacktrace;
          const objectId = message.id ?? 0;
          if (self.validationErrors.has(errorMessage)) {
            return;
          }
          const errorObj = new ValidationError(++self.errorCount, objectId, errorMessage, stacktrace);
          self.validationErrors.set(errorMessage, errorObj);
          self.onValidationError.emit(errorObj);
          break;
        }
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

  findObjectErrors(id) {
    const errors = [];
    for (const error of this.validationErrors.values()) {
      if (error.object === id) {
        errors.push(error);
      }
    }
    return errors;
  }

  _deleteOldRecycledObjects(objectList) {
    const recycleTime = 200;
    const time = performance.now();
    const numBindGroups = objectList.length;
    for (let i = numBindGroups - 1; i >= 0; --i) {
      const obj = objectList[i];
      if (!obj || (time - obj._deletionTime > recycleTime)) {
        objectList = objectList.splice(i, 1);
      }
    }
    return objectList;
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
    const t = performance.now();
    if (this.startFrameTime != -1) {
      this.frameTime = t - this.startFrameTime;
    }
    this.startFrameTime = performance.now();
    this.onBeginFrame.emit();
  }

  _endFrame(commandCount) {
    if (commandCount === 0) {
      return;
    }
    this.endFrameTime = performance.now();
    //this.frameTime = this.endFrameTime - this.startFrameTime;
    if (this.frameTime != 0) {
      this.onEndFrame.emit();
    }
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
    if (!object) {
      return;
    }

    this.allObjects.delete(id);

    if (object instanceof Adapter) {
      this.adapters.delete(id, object);
    } else if (object instanceof Device) {
      this.devices.delete(id, object);
    } else if (object instanceof Sampler) {
      this.samplers.delete(id, object);
    } else if (object instanceof Texture) {
      this.textures.delete(id, object);
      const size = object.getGpuSize();
      if (size != -1) {
        this.totalTextureMemory -= size;
      }
    } else if (object instanceof TextureView) {
      this.textureViews.delete(id, object);
      object._deletionTime = performance.now();
    } else if (object instanceof Buffer) {
      this.buffers.delete(id, object);
      const size = object.size;
      this.totalBufferMemory -= size ?? 0;
    } else if (object instanceof BindGroup) {
      this.bindGroups.delete(id, object);
      object._deletionTime = performance.now();
    } else if (object instanceof BindGroupLayout) {
      this.bindGroupLayouts.delete(id, object);
    } else if (object instanceof PipelineLayout) {
      this.pipelineLayouts.delete(id, object);
    } else if (object instanceof ShaderModule) {
      this.shaderModules.delete(id, object);
    } else if (object instanceof RenderPipeline) {
      this.pendingRenderPipelines.delete(id, object);
      this.renderPipelines.delete(id, object);
    } else if (object instanceof ComputePipeline) {
      this.computePipelines.set(id, object);
      this.pendingComputePipelines.delete(id, object);
    }

    this.onDeleteObject.emit(id, object);
  }
}
