import { Actions, PanelActions } from "../utils/actions.js";
import { Signal } from "../utils/signal.js";
import * as GPU from "./gpu_objects/index.js";

export class ObjectDatabase {
  constructor(port) {
    this.port = port;

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

    this.inspectedObject = null;

    this.onDeleteObject = new Signal();
    this.onResolvePendingObject = new Signal();
    this.onAddObject = new Signal();
    this.onDeltaFrameTime = new Signal();
    this.onEndFrame = new Signal();
    this.onAdapterInfo = new Signal();
    this.onObjectLabelChanged = new Signal();
    this.onValidationError = new Signal();

    this.totalTextureMemory = 0;
    this.totalBufferMemory = 0;

    this.deltaFrameTime = -1;

    const self = this;
   
    port.addListener((message) => {
      switch (message.action) {
        case Actions.DeltaTime:
          this.deltaFrameTime = message.deltaTime;
          this.onDeltaFrameTime.emit();
          break;
        case Actions.ValidationError: {
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
        case Actions.DeleteObject:
          self._deleteObject(message.id);
          break;
        case Actions.DeleteObjects: {
          const objects = message.idList;
          for (const id of objects) {
            self._deleteObject(id);
          }
          break;
        }
        case Actions.ResolveAsyncObject:
          self._resolvePendingObject(message.id);
          break;
        case Actions.ObjectSetLabel:
          self._setObjectLabel(message.id, message.label);
          break;
        case Actions.AddObject: {
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
              const obj = new GPU.Adapter(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "Device": {
              const obj = new GPU.Device(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "ShaderModule": {
              const obj = new GPU.ShaderModule(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              obj.size = descriptor?.code?.length ?? 0;
              break;
            }
            case "Buffer": {
              const obj = new GPU.Buffer(id, descriptor, stacktrace);
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
              const obj = new GPU.Texture(id, descriptor, stacktrace);
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
              const obj = new GPU.TextureView(id, parent, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "Sampler": {
              const obj = new GPU.Sampler(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "BindGroup": {
              const obj = new GPU.BindGroup(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "BindGroupLayout": {
              const obj = new GPU.BindGroupLayout(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "RenderPipeline": {
              const obj = new GPU.RenderPipeline(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "ComputePipeline": {
              const obj = new GPU.ComputePipeline(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
            case "PipelineLayout": {
              const obj = new GPU.PipelineLayout(id, descriptor, stacktrace);
              self._addObject(obj, parent, pending);
              break;
            }
          }
          break;
        }
      }
    });
  }

  requestTextureData(texture) {
    // TODO implement depth-stencil texture loading
    if (texture.isDepthStencil) {
      return;
    }
    if (texture.imageDataPending) {
      return;
    }
    texture.imageDataPending = true;
    this.port.postMessage({ action: PanelActions.RequestTexture, id: texture.id });
  }

  removeErrorsForObject(id) {
    const map = this.validationErrors;
    for (const key of map.keys()) {
      const error = map.get(key);
      if (error.object === id) {
        map.delete(key);
        this.onDeleteObject.emit(id, error);
      }
    }
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

    if (object instanceof GPU.ShaderModule) {
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
    } else if (object instanceof GPU.Buffer || object instanceof GPU.Texture) {
      const isTexture = object instanceof GPU.Texture;
      this.bindGroups.forEach((bg) => {
        const entries = bg.descriptor?.entries;
        if (entries) {
          for (const entry of entries) {
            const resource = entry.resource;
            if (isTexture && resource.constructor === String) {
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

  getObject(id) {
    if (id === undefined || id === null) {
      return null;
    }
    if (this.inspectedObject?.id === id) {
      return this.inspectedObject;
    }
    return this.allObjects.get(id);
  }

  getTextureFromView(view) {
    if (!view) {
      return null;
    }
    if (view.__texture) {
      return view.__texture;
    }
    if (view.texture) {
      view.__texture = this.getObject(view.texture);
    }
    return view.__texture;
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
    if (object instanceof GPU.Adapter) {
      this.adapters.set(id, object);
    } else if (object instanceof GPU.Device) {
      this.devices.set(id, object);
    } else if (object instanceof GPU.Sampler) {
      this.samplers.set(id, object);
    } else if (object instanceof GPU.Texture) {
      this.textures.set(id, object);
    } else if (object instanceof GPU.TextureView) {
      this.textureViews.set(id, object);
    } else if (object instanceof GPU.Buffer) {
      this.buffers.set(id, object);
    } else if (object instanceof GPU.BindGroup) {
      this.bindGroups.set(id, object);
    } else if (object instanceof GPU.BindGroupLayout) {
      this.bindGroupLayouts.set(id, object);
    } else if (object instanceof GPU.PipelineLayout) {
      this.pipelineLayouts.set(id, object);
    } else if (object instanceof GPU.ShaderModule) {
      this.shaderModules.set(id, object);
    } else if (object instanceof GPU.RenderPipeline) {
      if (pending) {
        this.pendingRenderPipelines.set(id, object);
      } else {
        this.renderPipelines.set(id, object);
      }
    } else if (object instanceof GPU.ComputePipeline) {
      this.computePipelines.set(id, object);
    }

    this.onAddObject.emit(object, pending);
  }

  _resolvePendingObject(id) {
    const object = this.allObjects.get(id);
    if (object instanceof GPU.RenderPipeline) {
      this.pendingRenderPipelines.delete(id);
      this.renderPipelines.set(id, object);
      this.onResolvePendingObject.emit(id, object);
    } else if (object instanceof GPU.ComputePipeline) {
      this.pendingComputePipelines.delete(id);
      this.computePipelines.set(id, object);
      this.onResolvePendingObject.emit(id, object);
    }
  }

  _deleteObject(id) {
    const object = this.allObjects.get(id);
    if (!object) {
      return;
    }

    object._deletionTime = performance.now();

    this.allObjects.delete(id);

    if (object instanceof GPU.Adapter) {
      this.adapters.delete(id, object);
    } else if (object instanceof GPU.Device) {
      this.devices.delete(id, object);
    } else if (object instanceof GPU.Sampler) {
      this.samplers.delete(id, object);
    } else if (object instanceof GPU.Texture) {
      this.textures.delete(id, object);
      const size = object.getGpuSize();
      if (size != -1) {
        this.totalTextureMemory -= size;
      }
    } else if (object instanceof GPU.TextureView) {
      this.textureViews.delete(id, object);
    } else if (object instanceof GPU.Buffer) {
      this.buffers.delete(id, object);
      const size = object.size;
      this.totalBufferMemory -= size ?? 0;
    } else if (object instanceof GPU.BindGroup) {
      this.bindGroups.delete(id, object);
    } else if (object instanceof GPU.BindGroupLayout) {
      this.bindGroupLayouts.delete(id, object);
    } else if (object instanceof GPU.PipelineLayout) {
      this.pipelineLayouts.delete(id, object);
    } else if (object instanceof GPU.ShaderModule) {
      this.shaderModules.delete(id, object);
    } else if (object instanceof GPU.RenderPipeline) {
      this.pendingRenderPipelines.delete(id, object);
      this.renderPipelines.delete(id, object);
    } else if (object instanceof GPU.ComputePipeline) {
      this.computePipelines.set(id, object);
      this.pendingComputePipelines.delete(id, object);
    }

    this.onDeleteObject.emit(id, object);
  }
}
