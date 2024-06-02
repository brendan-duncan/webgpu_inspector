self.addEventListener('message', (ev) => {
  switch (ev.data.type) {
    case 'init': {
      try {
        init(ev.data.offscreenCanvas);
      } catch (err) {
        console.error(`Error while initializing WebGPU in worker process: ${err.message}`);
      }
      break;
    }
  }
});

async function init(canvas) {
    if (!navigator.gpu) {
      return;
    }

    const response = await fetch('triangle.html');
    const text = await response.text();
    //console.log(text);

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return;
    }
    const device = await adapter.requestDevice();
  
    const presentationFormat = navigator.gpu.getPreferredCanvasFormat();
  
    const context = canvas.getContext("webgpu");
  
    context.configure({ device: device, format: presentationFormat });
  
    const depthTexture = device.createTexture({
      size: [canvas.width, canvas.height],
      sampleCount: 1,
      format: "depth24plus",
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    });
  
    const depthTextureView = depthTexture.createView();
  
    const redTriangleShader = device.createShaderModule({
      code: `
        @vertex
        fn vertexMain(@builtin(vertex_index) VertexIndex : u32) -> @builtin(position) vec4<f32> {
          var pos = array<vec2<f32>, 3>(
            vec2(0.0, 0.5),
            vec2(-0.5, -0.5),
            vec2(0.5, -0.5));
          return vec4<f32>(pos[VertexIndex], 0.5, 1.0);
        }
  
        @fragment
        fn fragmentMain() -> @location(0) vec4<f32> {
          return vec4(0.0, 1.0, 0.0, 1.0);
        }`,
    });
  
    const pipeline = device.createRenderPipeline({
      layout: "auto",
      vertex: {
        module: redTriangleShader,
        entryPoint: "vertexMain",
      },
      fragment: {
        module: redTriangleShader,
        entryPoint: "fragmentMain",
        targets: [{ format: presentationFormat } ]
      },
      primitive: { topology: "triangle-list" },
      depthStencil: {
        depthWriteEnabled: true,
        depthCompare: 'less',
        format: 'depth24plus',
      },
    });
  
    function frame() {
      const commandEncoder = device.createCommandEncoder();
  
      const canvasTextureView = context.getCurrentTexture().createView();
  
      const passEncoder = commandEncoder.beginRenderPass({
        colorAttachments: [
          {
            view: canvasTextureView,
            clearValue: { r: 0.5, g: 0.5, b: 0.5, a: 1.0 },
            loadOp: "clear",
            storeOp: "store",
          },
        ],
        depthStencilAttachment: {
          view: depthTextureView,
          depthClearValue: 1.0,
          depthLoadOp: "clear",
          depthStoreOp: "store",
        }
      });
      passEncoder.setPipeline(pipeline);
      passEncoder.draw(3);
      passEncoder.end();
  
      device.queue.submit([commandEncoder.finish()]);
  
      requestAnimationFrame(frame);
    }
  
    requestAnimationFrame(frame);
  };
