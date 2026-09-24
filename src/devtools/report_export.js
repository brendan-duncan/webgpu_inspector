/**
 * Export a report view (Frame Issues, Render Graph, Timing, ...) as a
 * standalone HTML snapshot that can be attached to a bug or shared: the
 * view's DOM as it is on screen, with the panel's stylesheet inlined, canvases
 * replaced by PNG images, and form controls showing their current values.
 * The snapshot is static: links and buttons don't do anything.
 */

// Rules from the panel's stylesheets, for the snapshot to look like the panel.
function collectCss(doc) {
    const parts = [];
    for (const sheet of doc.styleSheets) {
        let rules;
        try {
            rules = sheet.cssRules;
        } catch (e) {
            continue; // cross-origin sheet
        }
        for (const rule of rules) {
            parts.push(rule.cssText);
        }
    }
    return parts.join("\n");
}

// A canvas as a PNG data URL. A WebGPU canvas may already have been
// presented, which leaves nothing to read back; the canvas's own
// __exportSnapshot hook (if the view set one) redraws it first.
function canvasImage(canvas) {
    try {
        canvas.__exportSnapshot?.();
        return canvas.toDataURL("image/png");
    } catch (e) {
        return null;
    }
}

function escapeHtml(text) {
    return String(text).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;" })[c]);
}

/**
 * Build the snapshot's HTML.
 * @param {HTMLElement} root - the report view's element
 * @param {Object} [options]
 * @param {string} [options.title]
 * @param {string} [options.subtitle] - e.g. the page the capture came from
 * @returns {string}
 */
export function reportToHtml(root, { title = "WebGPU Inspector report", subtitle = "" } = {}) {
    const doc = root.ownerDocument;
    const clone = root.cloneNode(true);

    // Canvases don't carry their pixels through cloneNode; swap in images.
    const sourceCanvases = root.querySelectorAll("canvas");
    const cloneCanvases = clone.querySelectorAll("canvas");
    sourceCanvases.forEach((canvas, i) => {
        const target = cloneCanvases[i];
        const url = canvas.width && canvas.height ? canvasImage(canvas) : null;
        const rect = canvas.getBoundingClientRect();
        const img = doc.createElement("img");
        img.setAttribute("style", canvas.getAttribute("style") ?? "");
        if (rect.width) {
            img.style.width = `${rect.width}px`;
            img.style.height = `${rect.height}px`;
        }
        img.className = canvas.className;
        if (url) {
            img.src = url;
        } else {
            img.alt = "(image not available)";
        }
        target.replaceWith(img);
    });

    // Form controls keep their live values only as properties; write them out.
    const sourceInputs = root.querySelectorAll("input, select, textarea");
    const cloneInputs = clone.querySelectorAll("input, select, textarea");
    sourceInputs.forEach((input, i) => {
        const target = cloneInputs[i];
        if (input.tagName === "SELECT") {
            [...target.options].forEach((option, j) => {
                if (j === input.selectedIndex) {
                    option.setAttribute("selected", "");
                } else {
                    option.removeAttribute("selected");
                }
            });
        } else if (input.type === "checkbox" || input.type === "radio") {
            if (input.checked) {
                target.setAttribute("checked", "");
            } else {
                target.removeAttribute("checked");
            }
        } else if (input.tagName === "TEXTAREA") {
            target.textContent = input.value;
        } else {
            target.setAttribute("value", input.value);
        }
        target.setAttribute("disabled", "");
    });

    // Elements hidden by a collapsed section or an inactive tab stay as they
    // are; the snapshot shows what was on screen.
    const css = collectCss(doc);
    const date = new Date().toLocaleString();
    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${escapeHtml(title)}</title>
<style>
${css}
</style>
<style>
html, body { height: auto; overflow: auto; }
body { margin: 0; background: #1e1e1e; color: #e0e0e0; font-family: var(--font-family, sans-serif); }
.report-export-header { padding: 10px 12px; border-bottom: 1px solid #3c3c3c; background: #252526; }
.report-export-title { font-size: 13pt; font-weight: bold; }
.report-export-meta { font-size: 9pt; color: #a0a0a0; margin-top: 2px; }
.report-export-body > * { height: auto !important; max-height: none !important; overflow: visible !important; }
.report-export-body button, .report-export-body input, .report-export-body select { pointer-events: none; }
.report-export-body .report-export-hide { display: none !important; }
</style>
</head>
<body>
<div class="report-export-header">
  <div class="report-export-title">${escapeHtml(title)}</div>
  <div class="report-export-meta">WebGPU Inspector · ${escapeHtml(date)}${subtitle ? ` · ${escapeHtml(subtitle)}` : ""}</div>
</div>
<div class="report-export-body">
${clone.outerHTML}
</div>
</body>
</html>`;
}

/** Download a report view as an HTML file. */
export function downloadReportHtml(root, options = {}) {
    const html = reportToHtml(root, options);
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const base = (options.title ?? "report").replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "") || "report";
    a.download = `${base}.html`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}
