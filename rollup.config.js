import { readFileSync } from 'node:fs';
import * as path from "node:path";
import { nodeResolve } from "@rollup/plugin-node-resolve";
import { terser } from "rollup-plugin-terser";
import copy from "rollup-plugin-copy";
import fg from 'fast-glob';
import { SourceMapConsumer, SourceNode } from 'source-map'

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
          if (id === "webgpu_inspector_core_func") {
            return id;
          }
        },
        async load(id) {
          if (id === "webgpu_inspector_core_func") {
            const corePath = path.join(dst, 'webgpu_inspector_core.js');

            this.addWatchFile(corePath);
            this.addWatchFile(corePath + ".map");

            let code = readFileSync(corePath, 'utf-8');
            let codeMap = JSON.parse(readFileSync(corePath + ".map", 'utf-8'));

            const consumer = await new SourceMapConsumer(codeMap);
            const originalSrc = SourceNode.fromStringWithSourceMap(code, consumer);

            const srcPath = "src/webgpu_inspector_core_func";

            const newSrc = new SourceNode(1, 1, srcPath, [
              new SourceNode(1, 1, srcPath,  "export default function() { "),
              originalSrc,
              new SourceNode(1, 36, srcPath, " };")
            ]);

            newSrc.setSourceContent(srcPath, "export default function() { ${code} };");

            const generated = newSrc.toStringWithSourceMap({ file: srcPath });

            return {
              code: generated.code,
              map: JSON.parse(generated.map.toString()),
            };
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
