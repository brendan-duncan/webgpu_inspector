export class TextureUtils {
  constructor(device) {
    this.device = device;
    this.blitShaderModule = device.createShaderModule({code: TextureUtils.blitShader});
    this.blitPipelines = {};

    this.pointSampler = device.createSampler({
        magFilter: 'nearest',
        minFilter: 'nearest',
    });
  }

  blitTexture(src, dst, dstFormat) {
    let pipeline = this.blitPipelines[dstFormat];
    if (!pipeline) {
      pipeline = this.device.createRenderPipeline({
        layout: 'auto',
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
      this.blitPipelines[dstFormat] = pipeline;
    }

    const bindGroup = this.device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
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

    const passEncoder = commandEncoder.beginRenderPass(passDesc);
    passEncoder.setPipeline(pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(3);
    passEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);
  }
}

TextureUtils.blitShader = `
  var<private> posTex = array<vec4f, 3>(
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
  @binding(1) @group(0) var texture: texture_2d<f32>;
  @fragment
  fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
    return textureSample(texture, texSampler, input.uv);
  }
`;