# WebGPU Inspector — Claude Code plugin

Capture and analyze WebGPU frames from a live browser page, directly from
Claude Code. The plugin can drive Chrome itself and instrument **any page** —
no browser extension, and no changes to the page being analyzed.

It builds on the WebGPU Inspector
[local capture API](../docs/manual_injection.md#local-capture-api). Normal inspector usage —
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

The plugin is published through this repository, which doubles as a Claude Code
plugin marketplace ([../.claude-plugin/marketplace.json](../.claude-plugin/marketplace.json)).
The bridge server's dependencies are vendored, so there is **no `npm install`
step** — install and go.

**Install with the `claude` CLI (recommended — works everywhere).** It writes
the shared settings that both the terminal CLI and the VS Code / JetBrains
extensions read. From any terminal:

```sh
claude plugin marketplace add brendan-duncan/webgpu_inspector
claude plugin install webgpu-inspector@webgpu-inspector-plugins
```

`webgpu-inspector` is the plugin name; `webgpu-inspector-plugins` is the
marketplace name. The first argument to `marketplace add` is the GitHub
`owner/repo` (Claude Code reads `.claude-plugin/marketplace.json` from the repo
root); a full git URL or a local checkout path works too. Add `--scope project`
to install into the repo's `.claude/settings.json`, or `--scope local` for the
gitignored `.claude/settings.local.json`.

**Or from inside Claude Code:**
- Terminal CLI: run `/plugin marketplace add brendan-duncan/webgpu_inspector`,
  then `/plugin install webgpu-inspector@webgpu-inspector-plugins`.
- VS Code / JetBrains extension: `/plugin` is not available there — type
  `/plugins` (plural) to open the Manage Plugins dialog, add
  `brendan-duncan/webgpu_inspector` as a marketplace, and install
  `webgpu-inspector`.

Claude Code starts the bundled MCP server automatically from
[.mcp.json](.mcp.json) once the plugin is enabled. Run `/reload-plugins` after
editing the plugin to pick up changes without restarting.

To load the plugin for a single session without installing it (handy while
developing), launch the terminal CLI with
`claude --plugin-dir /path/to/webgpu_inspector/claude-plugin`. This flag is
terminal-CLI only — the editor extensions do not support it.

Requires Node.js 18+ and a local Chrome or Edge install.

## Update

Updates are **not** automatic by default. When a new version is released, pull
it in two steps — refresh the marketplace catalog, then update the plugin:

```sh
claude plugin marketplace update webgpu-inspector-plugins
claude plugin update webgpu-inspector@webgpu-inspector-plugins
```

`claude plugin update` on its own updates every installed plugin. The same
commands work as `/plugin marketplace update …` and `/plugin update …` inside
the terminal CLI; in the VS Code / JetBrains extension, use the `/plugins`
dialog. After an update, run `/reload-plugins` (or restart) to load it.

### Update the Plugin

Updates are **not** automatic by default. When a new version is released, pull
it in two steps — refresh the marketplace catalog, then update the plugin:

```sh
claude plugin marketplace update webgpu-inspector-plugins
claude plugin update webgpu-inspector@webgpu-inspector-plugins
```

Then run `/reload-plugins` (or restart) to load it. To get updates
automatically, open `/plugin` (terminal CLI) or `/plugins` (extension), go to
the **Marketplaces** tab, select `webgpu-inspector-plugins`, and enable
**auto-update**. Check your installed version with `claude plugin list`.

#### Automatic Updates

Auto-updating has to be enabled manually for plugins installed this way.
Edit **~/.claud/settings.json**
Look for **"webgpu-inspector-plugins"**
add **"autoUpdates": true**
after the "source" block,

```json
"webgpu-inspector-plugins": {
  "source": {
    "source": "github",
    "repo": "brendan-duncan/webgpu_inspector"
  },
  "autoUpdate": true
}
```

You can check your installed version anytime with `claude plugin list`.

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

The marketplace catalog lives at the repo root in
[../.claude-plugin/marketplace.json](../.claude-plugin/marketplace.json); this
directory is the plugin itself:

```
claude-plugin/
  .claude-plugin/plugin.json       plugin manifest
  .mcp.json                        registers the bundled MCP server
  commands/                        /webgpu-inspector:capture, :analyze
  skills/                          webgpu-capture-analysis
  server/                          bridge + MCP + CDP controller (Node)
  page/                            manual-instrumentation example
```

## Releasing a new version (maintainers)

Users only receive an update when the plugin's `version` changes, so a release
is: **bump the version, then push.** Claude Code treats `version` as an opaque
string — it doesn't have to be semver, it just has to differ from the published
one for clients to see a new version.

1. **Bump the version** in [.claude-plugin/plugin.json](.claude-plugin/plugin.json)
   — e.g. `"version": "0.1.0"` → `"0.2.0"`. This is the single source of truth;
   without bumping it, users who already installed keep their cached copy even
   after you push.
2. **Re-vendor dependencies if they changed.** If you touched
   `server/package.json`, run `npm install` in `server/`, then confirm the new
   files are staged (`git status` — the vendored tree is committed, see
   [Layout](#layout)). Skip this if only plugin/command/skill/server source
   changed.
3. **Update the [CHANGELOG](../CHANGELOG.md)** with what changed.
4. **Commit and push to the default branch** (`main`). The marketplace `source`
   is a path in this same repo, so `claude plugin marketplace update` does a
   `git pull` of `main` and re-resolves the plugin from there — no separate
   marketplace repo or release artifact to publish.
5. **(Optional) tag the release**: `git tag plugin-v0.2.0 && git push --tags`.

Existing users then pick it up with the commands in [Update](#update) (or
automatically if they enabled auto-update). New users always get the latest on
install. Verify locally before pushing with
`claude --plugin-dir /path/to/webgpu_inspector/claude-plugin`.

## Limitations (v1)

- Immediate capture relies on `requestAnimationFrame`; a page with no rAF loop
  falls back to a single immediate begin/end capture.
- Dedicated Workers are separate CDP targets and are not auto-instrumented yet;
  the main page and its frames are.
- The bridge binds one fixed port — a second concurrent Claude Code session
  can't host the bridge, though its file-based tools still work.
- Intended for local development: the bridge listens on localhost only.
