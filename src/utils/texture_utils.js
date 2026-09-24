import { TextureFormatInfo } from "./texture_format_info.js";

export class TextureUtils {
  constructor(device) {
    this.device = device;

    this.blitShaderModule = device.createShaderModule({ code: _getBlitShader("f32") });
    this.blitU32ShaderModule = device.createShaderModule({ code: _getBlitShader("u32") });
    this.blitS32ShaderModule = device.createShaderModule({ code: _getBlitShader("i32") });

    this.computeTextureMinMaxModule = device.createShaderModule({ code: _getComputeTextureMinMax("f32") });
    this.computeTextureMinMaxU32Module = device.createShaderModule({ code: _getComputeTextureMinMax("u32") });
    this.computeTextureMinMaxS32Module = device.createShaderModule({ code: _getComputeTextureMinMax("i32") });

    this.computeTextureMinMax3dModule = device.createShaderModule({ code: _getComputeTextureMinMax3d("f32") });
    this.computeTextureMinMax3dU32Module = device.createShaderModule({ code: _getComputeTextureMinMax3d("u32") });
    this.computeTextureMinMax3dS32Module = device.createShaderModule({ code: _getComputeTextureMinMax3d("i32") });

    this.blit3dShaderModule = device.createShaderModule({ code: TextureUtils.blit3dShader });
    this.multisampleBlitShaderModule = device.createShaderModule({ code: TextureUtils.multisampleBlitShader });
    this.depthToFloatShaderModule = device.createShaderModule({ code: TextureUtils.depthToFloatShader });
    this.depthCubeToFloatShaderModule = device.createShaderModule({ code: TextureUtils.depthCubeToFloatShader });
    this.depthToFloatMultisampleShaderModule = device.createShaderModule({ code: TextureUtils.depthToFloatMultisampleShader });
    this.blitPipelines = {};
    this.blitDepthPipelines = {};
    this.bindGroupLayouts = new Map();
    this.pipelineLayouts = new Map();
    this.depthToFloatPipeline = null;
    this.depthToFloatMSPipeline = null;

    this.pointSampler = device.createSampler({
        magFilter: 'nearest',
        minFilter: 'nearest',
    });

    this.depthCompareSampler = device.createSampler({
        compare: 'less-equal',
        magFilter: 'nearest',
        minFilter: 'nearest',
    });

    this.displayUniformBuffer = device.createBuffer({
      size: 4 * 8,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.depthCubeFaceUniformBuffers = [];
    for (let face = 0; face < 6; ++face) {
      const buffer = device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      });
      device.queue.writeBuffer(buffer, 0, new Uint32Array([face, 0, 0, 0]));
      this.depthCubeFaceUniformBuffers.push(buffer);
    }

    this.minMaxStorageBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    });

    this.minMaxReadbackBuffer = device.createBuffer({
        size: 32,
        usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
    });

    this.displayBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "uniform" }
        },
        {
          binding: 1,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: { type: "read-only-storage" }
        }
      ]
    });

    this.displayBindGroup = device.createBindGroup({
      layout: this.displayBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.displayUniformBuffer }
        },
        {
          binding: 1,
          resource: { buffer: this.minMaxStorageBuffer }
        }
      ]
    });

    this.computeMinMaxPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: this.computeTextureMinMaxModule, entryPoint: 'main' }
    });

    this.computeMinMaxU32Pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: this.computeTextureMinMaxU32Module, entryPoint: 'main' }
    });

    this.computeMinMaxS32Pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: this.computeTextureMinMaxS32Module, entryPoint: 'main' }
    });

    this.computeMinMax3dPipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: this.computeTextureMinMax3dModule, entryPoint: 'main' }
    });

    this.computeMinMax3dU32Pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: this.computeTextureMinMax3dU32Module, entryPoint: 'main' }
    });

    this.computeMinMax3dS32Pipeline = device.createComputePipeline({
        layout: 'auto',
        compute: { module: this.computeTextureMinMax3dS32Module, entryPoint: 'main' }
    });
  }

  copyDepthTexture(src, format, commandEncoder, mipLevel) {
    mipLevel ??= 0;
    const width = (src.width >> mipLevel) || 1;
    const height = (src.height >> mipLevel) || 1;
    const depthOrArrayLayers = src.depthOrArrayLayers;
    const usage = src.usage | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
    const size = [width, height, depthOrArrayLayers];
    format = format || "r32float";

    const dst = this.device.createTexture({ format, size, usage });

    if (src.sampleCount === 1 && depthOrArrayLayers === 6) {
      const srcView = src.createView({
        dimension: "cube",
        aspect: "depth-only",
        baseArrayLayer: 0,
        arrayLayerCount: 6,
        baseMipLevel: mipLevel,
        mipLevelCount: 1
      });

      for (let i = 0; i < depthOrArrayLayers; ++i) {
        const dstView = dst.createView({ dimension: "2d", baseArrayLayer: i, arrayLayerCount: 1 });
        this.convertDepthCubeFaceToFloat(srcView, i, dstView, format, commandEncoder);
      }

      return dst;
    }

    for (let i = 0; i < depthOrArrayLayers; ++i) {
      const srcView = src.createView({
        dimension: "2d",
        aspect: "depth-only",
        baseArrayLayer: i,
        arrayLayerCount: 1,
        baseMipLevel: mipLevel,
        mipLevelCount: 1
      });
      const dstView = dst.createView({ dimension: "2d", baseArrayLayer: i, arrayLayerCount: 1 });
      this.convertDepthToFloat(srcView, src.sampleCount, dstView, format, commandEncoder);
    }

    return dst;
  }

  copyMultisampledTexture(src) {
    const width = src.width;
    const height = src.height;
    const format = src.format;
    const usage = src.usage | GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC;
    const size = [width, height, 1]
    const dst = this.device.createTexture({ format, size, usage });

    this.blitTexture(src.createView(), src.format, src.sampleCount, dst.createView(), format);

    return dst;
  }

  blitTexture(srcView, srcFormat, sampleCount, dstView, dstFormat, display, dimension, layer,
      minMaxUpdateCallback) {
    layer ??= 0;
    dimension ??= "2d";
    // The 2D blit only uses textureLoad, so "unfilterable-float" works for every
    // float format, including 32-bit floats, which aren't filterable without the
    // float32-filterable feature. The 3D path samples with a sampler, so it
    // keeps the format's own sample type.
    let sampleType = TextureFormatInfo[srcFormat]?.sampleType || "unfilterable-float";
    if (sampleType === "float" && dimension !== "3d") {
      sampleType = "unfilterable-float";
    }

    const bgLayoutKey = `${sampleType}#${sampleCount}#${dimension}`;

    if (!this.bindGroupLayouts.has(bgLayoutKey)) {
      const entries = dimension === "3d"
        ? [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: "3d", sampleType } }
          ]
        : [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { viewDimension: dimension, sampleType, multisampled: sampleCount > 1 } }
          ];
      const bindGroupLayout = this.device.createBindGroupLayout({ entries });
      this.bindGroupLayouts.set(bgLayoutKey, bindGroupLayout);

      const pipelineLayout = this.device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout, this.displayBindGroupLayout]
      });
      this.pipelineLayouts.set(bgLayoutKey, pipelineLayout);
    }

    const formatInfo = TextureFormatInfo[srcFormat];
    const numChannels = formatInfo?.channels ?? 4;

    const bindGroupLayout = this.bindGroupLayouts.get(bgLayoutKey);
    const pipelineLayout = this.pipelineLayouts.get(bgLayoutKey);

    const shaderType = (formatInfo?.sampleType === "uint") ? "U32" : (formatInfo?.sampleType === "sint") ? "S32" : "f32";

    const pipelineKey = `${dstFormat}#${sampleType}#${sampleCount}#${dimension}#${shaderType}`;
    let pipeline = this.blitPipelines[pipelineKey];
    if (!pipeline) {
      const module = sampleCount > 1 ? this.multisampleBlitShaderModule : dimension === "3d" ? this.blit3dShaderModule
          : shaderType == "f32" ? this.blitShaderModule : shaderType == "U32" ? this.blitU32ShaderModule : this.blitS32ShaderModule;

      pipeline = this.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
          module,
          entryPoint: 'vertexMain',
        },
        fragment: {
          module: module,
          entryPoint: 'fragmentMain',
          targets: [ { format: dstFormat } ],
        },
        primitive: {
          topology: 'triangle-list',
        },
      });
      this.blitPipelines[pipelineKey] = pipeline;
    }

    const bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: dimension === "3d"
        ? [{ binding: 0, resource: this.pointSampler }, { binding: 1, resource: srcView }]
        : [{ binding: 0, resource: srcView }]
    });

    const commandEncoder = this.device.createCommandEncoder();

    const minMaxPipeline = dimension === "3d"
        ? ((formatInfo?.sampleType === "uint") ? this.computeMinMax3dU32Pipeline :
           (formatInfo?.sampleType === "sint") ? this.computeMinMax3dS32Pipeline : this.computeMinMax3dPipeline)
        : ((formatInfo?.sampleType === "uint") ? this.computeMinMaxU32Pipeline :
           (formatInfo?.sampleType === "sint") ? this.computeMinMaxS32Pipeline : this.computeMinMaxPipeline);

    const minMaxBindGroup = this.device.createBindGroup({
        layout: minMaxPipeline.getBindGroupLayout(0),
        entries: [
            { binding: 0, resource: srcView },
            { binding: 1, resource: { buffer: this.minMaxStorageBuffer } }
        ]
    });

    const computePass = commandEncoder.beginComputePass();
    computePass.setPipeline(minMaxPipeline);
    computePass.setBindGroup(0, minMaxBindGroup);
    computePass.dispatchWorkgroups(1);
    computePass.end();

    if (display) {
      this.device.queue.writeBuffer(this.displayUniformBuffer, 0,
        new Float32Array([display.exposure, display.channels, numChannels, display.autoRange ?? 0 ? 1 : 0,
          display.minRange ?? 0, display.maxRange ?? 1, layer, display.highlight ?? 0]));
    } else {
      this.device.queue.writeBuffer(this.displayUniformBuffer, 0,
        new Float32Array([1, 0, numChannels, 0, 0, 1, layer, 0]));
    }

    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: dstView,
        loadOp: 'clear',
        storeOp: 'store'
      }]
    });
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setBindGroup(1, this.displayBindGroup);
    passEncoder.draw(3);
    passEncoder.end();

    if (!this.minMaxReadbackBuffer._mapRequested) {
      commandEncoder.copyBufferToBuffer(this.minMaxStorageBuffer, 0, this.minMaxReadbackBuffer, 0, 32);
    }
    this.device.queue.submit([commandEncoder.finish()]);

    if (minMaxUpdateCallback && !this.minMaxReadbackBuffer._mapRequested) {
      this.minMaxReadbackBuffer._mapRequested = true;
      this.minMaxReadbackBuffer.mapAsync(GPUMapMode.READ).then(() => {
          const arrayBuffer = this.minMaxReadbackBuffer.getMappedRange();
          const data = new Float32Array(arrayBuffer.slice(0));
          this.minMaxReadbackBuffer.unmap();
          this.minMaxReadbackBuffer._mapRequested = false;
          display.minRange = data[0];
          display.maxRange = data[4];
          minMaxUpdateCallback(display.minRange, display.maxRange);
      });
    }
  }

  /**
   * Per-channel histogram of a 2D texture view, plus counts of special values.
   * Two compute passes: the finite range of each channel (ordered-bit atomics,
   * so NaN and infinity can't poison it), then the binning.
   * @param {GPUTextureView} srcView - a single-mip, single-layer 2D view
   * @param {string} srcFormat - the texture's format (depth formats read as their float copies)
   * @param {number} width - the view's width
   * @param {number} height - the view's height
   * @param {number} [bins=128]
   * @returns {Promise<Object>} { bins, channels, counts: Uint32Array[channels],
   *   min: number[], max: number[], nan, posInf, negInf, below0, above1, values }
   */
  async computeHistogram(srcView, srcFormat, width, height, bins = 128) {
    const info = TextureFormatInfo[srcFormat];
    const kind = info?.sampleType === "uint" ? "u32" : info?.sampleType === "sint" ? "i32" : "f32";
    const channels = info?.channels ?? 4;
    const sampleType = kind === "u32" ? "uint" : kind === "i32" ? "sint" : "unfilterable-float";
    const key = `histogram#${kind}`;
    if (!this._histogramPipelines) {
      this._histogramPipelines = new Map();
    }
    let entry = this._histogramPipelines.get(key);
    if (!entry) {
      const layout = this.device.createBindGroupLayout({
        entries: [
          { binding: 0, visibility: GPUShaderStage.COMPUTE, texture: { sampleType } },
          { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: "storage" } },
        ],
      });
      const module = this.device.createShaderModule({ code: _getHistogramShader(kind) });
      const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [layout] });
      entry = { layout, module, pipelineLayout, pipelines: new Map() };
      this._histogramPipelines.set(key, entry);
    }
    const pipelineKey = `${bins}#${channels}`;
    let pipelines = entry.pipelines.get(pipelineKey);
    if (!pipelines) {
      const constants = { BINS: bins, CHANNELS: channels };
      pipelines = ["rangeMain", "histogramMain"].map((entryPoint) => this.device.createComputePipeline({
        layout: entry.pipelineLayout,
        compute: { module: entry.module, entryPoint, constants },
      }));
      entry.pipelines.set(pipelineKey, pipelines);
    }

    // Layout: 4 range min keys, 4 range max keys, 5 counters, then 4 * bins.
    const words = 8 + 5 + 4 * bins;
    const init = new Uint32Array(words);
    init.fill(0xffffffff, 0, 4);
    const storage = this.device.createBuffer({ size: words * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
    const readback = this.device.createBuffer({ size: words * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
    try {
      this.device.queue.writeBuffer(storage, 0, init);
      const bindGroup = this.device.createBindGroup({
        layout: entry.layout,
        entries: [{ binding: 0, resource: srcView }, { binding: 1, resource: { buffer: storage } }],
      });
      const encoder = this.device.createCommandEncoder();
      for (const pipeline of pipelines) {
        const pass = encoder.beginComputePass();
        pass.setPipeline(pipeline);
        pass.setBindGroup(0, bindGroup);
        pass.dispatchWorkgroups(Math.ceil(width / 16), Math.ceil(height / 16));
        pass.end();
      }
      encoder.copyBufferToBuffer(storage, 0, readback, 0, words * 4);
      this.device.queue.submit([encoder.finish()]);
      await readback.mapAsync(GPUMapMode.READ);
      const data = new Uint32Array(readback.getMappedRange().slice(0));
      readback.unmap();

      // Undo the ordered-bit mapping of the range keys.
      const unkey = (k) => {
        const u = (k & 0x80000000) ? (k ^ 0x80000000) >>> 0 : (~k) >>> 0;
        return new Float32Array(new Uint32Array([u]).buffer)[0];
      };
      const min = [];
      const max = [];
      for (let c = 0; c < channels; ++c) {
        const empty = data[c] === 0xffffffff && data[4 + c] === 0;
        min.push(empty ? 0 : unkey(data[c]));
        max.push(empty ? 0 : unkey(data[4 + c]));
      }
      const counts = [];
      for (let c = 0; c < channels; ++c) {
        counts.push(data.slice(13 + c * bins, 13 + (c + 1) * bins));
      }
      return {
        bins, channels, counts, min, max,
        nan: data[8], posInf: data[9], negInf: data[10], below0: data[11], above1: data[12],
        values: width * height * channels,
      };
    } finally {
      storage.destroy();
      readback.destroy();
    }
  }

  convertDepthToFloat(fromTextureView, sampleCount, toTextureView, dstFormat, commandEncoder) {
    if (sampleCount > 1) {
      if (!this.depthToFloatMSPipeline) {
        this.device.pushErrorScope('validation');

        this.depthToFloatBindGroupMSLayout = this.device.createBindGroupLayout({
          entries: [
            {
              binding: 0,
              visibility: GPUShaderStage.FRAGMENT,
              texture: { sampleType: "depth", multisampled: true },
            }
          ]
        });

        const pipelineLayout = this.device.createPipelineLayout({
          bindGroupLayouts: [this.depthToFloatBindGroupMSLayout]
        });

        const module = this.depthToFloatMultisampleShaderModule;
        this.depthToFloatMSPipeline = this.device.createRenderPipeline({
          layout: pipelineLayout,
          vertex: {
            module,
            entryPoint: 'vertexMain',
          },
          fragment: {
            module: module,
            entryPoint: 'fragmentMain',
            targets: [ { format: dstFormat } ],
          },
          primitive: {
            topology: 'triangle-list',
          },
        });

        this.device.popErrorScope().then((result) => {
          if (result) {
            console.error(result.message);
          }
        });
      }
    } else if (!this.depthToFloatPipeline) {
      this.device.pushErrorScope('validation');

      this.depthToFloatBindGroupLayout = this.device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: { type: "comparison" },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: "depth" },
          }
        ]
      });

      const pipelineLayout = this.device.createPipelineLayout({
        bindGroupLayouts: [this.depthToFloatBindGroupLayout]
      });

      const module = this.depthToFloatShaderModule;
      this.depthToFloatPipeline = this.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
          module,
          entryPoint: 'vertexMain',
        },
        fragment: {
          module: module,
          entryPoint: 'fragmentMain',
          targets: [ { format: dstFormat } ],
        },
        primitive: {
          topology: 'triangle-list',
        },
      });

      this.device.popErrorScope().then((result) => {
        if (result) {
          console.error(result.message);
        }
      });
    }

    this.device.pushErrorScope('validation');

    const bindGroup = this.device.createBindGroup({
      layout: sampleCount > 1 ? this.depthToFloatBindGroupMSLayout : this.depthToFloatBindGroupLayout,
      entries: sampleCount > 1
        ? [ { binding: 0, resource: fromTextureView } ]
        : [ { binding: 0, resource: this.depthCompareSampler }, { binding: 1, resource: fromTextureView } ],
    });

    const doSubmit = !commandEncoder;

    commandEncoder ??= this.device.createCommandEncoder();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: toTextureView,
        loadOp: 'clear',
        storeOp: 'store',
        clearColor: { r: 0, g: 0, b: 0, a: 0 }
      }]
    });

    passEncoder.setPipeline(sampleCount > 1 ? this.depthToFloatMSPipeline : this.depthToFloatPipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(3);
    passEncoder.end();

    if (doSubmit) {
      this.device.queue.submit([commandEncoder.finish()]);
    }

    this.device.popErrorScope().then((result) => {
      if (result) {
        console.error(result.message);
      }
    });
  }

  convertDepthCubeFaceToFloat(fromTextureView, face, toTextureView, dstFormat, commandEncoder) {
    if (!this.depthCubeToFloatPipeline) {
      this.device.pushErrorScope('validation');

      this.depthCubeToFloatBindGroupLayout = this.device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: { type: "comparison" },
          },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            texture: { sampleType: "depth", viewDimension: "cube" },
          },
          {
            binding: 2,
            visibility: GPUShaderStage.FRAGMENT,
            buffer: { type: "uniform" },
          }
        ]
      });

      const pipelineLayout = this.device.createPipelineLayout({
        bindGroupLayouts: [this.depthCubeToFloatBindGroupLayout]
      });

      const module = this.depthCubeToFloatShaderModule;
      this.depthCubeToFloatPipeline = this.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
          module,
          entryPoint: 'vertexMain',
        },
        fragment: {
          module: module,
          entryPoint: 'fragmentMain',
          targets: [ { format: dstFormat } ],
        },
        primitive: {
          topology: 'triangle-list',
        },
      });

      this.device.popErrorScope().then((result) => {
        if (result) {
          console.error(result.message);
        }
      });
    }

    this.device.pushErrorScope('validation');

    const bindGroup = this.device.createBindGroup({
      layout: this.depthCubeToFloatBindGroupLayout,
      entries: [
        { binding: 0, resource: this.depthCompareSampler },
        { binding: 1, resource: fromTextureView },
        { binding: 2, resource: { buffer: this.depthCubeFaceUniformBuffers[face] } },
      ],
    });

    const doSubmit = !commandEncoder;

    commandEncoder ??= this.device.createCommandEncoder();
    const passEncoder = commandEncoder.beginRenderPass({
      colorAttachments: [{
        view: toTextureView,
        loadOp: 'clear',
        storeOp: 'store',
        clearColor: { r: 0, g: 0, b: 0, a: 0 }
      }]
    });

    passEncoder.setPipeline(this.depthCubeToFloatPipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(3);
    passEncoder.end();

    if (doSubmit) {
      this.device.queue.submit([commandEncoder.finish()]);
    }

    this.device.popErrorScope().then((result) => {
      if (result) {
        console.error(result.message);
      }
    });
  }
}

