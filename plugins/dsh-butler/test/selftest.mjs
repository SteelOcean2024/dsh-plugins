// dsh-butler 离线自测：不需要 DSH 就能验证状态总览与微信推送链路。
// 用法：node test/selftest.mjs
//
// 之所以能脱离 DSH 跑：index.js 只用 Node 内置模块，不 import 任何 @deepseek-ai/* 包。

import { apply } from "../index.js";

async function run(makeIm) {
  const registered = [];
  const calls = [];
  const im = makeIm(calls);

  const imCtx = {
    dshIm: im,
    tools: { register(d) { registered.push(d); return () => {}; } },
    logger: { info: (m) => console.log("   [info]", m), warn: (m) => console.log("   [warn]", m) },
  };
  const ctx = {
    tools: { register(d) { registered.push(d); return () => {}; } },
    inject(services, cb) { if (services.includes("dshIm")) cb(imCtx); },
  };

  apply(ctx);
  await new Promise((r) => setTimeout(r, 60));

  const names = registered.map((d) => d.name);
  if (!names.includes("ds_butler_status")) throw new Error("ds_butler_status 未注册");
  if (!names.includes("ds_butler_notify")) throw new Error("ds_butler_notify 未注册");

  const notify = registered.find((d) => d.name === "ds_butler_notify");
  const res = await notify.execute({ text: "自测" });
  return { names, calls, res, status: registered.find((d) => d.name === "ds_butler_status") };
}

// ── 场景 1：一切正常 ──────────────────────────────────────────────────────
console.log("### 场景 1：createTarget 成功、send 成功");
const s1 = await run((calls) => ({
  async createTarget(botId, t) { calls.push(["createTarget", botId, t]); return {}; },
  async send(botId, targetId, text) { calls.push(["send", botId, targetId, text]); return { sent: true }; },
}));
console.log("   注册工具:", s1.names.join(", "));
console.log("   调用:", JSON.stringify(s1.calls.map((c) => c[0])));
console.log("   结果:", JSON.stringify(s1.res));

// ── 场景 2：listBots 给出权威 botId ───────────────────────────────────────
console.log("");
console.log("### 场景 2：listBots 返回 weixin 渠道，应改用它的 botId");
const s2 = await run((calls) => ({
  async listBots() { return [{ botId: "wx_FROM_LISTBOTS", channel: "weixin" }]; },
  async createTarget(botId) { calls.push(["createTarget", botId]); return {}; },
  async send(botId) { calls.push(["send", botId]); return { sent: true }; },
}));
console.log("   createTarget 用的 botId:", s2.calls[0]?.[1]);
console.log("   结果:", JSON.stringify(s2.res));

// ── 场景 3：createTarget 报 unknown-bot ───────────────────────────────────
console.log("");
console.log("### 场景 3：createTarget 报 unknown-bot（渠道还没连上的情形）");
const s3 = await run(() => ({
  async listBots() { return []; },
  async createTarget() { const e = new Error("Unknown bot"); e.code = "unknown-bot"; throw e; },
  async send() { throw new Error("不该走到这里"); },
}));
console.log("   结果:", JSON.stringify(s3.res));

// ── 场景 4：目标已存在（target-conflict 视为正常） ────────────────────────
console.log("");
console.log("### 场景 4：目标已存在（target-conflict 应视为正常）");
const s4 = await run((calls) => ({
  async listBots() { return [{ botId: "wx_x", channel: "weixin" }]; },
  async createTarget() { const e = new Error("Target already exists"); e.code = "target-conflict"; throw e; },
  async send(botId, tid) { calls.push(["send", botId, tid]); return { sent: true }; },
}));
console.log("   结果:", JSON.stringify(s4.res));

// ── 状态总览仍在 ─────────────────────────────────────────────────────────
console.log("");
console.log("### 状态总览（scope=schedules，取前 5 行）");
const out = await s1.status.execute({ scope: "schedules" }, {});
console.log(out.text.split("\n").slice(0, 5).map((l) => "   " + l).join("\n"));

console.log("");
console.log("[OK] 四个场景全部跑完");
process.exit(0); // 后台预热定时器不该拖住进程
