// Bundles the whole server (our code + all npm deps) into a single CommonJS
// file: dist/claude-server.cjs. After this you can delete node_modules — the
// only runtime requirement is Node and an installed Claude Code on PATH.
import { build } from "esbuild";
import { rmSync, mkdirSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/claude-server.cjs",
  bundle: true,
  platform: "node",
  target: "node20",
  format: "cjs",
  // ws's optional speedups are loaded via try/catch require; leave them external
  // so the bundle doesn't fail to resolve them — ws falls back to pure JS.
  external: ["bufferutil", "utf-8-validate"],
  // The Agent SDK is ESM and uses import.meta.url; map it to the bundle path so
  // CJS output stays valid. (Claude Code is still resolved via PATH at runtime.)
  banner: {
    js: "const importMetaUrl = require('url').pathToFileURL(__filename).href;",
  },
  define: { "import.meta.url": "importMetaUrl" },
  legalComments: "none",
  logLevel: "info",
});

console.log("\n✓ bundled -> dist/claude-server.cjs");
