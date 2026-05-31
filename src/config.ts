/**
 * Application configuration.
 *
 * Environment variables are loaded from `.env` (next to the executable when
 * packaged, else the cwd) and validated with zod. Designed to "just work" on a
 * double-click: if no AUTH_TOKEN is present, one is generated and persisted so
 * the server starts instead of exiting.
 */
import { z } from "zod";
import { randomBytes } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

/**
 * Directory the app should treat as its home for `.env` and `workspaces`.
 * For a packaged exe (pkg sets `process.pkg`) that's the folder containing the
 * exe; otherwise the current working directory.
 */
export const APP_DIR = (process as { pkg?: unknown }).pkg
  ? dirname(process.execPath)
  : process.cwd();

const ENV_PATH = join(APP_DIR, ".env");

// Load .env from the app directory (no external dependency needed on Node 20.12+).
try {
  if (existsSync(ENV_PATH)) process.loadEnvFile?.(ENV_PATH);
  else process.loadEnvFile?.(); // fall back to cwd if present
} catch {
  // No .env — rely on the ambient environment. Not an error.
}

/** Ensure a usable AUTH_TOKEN exists, generating + persisting one if needed. */
function ensureAuthToken() {
  const existing = process.env.AUTH_TOKEN;
  if (existing && existing.length >= 16) return;

  const token = randomBytes(32).toString("hex");
  process.env.AUTH_TOKEN = token;

  try {
    if (!existsSync(ENV_PATH)) {
      writeFileSync(ENV_PATH, `HOST=127.0.0.1\nPORT=8787\nAUTH_TOKEN=${token}\n`);
    } else if (!/^AUTH_TOKEN=/m.test(readFileSync(ENV_PATH, "utf8"))) {
      appendFileSync(ENV_PATH, `\nAUTH_TOKEN=${token}\n`);
    }
    // eslint-disable-next-line no-console
    console.log(`[config] Generated AUTH_TOKEN and saved to ${ENV_PATH}`);
  } catch {
    // eslint-disable-next-line no-console
    console.log("[config] Generated an ephemeral AUTH_TOKEN (could not write .env)");
  }
}
ensureAuthToken();

const PermissionModeSchema = z.enum([
  "default",
  "acceptEdits",
  "bypassPermissions",
  "plan",
]);

const EnvSchema = z.object({
  HOST: z.string().default("127.0.0.1"),
  PORT: z.coerce.number().int().positive().default(8787),
  AUTH_TOKEN: z.string().min(16, "AUTH_TOKEN must be at least 16 chars"),

  DEFAULT_MODEL: z.string().default("claude-opus-4-6"),
  DEFAULT_PERMISSION_MODE: PermissionModeSchema.default("bypassPermissions"),
  DEFAULT_MAX_TURNS: z.coerce.number().int().positive().default(30),

  MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(4),
  MAX_QUEUE: z.coerce.number().int().nonnegative().default(50),
  RUN_TIMEOUT_MS: z.coerce.number().int().positive().default(600_000),

  WORKSPACE_ROOT: z.string().default("./workspaces"),

  // Default for whether conversations are saved to ~/.claude/projects. Set to
  // false to make ALL chats ephemeral (non-resumable) unless a request opts in
  // with "persist": true.
  PERSIST_SESSIONS: z.coerce.boolean().default(true),

  // Optional explicit path to the Claude Code executable. If unset, the server
  // auto-detects `claude` on PATH. Setting this lets the bundle/exe run without
  // the SDK's optional native-CLI dependency.
  CLAUDE_EXECUTABLE: z.string().optional(),

  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  LOG_PRETTY: z.coerce.boolean().default(false),
});

export type PermissionMode = z.infer<typeof PermissionModeSchema>;

function loadConfig() {
  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    // eslint-disable-next-line no-console
    console.error(`Invalid configuration:\n${issues}`);
    process.exit(1);
  }

  const data = parsed.data;
  // Resolve a relative workspace root against the app directory so it lands
  // next to the exe regardless of where it was launched from.
  if (!isAbsolute(data.WORKSPACE_ROOT)) {
    data.WORKSPACE_ROOT = join(APP_DIR, data.WORKSPACE_ROOT);
  }

  if (process.env.ANTHROPIC_API_KEY) {
    // eslint-disable-next-line no-console
    console.warn(
      "[config] ANTHROPIC_API_KEY is set — runs will use metered API billing, " +
        "NOT your Claude Code subscription. Unset it to use subscription auth.",
    );
  }

  return Object.freeze(data);
}

export const config = loadConfig();
export type Config = typeof config;
