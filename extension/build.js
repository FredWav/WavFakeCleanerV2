#!/usr/bin/env node
/**
 * Extension Build Script — produces browser-specific builds from one codebase.
 *
 * Output:
 *   dist/chromium/   → Chrome, Edge, Opera, Comet, Brave (MV3)
 *   dist/firefox/    → Firefox (MV3 with gecko settings)
 *   dist/safari/     → Safari Web Extension (MV3, needs Xcode wrapper)
 *
 * Usage:
 *   node build.js           # Build all
 *   node build.js chromium  # Build one target
 *   node build.js --zip     # Build all + create .zip files
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");

const TARGETS = ["chromium", "firefox", "safari"];

// Files to copy (relative to ROOT)
const COMMON_FILES = [
  "background/service-worker.js",
  "background/scorer.js",
  "background/pacer.js",
  "background/quota.js",
  "content/threads.js",
  "popup/index.html",
  "popup/styles.css",
  "popup/app.js",
  "_locales/fr/messages.json",
  "_locales/en/messages.json",
  "assets/icon-16.png",
  "assets/icon-48.png",
  "assets/icon-128.png",
];

function clean(target) {
  const dir = path.join(DIST, target);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

function copyFile(src, dest) {
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
}

function buildChromium() {
  const target = "chromium";
  clean(target);
  const out = path.join(DIST, target);

  // Copy common files
  for (const file of COMMON_FILES) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) copyFile(src, path.join(out, file));
  }

  // Copy Chrome manifest
  copyFile(path.join(ROOT, "manifest.json"), path.join(out, "manifest.json"));

  console.log(`  ✓ chromium → ${out}`);
}

function buildFirefox() {
  const target = "firefox";
  clean(target);
  const out = path.join(DIST, target);

  // Copy common files
  for (const file of COMMON_FILES) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) copyFile(src, path.join(out, file));
  }

  // Use Firefox manifest
  copyFile(path.join(ROOT, "manifest.firefox.json"), path.join(out, "manifest.json"));

  // Firefox: service worker → background script adapter
  const bgAdapter = `
// Firefox MV3 background script adapter
// Firefox supports background.scripts[] instead of service_worker
import "./service-worker.js";
`;
  const adapterPath = path.join(out, "background", "background.js");
  fs.writeFileSync(adapterPath, bgAdapter.trim() + "\n");

  console.log(`  ✓ firefox → ${out}`);
}

function buildSafari() {
  const target = "safari";
  clean(target);
  const out = path.join(DIST, target);

  // Copy common files
  for (const file of COMMON_FILES) {
    const src = path.join(ROOT, file);
    if (fs.existsSync(src)) copyFile(src, path.join(out, file));
  }

  // Safari uses Chromium-style MV3 manifest with minor tweaks
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));

  // Safari-specific: remove unsupported fields
  delete manifest.content_security_policy;

  // Safari needs minimum_chrome_version removed if present
  delete manifest.minimum_chrome_version;

  fs.writeFileSync(
    path.join(out, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n"
  );

  console.log(`  ✓ safari → ${out}`);
  console.log(`    Note: Run 'xcrun safari-web-extension-converter ${out}' to create Xcode project`);
}

function createZip(target) {
  const dir = path.join(DIST, target);
  const zipFile = path.join(DIST, `wavfakecleaner-${target}.zip`);
  if (fs.existsSync(zipFile)) fs.unlinkSync(zipFile);
  execSync(`cd "${dir}" && zip -r "${zipFile}" .`, { stdio: "pipe" });
  console.log(`  ✓ ${zipFile}`);
}

// ── Main ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const doZip = args.includes("--zip");
const requestedTargets = args.filter(a => !a.startsWith("--"));

const targets = requestedTargets.length > 0
  ? requestedTargets.filter(t => TARGETS.includes(t))
  : TARGETS;

if (targets.length === 0) {
  console.error(`Unknown target. Available: ${TARGETS.join(", ")}`);
  process.exit(1);
}

console.log("Building WavFakeCleaner extension...\n");

for (const target of targets) {
  switch (target) {
    case "chromium": buildChromium(); break;
    case "firefox": buildFirefox(); break;
    case "safari": buildSafari(); break;
  }
}

if (doZip) {
  console.log("\nCreating zip archives...");
  for (const target of targets) createZip(target);
}

console.log("\nDone!");
console.log(`
Browser compatibility:
  chromium → Chrome, Edge, Opera, Comet, Brave
  firefox  → Firefox
  safari   → Safari (requires Xcode + safari-web-extension-converter)
`);
