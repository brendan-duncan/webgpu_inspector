---
description: Capture WebGPU frames from a page and report what they contain
argument-hint: [url and/or frame count]
---

Capture and summarize WebGPU frames from a page.

`$ARGUMENTS` may contain a URL to open, a frame count, or both (default 1 frame).

Do this:

1. Call `browser_status`. If no browser is connected:
   - If `$ARGUMENTS` has a URL, call `launch_browser` with it.
   - Otherwise tell the user you can `launch_browser` (the plugin starts Chrome)
     or `attach_browser` (to a Chrome started with `--remote-debugging-port=9222`),
     and ask which — or ask for a URL to open.
2. If a browser is connected but `$ARGUMENTS` has a URL, call `open_page` with it.
3. Call `list_pages`. If none are connected, the page may not use WebGPU, or it
   created GPU objects before finishing load — say so and stop. If exactly one
   page is connected, use it; if several, ask which `pageId`.
4. Call `capture_frames` with that page and the requested frame count.
5. Report the returned summary in plain language: total commands, draw calls,
   dispatches, render/compute passes, object counts, validation errors, and
   every entry in `issues`.
6. Offer to dig deeper — shaders (`get_shader`), specific commands
   (`get_commands`), object descriptors (`get_object`), validation errors.