function _getComputeTextureMinMax(fmt) {
  return `
  struct Result {
      minValue: vec4f,
      maxValue: vec4f,
  };
  @group(0) @binding(0) var inputTexture: texture_2d<${fmt}>;
  @group(0) @binding(1) var<storage, read_write> output: Result;
  @compute @workgroup_size(1)
  fn main() {
      let dims = textureDimensions(inputTexture);
      // Another option is the set minValue to 0, which would manke the
      // range [0, maxValue] unless there are negative values in the texture.
      // Not sure which is better for general use.
      //var minValue = vec4f(0.0);
      var minValue = vec4f(3.402823466e+38); // max float
      var maxValue = vec4f(0.0);
      for (var x = 0u; x < dims.x; x++) {
          for (var y = 0u; y < dims.y; y++) {
              let color = vec4f(textureLoad(inputTexture, vec2<u32>(x, y), 0));
              minValue = min(minValue, color);
              maxValue = max(maxValue, color);
          }
      }
      output.minValue = minValue;
      output.maxValue = maxValue;
  }`;
}

function _getComputeTextureMinMax3d(fmt) {
  return `
  struct Result {
      minValue: vec4f,
      maxValue: vec4f,
  };
  @group(0) @binding(0) var inputTexture: texture_3d<${fmt}>;
  @group(0) @binding(1) var<storage, read_write> output: Result;
  @compute @workgroup_size(1)
  fn main() {
      let dims = textureDimensions(inputTexture);
      var minValue = vec4f(3.402823466e+38);
      var maxValue = vec4f(0.0);
      for (var x = 0u; x < dims.x; x++) {
          for (var y = 0u; y < dims.y; y++) {
              for (var z = 0u; z < dims.z; z++) {
                  let color = vec4f(textureLoad(inputTexture, vec3u(x, y, z), 0));
                  minValue = min(minValue, color);
                  maxValue = max(maxValue, color);
              }
          }
      }
      output.minValue = minValue;
      output.maxValue = maxValue;
  }`;
}

