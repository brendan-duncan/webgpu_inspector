# WebGPU Inspector: Iframe Worker Communication Fix

## Problem
The WebGPU Inspector failed to capture WebGPU calls from workers running inside iframes. Workers would create WebGPU contexts and the inspector would inject correctly, but the communication chain would break at the iframe boundary, preventing messages from reaching the devtools panel.

## Root Cause
The message flow in the original implementation worked correctly for:
- Main page workers ✅ 
- Iframe WebGPU calls ✅
- Cross-origin iframes (graceful degradation) ✅

But failed for:
- Workers inside same-origin iframes ❌

The issue was a message forwarding gap: When a worker inside an iframe generated WebGPU inspector messages, they would reach the iframe's window context but weren't forwarded to the parent page where devtools communication occurs.

## Solution

### 1. Enhanced Message Tagging
Updated `_postMessage` method in `src/webgpu_inspector.js` to include iframe context detection:
```javascript
// Check if we're in an iframe context and tag message accordingly
if (_window && _window.parent && _window.parent !== _window) {
  try {
    if (_window.parent.location) {
      message.__webgpuInspectorFrame = true;
      message.__webgpuInspectorFrameOrigin = _window.location.origin;
    }
  } catch (e) {
    // Cross-origin iframe
    message.__webgpuInspectorFrame = true;
    message.__webgpuInspectorFrameOrigin = 'cross-origin';
  }
}
```

### 2. Iframe Message Forwarding Bridge
Added message forwarding logic in the inspector initialization to detect iframe contexts and forward worker messages to parent:
```javascript
if (_window && _window.parent && _window.parent !== _window) {
  try {
    const parentAccessible = _window.parent.location !== null;
    
    if (parentAccessible) {
      // Listen for messages from workers in this iframe and forward them to parent
      _window.addEventListener("__WebGPUInspector", (event) => {
        const detail = event.detail || event.data;
        
        if (detail && detail.__webgpuInspector && !detail.__webgpuInspectorPage) {
          if (detail.__webgpuInspectorWorker || detail.__webgpuInspectorFrame) {
            // Forward to parent page
            const forwardedMessage = {
              ...detail,
              __webgpuInspectorIframe: true,
              __webgpuInspectorIframeOrigin: _window.location.origin
            };
            
            _window.parent.dispatchEvent(new CustomEvent("__WebGPUInspector", {
              detail: forwardedMessage
            }));
          }
        }
      });
    }
  } catch (e) {
    // Cross-origin iframe - gracefully disable forwarding
  }
}
```

### 3. Worker Message Tagging
Updated Worker proxy to properly tag messages from workers:
```javascript
if (message.__webgpuInspector) {
  // Tag this message as coming from a worker to enable proper forwarding
  message.__webgpuInspectorWorker = true;
  window.dispatchEvent(new CustomEvent("__WebGPUInspector", { detail: message }));
}
```

## Test Files

### 1. Main Test: `test/iframe_worker_test.html`
Comprehensive test page that demonstrates:
- Main page worker (control test - should work)
- Same-origin iframe with worker (fixed by this change)
- Cross-origin iframe (gracefully fails as expected)
- Real-time message logging and status reporting

### 2. Iframe Content: `test/iframe_worker_content.html`
Iframe page containing WebGPU worker with detailed status reporting and message forwarding to parent.

## Key Changes Summary

**Files Modified:**
- `src/webgpu_inspector.js` - Core message forwarding logic
  - Lines 313-344: Added iframe message forwarding bridge
  - Lines 433-460: Enhanced message context tagging
  - Lines 2499-2503: Worker message tagging

**Files Added:**
- `test/iframe_worker_test.html` - Comprehensive test suite
- `test/iframe_worker_content.html` - Iframe content with worker

## Message Flow (After Fix)

```
Worker (in iframe) 
    ↓ (WebGPU calls)
Iframe Window (inspector injected)
    ↓ (forwarded via __WebGPUInspector event)
Parent Page Window (inspector active)
    ↓ (via chrome extension APIs)
DevTools Panel
```

## Compatibility

- **Same-origin iframes**: Full functionality enabled
- **Cross-origin iframes**: Gracefully degrades (existing behavior preserved)
- **Nested iframes**: Supports multiple levels (each iframe forwards to its parent)
- **Workers in main page**: No change in existing functionality

## Testing

To test the fix:
1. Build the project: `npm run build`
2. Load the Chrome extension or Firefox extension
3. Open `test/iframe_worker_test.html` in a browser with WebGPU support
4. Open DevTools and navigate to WebGPU Inspector panel
5. Start workers in different contexts
6. Verify that all WebGPU calls appear in the inspector, including from the iframe worker

## Future Enhancements

Potential improvements:
1. **Message deduplication**: Prevent forwarding duplicate messages
2. **Performance monitoring**: Track message forwarding overhead
3. **Error handling**: Better error recovery for forwarding failures
4. **Configuration**: Option to disable iframe inspection when not needed