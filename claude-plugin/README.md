# WebGPU Inspector — Claude Code plugin

Capture and analyze WebGPU frames from a live browser page, directly from
Claude Code. The plugin can drive Chrome itself and instrument **any page** —
no browser extension, and no changes to the page being analyzed.

It builds on the WebGPU Inspector
[local capture API](../README.md#local-capture-api). Normal inspector usage —
the file-download capture workflow — is unaffected.

## How it works

```
Claude Code ──stdio (MCP)──► bridge process ──CDP──► Chrome
                                  ▲                    │ injects the inspector
                                  └──localhost WS+HTTP──┘ into every page
```

The bridge process (in [server/](server/)) runs three things at once:

- an **MCP server** over stdio — the tools Claude calls;
- a **localhost HTTP + WebSocket bridge** on port `9690` — instrumented pages
  connect here and upload captures;
- a **CDP browser controller** — launches or attaches to Chrome and injects
  the WebGPU Inspector into every page before any page script runs (using
  `Page.addScriptToEvaluateOnNewDocument`, plus `Page.setBypassCSP` so the page
  can reach the localhost bridge even under a strict Content-Security-Policy).

Each instrumented page connects back to the bridge, records the next frame(s)
on request, and uploads the result. The upload is the same schema as **Save
Capture** in the DevTools Capture panel, so captures also open there with
**Load Capture**.

## Install

1. Install the bridge server's dependencies:

   ```sh
   cd claude-plugin/server
   npm install
   ```

2. Add the plugin to Claude Code. This `claude-plugin/` directory is a
   self-contained local plugin marketplace
   ([.claude-plugin/marketplace.json](.claude-plugin/marketplace.json)), so it
   installs straight from your checkout — no remote marketplace required.

   **Install with the `claude` CLI (recommended — works everywhere).** It
   writes the shared settings that both the terminal CLI and the VS Code /
   JetBrains extensions read. From any terminal:

   ```sh
   claude plugin marketplace add /path/to/webgpu_inspector/claude-plugin
   claude plugin install webgpu-inspector@webgpu-inspector-plugins
   ```

   `webgpu-inspector` is the plugin name; `webgpu-inspector-plugins` is the
   marketplace name. The marketplace argument is an absolute path (or a path
   relative to your terminal's working directory) to this `claude-plugin/`
   directory. Add `--scope project` to install into the repo's
   `.claude/settings.json`, or `--scope local` for the gitignored
   `.claude/settings.local.json`.

   **Or from inside Claude Code:**
   - Terminal CLI: run `/plugin marketplace add <path>`, then
     `/plugin install webgpu-inspector@webgpu-inspector-plugins`.
   - VS Code / JetBrains extension: `/plugin` is not available there — type
     `/plugins` (plural) to open the Manage Plugins dialog, add this
     `claude-plugin/` directory as a marketplace, and install
     `webgpu-inspector`.

   Claude Code starts the bundled MCP server automatically from
   [.mcp.json](.mcp.json) once the plugin is enabled. Run `/reload-plugins`
   after editing the plugin to pick up changes without restarting.

   To load the plugin for a single session without installing it (handy while
   developing), launch the terminal CLI with
   `claude --plugin-dir /path/to/webgpu_inspector/claude-plugin`. This flag is
   terminal-CLI only — the editor extensions do not support it.

Requires Node.js 18+ and a local Chrome or Edge install.

## Use it

The plugin instruments pages for you. Two ways in:

- **Launch a fresh browser** — the plugin starts Chrome and every page it opens
  is instrumented automatically. Ask Claude to "launch a browser and open
  `<url>`", or run `/webgpu-inspector:capture <url>`.
- **Attach to your browser** — start Chrome with
  `--remote-debugging-port=9222`, then ask Claude to attach. New tabs and
  navigations are instrumented automatically.

Then:

- `/webgpu-inspector:capture [url or frames]` — capture frame(s) and summarize.
- `/webgpu-inspector:analyze [capture id or file path]` — analyze a capture in
  depth for performance and correctness issues.

Or just ask in plain language ("launch a browser, open my WebGPU app, and tell
me why the frame is slow"). The bundled `webgpu-capture-analysis` skill guides
the interpretation.

### Manual instrumentation (optional)

A page can still opt into the bridge itself, without the plugin driving the
browser — load `webgpu_inspector.js` before any WebGPU code and call
`webgpuInspector.initializeServer({ name: "my-app" })`. See
[page/example.html](page/example.html). This is a fallback; the CDP path above
needs no page changes.

## MCP tools

| Tool | Purpose |
| --- | --- |
| `launch_browser` | Launch Chrome/Edge controlled by the plugin |
| `attach_browser` | Attach to a Chrome started with `--remote-debugging-port` |
| `open_page` | Open a new instrumented tab at a URL |
| `browser_status` | Browser connection + instrumented targets |
| `list_pages` | Pages connected to the bridge |
| `capture_frames` | Capture N frames from a page, return a summary |
| `list_captures` | Captures available to analyze |
| `load_capture_file` | Ingest a saved capture `.json` file |
| `get_capture_summary` | Counts, stats, shaders, validation errors, issues |
| `get_commands` | Paginated, base64-stripped command list |
| `get_object` | One GPU object's descriptor |
| `get_shader` | A ShaderModule's WGSL source |
| `get_validation_errors` | Validation errors from the capture |

Tools never return raw base64 texture/buffer blobs — captures can be many
megabytes. They return summaries, paginated slices, and counts instead.

## Configuration

The MCP server reads these environment variables (set them in [.mcp.json](.mcp.json)):

- `WEBGPU_BRIDGE_PORT` — bridge port (default `9690`).
- `WEBGPU_BRIDGE_HOST` — bind address (default `127.0.0.1`).
- `WEBGPU_BRIDGE_TOKEN` — if set, instrumented pages must present it.
- `WEBGPU_BRIDGE_CAPTURES_DIR` — where uploaded captures are written (default
  `<plugin>/captures`).
- `WEBGPU_BRIDGE_CHROME` — path to the Chrome/Edge binary for `launch_browser`
  (auto-detected if unset).
- `WEBGPU_INSPECTOR_SCRIPT` — path or URL of the `webgpu_inspector.js` to
  inject (defaults to the locally built copy, falling back to the CDN).

## Layout

```
claude-plugin/
  .claude-plugin/plugin.json       plugin manifest
  .claude-plugin/marketplace.json  local marketplace entry (for install)
  .mcp.json                        registers the bundled MCP server
  commands/                        /webgpu-inspector:capture, :analyze
  skills/                          webgpu-capture-analysis
  server/                          bridge + MCP + CDP controller (Node)
  page/                            manual-instrumentation example
```

## Limitations (v1)

- Immediate capture relies on `requestAnimationFrame`; a page with no rAF loop
  falls back to a single immediate begin/end capture.
- Dedicated Workers are separate CDP targets and are not auto-instrumented yet;
  the main page and its frames are.
- The bridge binds one fixed port — a second concurrent Claude Code session
  can't host the bridge, though its file-based tools still work.
- Intended for local development: the bridge listens on localhost only.