function _getHistogramShader(fmt) {
  return `
  override BINS: u32 = 128u;
  override CHANNELS: u32 = 4u;
  @group(0) @binding(0) var tex: texture_2d<${fmt}>;
  // [0..3] min keys, [4..7] max keys, [8] NaN, [9] +Inf, [10] -Inf, [11] < 0, [12] > 1, then bins.
  @group(0) @binding(1) var<storage, read_write> data: array<atomic<u32>>;

  // Float bits mapped so unsigned order matches float order.
  fn orderedKey(x: f32) -> u32 {
    let u = bitcast<u32>(x);
    return select(u ^ 0x80000000u, ~u, (u & 0x80000000u) != 0u);
  }

  fn isFinite(x: f32) -> bool {
    return (bitcast<u32>(x) & 0x7f800000u) != 0x7f800000u;
  }

  @compute @workgroup_size(16, 16)
  fn rangeMain(@builtin(global_invocation_id) id: vec3u) {
    let dim = textureDimensions(tex);
    if (id.x >= dim.x || id.y >= dim.y) {
      return;
    }
    let v = vec4f(textureLoad(tex, vec2i(id.xy), 0));
    for (var c = 0u; c < CHANNELS; c++) {
      if (isFinite(v[c])) {
        let k = orderedKey(v[c]);
        atomicMin(&data[c], k);
        atomicMax(&data[4u + c], k);
      }
    }
  }

  fn fromKey(k: u32) -> f32 {
    return bitcast<f32>(select(~k, k ^ 0x80000000u, (k & 0x80000000u) != 0u));
  }

  @compute @workgroup_size(16, 16)
  fn histogramMain(@builtin(global_invocation_id) id: vec3u) {
    let dim = textureDimensions(tex);
    if (id.x >= dim.x || id.y >= dim.y) {
      return;
    }
    let v = vec4f(textureLoad(tex, vec2i(id.xy), 0));
    for (var c = 0u; c < CHANNELS; c++) {
      let x = v[c];
      let bits = bitcast<u32>(x) & 0x7fffffffu;
      if (bits > 0x7f800000u) {
        atomicAdd(&data[8], 1u);
        continue;
      }
      if (bits == 0x7f800000u) {
        atomicAdd(&data[select(10u, 9u, x > 0.0)], 1u);
        continue;
      }
      if (x < 0.0) {
        atomicAdd(&data[11], 1u);
      }
      if (x > 1.0) {
        atomicAdd(&data[12], 1u);
      }
      let lo = fromKey(atomicLoad(&data[c]));
      let hi = fromKey(atomicLoad(&data[4u + c]));
      var b = 0u;
      if (hi > lo) {
        b = min(u32((x - lo) / (hi - lo) * f32(BINS)), BINS - 1u);
      }
      atomicAdd(&data[13u + c * BINS + b], 1u);
    }
  }`;
}

