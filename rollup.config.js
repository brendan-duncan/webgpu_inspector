import { readFileSync } from 'node:fs';
import * as path from "node:path";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { terser } from "rollup-plugin-terser";
import copy from "rollup-plugin-copy";
import fg from 'fast-glob';

function build(name, input, dst, file, copyFiles, watchInclude) {
  const format = "iife";
  const info = {
    input,
    output: {
      format,
      file: path.join(dst, file),
      sourcemap: true,
      name
    },
    plugins: [
      {
        name: "stringer",
        resolveId(id, importer) {
          if (id === "webgpu_inspector_core_string") {
            return id;
          }
        },
        load(id) {
          if (id === "webgpu_inspector_core_string") {
            const corePath = path.join(dst, 'webgpu_inspector_core.js');
            const code = readFileSync(corePath, 'utf-8');
            this.addWatchFile(corePath);
            return `export default ${JSON.stringify(code)};`
          }
        }
      },
      nodeResolve(),
      terser({
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
      })
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
        for (const file of files) {
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
    build("__webgpu_inspector_core", 'src/webgpu_inspector_core.js', `extensions/${version}`, 'webgpu_inspector_core.js'),
    build("__webgpu_inspector", 'src/webgpu_inspector.js', `extensions/${version}`, '/webgpu_inspector.js'),
    build("__webgpu_inspector_worker", 'src/webgpu_inspector_worker.js', `extensions/${version}`, '/webgpu_inspector_worker.js'),
    build("__webgpu_recorder", 'webgpu_recorder/webgpu_recorder.js', `extensions/${version}`, '/webgpu_recorder.js'),
    build("__webgpu_inspector_window", 'src/devtools/inspector_window.js', `extensions/${version}`, '/webgpu_inspector_window.js'),
    build("__background", 'src/extension/background.js', `extensions/${version}`, '/background.js'),
    build("__content_script", 'src/extension/content_script.js', `extensions/${version}`, 'content_script.js', copyFiles, "src/extension/**/*"),
  );
}

export default builds;
