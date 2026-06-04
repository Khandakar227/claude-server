# claude-server

A personal HTTP + WebSocket server that exposes your locally-installed **Claude Code** (via the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)) over a port. Send a `system_prompt` + `user_prompt`, the server runs an agent on this machine and returns the result plus a `session_id` you can resume — with **real-time streaming over WebSocket**.

Uses your Claude Code **subscription login** (no API key required). Binds to `127.0.0.1` only by default.

---

## Features

- **Real-time streaming** over WebSocket (`/v1/ws`) and SSE (`/v1/agents/stream`).
- **Buffered** single-response endpoint (`/v1/agents/run`).
- **Resumable sessions** — pass back the `session_id` to continue a conversation; full context is rehydrated server-side (you only send the new prompt).
- **Concurrency control** — bounded worker pool, overflow queue, one in-flight run per session.
- **Token & cost accounting** per run and per session (`/v1/usage`).
- **Cancellation & timeouts** — cancel by session, client-disconnect aborts the run, per-run wall-clock timeout.
- **Custom tools / function calling** — extend via in-process SDK MCP tools (see Extending).
- Bearer-token auth, structured logging with secret redaction, graceful shutdown.

## Requirements

- Node.js ≥ 20
- Claude Code installed and logged in (`claude` — verify with `claude --version`).
- **Do not** set `ANTHROPIC_API_KEY` unless you want metered API billing instead of your subscription.

## Setup

```bash
npm install
cp .env.example .env
npm run gen-token          # paste the output into AUTH_TOKEN in .env
npm run dev                # or: npm run build && npm start
```

Server prints:
```
http://127.0.0.1:8787   ws://127.0.0.1:8787/v1/ws
```

## API

All `/v1/*` routes require `Authorization: Bearer <AUTH_TOKEN>` (WebSocket also accepts `?token=`).

### `POST /v1/agents/run` — buffered
```jsonc
// request
{
  "system_prompt": "Be terse.",          // optional
  "user_prompt": "What is 2+2?",          // required
  "session_id": null,                      // null = new; string = resume
  "system_prompt_mode": "append",          // "append" (keep Claude Code prompt) | "replace"
  "persist": true,                         // false = ephemeral: no transcript saved, not resumable
  "model": "claude-sonnet-4-6",            // optional
  "max_turns": 30,                         // optional
  "max_budget_usd": 0.50,                  // optional hard cost cap
  "permission_mode": "bypassPermissions",  // optional override
  "allowed_tools": ["Read","Bash"],        // optional allowlist
  "metadata": { "tag": "demo" },           // optional, stored with session
  "attachments": [                          // optional images / documents
    { "type": "image", "media_type": "image/png", "data": "<base64>" }
  ]
}
// response
{ "session_id": "...", "result": "4", "status": "success",
  "turns": 1, "tool_calls": [], "usage": {...}, "cost_usd": 0.01, "duration_ms": 800 }
```

```bash
curl -s localhost:8787/v1/agents/run \
  -H "Authorization: Bearer $AUTH_TOKEN" -H "content-type: application/json" \
  -d '{"system_prompt":"Be terse.","user_prompt":"What is 2+2?"}'
```

### `POST /v1/agents/stream` — SSE
Same body. Emits `event: session | delta | thinking | message | tool_use | tool_result | usage | result | done`.

### `GET /v1/ws` — WebSocket (real-time)
Client frames:
```jsonc
{ "type": "run", "payload": { /* same as /run body */ } }
{ "type": "cancel" }
{ "type": "ping" }
```
Server frames (one active run per socket): `session`, `delta`, `thinking`, `message`, `tool_use`, `tool_result`, `usage`, `result`, `error`, `pong`.

To continue a conversation: wait for `result`, then send another `run` with the `session_id` from the `session` frame.

Try it: `node scripts/ws-test.mjs`

### Sessions & usage
- `GET /v1/sessions` — list (id, usage, cost, timestamps)
- `GET /v1/sessions/:id` — one session's metadata
- `DELETE /v1/sessions/:id` — forget a session (cancels any active run)
- `POST /v1/sessions/:id/cancel` — cancel the active run for a session
- `GET /v1/usage` — aggregate token/cost totals
- `GET /health` — liveness, queue depth, active runs (public)

## Packaging — start it easily / delete node_modules

The agent engine is your **installed Claude Code** (`claude` on PATH); the server resolves it at runtime (`src/agent/claude-path.ts`), so neither artifact below needs `node_modules`. Claude Code must be installed for any of them to work.

```bash
npm run build:bundle   # -> dist/claude-server.cjs   (~3 MB single JS file)
npm run build:exe      # -> bin/claude-server.exe     (~53 MB standalone exe)
npm run build          # typecheck + both of the above
```

