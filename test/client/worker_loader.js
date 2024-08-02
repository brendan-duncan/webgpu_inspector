const canvas = document.getElementById("webgpu_canvas");
const offscreenCanvas = canvas.transferControlToOffscreen();

//const url = new URL('./assets/webgpu_worker.js', import.meta.url);
//console.log(url.href);
const worker = new Worker('/test/client/assets/webgpu_worker.js', { type: 'module' });
//const worker = new Worker('assets/webgpu_worker.js', { type: 'module' });
//const worker = new Worker(url.href, { type: 'module' });
//const worker = new Worker(url, { type: 'module' });

const devicePixelRatio = window.devicePixelRatio;
offscreenCanvas.width = canvas.clientWidth * devicePixelRatio;
offscreenCanvas.height = canvas.clientHeight * devicePixelRatio;
worker.postMessage({ type: 'init', offscreenCanvas }, [offscreenCanvas]);
