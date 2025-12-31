document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById("webgpu_canvas");
    if (!canvas) {
        console.error('[Worker Loader] Canvas not found');
        return;
    }

    if (!navigator.gpu) {
        console.error('[Worker Loader] WebGPU not supported');
        return;
    }

    const offscreenCanvas = canvas.transferControlToOffscreen();
    
    // Try different approaches to create the worker URL
    let workerUrl;
    try {
        // Try using import.meta.url first
        const url = new URL('./assets/webgpu_worker.js', import.meta.url);
        workerUrl = url.href;
        console.log('[Worker Loader] Using import.meta.url:', workerUrl);
    } catch (e) {
        console.warn('[Worker Loader] import.meta.url failed, using relative path:', e);
        // Fallback to relative path
        workerUrl = './assets/webgpu_worker.js';
    }

    console.log('[Worker Loader] Creating worker with URL:', workerUrl);
    
    try {
        const worker = new Worker(workerUrl, { type: 'module' });
        
        worker.addEventListener('error', (error) => {
            console.error('[Worker Loader] Worker error:', error);
        });
        
        worker.addEventListener('message', (event) => {
            console.log('[Worker Loader] Worker message:', event.data);
        });

        const devicePixelRatio = window.devicePixelRatio;
        offscreenCanvas.width = canvas.clientWidth * devicePixelRatio;
        offscreenCanvas.height = canvas.clientHeight * devicePixelRatio;
        
        console.log('[Worker Loader] Initializing worker with canvas:', {
            width: offscreenCanvas.width,
            height: offscreenCanvas.height,
            devicePixelRatio
        });
        
        worker.postMessage({ type: 'init', offscreenCanvas }, [offscreenCanvas]);
        
    } catch (error) {
        console.error('[Worker Loader] Failed to create worker:', error);
        // Try alternative approach
        try {
            console.log('[Worker Loader] Trying alternative worker creation...');
            const worker = new Worker(workerUrl);
            const devicePixelRatio = window.devicePixelRatio;
            offscreenCanvas.width = canvas.clientWidth * devicePixelRatio;
            offscreenCanvas.height = canvas.clientHeight * devicePixelRatio;
            worker.postMessage({ type: 'init', offscreenCanvas }, [offscreenCanvas]);
        } catch (altError) {
            console.error('[Worker Loader] Alternative worker creation also failed:', altError);
        }
    }
});
