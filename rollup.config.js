import { nodeResolve } from "@rollup/plugin-node-resolve";
import { terser } from "rollup-plugin-terser";
import copy from "rollup-plugin-copy";
import fg from 'fast-glob';

function build(name, input, file, copyFiles, watchInclude) { 
  const format = "iife";
  const info = {
      input,
      output: {
        format,
        file,
        sourcemap: true,
        name
      },
      plugins: [
        nodeResolve(),
        /*terser({
          ecma: 2020,
          compress: {
            module: true,
            toplevel: true,
            keep_classnames: true,
            unsafe_arrows: true,
            drop_console: false,
            drop_debugger: false
          },
          output: { quote_style: 1 }
        })*/
      ]
  };

  if (copyFiles) {
    info.plugins.push(copy(copyFiles));
  }

  if (watchInclude) {
    info.plugins.push({
      name: 'watch-external',
      async buildStart() {
        const files = await fg(watchInclude);
        for (const file of files){
          this.addWatchFile(file);
        }
      }
    });
  }

  return info;
}

const builds = [];
const versions = ["chrome", "firefox"];
for (const version of versions) {
  const copyFiles = {
    targets: [
      { src: `src/extension/${version}/manifest.json`, dest: `extensions/${version}` },
      { src: `src/extension/webgpu_inspector_devtools.html`, dest: `extensions/${version}` },
      { src: `src/extension/webgpu_inspector_devtools.js`, dest: `extensions/${version}` },
      { src: `src/extension/webgpu_inspector_panel.css`, dest: `extensions/${version}` },
      { src: `src/extension/webgpu_inspector_panel.html`, dest: `extensions/${version}` },
      { src: `src/extension/res`, dest: `extensions/${version}` },
    ]
  };

  builds.push(
    build("__webgpu_inspector", 'src/webgpu_inspector.js', `extensions/${version}/webgpu_inspector.js`),
    build("__webgpu_recorder", 'src/webgpu_recorder.js', `extensions/${version}/webgpu_recorder.js`),
    build("__webgpu_inspector_window", 'src/devtools/inspector_window.js', `extensions/${version}/webgpu_inspector_window.js`),
    build("__background", 'src/extension/background.js', `extensions/${version}/background.js`),
    build("__content_script", 'src/extension/content_script.js', `extensions/${version}/content_script.js`, copyFiles, "src/extension/**/*"),
  );
}

export default builds;
