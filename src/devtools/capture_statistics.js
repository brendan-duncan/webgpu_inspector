export class CaptureStatistics {
  constructor() {
    this.apiCalls = 0;

    this.draw = 0;
    this.drawIndirect = 0;
    this.dispatch = 0;
    
    this.setVertexBuffer = 0;
    this.setIndexBuffer = 0;
    this.setBindGroup = 0;
    //this.uniformBuffers = 0;
    //this.storageBuffers = 0;
    //this.textures = 0;
    //this.samplers = 0;
    this.setPipeline = 0;

    //this.vertexShaders = 0;
    //this.fragmentShaders = 0;
    //this.computeShaders = 0;

    this.computePasses = 0;
    this.renderPasses = 0;
    this.colorAttachments = 0;
    this.depthStencilAttachments = 0;
    this.copyCalls = 0;
    this.writeBuffer = 0;
    //this.bufferBytesWritten = 0;
    this.writeTexture = 0;
    //this.textureBytesWritten = 0;
    //this.totalBytesWritten = 0;

    //this.totalInstances = 0;
    //this.totalVertices = 0;
    //this.totalTriangles = 0;
    //this.totalLines = 0;
    //this.totalPoints = 0;
  }

  updateStats(className, method, args) {
    this.apiCalls++;

    if (method === "dispatchWorkgroups" || method === "dispatchWorkgroupsIndirect") {
      this.dispatch++;
    } else if (method === "draw" || method === "drawIndexed") {
      this.draw++;
    } else if (method === "drawIndirect" || method === "drawIndexedIndirect") {
      this.drawIndirect++;
    } else if (method === "setIndexBuffer") {
      this.setIndexBuffer++;
    } else if (method === "setVertexBuffer") {
      this.setVertexBuffer++;
    } else if (method === "setPipeline") {
      this.setPipeline++;
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
      //const dataTk = args[2].split(" ");
      //const dataLength = parseInt(dataTk[dataTk.length - 1]);
      //const offset = args.length > 2 ? args[3] : 0;
      //const size = args.length > 3 ? args[4] : dataLength - offset;
      //this.bufferBytesWritten += size;
      //this.totalBytesWritten += size;
    } else if (method === "writeTexture") {
      this.writeTexture++;
      /*const data = args[1];
      const size = data.length;
      this.textureBytesWritten += size;
      this.totalBytesWritten += size;*/
    } else if (method === "copyBufferToBuffer" || method === "copyBufferToTexture" ||
               method === "copyTextureToBuffer" || method === "copyTextureToTexture") {
      this.copyCalls++;
    }
  }
}
