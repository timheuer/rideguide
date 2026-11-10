import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildHtml } from "./generate-guide.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const htmlPath = resolve(root, "ride-guide.html");
const indexPath = resolve(root, "index.html");
const pdfPath = resolve(root, "ride-guide.pdf");

const candidates = [
  process.env.BROWSER_PATH,
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
];
const browser = candidates.find((p) => p && existsSync(p));
if (!browser) {
  throw new Error("No Edge or Chrome found. Set BROWSER_PATH to a Chromium-based browser executable.");
}

const html = await buildHtml();
await writeFile(htmlPath, html, "utf8");
await writeFile(indexPath, html, "utf8");

// The virtual time budget gives map tiles and web fonts time to load before printing.
execFileSync(
  browser,
  [
    "--headless",
    "--disable-gpu",
    "--no-pdf-header-footer",
    "--virtual-time-budget=15000",
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlPath).href,
  ],
  { stdio: "ignore" },
);

console.log(`Generated ${htmlPath}`);
console.log(`Generated ${indexPath}`);
console.log(`Generated ${pdfPath}`);