**Option A — single-file bundle + double-click launcher** (needs Node installed)
- `dist/claude-server.cjs` is fully self-contained; you can delete `node_modules` after building.
- Double-click **`start.bat`** (Windows) or run **`./start.sh`** (Linux/macOS). It auto-creates a `.env` with a fresh token on first run, then starts the server.

**Option B — true standalone executable** (no Node needed)
- `bin/claude-server.exe` embeds a Node runtime. Copy it anywhere with a `.env` beside it (or set env vars) and double-click / run it.
- Build for other platforms: `TARGET=node22-linux-x64 npm run build:exe` (also `node22-macos-x64`/`-arm64`).
- The exe is unsigned — Windows SmartScreen may warn on first run (*More info → Run anyway*).

Minimum to run either: the artifact + a `.env` containing `AUTH_TOKEN` (and optionally `PORT`). After `build:bundle`/`build:exe` you can safely `rm -rf node_modules`.

To override the engine path explicitly, set `CLAUDE_EXECUTABLE=/path/to/claude` in `.env`.

## Attachments (images & documents)

Send images or PDFs with a prompt via the optional `attachments` array (works on `/run`, `/stream`, and WS `run` frames). Each attachment is either inline base64 (`data`) or a remote `url`:

```jsonc
{
  "user_prompt": "What's in this image?",
  "attachments": [
    { "type": "image", "media_type": "image/png", "data": "<base64>" },
    { "type": "image", "data": "data:image/jpeg;base64,/9j/4AAQ..." },  // data: URL ok, media_type parsed
    { "type": "image", "url": "https://example.com/pic.png" },           // or a URL
    { "type": "document", "media_type": "application/pdf", "data": "<base64>" }
  ]
}
```

Notes:
- `type` is `image` or `document` (PDF). Images: PNG/JPEG/GIF/WebP.
- Provide either `data` (base64, with `media_type`) **or** `url`. A `data:` URL is accepted and its media type is auto-detected.
- Internally the server switches to the SDK's structured-message input to attach the content blocks; everything else (sessions, streaming, ephemeral) works the same.
- JSON body limit is 25 MB (base64 inflates ~33%). For very large files, prefer a `url`, or drop the file on disk and let the agent's `Read` tool open it by path.

## Ephemeral (temporary) chats

By default conversations are saved to `~/.claude/projects` and are resumable. To make a chat **temporary** — no transcript written to disk, not resumable — set `"persist": false` on the request (works on `/run`, `/stream`, and WS `run` frames). The server passes `persistSession: false` to the SDK and best-effort removes the per-session workspace and any title stub, so an ephemeral run leaves **no trace on disk**. Trade-off: with no stored context, ephemeral runs are one-shot (you can't resume them).

To make **every** chat ephemeral by default, set `PERSIST_SESSIONS=false` in `.env`; individual requests can still opt back in with `"persist": true`.

## Configuration

See `.env.example`. Key vars: `PORT`, `AUTH_TOKEN`, `DEFAULT_MODEL`, `DEFAULT_PERMISSION_MODE`, `MAX_CONCURRENT_RUNS`, `MAX_QUEUE`, `RUN_TIMEOUT_MS`, `WORKSPACE_ROOT`, `LOG_LEVEL`, `LOG_PRETTY`.

## Architecture

```
Fastify (HTTP + WS)
  ├─ auth (bearer)           src/auth.ts
  ├─ routes                  src/transport/{http,ws}.ts
  └─ Orchestrator            src/agent/orchestrator.ts   ← concurrency, queue, per-session lock, cancel
        └─ runAgent()        src/agent/runner.ts         ← the only call to SDK query()
              └─ events.ts   normalized AgentEvent stream
        └─ SessionStore      src/sessions/*              ← metadata index (swap for SQLite)
```
- The SDK persists full transcripts under `~/.claude/projects`; the in-memory store only indexes metadata, so sessions stay resumable across restarts even though the index is volatile.
- Each run spawns a `claude` subprocess — `MAX_CONCURRENT_RUNS` is the primary memory control.

## Security notes

This server runs the agent with `bypassPermissions` by default — **anyone who can reach the port can execute code on this machine**. Mitigations in place: localhost-only bind (refuses non-loopback unless `ALLOW_NON_LOOPBACK=1`), bearer token, per-session workspace dirs under `WORKSPACE_ROOT`, run timeouts and optional cost caps. Do not expose this to a network without adding TLS, stronger auth, and tool/command policy hooks.

## Extending: custom function calling

Add in-process tools the agent can call (DB lookups, internal APIs, etc.) with `tool()` + `createSdkMcpServer()` from the SDK, then pass them through `Options.mcpServers` in `src/agent/runner.ts`. See the SDK docs for `createSdkMcpServer`.

## Roadmap

- SQLite-backed `SessionStore` (durable metadata + run ledger)
- `PreToolUse`/`PostToolUse` policy + audit hooks
- External MCP server registry/allowlist
- Streaming-input multi-turn (push prompts into one long-lived `query()` to avoid subprocess respawn)
