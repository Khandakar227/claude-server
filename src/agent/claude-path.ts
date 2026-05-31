/**
 * Resolves the path to the installed Claude Code executable.
 *
 * The Agent SDK normally spawns a native CLI shipped as an *optional* npm
 * dependency. A bundled single file or packaged exe has no node_modules, so that
 * dependency is absent. Instead we point the SDK at the system-installed Claude
 * Code (the `claude` binary on PATH) via `options.pathToClaudeCodeExecutable`.
 *
 * Resolution order: CLAUDE_EXECUTABLE env override → first match on PATH →
 * common install dir (~/.local/bin). Result is cached for the process lifetime.
 */
import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";

let resolved: string | undefined;
let didResolve = false;

function findOnPath(): string | undefined {
  const names =
    process.platform === "win32"
      ? ["claude.exe", "claude.cmd", "claude.bat", "claude"]
      : ["claude"];

  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const home = process.env.USERPROFILE ?? process.env.HOME;
  if (home) dirs.push(join(home, ".local", "bin")); // native installer default

  for (const dir of dirs) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Returns the Claude Code executable path, or undefined if none is found. */
export function resolveClaudeExecutable(): string | undefined {
  if (didResolve) return resolved;
  didResolve = true;
  resolved = config.CLAUDE_EXECUTABLE || findOnPath();
  if (resolved) logger.info({ claude: resolved }, "resolved Claude Code executable");
  else logger.warn("could not resolve a Claude Code executable on PATH");
  return resolved;
}
