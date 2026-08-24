// Standalone smoke test for the host half of dsh-ai-quota.
// Uses a real cordis Context with a fake `tools` service; no credentials,
// no keys in env, no real codex on PATH.
import { Context, Service } from "@deepseek-ai/cordis";
import { AiQuotaGateway, findOnPath, codexRateLimits } from "./index.js";

class FakeTools extends Service {
  constructor(ctx) {
    super(ctx, "tools");
    this.registered = [];
  }
  register(tool) {
    this.registered.push(tool.name);
    return () => {};
  }
}

const ctx = new Context();
ctx.plugin(FakeTools);
await ctx.plugin(AiQuotaGateway, {
  timeoutMs: 3000,
  deepseekApiKeyEnv: "DEEPSEEK_API_KEY",
  opencodeGoApiKeyEnv: "OPENCODE_GO_API_KEY",
  codexCli: "codex",
});

const tools = ctx.tools;
console.log("registered tools:", tools.registered);

const gateway = ctx.aiQuota;
const result = await gateway.query();
console.log(JSON.stringify(result, null, 2));

// findOnPath sanity
console.log("findOnPath(node) ->", findOnPath("node") ? "found" : "MISSING");
console.log("findOnPath(codex) ->", findOnPath("codex") ? "found" : "MISSING (expected)");

// codexRateLimits with a fake codex on PATH that answers the RPC
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const dir = mkdtempSync(path.join(tmpdir(), "fakecodex-"));
const fake = path.join(dir, "codex");
writeFileSync(
  fake,
  `#!/usr/bin/env node
const rl = require('node:readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method === 'initialize') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { capabilities: {}, serverInfo: {} } }) + '\\n');
  } else if (msg.method === 'account/rateLimits/read') {
    process.stdout.write(JSON.stringify({ id: msg.id, result: { planType: 'plus', rateLimits: { primary: { windowDurationMins: 300, usedPercent: 12, resetsAt: '2026-08-16T10:00:00.000Z' }, secondary: { windowDurationMins: 10080, usedPercent: 39, resetsAt: '2026-08-20T00:00:00.000Z' } } } }) + '\\n');
  }
});
`,
);
chmodSync(fake, 0o755);
const rpc = await codexRateLimits(path.join(dir, "codex"), 5000);
console.log("codexRateLimits(fake codex) ->", JSON.stringify(rpc, null, 2));

await ctx.fiber.dispose();
