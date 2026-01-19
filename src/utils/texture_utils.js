import { TextureFormatInfo } from "./texture_format_info.js";

export class TextureUtils {
  constructor(device) {
    this.device = device;
    this.blitShaderModule = device.createShaderModule({ code: TextureUtils.blitShader });
    this.blitU32ShaderModule = device.createShaderModule({ code: TextureUtils.blitU32Shader });
    this.blitS32ShaderModule = device.createShaderModule({ code: TextureUtils.blitS32Shader });
    this.blit3dShaderModule = device.createShaderModule({ code: TextureUtils.blit3dShader });
    this.multisampleBlitShaderModule = device.createShaderModule({ code: TextureUtils.multisampleBlitShader });
    this.depthToFloatShaderModule = device.createShaderModule({ code: TextureUtils.depthToFloatShader });
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

    this.displayUniformBuffer = device.createBuffer({
      size: 4 * 8,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.displayBindGroupLayout = device.createBindGroupLayout({
      entries: [
        {
          binding: 0,
          visibility: GPUShaderStage.FRAGMENT,
          buffer: {
            type: "uniform"
          }
        }
      ]
    });

    this.displayBindGroup = device.createBindGroup({
      layout: this.displayBindGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.displayUniformBuffer }
        }
      ]
    });
  }

  copyDepthTexture(src, format, commandEncoder) {
    const width = src.width;
    const height = src.height;
    const depthOrArrayLayers = src.depthOrArrayLayers;
    const usage = src.usage | GPUTextureUsage.RENDER_TARGET | GPUTextureUsage.COPY_SRC;
    const size = [width, height, depthOrArrayLayers];
    format = format || "r32float";

    const dst = this.device.createTexture({ format, size, usage });

    for (let i = 0; i < depthOrArrayLayers; ++i) {
      const srcView = src.createView({ dimension: "2d", aspect: "depth-only", baseArrayLayer: i, arrayLayerCount: 1 });
      const dstView = dst.createView({ dimension: "2d", baseArrayLayer: i, arrayLayerCount: 1 });
      this.convertDepthToFloat(srcView, src.sampleCount, dstView, format, commandEncoder);
    }
    
    return dst;
  }

  copyMultisampledTexture(src) {
    const width = src.width;
    const height = src.height;
    const format = src.format;
    const usage = src.usage | GPUTextureUsage.RENDER_TARGET | GPUTextureUsage.COPY_SRC;
    const size = [width, height, 1]
    const dst = this.device.createTexture({ format, size, usage });

    this.blitTexture(src.createView(), src.format, src.sampleCount, dst.createView(), format);

    return dst;
  }

  blitTexture(srcView, srcFormat, sampleCount, dstView, dstFormat, display, dimension, layer) {
    layer ??= 0;
    dimension ??= "2d";
    const sampleType = TextureFormatInfo[srcFormat]?.sampleType || "unfilterable-float";

    const bgLayoutKey = `${sampleType}#${sampleCount}#${dimension}`;

    if (!this.bindGroupLayouts.has(bgLayoutKey)) {
      const bindGroupLayout = this.device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: { type: "non-filtering" }
          },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            texture: {
              viewDimension: dimension,
              sampleType: sampleType,
              multisampled: sampleCount > 1
            }
          }
        ]
      });
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
      entries: [
        { binding: 0, resource: this.pointSampler },
        { binding: 1, resource: srcView }
      ]
    });

    const commandEncoder = this.device.createCommandEncoder();

    const passDesc = {
      colorAttachments: [{
        view: dstView,
        loadOp: 'clear',
        storeOp: 'store'
      }]
    };

    if (display) {
      this.device.queue.writeBuffer(this.displayUniformBuffer, 0,
        new Float32Array([display.exposure, display.channels, numChannels, display.minRange ?? 0, display.maxRange ?? 1, layer, 0, 0]));
    } else {
      this.device.queue.writeBuffer(this.displayUniformBuffer, 0,
        new Float32Array([1, 0, numChannels, 0, 1, layer, 0, 0]));
    }

    const passEncoder = commandEncoder.beginRenderPass(passDesc);
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setBindGroup(1, this.displayBindGroup);
    passEncoder.draw(3);
    passEncoder.end();
    this.device.queue.submit([commandEncoder.finish()]);
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
      entries: [ { binding: 0, resource: fromTextureView } ],
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
}