function _getBlitShader(fmt) {
  return `
  var<private> posTex:array<vec4f, 3> = array<vec4f, 3>(
    vec4f(-1.0, 1.0, 0.0, 0.0),
    vec4f(3.0, 1.0, 2.0, 0.0),
    vec4f(-1.0, -3.0, 0.0, 2.0));
  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f
  };
  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    output.uv = posTex[vertexIndex].zw;
    output.position = vec4f(posTex[vertexIndex].xy, 0.0, 1.0);
    return output;;
  }
  @group(0) @binding(0) var texture: texture_2d<${fmt}>;
  struct Display {
    exposure: f32,
    channels: f32,
    numChannels: f32,
    autoRange: f32,
    minRange: f32,
    maxRange: f32,
    _pad2: f32,
    highlight: f32
  };
  struct MinMax {
      min_val: vec4f,
      max_val: vec4f,
  };
  @group(1) @binding(0) var<uniform> display: Display;
  @group(1) @binding(1) var<storage> minMax: MinMax;

  // Highlight colors for special values (see TextureUtils.HIGHLIGHT_*). NaN
  // and infinity are tested on the bits: x != x may be folded away.
  fn highlightColor(v: vec4f, numChannels: u32, flags: u32) -> vec4f {
    for (var c = 0u; c < numChannels; c++) {
      let x = v[c];
      let bits = bitcast<u32>(x) & 0x7fffffffu;
      if ((flags & 1u) != 0u) {
        if (bits > 0x7f800000u) {
          return vec4f(1.0, 0.0, 1.0, 1.0);       // NaN: magenta
        }
        if (bits == 0x7f800000u) {
          return select(vec4f(0.0, 1.0, 1.0, 1.0), vec4f(1.0, 0.55, 0.0, 1.0), x > 0.0);  // +Inf orange, -Inf cyan
        }
      }
      if (bits <= 0x7f800000u) {
        if ((flags & 2u) != 0u && x < 0.0) {
          return vec4f(0.15, 0.35, 1.0, 1.0);     // below 0: blue
        }
        if ((flags & 4u) != 0u && x > 1.0) {
          return vec4f(1.0, 0.1, 0.1, 1.0);       // above 1: red
        }
      }
    }
    return vec4f(-1.0);
  }

  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    let flags = u32(display.highlight);
    if (flags != 0u) {
      let dim = textureDimensions(texture);
      let raw = vec4f(textureLoad(texture, vec2i(input.uv * vec2f(dim)), 0));
      let h = highlightColor(raw, u32(display.numChannels), flags);
      if (h.a >= 0.0) {
        return h;
      }
    }
    return shade(input);
  }

  fn shade(input: VertexOutput) -> vec4f {
    var dim = textureDimensions(texture);
    var color = vec4f(textureLoad(texture, vec2i(input.uv * vec2f(dim)), 0));
    var minVal = minMax.min_val;
    var maxVal = minMax.max_val;

    var minCh = min(minVal.r, min(minVal.g, minVal.b));
    var maxCh = max(maxVal.r, max(maxVal.g, maxVal.b));
    if (display.autoRange > 0.0 && abs(maxCh - minCh) > 0.00001) {
      color = vec4f((color.rgb - vec3f(minCh)) / vec3f(maxCh - minCh), color.a);
    }

    if (display.numChannels == 1.0) {
      if (display.minRange != display.maxRange) {
        if (color.r < display.minRange) {
          color = vec4f(0.0, 0.0, 0.0, 1);
        } else if (color.r > display.maxRange) {
          color = vec4f(1.0, 0.0, 0.0, 1);
        } else {
          color = vec4f((color.r - display.minRange) / (display.maxRange - display.minRange), 0.0, 0.0, 1);
        }
      }
      color = vec4f(color.r, color.r, color.r, 1.0);
    } else if (display.numChannels == 2.0) {
      color = vec4f(color.r, color.g, 0.0, 1.0);
    }

    if (display.channels == 1.0) { // R
      var rgb = color.rgb * display.exposure;
      return vec4f(rgb.r, 0.0, 0.0, 1);
    } else if (display.channels == 2.0) { // G
      var rgb = color.rgb * display.exposure;
      return vec4f(0.0, rgb.g, 0.0, 1);
    } else if (display.channels == 3.0) { // B
      var rgb = color.rgb * display.exposure;
      return vec4f(0.0, 0.0, rgb.b, 1);
    } else if (display.channels == 4.0) { // A
      var a = color.a * display.exposure;
      return vec4f(a, a, a, 1);
    } else if (display.channels == 5.0) { // Luminance
      var luminance = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
      var rgb = vec3f(luminance) * display.exposure;
      return vec4f(rgb, 1);
    }

    // RGB
    var rgb = color.rgb * display.exposure;
    return vec4f(rgb, 1);
  }`;
}

