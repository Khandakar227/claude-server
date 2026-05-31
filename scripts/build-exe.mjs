// Builds a true standalone executable with @yao-pkg/pkg: a self-contained binary
// that embeds a Node runtime + our bundle. Needs neither Node nor node_modules at
// runtime — only an installed Claude Code (claude on PATH), the agent engine.
//
// Prereq: run `node scripts/build-bundle.mjs` first (produces dist/claude-server.cjs).
// First run downloads a Node base binary into the pkg cache (~tens of MB).
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";

const require = createRequire(import.meta.url);

const BUNDLE = "dist/claude-server.cjs";
if (!existsSync(BUNDLE)) {
  console.error(`Missing ${BUNDLE}. Run: node scripts/build-bundle.mjs`);
  process.exit(1);
}
mkdirSync("bin", { recursive: true });

// Target the current platform's x64 Node 22 base. Override with TARGET env, e.g.
//   TARGET=node22-linux-x64 node scripts/build-exe.mjs
const plat = process.platform === "win32" ? "win" : process.platform === "darwin" ? "macos" : "linux";
const target = process.env.TARGET ?? `node22-${plat}-x64`;
const exeName = target.includes("win") ? "claude-server.exe" : "claude-server";
const outPath = `bin/${exeName}`;

const pkgBin = require.resolve("@yao-pkg/pkg/lib-es5/bin.js");
const args = [pkgBin, BUNDLE, "--targets", target, "--output", outPath, "--compress", "GZip"];

console.log(`→ packaging ${BUNDLE} for ${target}`);
execFileSync(process.execPath, args, { stdio: "inherit" });

const sizeMb = (statSync(outPath).size / 1024 / 1024).toFixed(0);
console.log(`\n✓ built ${outPath} (${sizeMb} MB)`);
console.log("  Run it from a folder containing a .env (or set env vars).");
if (target.includes("win")) {
  console.log("  Note: unsigned exe — SmartScreen may warn on first run (More info → Run anyway).");
}