TextureUtils.blitShader = `
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
  @group(0) @binding(1) var texture: texture_2d<f32>;
  struct Display {
    exposure: f32,
    channels: f32,
    numChannels: f32,
    minRange: f32,
    maxRange: f32,
    _pad1: f32,
    _pad2: f32,
    _pad3: f32
  };
  @group(1) @binding(0) var<uniform> display: Display; 
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    var color = textureSample(texture, texSampler, input.uv);

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

  TextureUtils.blitU32Shader = `
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
  @group(0) @binding(1) var texture: texture_2d<u32>;
  struct Display {
    exposure: f32,
    channels: f32,
    numChannels: f32,
    minRange: f32,
    maxRange: f32,
    _pad1: f32,
    _pad2: f32,
    _pad3: f32
  };
  @group(1) @binding(0) var<uniform> display: Display; 
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    var dim = textureDimensions(texture);
    var color = vec4f(textureLoad(texture, vec2i(input.uv * vec2f(dim)), 0));

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

TextureUtils.blitS32Shader = `
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
  @group(0) @binding(1) var texture: texture_2d<i32>;
  struct Display {
    exposure: f32,
    channels: f32,
    numChannels: f32,
    minRange: f32,
    maxRange: f32,
    _pad1: f32,
    _pad2: f32,
    _pad3: f32
  };
  @group(1) @binding(0) var<uniform> display: Display; 
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    var dim = textureDimensions(texture);
    var color = vec4f(textureLoad(texture, vec2i(input.uv * vec2f(dim)), 0));

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
    minRange: f32,
    maxRange: f32,
    layer: f32,
    _pad2: f32,
    _pad3: f32
  };
  @group(1) @binding(0) var<uniform> display: Display; 
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    var color = textureSampleLevel(texture, texSampler, vec3f(input.uv, display.layer), 0.0);

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
    minRange: f32,
    maxRange: f32,
    _pad1: f32,
    _pad2: f32,
    _pad3: f32
  };
  @group(1) @binding(0) var<uniform> display: Display; 
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    var coords = vec2i(input.uv * vec2f(textureDimensions(texture)));
    var color = textureLoad(texture, coords, 0);
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
    @builtin(position) position: vec4<f32>,
    @location(0) uv : vec2<f32>
  };
  @vertex
  fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
    var output: VertexOutput;
    output.uv = posTex[vertexIndex].zw;
    output.position = vec4f(posTex[vertexIndex].xy, 0.0, 1.0);
    return output;;
  }
  
  @binding(0) @group(0) var depth: texture_depth_2d;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    var depthSize = textureDimensions(depth);
    var coords = vec2<i32>(i32(f32(depthSize.x) * input.uv.x),
                           i32(f32(depthSize.y) * input.uv.y));
    var d = textureLoad(depth, coords, 0);
    return vec4<f32>(d, 0.0, 0.0, 1.0);
  }`;

TextureUtils.depthToFloatMultisampleShader = `
  var<private> posTex:array<vec4f, 3> = array<vec4f, 3>(
    vec4f(-1.0, 1.0, 0.0, 0.0),
    vec4f(3.0, 1.0, 2.0, 0.0),
    vec4f(-1.0, -3.0, 0.0, 2.0));
  struct VertexOutput {
    @builtin(position) position: vec4<f32>,
    @location(0) uv : vec2<f32>
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
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4<f32> {
    var depthSize = textureDimensions(depth);
    var coords = vec2<i32>(i32(f32(depthSize.x) * input.uv.x),
                           i32(f32(depthSize.y) * input.uv.y));
    var d = textureLoad(depth, coords, 0);
    return vec4<f32>(d, 0.0, 0.0, 1.0);
  }`;
