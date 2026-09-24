import { Div } from "./widget/div.js";
import { Span } from "./widget/span.js";
import { analyzePasses, collectPassStats, measurePasses } from "./bottleneck_report.js";

const SEVERITY_LABEL = { high: "HIGH", medium: "MEDIUM", low: "LOW", info: "INFO" };

function fmt(n, digits = 1) {
    return n === null || n === undefined || !Number.isFinite(n) ? "—" : n.toFixed(digits);
}

function count(n) {
    return n === null || n === undefined ? "—" : Math.round(n).toLocaleString();
}

/**
 * The GPU Bottlenecks report: one row per pass with its GPU time, fragment
 * counts and verdict, and the findings across the frame ranked as "what to
 * look at". The GPU counts are measured when the report opens.
 *
 * @param {Object} params
 * @param {Object[]} params.commands
 * @param {Object} params.database
 * @param {GPUDevice} params.device
 * @param {(attachment:Object)=>Object} params.getTextureFromAttachment
 * @param {(command:Object)=>void} params.onSelectCommand
 * @returns {Div}
 */
export function buildBottleneckView(params) {
    const panel = new Div(null, { class: "bottlenecks" });
    const status = new Div(panel, { class: "perf-report-header", text: "Measuring…" });
    const notes = new Div(panel, { class: "flame-notes" });
    const table = new Div(panel, { class: "bottlenecks-table" });
    const issues = new Div(panel, { class: "bottlenecks-issues" });

    const passes = collectPassStats(params.commands, {
        getObject: (id) => params.database.getObject(id),
        getTextureFromAttachment: params.getTextureFromAttachment,
    });

    const render = (measureNotes) => {
        const result = analyzePasses(passes);
        const timed = passes.some((p) => p.durationMs !== null);
        const measured = passes.some((p) => p.rasterized !== undefined);
        status.text = `${passes.length} pass${passes.length === 1 ? "" : "es"}${timed ? `, ${fmt(passes.reduce((s, p) => s + (p.durationMs ?? 0), 0), 3)} ms of GPU time` : ""}, ${result.issues.length} finding${result.issues.length === 1 ? "" : "s"}.`;
        notes.removeAllChildren();
        const allNotes = [];
        if (!timed) {
            allNotes.push("The capture has no pass timings, so passes can't be ranked by GPU time. Capture with Profile Passes (in the ☰ menu's Capture Settings) for them.");
        }
        allNotes.push("Rasterized counts every covered pixel before any test; Survived counts what then passed the depth and stencil tests. Both come from replaying each pass with a counting shader, one sample per pixel.");
        allNotes.push(...(measureNotes ?? []).slice(0, 5));
        for (const text of allNotes) {
            new Div(notes, { class: "flame-note", text });
        }

        table.removeAllChildren();
        const t = document.createElement("table");
        t.className = "mesh-table bottlenecks-grid";
        const head = t.createTHead().insertRow();
        for (const h of ["Pass", "GPU ms", "Share", "Draws", "Primitives", "Rasterized", "Survived", "Overdraw", "Px / prim", "Rejected", "Targets", "Verdict"]) {
            const th = document.createElement("th");
            th.textContent = h;
            head.appendChild(th);
        }
        const body = t.createTBody();
        for (const pass of result.passes) {
            const row = body.insertRow();
            const name = row.insertCell();
            name.textContent = pass.label;
            name.className = "dependency_link";
            name.title = "Go to the pass in the command list";
            name.addEventListener("click", () => params.onSelectCommand?.(pass.begin));
            row.insertCell().textContent = fmt(pass.durationMs, 3);
            row.insertCell().textContent = pass.share !== null ? `${(pass.share * 100).toFixed(0)}%` : "—";
            row.insertCell().textContent = pass.kind === "compute" ? `${pass.dispatches} disp.` : String(pass.draws);
            row.insertCell().textContent = pass.kind === "compute" ? "" : `${count(pass.primitives)}${pass.primitivesKnown ? "" : "+"}`;
            row.insertCell().textContent = pass.kind === "compute" ? "" : count(pass.rasterized);
            row.insertCell().textContent = pass.kind === "compute" ? "" : count(pass.survived);
            row.insertCell().textContent = pass.overdraw !== null ? `${fmt(pass.overdraw)}×` : "";
            row.insertCell().textContent = pass.fragsPerPrimitive !== null ? fmt(pass.fragsPerPrimitive) : "";
            row.insertCell().textContent = pass.rejected !== null ? `${(pass.rejected * 100).toFixed(0)}%` : "";
            const targets = row.insertCell();
            targets.textContent = pass.kind === "compute" ? "" : `${pass.width}x${pass.height}${pass.sampleCount > 1 ? ` ${pass.sampleCount}x` : ""}`;
            targets.title = pass.targets.join(", ");
            const verdict = row.insertCell();
            verdict.textContent = pass.verdict || (measured ? "" : "…");
            const worst = pass.findings[0]?.severity;
            if (worst) {
                verdict.className = `bottleneck-verdict bottleneck-${worst}`;
            }
        }
        table.element.appendChild(t);

        issues.removeAllChildren();
        new Div(issues, { class: "render-graph-heading", text: result.issues.length ? "What to look at" : (measured ? "Nothing stands out in the counts." : "") });
        const list = new Div(issues, { class: "perf-findings" });
        for (const f of result.issues) {
            const row = new Div(list, { class: `perf-finding perf-row-${f.severity}` });
            const head2 = new Div(row, { class: "perf-finding-head" });
            new Span(head2, { class: `perf-badge perf-${f.severity === "info" ? "info" : f.severity}`, text: SEVERITY_LABEL[f.severity] });
            new Span(head2, { class: "perf-rule", text: f.title });
            const link = new Span(head2, { class: "perf-line-link", text: f.pass.label });
            link.element.onclick = () => params.onSelectCommand?.(f.pass.begin);
            if (f.pass.share !== null) {
                new Span(head2, { class: "perf-line", text: `${(f.pass.share * 100).toFixed(0)}% of GPU time` });
            }
            new Div(row, { class: "perf-msg", text: f.message });
        }
    };

    render();
    if (!params.device) {
        status.text = "The DevTools GPU device is not available, so fragment counts can't be measured.";
        return panel;
    }
    measurePasses(passes, {
        device: params.device,
        database: params.database,
        commands: params.commands,
        getTextureFromAttachment: params.getTextureFromAttachment,
        onProgress: (text) => {
            status.text = text;
        },
    }).then((measureNotes) => render(measureNotes)).catch((e) => {
        console.error("GPU Bottlenecks measurement failed:", e);
        status.text = `Measurement failed: ${e.message ?? e}`;
    });
    return panel;
}
