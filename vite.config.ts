import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "path";
import { writeFileSync, mkdirSync, copyFileSync, existsSync } from "fs";
import { build as esbuild } from "esbuild";

// Plugin to emit manifest.json, offscreen.html, icons, and IIFE content script
function extensionPlugin(): Plugin {
  return {
    name: "extension-assets",
    apply: "build",
    async closeBundle() {
      // Icons
      mkdirSync("dist/icons", { recursive: true });
      for (const sz of [16, 48, 128]) {
        const src = `public/icons/icon${sz}.png`;
        if (existsSync(src)) {
          copyFileSync(src, `dist/icons/icon${sz}.png`);
        }
      }

      // Build MAIN world bridge (runs in page context for API calls)
      await esbuild({
        entryPoints: ["src/content/main-world-bridge.ts"],
        bundle: true,
        format: "iife",
        outfile: "dist/main-world-bridge.js",
        tsconfig: "tsconfig.json",
        minify: true,
      });

      // Build content script as IIFE (self-contained, no ES imports)
      // Content scripts MUST be classic scripts — Chrome doesn't load ES modules for them
      await esbuild({
        entryPoints: ["src/content/main.ts"],
        bundle: true,
        format: "iife",
        outfile: "dist/content.js",
        alias: {
          "@shared": "./src/shared",
          "@background": "./src/background",
          "@content": "./src/content",
        },
        tsconfig: "tsconfig.json",
        minify: false, // keep readable for debugging
        banner: {
          js: 'console.log("[WFC] === Content script IIFE starting ===", window.location.href);',
        },
        footer: {
          js: 'console.log("[WFC] === Content script IIFE finished ===");',
        },
      });

      // Manifest
      const threadsDomains = [
        "https://www.threads.net/*",
        "https://threads.net/*",
        "https://www.threads.com/*",
        "https://threads.com/*",
      ];
      const manifest = {
        manifest_version: 3,
        name: "Wav Fake Cleaner",
        version: "2.0.0",
        description: "Detect and remove fake followers from your Threads account",
        permissions: ["sidePanel", "storage", "alarms", "offscreen", "activeTab", "scripting"],
        host_permissions: threadsDomains,
        background: {
          service_worker: "service-worker.js",
          type: "module",
        },
        side_panel: {
          default_path: "sidepanel.html",
        },
        content_scripts: [
          {
            matches: threadsDomains,
            js: ["content.js"],
            run_at: "document_idle",
          },
        ],
        icons: {
          "16": "icons/icon16.png",
          "48": "icons/icon48.png",
          "128": "icons/icon128.png",
        },
        action: {
          default_popup: "popup.html",
          default_icon: {
            "16": "icons/icon16.png",
            "48": "icons/icon48.png",
          },
        },
        web_accessible_resources: [
          {
            matches: threadsDomains,
            resources: ["assets/*", "offscreen.html", "offscreen.js", "main-world-bridge.js"],
            use_dynamic_url: false,
          },
        ],
      };
      writeFileSync("dist/manifest.json", JSON.stringify(manifest, null, 2));

      // Offscreen HTML
      writeFileSync(
        "dist/offscreen.html",
        `<!DOCTYPE html><html><head><title>WFC Offscreen</title></head><body><script src="./offscreen.js"></script></body></html>`
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), extensionPlugin()],
  resolve: {
    alias: {
      "@shared": resolve(__dirname, "src/shared"),
      "@background": resolve(__dirname, "src/background"),
      "@content": resolve(__dirname, "src/content"),
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        sidepanel: resolve(__dirname, "sidepanel.html"),
        popup: resolve(__dirname, "popup.html"),
        "service-worker": resolve(__dirname, "src/background/service-worker.ts"),
        offscreen: resolve(__dirname, "src/offscreen/offscreen.ts"),
        // content script is built separately by esbuild (IIFE format)
      },
      output: {
        entryFileNames: (chunk) => {
          if (["service-worker", "offscreen"].includes(chunk.name)) {
            return "[name].js";
          }
          return "assets/[name]-[hash].js";
        },
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
  },
});
