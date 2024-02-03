import { Signal } from "./signal.js";
import { getStacktrace } from "./stacktrace.js";

export const GPUObjectTypes = new Set([
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

export const GPUCreateMethods = new Set([
  "createBuffer",
  "createTexture",
  "createSampler",
  "importExternalTexture",
  "createBindGroupLayout",
  "createPipelineLayout",
  "createBindGroup",
  "createShaderModule",
  "createComputePipeline",
  "createRenderPipeline",
  "createComputePipelineAsync",
  "createRenderPipelineAsync",
  "createCommandEncoder",
  "createRenderBundleEncoder",
  "createQuerySet",
  "createView"
]);

export class GPUObjectWrapper {
  constructor(idGenerator) {
    this._idGenerator = idGenerator;
    this.onPreCall = new Signal();
    this.onPostCall = new Signal();
    this.onPromise = new Signal();
    this.onPromiseResolve = new Signal();
    this.recordStacktraces = false;
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
      self.onPreCall.emit(object, method, args);

      // Call the original method
      const result = origMethod.call(object, ...args);

      const isCreate = GPUCreateMethods.has(method);

      const stacktrace = self.recordStacktraces || isCreate ? getStacktrace() : undefined;

      // If it was an async method it will have returned a Promise
      if (result instanceof Promise) {
        const id = self._idGenerator.getNextId(object);
        self.onPromise.emit(object, method, args, id, stacktrace);
        const promise = result;
        const wrappedPromise = new Promise((resolve) => {
          promise.then((result) => {
            self.onPromiseResolve.emit(object, method, args, id, result, stacktrace);
            resolve(result);
          });
        });
        return wrappedPromise;
      }

      // Otherwise it's a synchronous method
      self.onPostCall.emit(object, method, args, result, stacktrace);

      return result;
    };
  }
}
