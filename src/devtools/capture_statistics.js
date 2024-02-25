import { TextureView, Sampler } from "./gpu_objects/index.js";

export class CaptureStatistics {
  constructor() {
    this.apiCalls = 0;

    this.draw = 0;
    this.drawIndirect = 0;
    this.dispatch = 0;
    
    this.setVertexBuffer = 0;
    this.setIndexBuffer = 0;
    this.setBindGroup = 0;
    this.uniformBuffers = 0;
    this.storageBuffers = 0;
    this.textures = 0;
    this.samplers = 0;
    this.setPipeline = 0;

    this.vertexShaders = 0;
    this.fragmentShaders = 0;
    this.computeShaders = 0;

    this.computePasses = 0;
    this.renderPasses = 0;
    this.colorAttachments = 0;
    this.depthStencilAttachments = 0;
    this.copyCommands = 0;
    this.writeBuffer = 0;
    this.bufferBytesWritten = 0;
    this.writeTexture = 0;
    //this.textureBytesWritten = 0;
    this.totalBytesWritten = 0;

    this.totalInstances = 0;
    this.totalVertices = 0;
    this.totalTriangles = 0;
    this.totalLines = 0;
    this.totalPoints = 0;

    Object.defineProperty(this, '_lastPipeline', { enumerable: false, writable: true, value: 0 });
  }

  reset() {
    this.apiCalls = 0;

    this.draw = 0;
    this.drawIndirect = 0;
    this.dispatch = 0;
    
    this.setVertexBuffer = 0;
    this.setIndexBuffer = 0;
    this.setBindGroup = 0;
    this.uniformBuffers = 0;
    this.storageBuffers = 0;
    this.textures = 0;
    this.samplers = 0;
    this.setPipeline = 0;

    this.vertexShaders = 0;
    this.fragmentShaders = 0;
    this.computeShaders = 0;

    this.computePasses = 0;
    this.renderPasses = 0;
    this.colorAttachments = 0;
    this.depthStencilAttachments = 0;
    this.copyCommands = 0;
    this.writeBuffer = 0;
    this.bufferBytesWritten = 0;
    this.writeTexture = 0;
    //this.textureBytesWritten = 0;
    this.totalBytesWritten = 0;

    this.totalInstances = 0;
    this.totalVertices = 0;
    this.totalTriangles = 0;
    this.totalLines = 0;
    this.totalPoints = 0;

    this._lastPipeline = 0;
  }

  updateStats(database, command) {
    this.apiCalls++;

    const method = command.method;
    const args = command.args;

    if (method === "dispatchWorkgroups" || method === "dispatchWorkgroupsIndirect") {
      this.dispatch++;
    } else if (method === "draw" || method === "drawIndexed" || method === "drawIndirect" || method === "drawIndexedIndirect") {
      this.draw++;
      let vertexCount = 0;

      if (method === "drawIndirect" || method === "drawIndexedIndirect") {
        this.drawIndirect++;
        // TODO the buffer data has not finished loading by the time these stats are collected
        if (command.isBufferDataLoaded && command.bufferData) {
          const bufferData = command.bufferData[0];
          if (bufferData) {
            const u32Array = new Uint32Array(bufferData.buffer);
            vertexCount = u32Array[0];
          }
        }
      } else {
        vertexCount = parseInt(args[0] ?? 0) ?? 0;
        this.totalInstances += parseInt(args[1] ?? 1);
      }

      this.totalVertices += vertexCount;

      if (this._lastPipeline) {
        const pipeline = database.getObject(this._lastPipeline.__id);
        if (pipeline?.descriptor) {
          const topology = pipeline.descriptor.primitive?.topology ?? "triangle-list";
          if (topology === "triangle-list") {
            const numTriangles = vertexCount / 3;
            this.totalTriangles += numTriangles;
          } else if (topology === "triangle-strip") {
            const numTriangles = vertexCount - 2;
            this.totalTriangles += numTriangles;
          } else if (topology === "point-list") {
            this.totalPoints += vertexCount;
          } else if (topology === "line-list") {
            this.totalLines += vertexCount / 2;
          } else if (topology === "line-strip") {
            this.totalLines += vertexCount - 1;
          }
        }
      }
    } else if (method === "setIndexBuffer") {
      this.setIndexBuffer++;
    } else if (method === "setVertexBuffer") {
      this.setVertexBuffer++;
    } else if (method === "setPipeline") {
      this.setPipeline++;
      this._lastPipeline = args[0];
      const pipeline = database.getObject(args[0].__id);
      if (pipeline) {
        if (pipeline.descriptor.vertex) {
          this.vertexShaders++;
        }
        if (pipeline.descriptor.fragment) {
          this.fragmentShaders++;
        }
        if (pipeline.descriptor.compute) {
          this.computeShaders++;
        }
      }
    } else if (method === "setBindGroup") {
      this.setBindGroup++;
      const bindgroup = database.getObject(args[1].__id);
      if (bindgroup) {
        for (const entry of bindgroup.descriptor.entries) {
          if (entry.resource?.buffer) {
            const buffer = database.getObject(entry.resource.buffer.__id);
            if (buffer) {
              if (buffer.descriptor.usage & GPUBufferUsage.STORAGE) {
                this.storageBuffers++;
              }
              if (buffer.descriptor.usage & GPUBufferUsage.UNIFORM) {
                this.uniformBuffers++;
              }
            }
          } else if (entry.resource?.__id) {
            const resource = database.getObject(entry.resource.__id);
            if (resource instanceof TextureView) {
              this.textures++;
            } else if (resource instanceof Sampler) {
              this.samplers++;
            }
          }
        }
      }
    } else if (method === "beginComputePass") {
      this.computePasses++;
    } else if (method === "beginRenderPass") {
      this.renderPasses++;
      const desc = args[0];
      if (desc.colorAttachments) {
        this.colorAttachments += desc.colorAttachments.length;
      }
      if (desc.depthStencilAttachment) {
        this.depthStencilAttachments++;
      }
    } else if (method === "writeBuffer") {
      this.writeBuffer++;
      const data = args[2];
      let dataLength = 0;
      if (args[2].constructor === String) {
        const dataTk = args[2].split(" ");
        dataLength = parseInt(dataTk[dataTk.length - 1]);
      } else if (data.length !== undefined) {
        dataLength = data.length;
      }
      const offset = args.length > 3 ? args[3] : 0;
      const size = args.length > 4 ? args[4] : dataLength - offset;
      this.bufferBytesWritten += size;
      this.totalBytesWritten += size;
    } else if (method === "writeTexture") {
      this.writeTexture++;
      /*const data = args[1];
      const size = data.length;
      this.textureBytesWritten += size;
      this.totalBytesWritten += size;*/
    } else if (method === "copyBufferToBuffer" || method === "copyBufferToTexture" ||
               method === "copyTextureToBuffer" || method === "copyTextureToTexture") {
      this.copyCommands++;
    }
  }
}
