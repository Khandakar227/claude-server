// Quick WebSocket smoke test: streams a run and prints frames as they arrive.
import { readFileSync } from "node:fs";
import { WebSocket } from "ws";

const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
const token = (env.match(/^AUTH_TOKEN=(.*)$/m)?.[1] ?? "").trim();
const ws = new WebSocket(`ws://127.0.0.1:8787/v1/ws?token=${token}`);

let deltas = 0;
ws.on("open", () => {
  console.log("[open] sending run");
  ws.send(JSON.stringify({
    type: "run",
    payload: {
      user_prompt: "Count from 1 to 5, one number per line.",
      model: "claude-haiku-4-5-20251001",
      system_prompt: "Be terse.",
    },
  }));
});

ws.on("message", (raw) => {
  const ev = JSON.parse(raw.toString());
  if (ev.type === "delta") { deltas++; process.stdout.write("."); return; }
  if (ev.type === "session") console.log(`\n[session] ${ev.sessionId}`);
  else if (ev.type === "result") {
    console.log(`\n[result] status=${ev.status} turns=${ev.turns} deltas=${deltas} cost=$${ev.costUsd}`);
    console.log(`[text] ${JSON.stringify(ev.result)}`);
    ws.close();
  } else if (ev.type === "error") {
    console.log(`\n[error] ${ev.code}: ${ev.message}`);
    ws.close();
  }
});

ws.on("close", () => { console.log("[closed]"); process.exit(0); });
ws.on("error", (e) => { console.error("[ws error]", e.message); process.exit(1); });
setTimeout(() => { console.error("timeout"); process.exit(1); }, 90000);
