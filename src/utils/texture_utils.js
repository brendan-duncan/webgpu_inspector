//import { TextureFormatInfo } from "./texture_format_info.js";

export class TextureUtils {
  constructor(device) {
    this.device = device;
    this.blitShaderModule = device.createShaderModule({code: TextureUtils.blitShader});
    this.blitDepthShaderModule = device.createShaderModule({code: TextureUtils.blitDepthShader});
    this.blitPipelines = {};
    this.blitDepthPipelines = {};
    this.bindGroupLayouts = new Map();
    this.pipelineLayouts = new Map();

    this.pointSampler = device.createSampler({
        magFilter: 'nearest',
        minFilter: 'nearest',
    });

    this.displayUniformBuffer = device.createBuffer({
      size: 8,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.displayBingGroupLayout = device.createBindGroupLayout({
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
      layout: this.displayBingGroupLayout,
      entries: [
        {
          binding: 0,
          resource: { buffer: this.displayUniformBuffer }
        }
      ]
    });
  }

  copyDepthTexture(src, format) {
    const width = src.width;
    const height = src.height;
    const usage = src.usage | GPUTextureUsage.RENDER_TARGET | GPUTextureUsage.COPY_SRC;
    const size = [width, height, 1]
    const dst = this.device.createTexture({ format, size, usage });

    let pipeline = this.blitDepthPipelines[format];
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        layout: 'auto',
        vertex: {
          module: this.blitDepthShaderModule,
          entryPoint: 'vertexMain',
        },
        fragment: {
          module: this.blitDepthShaderModule,
          entryPoint: 'fragmentMain',
          targets: [],
        },
        depthStencil: {
          format,
          depthWriteEnabled: true,
          depthCompare: "always"
        },
        primitive: {
          topology: 'triangle-list',
        },
      });
      this.blitDepthPipelines[format] = pipeline;
    }

    const srcView = src.createView({ aspect: "depth-only" });

    const bindGroupLayout = pipeline.getBindGroupLayout(0);
    const bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [
        { binding: 0, resource: this.pointSampler },
        { binding: 1, resource: srcView }
      ],
    });

    const commandEncoder = this.device.createCommandEncoder();

    const dstView = dst.createView();

    const passDesc = {
      colorAttachments: [],
      depthStencilAttachment: {
        view: dstView,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
        depthClearValue: 0,
        depthReadOnly: false
      }
    };

    const passEncoder = commandEncoder.beginRenderPass(passDesc);
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(3);
    passEncoder.end();
    this.device.queue.submit([commandEncoder.finish()]);
    
    return dst;
  }

  blitTexture(src, dst, dstFormat, display) {
    const sampleType = "unfilterable-float";

    if (!this.bindGroupLayouts.has(sampleType)) {
      const bindGroupLayout = this.device.createBindGroupLayout({
        entries: [
          {
            binding: 0,
            visibility: GPUShaderStage.FRAGMENT,
            sampler: {
              type: "non-filtering"
            }
          },
          {
            binding: 1,
            visibility: GPUShaderStage.FRAGMENT,
            texture: {
              sampleType: sampleType
            }
          }
        ]
      });
      this.bindGroupLayouts.set(sampleType, bindGroupLayout);

      const pipelineLayout = this.device.createPipelineLayout({
        bindGroupLayouts: [bindGroupLayout, this.displayBingGroupLayout]
      });
      this.pipelineLayouts.set(sampleType, pipelineLayout);
    }

    const bindGroupLayout = this.bindGroupLayouts.get(sampleType);
    const pipelineLayout = this.pipelineLayouts.get(sampleType);

    const pipelineKey = `${dstFormat}#${sampleType}`;
    let pipeline = this.blitPipelines[pipelineKey];
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        layout: pipelineLayout,
        vertex: {
          module: this.blitShaderModule,
          entryPoint: 'vertexMain',
        },
        fragment: {
          module: this.blitShaderModule,
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
        { binding: 1, resource: src }
      ],
    });
    
    const commandEncoder = this.device.createCommandEncoder();

    const passDesc = {
      colorAttachments: [{
        view: dst,
        loadOp: 'clear',
        storeOp: 'store'
      }]
    };

    if (display) {
      console.log("display", display.exposure, display.channels);
      this.device.queue.writeBuffer(this.displayUniformBuffer, 0,
        new Float32Array([display.exposure, display.channels]));
    } else {
      this.device.queue.writeBuffer(this.displayUniformBuffer, 0,
        new Float32Array([1, 0]));
    }

    const passEncoder = commandEncoder.beginRenderPass(passDesc);
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setBindGroup(1, this.displayBindGroup);
    passEncoder.draw(3);
    passEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);
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
    channels: f32
  };
  @group(1) @binding(0) var<uniform> display: Display; 
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    var color = textureSample(texture, texSampler, input.uv);
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
    }

    // RGB
    var rgb = color.rgb * display.exposure;
    return vec4f(rgb, color.a);
  }
`;

TextureUtils.blitDepthShader = `
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
  @binding(0) @group(0) var texSampler: sampler;
  @binding(1) @group(0) var texture: texture_depth_2d;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @builtin(frag_depth) f32 {
    return textureSample(texture, texSampler, input.uv);
  }
`;
