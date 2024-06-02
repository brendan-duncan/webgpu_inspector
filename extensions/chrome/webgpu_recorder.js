!function(e){const t=self.postMessage,r=self.dispatchEvent,o=self.document;function s(e,t){try{const r=document.createElement('a');r.href=URL.createObjectURL(new Blob([e],{type:'text/html'})),r.download=t,document.body.appendChild(r),r.click(),document.body.removeChild(r)}catch(e){}}class n{constructor(e){if(e=e||{},this.config={maxFrameCount:Math.max((e.frames??100)-1,1),exportName:e.export||'WebGPURecord',canvasWidth:e.width||800,canvasHeight:e.height||600,removeUnusedResources:!!e.removeUnusedResources,messageRecording:!!e.messageRecording,download:e.download??!0},this._objectIndex=1,this._initalized=!1,this._initializeCommandObjects=[],this._frameCommandObjects=[],this._currentFrameCommandObjects=null,this._initializeCommands=[],this._frameCommands=[],this._frameObjects=[],this._initializeObjects=[],this._currentFrameCommands=null,this._currentFrameObjects=null,this.__frameObjects=[],this.__initializeObjects=[],this.__currentFrameObjects=null,this._frameIndex=-1,this._isRecording=!1,this._frameVariables={},this._arrayCache=[],this._totalData=0,this._isRecording=!0,this._initalized=!0,this._frameVariables[-1]=new Set,this._adapter=null,this._unusedTextures=new Set,this._unusedTextureViews=new Map,this._unusedBuffers=new Set,this._dataCacheObjects=[],this._externalImageBufferPromises=[],!navigator.gpu)return;this._gpuWrapper=new i(this),this._gpuWrapper.onPromiseResolve=this._onAsyncResolve.bind(this),this._gpuWrapper.onPreCall=this._preMethodCall.bind(this),this._gpuWrapper.onPostCall=this._onMethodCall.bind(this),this._registerObject(navigator.gpu),this._recordLine(`${this._getObjectVariable(navigator.gpu)} = navigator.gpu;`,null),this._wrapCanvases();const t=this;if(o){const e=document.createElement;o.createElement=r=>{const s=e.call(o,r);return'canvas'===r&&t._wrapCanvas(s),s}}const r=requestAnimationFrame;requestAnimationFrame=e=>r((function(r){t._frameStart(r);const o=e(r);o instanceof Promise?Promise.all([o]).then((()=>{t._frameEnd(r)})):t._frameEnd(r)}))}getNextId(){return this._objectIndex++}_frameStart(){this._frameIndex++,this._frameVariables[this._frameIndex]=new Set,this._currentFrameCommands=[],this._frameCommands.push(this._currentFrameCommands),this._currentFrameObjects=[],this._frameObjects.push(this._currentFrameObjects),this.__currentFrameObjects=[],this.__frameObjects.push(this.__currentFrameObjects),this._currentFrameCommandObjects=[],this._frameCommandObjects.push(this._currentFrameCommandObjects)}_frameEnd(){this._frameIndex===this.config.maxFrameCount&&this.generateOutput()}_removeUnusedCommands(e,t,r,o){for(let s=e.length-1;s>=0;--s){const n=e[s];n&&(r.has(n.__id)&&(t[s]=o))}}generateOutput(){const e=new Set;if(this._isRecording=!1,this.config.removeUnusedResources){for(const t of this._unusedTextures)e.add(t);for(const[t,r]of this._unusedTextureViews)e.add(t);for(const t of this._unusedBuffers)e.add(t);this._removeUnusedCommands(this._initializeObjects,this._initializeCommands,e,''),this._removeUnusedCommands(this.__initializeObjects,this._initializeCommandObjects,e,null)}if(this._initializeCommands=this._initializeCommands.filter((e=>!!e)),this.config.removeUnusedResources)for(const t of e)for(let e=0,r=this._dataCacheObjects.length;e<r;++e){let r=this._dataCacheObjects[e];if(r){for(let e=r.length-1;e>=0;--e)r[e].__id===t&&r.splice(e,1);0===r.length&&(this._arrayCache[e].length=0,this._arrayCache[e].type='Uint8Array',this._arrayCache[e].array=new Uint8Array(0))}}let t=`\n    <!DOCTYPE html>\n    <html>\n        <body style="text-align: center;">\n            <canvas id="#webgpu" width=${this.config.canvasWidth} height=${this.config.canvasHeight}></canvas>\n            <script>\n    let D = new Array(${this._arrayCache.length});\n    async function main() {\n      await loadData();\n\n      let canvas = document.getElementById("#webgpu");\n      let context = canvas.getContext("webgpu");\n      let frameLabel = document.createElement("div");\n      frameLabel.style = "position: absolute; top: 10px; left: 10px; font-size: 24pt; color: #f00;";\n      document.body.append(frameLabel);\n      ${this._getVariableDeclarations(-1)}\n      ${this._initializeCommands.join('\n  ')}\n`;for(let r=0,o=this._frameCommands.length;r<o;++r)this.config.removeUnusedResources&&(this._removeUnusedCommands(this._frameObjects[r],this._frameCommands[r],e,''),this._removeUnusedCommands(this.__frameObjects[r],this._frameCommandObjects[r],e,null),this._frameCommands[r]=this._frameCommands[r].filter((e=>!!e))),t+=`\n      async function f${r}() {\n          ${this._getVariableDeclarations(r)}\n          ${this._frameCommands[r].join('\n  ')}\n      }\n`;t+='    let frames=[';for(let e=0,r=this._frameCommands.length;e<r;++e)t+=`f${e},`;t+='];',t+=`\n        let frame = 0;\n        let lastFrame = -1;\n        let t0 = performance.now();\n        async function renderFrame() {\n            if (frame > ${this._frameCommands.length-1}) return;\n            requestAnimationFrame(renderFrame);\n            if (frame == lastFrame) return;\n            lastFrame = frame;\n            let t1 = performance.now();\n            frameLabel.innerText = "F: " + (frame + 1) + "  T:" + (t1 - t0).toFixed(2);\n            t0 = t1;\n            try {\n                await frames[frame]();\n            } catch (err) {\n                console.log("Error Frame:", frame);\n                console.error(err.message);\n            }\n            frame++;\n        }\n        requestAnimationFrame(renderFrame);\n    }\n    \n    function setCanvasSize(canvas, width, height) {\n        if (canvas.width !== width || canvas.height !== height) {\n            canvas.width = width;\n            canvas.height = height;\n        }\n    }\n    \n    async function B64ToA(s, type, length) {\n        const res = await fetch(s);\n        const x = new Uint8Array(await res.arrayBuffer());\n        if (type == "Uint32Array") {\n            return new Uint32Array(x.buffer, 0, x.length/4);\n        }\n        return new Uint8Array(x.buffer, 0, x.length);\n    }\n    \n    async function loadData() {\n`,this._encodedData=[];const r=this;Promise.all(this._externalImageBufferPromises).then((()=>{r._externalImageBufferPromises.length=0;const e=[];for(let o=0;o<r._arrayCache.length;++o){const s=r._arrayCache[o];e.push(new Promise((e=>{r._encodeDataUrl(s.array).then((n=>{r._encodedData[o]=n,t+=`D[${o}] = await B64ToA("${n}", "${s.type}", ${s.length});\n`,e()}))})))}Promise.all(e).then((()=>{t+='\n        }\n        main();\n                <\/script>\n            </body>\n        </html>\n',r._downloadFile(t,(r.config.exportName||'WebGpuRecord')+'.html')}))}))}async _encodeDataUrl(e,t='application/octet-stream'){const r=new Uint8Array(e.buffer,e.byteOffset,e.byteLength);return await new Promise(((e,o)=>{const s=Object.assign(new FileReader,{onload:()=>e(s.result),onerror:()=>o(s.error)});s.readAsDataURL(new File([r],'',{type:t}))}))}_dispatchEvent(e){e.__webgpuRecorder=!0,e.__webgpuRecorderPage=!0,e.__webgpuRecorderWorker=!o,o?r(new CustomEvent('__WebGPURecorder',{detail:e})):t(e)}_downloadFile(e,r){if(this.config.download&&(o?s(e,r):t({type:'webgpu_record_download',data:e,filename:r})),this.config.messageRecording){this._initializeCommandObjects=this._initializeCommandObjects.filter((e=>!!e));let e=this._initializeCommandObjects.length;for(let t=0;t<this._frameCommandObjects.length;++t)this._frameCommandObjects[t]=this._frameCommandObjects[t].filter((e=>!!e)),e+=this._frameCommandObjects[t].length;this._dispatchEvent({action:'webgpu_record_data_count',count:this._arrayCache.length});let t=0,r=-1;const o='webgpu_record_command';for(let s=0;s<this._initializeCommandObjects.length;++s){const n=this._initializeCommandObjects[s];this._dispatchEvent({action:o,command:n,commandIndex:s,frame:r,index:t,count:e}),t++}for(r=0;r<this._frameCommandObjects.length;++r){const s=this._frameCommandObjects[r];for(let n=0;n<s.length;++n){const i=s[n];this._dispatchEvent({action:o,command:i,commandIndex:n,frame:r,index:t,count:e}),t++}}{const e=this._arrayCache.length,t='webgpu_record_data';for(let r=0;r<e;++r){const o=this._arrayCache[r],s=o.length,n=o.type,i=this._encodedData[r];this._dispatchEvent({action:t,data:i,type:n,size:s,index:r,count:e})}}}this._encodedData.length=0}_wrapCanvas(e){if(e.__id)return;this._registerObject(e);let t=this,r=e.getContext;e.getContext=(o,s)=>{let n=r.call(e,o,s);return'webgpu'===o&&n&&t._wrapContext(n),n}}_wrapCanvases(){if(o){const e=o.getElementsByTagName('canvas');for(let t=0;t<e.length;++t){const r=e[t];this._wrapCanvas(r)}}}_registerObject(e){const t=this.getNextId(e);e.__id=t,e.__frame=this._frameIndex}_isFrameVariable(e,t){return this._frameVariables[e]&&this._frameVariables[e].has(t)}_removeVariable(e){for(const t in this._frameVariables){this._frameVariables[t].delete(e)}}_addVariable(e,t){this._frameVariables[e].add(t)}_getVariableDeclarations(e){const t=this._frameVariables[e];return t.size?`let ${[...t].join(',')};`:''}_getObjectVariable(e){if(!e)return;if(e instanceof GPUCanvasContext)return'context';void 0===e.__id&&this._registerObject(e);const t=`x${e.constructor.name.replace(/^GPU/,'')}${e.__id||0}`;return this._frameIndex!=e.__frame?this._isFrameVariable(-1,t)||(this._removeVariable(t),this._addVariable(-1,t)):this._addVariable(this._frameIndex,t),t}_wrapContext(e){this._recordLine(`${this._getObjectVariable(e)} = canvas.getContext("webgpu");`,null)}_onAsyncResolve(e,t,r,o,s){if('requestDevice'===t){const t=e;void 0===t.__id&&this._recordCommand(!0,navigator.gpu,'requestAdapter',t,[]),s.queue.__device=s}this._recordCommand(!0,e,t,s,r)}_preMethodCall(e,t,r){if(this._isRecording)if('unmap'===t){if(e.__mappedRanges){for(const t of e.__mappedRanges){const r=this._getDataCache(t,0,t.byteLength,t);this._recordLine(`new Uint8Array(${this._getObjectVariable(t)}).set(D[${r}]);`,e),this._recordCommand('',t,'__writeData',null,[r],!0)}delete e.__mappedRanges}}else'getCurrentTexture'===t?(this._recordLine(`setCanvasSize(${this._getObjectVariable(e)}.canvas, ${e.canvas.width}, ${e.canvas.height})`,null),this._recordCommand('',e,'__setCanvasSize',null,[e.canvas.width,e.canvas.height],!0)):'createTexture'===t&&(r[0].usage|=GPUTextureUsage.COPY_SRC)}_onMethodCall(e,t,r,o){if(this._isRecording){if('copyExternalImageToTexture'===t){const o=e,s=r[1].texture,i=s.format,a=n._formatInfo[i],c=a?a.bytesPerBlock:4,d=r[0].source.width*c+255&-256,h=r[0].source.height,p=d*h,u=r[2];this._gpuWrapper.skipRecord++;const l=o.__device,b=l.createBuffer({size:p,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),_=l.createCommandEncoder();_.copyTextureToBuffer({texture:r[1].texture},{buffer:b,bytesPerRow:d,rowsPerImage:h},u),o.submit([_.finish()]),this._gpuWrapper.skipRecord--;let m=-1;try{const n=new Uint8Array(p);m=this._getDataCache(n,0,p,s,!1),this._recordLine(`${this._getObjectVariable(o)}.writeTexture(${this._stringifyObject(t,r[1])}, D[${m}], {bytesPerRow:${d}}, ${this._stringifyObject(t,u)});`,e),this._recordCommand(!1,o,'__writeTexture',null,[r[1],{__data:m},{bytesPerRow:d},u],!0)}catch(e){console.error(e.message)}const g=this,f=new Promise((e=>{g._gpuWrapper.skipRecord++,b.mapAsync(GPUMapMode.READ).then((()=>{const t=b.getMappedRange(),r=new Uint8Array(t);g._replaceDataCache(m,r,0,r.length),e()})),this._gpuWrapper.skipRecord--}));this._externalImageBufferPromises.push(f)}else this._recordCommand(!1,e,t,o,r);'getMappedRange'===t?(e.__mappedRanges||(e.__mappedRanges=[]),e.__mappedRanges.push(o)):'submit'===t&&this._recordLine('',null)}}_stringifyObject(e,t,r){let o='',s=!0;for(const n in t){let i=t[n];if(!n.startsWith('_')&&(!(i instanceof Function)&&void 0!==i)){if(s||(o+=','),s=!1,o+=`"${n}":`,'requestDevice'===e){if('requiredFeatures'===n){o+='requiredFeatures';continue}if('requiredLimits'===n){o+='requiredLimits';continue}}if('createBindGroup'===e){if('resource'===n&&this._unusedTextureViews.has(i.__id)){const e=this._unusedTextureViews.get(i.__id);this._unusedTextures.delete(e)}}else if('beginRenderPass'===e&&'colorAttachments'===n)for(const e of i)if(e.view){const t=e.view;if(this._unusedTextureViews.has(t.__id)){const e=this._unusedTextureViews.get(t.__id);this._unusedTextures.delete(e),this._unusedTextureViews.delete(t.__id)}}null===i?o+='null':'string'==typeof i?o+=r||'createShaderModule'!==e?JSON.stringify(i):`\`${i}\``:void 0!==i.__id?o+=r?`{ "__id":"${this._getObjectVariable(i)}" }`:this._getObjectVariable(i):void 0!==i.__data?o+=r?`{ "__data": ${i.__data} }`:`D[${i.__data}]`:i.constructor===Array?o+=this._stringifyArray(i,r):o+='object'==typeof i?this._stringifyObject(e,i,r):`${i}`}}return o=`{${o}}`,o}_stringifyArray(e,t){let r='[';return r+=this._stringifyArgs('',e,t),r+=']',r}_heapAccessShiftForWebGPUHeap(e){return e.BYTES_PER_ELEMENT?31-Math.clz32(e.BYTES_PER_ELEMENT):0}_replaceDataCache(e,t,r,o){const s=(t.byteOffset??0)+((r??0)<<this._heapAccessShiftForWebGPUHeap(t)),n=void 0===o?t.byteLength:o<<this._heapAccessShiftForWebGPUHeap(t);this._totalData+=n;const i=new Uint8Array(t.buffer??t,s,n),a=Uint8Array.from(i);this._arrayCache[e]={length:n,type:'ArrayBuffer'===t.constructor?Uint8Array:t.constructor.name,array:a}}_compareCacheData(e,t){if(e.length!=t.length)return!1;for(let r=0,o=e.length;r<o;++r)if(e[r]!=t[r])return!1;return!0}_getDataCache(e,t,r,o,s){let n=this,i=-1;if(s){i=n._arrayCache.length;const t=e;n._arrayCache.push({length:r,type:'ArrayBuffer'===e.constructor?Uint8Array:e.constructor.name,array:t})}else{const o=(e.byteOffset??0)+((t??0)<<this._heapAccessShiftForWebGPUHeap(e)),s=void 0===r?e.byteLength:r<<this._heapAccessShiftForWebGPUHeap(e);this._totalData+=s;const a=new Uint8Array(e.buffer??e,o,s);for(let e=0;e<n._arrayCache.length;++e){if(n._arrayCache[e].length===r&&this._compareCacheData(this._arrayCache[e].array,a)){i=e;break}}if(-1===i){i=n._arrayCache.length;const t=Uint8Array.from(a);n._arrayCache.push({length:s,type:'ArrayBuffer'===e.constructor?Uint8Array:e.constructor.name,array:t})}}return o&&(this._dataCacheObjects[i]||(this._dataCacheObjects[i]=[]),this._dataCacheObjects[i].push(o)),i}_processArgs(e,t){if(t=[...t],'writeBuffer'===e){const e=t[2],r=t[3],o=t[4],s=this._getDataCache(e,r,o,e);t[2]={__data:s},t[3]=0}else if('writeTexture'===e){const e=t[0].texture,r=t[1],o=t[2].bytesPerRow,s=t[3].width||t[3][0],{blockWidth:i,blockHeight:a,bytesPerBlock:c}=n._formatInfo[e.format],d=s/i,h=(t[2].rowsPerImage||(t[3].height||t[3][1]||1)/a)*(t[3].depthOrArrayLayers||t[3][2]||1),p=h>0?o*(h-1)+d*c:0,u=t[2].offset,l=this._getDataCache(new Uint8Array(r.buffer||r,r.byteOffset,r.byteLength),u,p,e);t[1]={__data:l},t[2]={offset:0,bytesPerRow:t[2].bytesPerRow,rowsPerImage:t[2].rowsPerImage}}else if('setBindGroup'===e){if(5===t.length){const e=t[2],r=t[3],o=t[4],s=this._getDataCache(e,r,o,e);t[2]={__data:s},t.length=3}else if(3===t.length&&t[2]?.length){const e=t[2],r=this._getDataCache(e,0,e.length,e);t[2]={__data:r},t.length=3}}else if('createBindGroup'===e){if(t[0].entries){const e=t[0].entries;for(const t of e){const e=t.resource;if(e&&e.__id){if(this._unusedTextureViews.has(e.__id)){const t=this._unusedTextureViews.get(e.__id);this._unusedTextures.delete(t)}}else if(e&&e.buffer){const t=e.buffer;this._unusedBuffers.has(t.__id)&&this._unusedBuffers.delete(t.__id)}}}}else if('copyBufferToTexture'===e){const e=t[0].buffer;this._unusedBuffers.delete(e.__id);const r=t[1].texture;this._unusedTextures.delete(r.__id)}else if('copyTextureToBuffer'===e){const e=t[0].texture;this._unusedTextures.delete(e.__id);const r=t[1].buffer;this._unusedBuffers.delete(r.__id)}else if('copyBufferToBuffer'===e)this._unusedBuffers.delete(t[0].__id),this._unusedBuffers.delete(t[2].__id);else if('setVertexBuffer'===e){const e=t[1];this._unusedBuffers.delete(e.__id)}else if('setIndexBuffer'===e){const e=t[0];this._unusedBuffers.delete(e.__id)}else if('beginRenderPass'===e){if(t[0].colorAttachments){const e=t[0].colorAttachments;for(const t of e)if(t.view){const e=t.view;if(this._unusedTextureViews.has(e.__id)){const t=this._unusedTextureViews.get(e.__id);this._unusedTextures.delete(t),this._unusedTextureViews.delete(e.__id)}}}if(t[0].depthStencilAttachment){const e=t[0].depthStencilAttachment;if(e.view){const t=e.view;if(this._unusedTextureViews.has(t.__id)){const e=this._unusedTextureViews.get(t.__id);this._unusedTextures.delete(e),this._unusedTextureViews.delete(t.__id)}}}}return t}_stringifyArgs(e,t,r){if(0===t.length||1===t.length&&void 0===t[0])return'';t=this._processArgs(e,t);const o=[];for(const s of t)void 0===s?r||o.push('undefined'):null===s?o.push('null'):void 0!==s.__data?r?o.push(`{ "__data": ${s.__data} }`):o.push(`D[${s.__data}]`):s.__id?r?o.push(`{ "__id": "${this._getObjectVariable(s)}" }`):o.push(this._getObjectVariable(s)):s.constructor===Array?o.push(this._stringifyArray(s,r)):'object'==typeof s?o.push(this._stringifyObject(e,s,r)):'string'==typeof s?r||'createShaderModule'!==e?o.push(JSON.stringify(s)):o.push(`\`${s}\``):o.push(s);return o.join()}_recordLine(e,t){this._isRecording&&(-1===this._frameIndex?(this._initializeCommands.push(e),this._initializeObjects.push(t)):(this._currentFrameCommands.push(e),this._currentFrameObjects.push(t)))}_recordCommand(e,t,r,o,s,n){if(!this._isRecording)return;if(o){if('string'==typeof o)return;void 0===o.__id&&this._registerObject(o)}e=e?'await ':'';let i=t;const a=!!this._adapter;a||'requestAdapter'!==r?'createTexture'===r?(this._unusedTextures.add(o.__id),i=o):'createView'===r?this._unusedTextureViews.set(o.__id,t.__id):'writeTexture'===r?i=s[0].texture:'createBuffer'===r?(this._unusedBuffers.add(o.__id),i=o):'writeBuffer'===r&&(i=s[0]):this._adapter=o;const c=`[${this._stringifyArgs(r,s,!0)}]`,d={object:this._getObjectVariable(t),method:r,result:this._getObjectVariable(o),args:c,async:e};if(-1===this._frameIndex?(this._initializeCommandObjects.push(d),this.__initializeObjects.push(i)):(this._currentFrameCommandObjects.push(d),this.__currentFrameObjects.push(i)),!n){if('beginRenderPass'!==r&&'beginComputePass'!==r||this._recordLine('\n',null),o?this._recordLine(`${this._getObjectVariable(o)} = ${e}${this._getObjectVariable(t)}.${r}(${this._stringifyArgs(r,s)});`,i):this._recordLine(`${e}${this._getObjectVariable(t)}.${r}(${this._stringifyArgs(r,s)});`,i),'end'===r&&this._recordLine('\n',null),!a&&'requestAdapter'===r){const e=this._getObjectVariable(o);this._recordLine(`const requiredFeatures = [];\n        for (const x of ${e}.features) {\n            requiredFeatures.push(x);\n        }`,i),this._recordLine(`const requiredLimits = {};\n        const exclude = new Set(["minSubgroupSize", "maxSubgroupSize"]);\n        for (const x in ${e}.limits) {\n          if (!exclude.has(x)) {\n            requiredLimits[x] = ${e}.limits[x];\n          }\n        }`,i)}if(o instanceof GPUDevice){const e=o.queue;if(void 0===e.__id){const t=this._getObjectVariable(e);this._recordLine(`${t} = ${this._getObjectVariable(o)}.queue;`,o),this._recordCommand('',o,'__getQueue',e,[],!0)}}}}}n._asyncMethods=new Set(['requestAdapter','requestDevice','createComputePipelineAsync','createRenderPipelineAsync','mapAsync']),n._skipMethods=new Set(['toString','entries','getContext','forEach','has','keys','values','getPreferredFormat','requestAdapterInfo','pushErrorScope','popErrorScope']),n._formatInfo={r8unorm:{blockWidth:1,blockHeight:1,bytesPerBlock:1},r8snorm:{blockWidth:1,blockHeight:1,bytesPerBlock:1},r8uint:{blockWidth:1,blockHeight:1,bytesPerBlock:1},r8sint:{blockWidth:1,blockHeight:1,bytesPerBlock:1},rg8unorm:{blockWidth:1,blockHeight:1,bytesPerBlock:2},rg8snorm:{blockWidth:1,blockHeight:1,bytesPerBlock:2},rg8uint:{blockWidth:1,blockHeight:1,bytesPerBlock:2},rg8sint:{blockWidth:1,blockHeight:1,bytesPerBlock:2},rgba8unorm:{blockWidth:1,blockHeight:1,bytesPerBlock:4},'rgba8unorm-srgb':{blockWidth:1,blockHeight:1,bytesPerBlock:4},rgba8snorm:{blockWidth:1,blockHeight:1,bytesPerBlock:4},rgba8uint:{blockWidth:1,blockHeight:1,bytesPerBlock:4},rgba8sint:{blockWidth:1,blockHeight:1,bytesPerBlock:4},bgra8unorm:{blockWidth:1,blockHeight:1,bytesPerBlock:4},'bgra8unorm-srgb':{blockWidth:1,blockHeight:1,bytesPerBlock:4},r16uint:{blockWidth:1,blockHeight:1,bytesPerBlock:2},r16sint:{blockWidth:1,blockHeight:1,bytesPerBlock:2},r16float:{blockWidth:1,blockHeight:1,bytesPerBlock:2},rg16uint:{blockWidth:1,blockHeight:1,bytesPerBlock:4},rg16sint:{blockWidth:1,blockHeight:1,bytesPerBlock:4},rg16float:{blockWidth:1,blockHeight:1,bytesPerBlock:4},rgba16uint:{blockWidth:1,blockHeight:1,bytesPerBlock:8},rgba16sint:{blockWidth:1,blockHeight:1,bytesPerBlock:8},rgba16float:{blockWidth:1,blockHeight:1,bytesPerBlock:8},r32uint:{blockWidth:1,blockHeight:1,bytesPerBlock:4},r32sint:{blockWidth:1,blockHeight:1,bytesPerBlock:4},r32float:{blockWidth:1,blockHeight:1,bytesPerBlock:4},rg32uint:{blockWidth:1,blockHeight:1,bytesPerBlock:8},rg32sint:{blockWidth:1,blockHeight:1,bytesPerBlock:8},rg32float:{blockWidth:1,blockHeight:1,bytesPerBlock:8},rgba32uint:{blockWidth:1,blockHeight:1,bytesPerBlock:16},rgba32sint:{blockWidth:1,blockHeight:1,bytesPerBlock:16},rgba32float:{blockWidth:1,blockHeight:1,bytesPerBlock:16},rgb10a2unorm:{blockWidth:1,blockHeight:1,bytesPerBlock:4},rg11b10ufloat:{blockWidth:1,blockHeight:1,bytesPerBlock:4},rgb9e5ufloat:{blockWidth:1,blockHeight:1,bytesPerBlock:4},stencil8:{blockWidth:1,blockHeight:1,bytesPerBlock:1},depth16unorm:{blockWidth:1,blockHeight:1,bytesPerBlock:2},depth32float:{blockWidth:1,blockHeight:1,bytesPerBlock:4},depth24plus:{blockWidth:1,blockHeight:1},'depth24plus-stencil8':{blockWidth:1,blockHeight:1},'depth32float-stencil8':{blockWidth:1,blockHeight:1},'bc1-rgba-unorm':{blockWidth:4,blockHeight:4,bytesPerBlock:8},'bc1-rgba-unorm-srgb':{blockWidth:4,blockHeight:4,bytesPerBlock:8},'bc2-rgba-unorm':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'bc2-rgba-unorm-srgb':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'bc3-rgba-unorm':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'bc3-rgba-unorm-srgb':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'bc4-r-unorm':{blockWidth:4,blockHeight:4,bytesPerBlock:8},'bc4-r-snorm':{blockWidth:4,blockHeight:4,bytesPerBlock:8},'bc5-rg-unorm':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'bc5-rg-snorm':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'bc6h-rgb-ufloat':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'bc6h-rgb-float':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'bc7-rgba-unorm':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'bc7-rgba-unorm-srgb':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'etc2-rgb8unorm':{blockWidth:4,blockHeight:4,bytesPerBlock:8},'etc2-rgb8unorm-srgb':{blockWidth:4,blockHeight:4,bytesPerBlock:8},'etc2-rgb8a1unorm':{blockWidth:4,blockHeight:4,bytesPerBlock:8},'etc2-rgb8a1unorm-srgb':{blockWidth:4,blockHeight:4,bytesPerBlock:8},'etc2-rgba8unorm':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'etc2-rgba8unorm-srgb':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'eac-r11unorm':{blockWidth:4,blockHeight:4,bytesPerBlock:8},'eac-r11snorm':{blockWidth:4,blockHeight:4,bytesPerBlock:8},'eac-rg11unorm':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'eac-rg11snorm':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'astc-4x4-unorm':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'astc-4x4-unorm-srgb':{blockWidth:4,blockHeight:4,bytesPerBlock:16},'astc-5x4-unorm':{blockWidth:5,blockHeight:4,bytesPerBlock:16},'astc-5x4-unorm-srgb':{blockWidth:5,blockHeight:4,bytesPerBlock:16},'astc-5x5-unorm':{blockWidth:5,blockHeight:5,bytesPerBlock:16},'astc-5x5-unorm-srgb':{blockWidth:5,blockHeight:5,bytesPerBlock:16},'astc-6x5-unorm':{blockWidth:6,blockHeight:5,bytesPerBlock:16},'astc-6x5-unorm-srgb':{blockWidth:6,blockHeight:5,bytesPerBlock:16},'astc-6x6-unorm':{blockWidth:6,blockHeight:6,bytesPerBlock:16},'astc-6x6-unorm-srgb':{blockWidth:6,blockHeight:6,bytesPerBlock:16},'astc-8x5-unorm':{blockWidth:8,blockHeight:5,bytesPerBlock:16},'astc-8x5-unorm-srgb':{blockWidth:8,blockHeight:5,bytesPerBlock:16},'astc-8x6-unorm':{blockWidth:8,blockHeight:6,bytesPerBlock:16},'astc-8x6-unorm-srgb':{blockWidth:8,blockHeight:6,bytesPerBlock:16},'astc-8x8-unorm':{blockWidth:8,blockHeight:8,bytesPerBlock:16},'astc-8x8-unorm-srgb':{blockWidth:8,blockHeight:8,bytesPerBlock:16},'astc-10x5-unorm':{blockWidth:10,blockHeight:5,bytesPerBlock:16},'astc-10x5-unorm-srgb':{blockWidth:10,blockHeight:5,bytesPerBlock:16},'astc-10x6-unorm':{blockWidth:10,blockHeight:6,bytesPerBlock:16},'astc-10x6-unorm-srgb':{blockWidth:10,blockHeight:6,bytesPerBlock:16},'astc-10x8-unorm':{blockWidth:10,blockHeight:8,bytesPerBlock:16},'astc-10x8-unorm-srgb':{blockWidth:10,blockHeight:8,bytesPerBlock:16},'astc-10x10-unorm':{blockWidth:10,blockHeight:10,bytesPerBlock:16},'astc-10x10-unorm-srgb':{blockWidth:10,blockHeight:10,bytesPerBlock:16},'astc-12x10-unorm':{blockWidth:12,blockHeight:10,bytesPerBlock:16},'astc-12x10-unorm-srgb':{blockWidth:12,blockHeight:10,bytesPerBlock:16},'astc-12x12-unorm':{blockWidth:12,blockHeight:12,bytesPerBlock:16},'astc-12x12-unorm-srgb':{blockWidth:12,blockHeight:12,bytesPerBlock:16}},new Set([GPUAdapter,GPUDevice,GPUBuffer,GPUTexture,GPUTextureView,GPUExternalTexture,GPUSampler,GPUBindGroupLayout,GPUBindGroup,GPUPipelineLayout,GPUShaderModule,GPUComputePipeline,GPURenderPipeline,GPUCommandBuffer,GPUCommandEncoder,GPUComputePassEncoder,GPURenderPassEncoder,GPURenderBundle,GPUQueue,GPUQuerySet,GPUCanvasContext]);class i{constructor(e){this._idGenerator=e,this.onPreCall=null,this.onPostCall=null,this.onPromise=null,this.onPromiseResolve=null,this.skipRecord=0,this._wrapGPUTypes()}_wrapGPUTypes(){GPU.prototype.requestAdapter=this._wrapMethod('requestAdapter',GPU.prototype.requestAdapter),GPU.prototype.getPreferredFormat=this._wrapMethod('getPreferredFormat',GPU.prototype.getPreferredFormat),GPUAdapter.prototype.requestDevice=this._wrapMethod('requestDevice',GPUAdapter.prototype.requestDevice),GPUDevice.prototype.destroy=this._wrapMethod('destroy',GPUDevice.prototype.destroy),GPUDevice.prototype.createBuffer=this._wrapMethod('createBuffer',GPUDevice.prototype.createBuffer),GPUDevice.prototype.createTexture=this._wrapMethod('createTexture',GPUDevice.prototype.createTexture),GPUDevice.prototype.createSampler=this._wrapMethod('createSampler',GPUDevice.prototype.createSampler),GPUDevice.prototype.importExternalTexture=this._wrapMethod('importExternalTexture',GPUDevice.prototype.importExternalTexture),GPUDevice.prototype.createBindGroupLayout=this._wrapMethod('createBindGroupLayout',GPUDevice.prototype.createBindGroupLayout),GPUDevice.prototype.createPipelineLayout=this._wrapMethod('createPipelineLayout',GPUDevice.prototype.createPipelineLayout),GPUDevice.prototype.createBindGroup=this._wrapMethod('createBindGroup',GPUDevice.prototype.createBindGroup),GPUDevice.prototype.createShaderModule=this._wrapMethod('createShaderModule',GPUDevice.prototype.createShaderModule),GPUDevice.prototype.createComputePipeline=this._wrapMethod('createComputePipeline',GPUDevice.prototype.createComputePipeline),GPUDevice.prototype.createRenderPipeline=this._wrapMethod('createRenderPipeline',GPUDevice.prototype.createRenderPipeline),GPUDevice.prototype.createComputePipelineAsync=this._wrapMethod('createComputePipelineAsync',GPUDevice.prototype.createComputePipelineAsync),GPUDevice.prototype.createRenderPipelineAsync=this._wrapMethod('createRenderPipelineAsync',GPUDevice.prototype.createRenderPipelineAsync),GPUDevice.prototype.createCommandEncoder=this._wrapMethod('createCommandEncoder',GPUDevice.prototype.createCommandEncoder),GPUDevice.prototype.createRenderBundleEncoder=this._wrapMethod('createRenderBundleEncoder',GPUDevice.prototype.createRenderBundleEncoder),GPUDevice.prototype.createQuerySet=this._wrapMethod('createQuerySet',GPUDevice.prototype.createQuerySet),GPUBuffer.prototype.mapAsync=this._wrapMethod('mapAsync',GPUBuffer.prototype.mapAsync),GPUBuffer.prototype.getMappedRange=this._wrapMethod('getMappedRange',GPUBuffer.prototype.getMappedRange),GPUBuffer.prototype.unmap=this._wrapMethod('unmap',GPUBuffer.prototype.unmap),GPUBuffer.prototype.destroy=this._wrapMethod('destroy',GPUBuffer.prototype.destroy),GPUTexture.prototype.createView=this._wrapMethod('createView',GPUTexture.prototype.createView),GPUTexture.prototype.destroy=this._wrapMethod('destroy',GPUTexture.prototype.destroy),GPUShaderModule.prototype.getCompilationInfo=this._wrapMethod('getCompilationInfo',GPUShaderModule.prototype.getCompilationInfo),GPUComputePipeline.prototype.getBindGroupLayout=this._wrapMethod('getBindGroupLayout',GPUComputePipeline.prototype.getBindGroupLayout),GPURenderPipeline.prototype.getBindGroupLayout=this._wrapMethod('getBindGroupLayout',GPURenderPipeline.prototype.getBindGroupLayout),GPUCommandEncoder.prototype.beginRenderPass=this._wrapMethod('beginRenderPass',GPUCommandEncoder.prototype.beginRenderPass),GPUCommandEncoder.prototype.beginComputePass=this._wrapMethod('beginComputePass',GPUCommandEncoder.prototype.beginComputePass),GPUCommandEncoder.prototype.copyBufferToBuffer=this._wrapMethod('copyBufferToBuffer',GPUCommandEncoder.prototype.copyBufferToBuffer),GPUCommandEncoder.prototype.copyBufferToTexture=this._wrapMethod('copyBufferToTexture',GPUCommandEncoder.prototype.copyBufferToTexture),GPUCommandEncoder.prototype.copyTextureToBuffer=this._wrapMethod('copyTextureToBuffer',GPUCommandEncoder.prototype.copyTextureToBuffer),GPUCommandEncoder.prototype.copyTextureToTexture=this._wrapMethod('copyTextureToTexture',GPUCommandEncoder.prototype.copyTextureToTexture),GPUCommandEncoder.prototype.clearBuffer=this._wrapMethod('clearBuffer',GPUCommandEncoder.prototype.clearBuffer),GPUCommandEncoder.prototype.resolveQuerySet=this._wrapMethod('resolveQuerySet',GPUCommandEncoder.prototype.resolveQuerySet),GPUCommandEncoder.prototype.finish=this._wrapMethod('finish',GPUCommandEncoder.prototype.finish),GPUCommandEncoder.prototype.pushDebugGroup=this._wrapMethod('pushDebugGroup',GPUCommandEncoder.prototype.pushDebugGroup),GPUCommandEncoder.prototype.popDebugGroup=this._wrapMethod('popDebugGroup',GPUCommandEncoder.prototype.popDebugGroup),GPUCommandEncoder.prototype.insertDebugMarker=this._wrapMethod('insertDebugMarker',GPUCommandEncoder.prototype.insertDebugMarker),GPUComputePassEncoder.prototype.setPipeline=this._wrapMethod('setPipeline',GPUComputePassEncoder.prototype.setPipeline),GPUComputePassEncoder.prototype.dispatchWorkgroups=this._wrapMethod('dispatchWorkgroups',GPUComputePassEncoder.prototype.dispatchWorkgroups),GPUComputePassEncoder.prototype.dispatchWorkgroupsIndirect=this._wrapMethod('dispatchWorkgroupsIndirect',GPUComputePassEncoder.prototype.dispatchWorkgroupsIndirect),GPUComputePassEncoder.prototype.end=this._wrapMethod('end',GPUComputePassEncoder.prototype.end),GPUComputePassEncoder.prototype.setBindGroup=this._wrapMethod('setBindGroup',GPUComputePassEncoder.prototype.setBindGroup),GPUComputePassEncoder.prototype.setBindGroup=this._wrapMethod('setBindGroup',GPUComputePassEncoder.prototype.setBindGroup),GPUComputePassEncoder.prototype.pushDebugGroup=this._wrapMethod('pushDebugGroup',GPUComputePassEncoder.prototype.pushDebugGroup),GPUComputePassEncoder.prototype.popDebugGroup=this._wrapMethod('popDebugGroup',GPUComputePassEncoder.prototype.popDebugGroup),GPUComputePassEncoder.prototype.insertDebugMarker=this._wrapMethod('insertDebugMarker',GPUComputePassEncoder.prototype.insertDebugMarker),GPURenderPassEncoder.prototype.setViewport=this._wrapMethod('setViewport',GPURenderPassEncoder.prototype.setViewport),GPURenderPassEncoder.prototype.setScissorRect=this._wrapMethod('setScissorRect',GPURenderPassEncoder.prototype.setScissorRect),GPURenderPassEncoder.prototype.setBlendConstant=this._wrapMethod('setBlendConstant',GPURenderPassEncoder.prototype.setBlendConstant),GPURenderPassEncoder.prototype.setStencilReference=this._wrapMethod('setStencilReference',GPURenderPassEncoder.prototype.setStencilReference),GPURenderPassEncoder.prototype.beginOcclusionQuery=this._wrapMethod('beginOcclusionQuery',GPURenderPassEncoder.prototype.beginOcclusionQuery),GPURenderPassEncoder.prototype.endOcclusionQuery=this._wrapMethod('endOcclusionQuery',GPURenderPassEncoder.prototype.endOcclusionQuery),GPURenderPassEncoder.prototype.executeBundles=this._wrapMethod('executeBundles',GPURenderPassEncoder.prototype.executeBundles),GPURenderPassEncoder.prototype.end=this._wrapMethod('end',GPURenderPassEncoder.prototype.end),GPURenderPassEncoder.prototype.setPipeline=this._wrapMethod('setPipeline',GPURenderPassEncoder.prototype.setPipeline),GPURenderPassEncoder.prototype.setIndexBuffer=this._wrapMethod('setIndexBuffer',GPURenderPassEncoder.prototype.setIndexBuffer),GPURenderPassEncoder.prototype.setVertexBuffer=this._wrapMethod('setVertexBuffer',GPURenderPassEncoder.prototype.setVertexBuffer),GPURenderPassEncoder.prototype.draw=this._wrapMethod('draw',GPURenderPassEncoder.prototype.draw),GPURenderPassEncoder.prototype.drawIndexed=this._wrapMethod('drawIndexed',GPURenderPassEncoder.prototype.drawIndexed),GPURenderPassEncoder.prototype.drawIndirect=this._wrapMethod('drawIndirect',GPURenderPassEncoder.prototype.drawIndirect),GPURenderPassEncoder.prototype.drawIndexedIndirect=this._wrapMethod('drawIndexedIndirect',GPURenderPassEncoder.prototype.drawIndexedIndirect),GPURenderPassEncoder.prototype.setBindGroup=this._wrapMethod('setBindGroup',GPURenderPassEncoder.prototype.setBindGroup),GPURenderPassEncoder.prototype.pushDebugGroup=this._wrapMethod('pushDebugGroup',GPURenderPassEncoder.prototype.pushDebugGroup),GPURenderPassEncoder.prototype.popDebugGroup=this._wrapMethod('popDebugGroup',GPURenderPassEncoder.prototype.popDebugGroup),GPURenderPassEncoder.prototype.insertDebugMarker=this._wrapMethod('insertDebugMarker',GPURenderPassEncoder.prototype.insertDebugMarker),GPUQueue.prototype.submit=this._wrapMethod('submit',GPUQueue.prototype.submit),GPUQueue.prototype.writeBuffer=this._wrapMethod('writeBuffer',GPUQueue.prototype.writeBuffer),GPUQueue.prototype.writeTexture=this._wrapMethod('writeTexture',GPUQueue.prototype.writeTexture),GPUQueue.prototype.copyExternalImageToTexture=this._wrapMethod('copyExternalImageToTexture',GPUQueue.prototype.copyExternalImageToTexture),GPUQuerySet.prototype.destroy=this._wrapMethod('destroy',GPUQuerySet.prototype.destroy),GPUCanvasContext.prototype.configure=this._wrapMethod('configure',GPUCanvasContext.prototype.configure),GPUCanvasContext.prototype.unconfigure=this._wrapMethod('unconfigure',GPUCanvasContext.prototype.unconfigure),GPUCanvasContext.prototype.getCurrentTexture=this._wrapMethod('getCurrentTexture',GPUCanvasContext.prototype.getCurrentTexture),GPURenderBundleEncoder.prototype.draw=this._wrapMethod('draw',GPURenderBundleEncoder.prototype.draw),GPURenderBundleEncoder.prototype.drawIndexed=this._wrapMethod('drawIndexed',GPURenderBundleEncoder.prototype.drawIndexed),GPURenderBundleEncoder.prototype.drawIndirect=this._wrapMethod('drawIndirect',GPURenderBundleEncoder.prototype.drawIndirect),GPURenderBundleEncoder.prototype.drawIndexedIndirect=this._wrapMethod('drawIndexedIndirect',GPURenderBundleEncoder.prototype.drawIndexedIndirect),GPURenderBundleEncoder.prototype.finish=this._wrapMethod('finish',GPURenderBundleEncoder.prototype.finish),GPURenderBundleEncoder.prototype.insertDebugMarker=this._wrapMethod('insertDebugMarker',GPURenderBundleEncoder.prototype.insertDebugMarker),GPURenderBundleEncoder.prototype.popDebugGroup=this._wrapMethod('popDebugGroup',GPURenderBundleEncoder.prototype.popDebugGroup),GPURenderBundleEncoder.prototype.pushDebugGroup=this._wrapMethod('pushDebugGroup',GPURenderBundleEncoder.prototype.pushDebugGroup),GPURenderBundleEncoder.prototype.setBindGroup=this._wrapMethod('setBindGroup',GPURenderBundleEncoder.prototype.setBindGroup),GPURenderBundleEncoder.prototype.setIndexBuffer=this._wrapMethod('setIndexBuffer',GPURenderBundleEncoder.prototype.setIndexBuffer),GPURenderBundleEncoder.prototype.setPipeline=this._wrapMethod('setPipeline',GPURenderBundleEncoder.prototype.setPipeline),GPURenderBundleEncoder.prototype.setVertexBuffer=this._wrapMethod('setVertexBuffer',GPURenderBundleEncoder.prototype.setVertexBuffer)}_wrapMethod(e,t){const r=this;return function(){const o=this,s=[...arguments];0===r.skipRecord&&r.onPreCall&&r.onPreCall(o,e,s);const n=t.call(o,...s);if(0===r.skipRecord){if(n instanceof Promise){const t=r._idGenerator.getNextId(o);r.onPromise&&r.onPromise(o,e,s,t);const i=n,a=new Promise((n=>{i.then((i=>{r.onPromiseResolve&&r.onPromiseResolve(o,e,s,t,i),n(i)}))}));return a}r.onPostCall&&r.onPostCall(o,e,s,n)}return n}}}let a='<%=_webgpuHostAddress%>',c='<%=_webgpuBaseAddress%>';const d=URL;function h(e){if(a.startsWith('<%='))return e;if(e?.constructor===String){if(e.startsWith('http://')||e.startsWith('https://')||e.startsWith('ws://')||e.startsWith('wss://')||e.startsWith('blob:')||e.startsWith('data:'))return e;try{if(new d(e).protocol)return e}catch(e){}return e.startsWith('/')?`${a}/${e}`:`${c}/${e}`}return e}const p=fetch;self.fetch=(e,t)=>{let r=e instanceof Request?e.url:e;return r=h(r),p(r,t)},URL=new Proxy(URL,{construct:(e,t,r)=>(t.length>0&&(t[0]=h(t[0])),new e(...t))}),WebSocket=new Proxy(WebSocket,{construct:(e,t,r)=>(t.length>0&&(t[0]=h(t[0])),new e(...t))}),Request=new Proxy(Request,{construct:(e,t,r)=>(t.length>0&&(t[0]=h(t[0])),new e(...t))}),Worker=new Proxy(Worker,{construct(e,t,r){let o=`self.__webgpu_src = ${self.__webgpu_src.toString()};self.__webgpu_src();`;const n=t[0],i=new d(n);a=`${i.protocol}//${i.host}`;const h=i.pathname.substring(0,i.pathname.lastIndexOf('/'));if(c=`${a}${h}`,o=o.replaceAll('<%=_webgpuHostAddress%>',`${a}`),o=o.replaceAll('<%=_webgpuBaseAddress%>',`${c}`),self._webgpu_recorder_init){const e=self._webgpu_recorder_init.filename,t=self._webgpu_recorder_init.frames,r=self._webgpu_recorder_init.messageRecording,s=self._webgpu_recorder_init.removeUnusedResources,n=self._webgpu_recorder_init.download,i={frames:t||1,export:e,removeUnusedResources:!!s,messageRecording:!!r,download:null===n||'false'!==n&&('true'===n||n)};o=o.replaceAll('<%=webgpuRecorderConfig%>',JSON.stringify(i))}t.length>1&&'module'===t[1].type?o+=`import ${JSON.stringify(t[0])};`:o+=`importScripts(${JSON.stringify(t[0])});`;let p=new Blob([o]);p=p.slice(0,p.size,'text/javascript'),t[0]=URL.createObjectURL(p);const u=new e(...t);return u.__webgpuRecorder=!0,window.addEventListener('__WebGPURecorder',(e=>{u.__webgpuRecorder&&e.detail.__webgpuRecorder&&!e.detail.__webgpuRecorderPage&&u.postMessage(e.detail)})),u.addEventListener('message',(e=>{'webgpu_record_download'===e.data.type?s(e.data.data,e.data.filename):e.data.__webgpuRecorder&&window.dispatchEvent(new CustomEvent('__WebGPURecorder',{detail:e.data}))})),new Proxy(u,{get:(e,t,r)=>'addEventListener'===t?function(){if('message'===arguments[0]){const e=arguments[1];arguments[1]=function(){arguments[0].data.__webGPURecorder||e(...arguments)}}return e.addEventListener(...arguments)}:'terminate'===t?function(){const t=e.terminate(...arguments);return e.__WebGPURecorder=!1,t}:t in e?'function'==typeof e[t]?e[t].bind(e):e[t]:void 0,set:(e,t,r,o)=>(e[t]=r,!0)})}}),e.__webgpuRecorder=null,(()=>{let t=null;const r='<%=webgpuRecorderConfig%>';if(!r.startsWith('<%='))try{t=JSON.parse(r)}catch(e){}if(!t&&null!=o){const e=o.getElementById('__webgpu_recorder');if(e){initialized=!0;const r=e.getAttribute('filename'),o=e.getAttribute('frames'),s=e.getAttribute('messageRecording'),n=e.getAttribute('removeUnusedResources'),i=e.getAttribute('download');t={frames:o||1,export:r,removeUnusedResources:!!n,messageRecording:!!s,download:null===i||'false'!==i&&('true'===i||i)}}}!t&&self._webgpu_recorder_init&&(t=self._webgpu_recorder_init),t&&(e.__webgpuRecorder=new n(t))})(),e.WebGPURecorder=n,e.webgpu_recorder_download_data=s,Object.defineProperty(e,'__esModule',{value:!0})}({});
//# sourceMappingURL=webgpu_recorder.js.map
