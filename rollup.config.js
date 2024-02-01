function build(name, input, format, file) {
  return {
      input,
      output: [
          {
              format,
              file,
              sourcemap: false,
              name
          }
      ]
  }
}

const builds = [
  build("__webgpu_inspector", 'src/webgpu_inspector.js', 'iife', 'extensions/webgpu_inspector.bundle.js'),
  build("__webgpu_recorder", 'src/webgpu_recorder.js', 'iife', 'extensions/webgpu_recorder.bundle.js'),
  build("__webgpu_inspector_window", 'src/devtools/inspector_window.js', 'iife', 'extensions/webgpu_inspector_window.bundle.js'),
];

export default builds;