TextureUtils.blit3dShader = `
  var<private> posTex:array<vec4f, 3> = array<vec4f, 3>(
    vec4f(-1.0, 1.0, 0.0, 0.0),
    vec4f(3.0, 1.0, 2.0, 0.0),
    vec4f(-1.0, -3.0, 0.0, 2.0));
  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f
  };
  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    output.uv = posTex[vertexIndex].zw;
    output.position = vec4f(posTex[vertexIndex].xy, 0.0, 1.0);
    return output;;
  }
  @group(0) @binding(0) var texSampler: sampler;
  @group(0) @binding(1) var texture: texture_3d<f32>;
  struct Display {
    exposure: f32,
    channels: f32,
    numChannels: f32,
    autoRange: f32,
    minRange: f32,
    maxRange: f32,
    layer: f32,
    _pad3: f32
  };
  struct MinMax {
      min_val: vec4f,
      max_val: vec4f,
  };
  @group(1) @binding(0) var<uniform> display: Display;
  @group(1) @binding(1) var<storage> minMax: MinMax;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    var color = textureSampleLevel(texture, texSampler, vec3f(input.uv, display.layer), 0.0);
    var minVal = minMax.min_val;
    var maxVal = minMax.max_val;

    var minCh = min(minVal.r, min(minVal.g, minVal.b));
    var maxCh = max(maxVal.r, max(maxVal.g, maxVal.b));
    if (display.autoRange > 0.0 && abs(maxCh - minCh) > 0.00001) {
      color = vec4f((color.rgb - vec3f(minCh)) / vec3f(maxCh - minCh), color.a);
    }

    if (display.numChannels == 1.0) {
      if (display.minRange != display.maxRange) {
        if (color.r < display.minRange) {
          color = vec4f(0.0, 0.0, 0.0, 1);
        } else if (color.r > display.maxRange) {
          color = vec4f(1.0, 0.0, 0.0, 1);
        } else {
          color = vec4f((color.r - display.minRange) / (display.maxRange - display.minRange), 0.0, 0.0, 1);
        }
      }
      color = vec4f(color.r, color.r, color.r, 1.0);
    } else if (display.numChannels == 2.0) {
      color = vec4f(color.r, color.g, 0.0, 1.0);
    }

    if (display.channels == 1.0) { // R
      var rgb = color.rgb * display.exposure;
      return vec4f(rgb.r, 0.0, 0.0, 1);
    } else if (display.channels == 2.0) { // G
      var rgb = color.rgb * display.exposure;
      return vec4f(0.0, rgb.g, 0.0, 1);
    } else if (display.channels == 3.0) { // B
      var rgb = color.rgb * display.exposure;
      return vec4f(0.0, 0.0, rgb.b, 1);
    } else if (display.channels == 4.0) { // A
      var a = color.a * display.exposure;
      return vec4f(a, a, a, 1);
    } else if (display.channels == 5.0) { // Luminance
      var luminance = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
      var rgb = vec3f(luminance) * display.exposure;
      return vec4f(rgb, 1);
    }

    // RGB
    var rgb = color.rgb * display.exposure;
    return vec4f(rgb, 1);
  }
`;

