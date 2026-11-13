// dsh-butler 监测循环验证（集成测试，读本机真实会话日志）
// 用法：node test/watcher.mjs
//
// 它做四步：
//   1. 首次加载 → 只建立基线，不应推送任何历史轮次
//   2. 人为删掉某个会话的基线（等价于「这个会话又完成了一轮」）
//   3. 重新加载 → 应推送正好 1 条，并打印内容
//   4. 调 ds_butler_watch(status) 看监测状态
//
// 注意：它会读写真实的 ~/.dsh/dsh-butler/notify-state.json。

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { apply } from "../index.js";

const STATE = join(homedir(), ".dsh", "dsh-butler", "notify-state.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 假的 dshIm：记录推送，不真发；假装渠道已连上
function makeCtx(sink) {
  const registered = [];
  const im = {
    async createTarget() { return {}; },
    async send(botId, targetId, text) { sink.push(text); return { sent: true }; },
    async listBots() { return [{ botId: "wx_test", channel: "weixin" }]; },
  };
  const imCtx = {
    dshIm: im,
    tools: { register(d) { registered.push(d); return () => {}; } },
    logger: { info: (m) => console.log("   [info]", m), warn: (m) => console.log("   [warn]", m) },
    effect: () => {},
  };
  const ctx = {
    tools: { register(d) { registered.push(d); return () => {}; } },
    inject(services, cb) { if (services.includes("dshIm")) cb(imCtx); },
  };
  return { ctx, registered };
}

console.log("### 第 1 步：首次加载，只建立基线");
const sink1 = [];
const first = makeCtx(sink1);
apply(first.ctx);
await sleep(2500);
console.log("   推送条数:", sink1.length, sink1.length === 0 ? "✅ 正确（没有把历史轮次刷出来）" : "❌ 不该推历史");
console.log("   状态文件:", existsSync(STATE) ? "已生成" : "未生成");
if (!existsSync(STATE)) { console.error("[FAIL] 没有生成状态文件"); process.exit(1); }

console.log("");
console.log("### 第 2 步：删掉一个会话的基线，模拟「又完成了一轮」");
const st = JSON.parse(readFileSync(STATE, "utf8"));
const sids = Object.keys(st.sessions).filter((s) => Number.isFinite(st.sessions[s].lastTurn));
if (sids.length === 0) { console.error("[FAIL] 状态里没有可用会话"); process.exit(1); }
const target = sids.find((s) => (st.sessions[s].lastTurn ?? 0) >= 5) ?? sids[0];
const before = st.sessions[target].lastTurn;
delete st.sessions[target];
writeFileSync(STATE, JSON.stringify(st, null, 2), "utf8");
console.log(`   会话 ${target.slice(0, 12)} 删除前是第 ${before} 轮`);

console.log("");
console.log("### 第 3 步：重新加载，应推送 1 条");
const sink2 = [];
const second = makeCtx(sink2);
apply(second.ctx);
await sleep(3000);
console.log("   推送条数:", sink2.length, sink2.length === 1 ? "✅" : "❌ 期望 1 条");
for (const t of sink2) {
  console.log("");
  console.log("   ┌─ 推送内容 ─────────────────");
  for (const line of t.split("\n")) console.log("   │ " + line);
  console.log("   └────────────────────────────");
}

console.log("");
console.log("### 第 4 步：ds_butler_watch(status)");
const watch = second.registered.find((d) => d.name === "ds_butler_watch");
if (!watch) { console.error("[FAIL] ds_butler_watch 未注册"); process.exit(1); }
const status = await watch.execute({ action: "status" });
console.log(status.text.split("\n").slice(0, 6).map((l) => "   " + l).join("\n"));

console.log("");
if (sink1.length === 0 && sink2.length === 1) {
  console.log("[OK] 监测循环通过：基线正确、新完成精确推送 1 条");
  process.exit(0);
}
console.error("[FAIL] 监测循环未达预期");
process.exit(1);
