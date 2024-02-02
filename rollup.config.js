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
  build("__webgpu_inspector", 'src/webgpu_inspector.js', 'iife', 'extensions/webgpu_inspector.js'),
  build("__webgpu_recorder", 'src/webgpu_recorder.js', 'iife', 'extensions/webgpu_recorder.js'),
  build("__webgpu_inspector_window", 'src/devtools/inspector_window.js', 'iife', 'extensions/webgpu_inspector_window.js'),
  build("__background", 'src/background.js', 'iife', 'extensions/background.js'),
  build("__content_script", 'src/content_script.js', 'iife', 'extensions/content_script.js'),
];

export default builds;