TextureUtils.multisampleBlitShader = `
  var<private> posTex:array<vec4f, 3> = array<vec4f, 3>(
    vec4f(-1.0, 1.0, 0.0, 0.0),
    vec4f(3.0, 1.0, 2.0, 0.0),
    vec4f(-1.0, -3.0, 0.0, 2.0));
  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv: vec2f
  };
  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    output.uv = posTex[vertexIndex].zw;
    output.position = vec4f(posTex[vertexIndex].xy, 0.0, 1.0);
    return output;;
  }
  @group(0) @binding(0) var texSampler: sampler;
  @group(0) @binding(1) var texture: texture_multisampled_2d<f32>;
  struct Display {
    exposure: f32,
    channels: f32,
    numChannels: f32,
    autoRange: f32,
    minRange: f32,
    maxRange: f32,
    _pad2: f32,
    _pad3: f32
  };
  struct MinMax {
      min_val: vec4f,
      max_val: vec4f,
  };
  @group(1) @binding(0) var<uniform> display: Display;
  @group(1) @binding(1) var<storage> minMax: MinMax;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    var coords = vec2i(input.uv * vec2f(textureDimensions(texture)));
    var color = textureLoad(texture, coords, 0);
    var minVal = minMax.min_val;
    var maxVal = minMax.max_val;

    var minCh = min(minVal.r, min(minVal.g, minVal.b));
    var maxCh = max(maxVal.r, max(maxVal.g, maxVal.b));
    if (display.autoRange > 0.0 && abs(maxCh - minCh) > 0.00001) {
      color = vec4f((color.rgb - vec3f(minCh)) / vec3f(maxCh - minCh), color.a);
    }

    if (display.numChannels == 1.0) {
      if (display.minRange != display.maxRange) {
        if (color.r < display.minRange) {
          color = vec4f(0.0, 0.0, 0.0, color.a);
        } else if (color.r > display.maxRange) {
          color = vec4f(1.0, 1.0, 1.0, color.a);
        } else {
          color = vec4f((color.r - display.minRange) / (display.maxRange - display.minRange), 0.0, 0.0, color.a);
        }
      }
      color = vec4f(color.r, color.r, color.r, 1.0);
    } else if (display.numChannels == 2.0) {
      color = vec4f(color.r, color.g, 0.0, 1.0);
    }
    if (display.channels == 1.0) { // R
      var rgb = color.rgb * display.exposure;
      return vec4f(rgb.r, 0.0, 0.0, color.a);
    } else if (display.channels == 2.0) { // G
      var rgb = color.rgb * display.exposure;
      return vec4f(0.0, rgb.g, 0.0, color.a);
    } else if (display.channels == 3.0) { // B
      var rgb = color.rgb * display.exposure;
      return vec4f(0.0, 0.0, rgb.b, color.a);
    } else if (display.channels == 4.0) { // A
      var a = color.a * display.exposure;
      return vec4f(a, a, a, color.a);
    } else if (display.channels == 5.0) { // Luminance
      var luminance = dot(color.rgb, vec3f(0.2126, 0.7152, 0.0722));
      var rgb = vec3f(luminance) * display.exposure;
      return vec4f(rgb, color.a);
    }

    // RGB
    var rgb = color.rgb * display.exposure;
    return vec4f(rgb, color.a);
  }`;

