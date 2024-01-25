import { Signal } from "./widget/signal.js";

export class Adapter {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

export class Device {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

export class Buffer {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

export class Sampler {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

export class Texture {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

export class ShaderModule {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

export class BindGroupLayout {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

export class PipelineLayout {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

export class BindGroup {
  constructor(descriptor) {
    this.descriptor = descriptor;
  }
}

export class RenderPipeline {
  constructor(descriptor) {
    this.descriptor = descriptor;
    this.time = 0;
    this.element = null;
  }
}

export class ComputePipeline {
  constructor(descriptor) {
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
              break;
            }
            case "Texture": {
              const obj = new Texture(descriptor);
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
      this.onDeleteObject.emit(id, object);
    }
  }
}
