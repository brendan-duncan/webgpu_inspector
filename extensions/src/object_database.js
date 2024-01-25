import { Signal } from "./widget/signal.js";
import { TextureFormatInfo } from "./texture_format_info.js";

export class GPUObject {
  constructor() {
    this.label = "";
  }
}

export class Adapter extends GPUObject {
  constructor(descriptor) {
    super();
    this.descriptor = descriptor;
  }
}

export class Device extends GPUObject {
  constructor(descriptor) {
    super();
    this.descriptor = descriptor;
  }
}

export class Buffer extends GPUObject {
  constructor(descriptor) {
    super();
    this.descriptor = descriptor;
  }
}

export class Sampler extends GPUObject {
  constructor(descriptor) {
    super();
    this.descriptor = descriptor;
  }
}

export class Texture extends GPUObject {
  constructor(descriptor) {
    super();
    this.descriptor = descriptor;
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

export class ShaderModule extends GPUObject {
  constructor(descriptor) {
    super();
    this.descriptor = descriptor;
    this.hasVertexEntries = descriptor?.code ? descriptor.code.indexOf("@vertex") != -1 : false;
    this.hasFragmentEntries = descriptor?.code ? descriptor.code.indexOf("@fragment") != -1 : false;
    this.hasComputeEntries = descriptor?.code ? descriptor.code.indexOf("@compute") != -1 : false;
  }
}

export class BindGroupLayout extends GPUObject {
  constructor(descriptor) {
    super();
    this.descriptor = descriptor;
  }
}

export class PipelineLayout extends GPUObject {
  constructor(descriptor) {
    super();
    this.descriptor = descriptor;
  }
}

export class BindGroup extends GPUObject {
  constructor(descriptor) {
    super();
    this.descriptor = descriptor;
  }
}

export class RenderPipeline extends GPUObject {
  constructor(descriptor) {
    super();
    this.descriptor = descriptor;
  }
}

export class ComputePipeline extends GPUObject {
  constructor(descriptor) {
    super();
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
    this.onBeginRenderPass = new Signal();
    this.onBeginComputePass = new Signal();
    this.onEndPass = new Signal();
    this.onAdapterInfo = new Signal();
    this.onObjectLabelChanged = new Signal();

    this.totalTextureMemory = 0;
    this.totalBufferMemory = 0;

    const self = this;
    port.onMessage.addListener((message) => {
      switch (message.action) {
        case "inspect_begin_frame":
          self.beginFrame();
          break;
        case "inspect_end_frame":
          self.endFrame();
          break;
        case "inspect_begin_render_pass":
          self.beginRenderPass();
          break;
        case "inspect_begin_compute_pass":
          self.beginComputePass();
          break;
        case "inspect_end_pass":
          self.endPass();
          break;
        case "inspect_delete_object":
          self.deleteObject(message.id);
          break;
        case "inspect_resolve_async_object":
          self.resolvePendingObject(message.id);
          break;
        case "inspect_object_set_label":
          self.setObjectLabel(message.id, message.label);
          break;
        case "inspect_add_object": {
          const pending = !!message.pending;
          const id = message.id;
          let descriptor = null;
          try {
            descriptor = message.descriptor ? JSON.parse(message.descriptor) : null;
          } catch (e) {
            break;
          }
          switch (message.type) {
            case "Adapter": {
              const obj = new Adapter(descriptor);
              self.addObject(id, obj, pending);
              break;
            }
            case "Device": {
              const obj = new Device(descriptor);
              self.addObject(id, obj, pending);
              break;
            }
            case "ShaderModule": {
              const obj = new ShaderModule(descriptor);
              self.addObject(id, obj, pending);
              obj.size = descriptor?.code?.length ?? 0;
              break;
            }
            case "Buffer": {
              const obj = new Buffer(descriptor);
              self.addObject(id, obj, pending);
              obj.size = descriptor?.size ?? 0;
              this.totalBufferMemory += obj.size;
              break;
            }
            case "Texture": {
              const obj = new Texture(descriptor);
              const size = obj.getGpuSize();
              if (size != -1) {
                this.totalTextureMemory += size;
              }
              self.addObject(id, obj, pending);
              break;
            }
            case "Sampler": {
              const obj = new Sampler(descriptor);
              self.addObject(id, obj, pending);
              break;
            }
            case "BindGroup": {
              const obj = new BindGroup(descriptor);
              self.addObject(id, obj, pending);
              break;
            }
            case "BindGroupLayout": {
              const obj = new BindGroupLayout(descriptor);
              self.addObject(id, obj, pending);
              break;
            }
            case "RenderPipeline": {
              const obj = new RenderPipeline(descriptor);
              self.addObject(id, obj, pending);
              break;
            }
            case "ComputePipeline": {
              const obj = new ComputePipeline(descriptor);
              self.addObject(id, obj, pending);
              break;
            }
            case "PipelineLayout": {
              const obj = new PipelineLayout(descriptor);
              self.addObject(id, obj, pending);
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
    this.buffers = new Map();
    this.bindGroups = new Map();
    this.bindGroupLayouts = new Map();
    this.shaderModules = new Map();
    this.pipelineLayouts = new Map();
    this.renderPipelines = new Map();
    this.computePipelines = new Map();
    this.pendingRenderPipelines = new Map();
    this.pendingComputePipelines = new Map();
    this.renderPassCount = 0;
    this.computePassCount = 0;
    this.frameTime = 0;
  }

  beginFrame() {
    this.startFrameTime = performance.now();
    this.renderPassCount = 0;
    this.onBeginFrame.emit();
  }

  endFrame() {
    this.endFrameTime = performance.now();
    this.frameTime = this.endFrameTime - this.startFrameTime;
    this.onEndFrame.emit();
  }

  beginRenderPass() {
    this.renderPassCount++;
    this.onBeginRenderPass.emit();
  }

  beginComputePass() {
    this.computePassCount++;
    this.onBeginComputePass.emit();
  }

  endPass() {
    this.onEndPass.emit();
  }

  getObject(id) {
    return this.allObjects.get(id);
  }

  setObjectLabel(id, label) {
    const object = this.getObject(id);
    if (object) {
      object.label = label;
      this.onObjectLabelChanged.emit(id, object, label);
    }
  }

  addObject(id, object, pending) {
    this.allObjects.set(id, object);
    if (object instanceof Adapter) {
      this.adapters.set(id, object);
    } else if (object instanceof Device) {
      this.devices.set(id, object);
    } else if (object instanceof Sampler) {
      this.samplers.set(id, object);
    } else if (object instanceof Texture) {
      this.textures.set(id, object);
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

    this.onAddObject.emit(id, object, pending);
  }

  resolvePendingObject(id) {
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

  deleteObject(id) {
    const object = this.allObjects.get(id);
    this.allObjects.delete(id);
    this.adapters.delete(id);
    this.devices.delete(id);
    this.samplers.delete(id);
    this.textures.delete(id);
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
      this.onDeleteObject.emit(id, object);
    }
  }
}