TextureUtils.depthToFloatShader = `
  var<private> posTex:array<vec4f, 3> = array<vec4f, 3>(
    vec4f(-1.0, 1.0, 0.0, 0.0),
    vec4f(3.0, 1.0, 2.0, 0.0),
    vec4f(-1.0, -3.0, 0.0, 2.0));
  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv : vec2f
  };
  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    output.uv = posTex[vertexIndex].zw;
    output.position = vec4f(posTex[vertexIndex].xy, 0.0, 1.0);
    return output;;
  }

  @binding(0) @group(0) var depthSampler: sampler_comparison;
  @binding(1) @group(0) var depth: texture_depth_2d;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) f32 {
    var lo = 0.0;
    var hi = 1.0;
    for (var i = 0; i < 16; i++) {
      let mid = (lo + hi) * 0.5;
      let compare = textureSampleCompare(depth, depthSampler, input.uv, mid);
      if (compare > 0.5) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo;
  }`;

TextureUtils.depthCubeToFloatShader = `
  var<private> posTex:array<vec4f, 3> = array<vec4f, 3>(
    vec4f(-1.0, 1.0, 0.0, 0.0),
    vec4f(3.0, 1.0, 2.0, 0.0),
    vec4f(-1.0, -3.0, 0.0, 2.0));
  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv : vec2f
  };
  struct FaceUniform {
    face: u32,
  };
  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    output.uv = posTex[vertexIndex].zw;
    output.position = vec4f(posTex[vertexIndex].xy, 0.0, 1.0);
    return output;;
  }

  fn cubeDirection(face: u32, uv: vec2f) -> vec3f {
    let xy = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
    if (face == 0u) {
      return vec3f(1.0, xy.y, -xy.x);
    } else if (face == 1u) {
      return vec3f(-1.0, xy.y, xy.x);
    } else if (face == 2u) {
      return vec3f(xy.x, 1.0, -xy.y);
    } else if (face == 3u) {
      return vec3f(xy.x, -1.0, xy.y);
    } else if (face == 4u) {
      return vec3f(xy.x, xy.y, 1.0);
    }
    return vec3f(-xy.x, xy.y, -1.0);
  }

  @binding(0) @group(0) var depthSampler: sampler_comparison;
  @binding(1) @group(0) var depth: texture_depth_cube;
  @binding(2) @group(0) var<uniform> faceUniform: FaceUniform;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) f32 {
    let direction = cubeDirection(faceUniform.face, input.uv);
    var lo = 0.0;
    var hi = 1.0;
    for (var i = 0; i < 16; i++) {
      let mid = (lo + hi) * 0.5;
      let compare = textureSampleCompare(depth, depthSampler, direction, mid);
      if (compare > 0.5) {
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return lo;
  }`;

TextureUtils.depthToFloatMultisampleShader = `
  var<private> posTex:array<vec4f, 3> = array<vec4f, 3>(
    vec4f(-1.0, 1.0, 0.0, 0.0),
    vec4f(3.0, 1.0, 2.0, 0.0),
    vec4f(-1.0, -3.0, 0.0, 2.0));
  struct VertexOutput {
    @builtin(position) position: vec4f,
    @location(0) uv : vec2f
  };
  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    output.uv = posTex[vertexIndex].zw;
    output.position = vec4f(posTex[vertexIndex].xy, 0.0, 1.0);
    return output;;
  }

  @binding(0) @group(0) var depth: texture_depth_multisampled_2d;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) f32 {
    var depthSize = textureDimensions(depth);
    var coords = vec2<i32>(i32(f32(depthSize.x) * input.uv.x),
                           i32(f32(depthSize.y) * input.uv.y));
    var d = textureLoad(depth, coords, 0);
    return d;
  }`;
