/**
 * Entry point. Asserts a safe bind address, starts the server, and installs
 * graceful-shutdown handlers.
 */
import { config } from "./config.js";
import { logger } from "./logger.js";
import { buildApp } from "./server.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * Keep a double-clicked console window open so the user can read an error
 * before it vanishes. No-op when not attached to an interactive terminal.
 */
async function pauseIfInteractive(): Promise<void> {
  if (!process.stdin.isTTY) return;
  process.stdout.write("\nPress Enter to exit...");
  await new Promise<void>((resolve) => {
    process.stdin.once("data", () => resolve());
    process.stdin.resume();
  });
}

/** Plain, human-readable startup banner (pino JSON is hard to read in a console). */
function printBanner(): void {
  const base = `http://${config.HOST}:${config.PORT}`;
  const token = process.env.AUTH_TOKEN ?? "";
  // eslint-disable-next-line no-console
  console.log(
    [
      "",
      "  claude-server is running",
      `  HTTP    ${base}`,
      `  WS      ws://${config.HOST}:${config.PORT}/v1/ws`,
      `  Health  ${base}/health`,
      `  Token   ${token.slice(0, 8)}… (full value in .env)`,
      "",
      "  Leave this window open. Close it / Ctrl+C to stop.",
      "",
    ].join("\n"),
  );
}

async function main() {
  if (!LOOPBACK.has(config.HOST)) {
    // This server runs the agent with bypassPermissions — anyone who can reach
    // the port can execute code on this machine. Refuse non-loopback binds
    // unless explicitly overridden, to prevent accidental network exposure.
    if (process.env.ALLOW_NON_LOOPBACK !== "1") {
      logger.fatal(
        { host: config.HOST },
        "Refusing to bind to a non-loopback host. Set ALLOW_NON_LOOPBACK=1 to override (NOT recommended).",
      );
      process.exit(1);
    }
    logger.warn({ host: config.HOST }, "Binding to a non-loopback host — agent tool access is network-reachable!");
  }

  const { app } = await buildApp();

  await app.listen({ host: config.HOST, port: config.PORT });
  logger.info(
    { url: `http://${config.HOST}:${config.PORT}`, ws: `ws://${config.HOST}:${config.PORT}/v1/ws` },
    "claude-server listening",
  );
  printBanner();

  const shutdown = async (signal: string) => {
    logger.info({ signal }, "shutting down");
    try {
      await app.close();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, "error during shutdown");
      process.exit(1);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch(async (err) => {
  logger.fatal({ err }, "failed to start");
  // eslint-disable-next-line no-console
  console.error(`\nclaude-server failed to start: ${err instanceof Error ? err.message : err}`);
  await pauseIfInteractive();
  process.exit(1);
});
