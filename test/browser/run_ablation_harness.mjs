// Drives test/browser/ablation_harness.html in headless Chrome and reports
// the results. Uses the MCP plugin server's puppeteer-core.
// Run with: node test/browser/run_ablation_harness.mjs
import http from "node:http";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createRequire } = await import("node:module");
const puppeteer = createRequire(path.join(root, "claude-plugin/server/index.js"))("puppeteer-core");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript" };

const server = http.createServer((req, res) => {
    const file = path.join(root, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404).end();
        return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] ?? "application/octet-stream" });
    res.end(fs.readFileSync(file));
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const port = server.address().port;

const chromePaths = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA + "/Google/Chrome/Application/chrome.exe",
];
const executablePath = chromePaths.find((p) => p && fs.existsSync(p));
if (!executablePath) {
    console.error("Chrome not found");
    process.exit(1);
}

const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    args: [
        "--enable-unsafe-webgpu",
        "--enable-features=WebGPU",
        "--use-angle=d3d11",
        "--no-sandbox",
        // Timestamp queries are gated behind the unsafe-APIs allowance.
        "--disable-dawn-features=disallow_unsafe_apis",
    ],
});
try {
    const page = await browser.newPage();
    page.on("console", (msg) => console.log("[page]", msg.type(), msg.text()));
    page.on("pageerror", (e) => console.log("[pageerror]", e.message));
    await page.goto(`http://127.0.0.1:${port}/test/browser/ablation_harness.html`);
    await page.waitForFunction("Array.isArray(window.__results)", { timeout: 60000 });
    const results = await page.evaluate("window.__results");
    let failed = 0;
    for (const r of results) {
        if (!r.ok) {
            failed++;
        }
        console.log(`${r.ok ? "PASS" : "FAIL"}: ${r.name}`);
        if (!r.ok) {
            console.log(`  failure: ${r.failure}`);
        } else if (r.info) {
            console.log(`  ${JSON.stringify(r.info)}`);
        }
    }
    process.exitCode = failed ? 1 : 0;
    console.log(failed ? `${failed} case(s) FAILED` : `All ${results.length} cases passed`);
} finally {
    await browser.close();
    server.close();
}
