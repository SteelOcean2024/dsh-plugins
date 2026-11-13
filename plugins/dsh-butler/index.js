import { homedir } from "node:os";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { zstdDecompressSync } from "node:zlib";

export const name = "dsh-butler";
export const inject = ["tools"];

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const MAX_FRAMES_PER_SESSION = 24;
const MAX_SESSIONS = 300;
const MAX_LOG_BYTES = 64 * 1024 * 1024;

function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

function listDir(p) {
  try { return readdirSync(p); } catch { return []; }
}

// 从会话日志尾部往前找最后一个 turn/end 的 reason.kind
function lastTurnState(sessionDir) {
  const log = join(sessionDir, "session.v4.jsonl.zstd");
  if (!existsSync(log)) return { kind: "empty" };
  let size = 0;
  try { size = statSync(log).size; } catch { return { kind: "unreadable" }; }
  if (size === 0) return { kind: "empty" };
  if (size > MAX_LOG_BYTES) return { kind: "toolarge" };
  let buf;
  try { buf = readFileSync(log); } catch { return { kind: "unreadable" }; }

  const offs = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i += 4; }
  if (offs.length === 0) return { kind: "unreadable" };

  const start = Math.max(0, offs.length - MAX_FRAMES_PER_SESSION);
  for (let k = offs.length - 1; k >= start; k--) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    let text;
    try { text = zstdDecompressSync(buf.subarray(offs[k], end)).toString("utf8"); } catch { continue; }
    const lines = text.split("\n");
    for (let li = lines.length - 1; li >= 0; li--) {
      const t = lines[li].trim();
      if (!t) continue;
      let rec;
      try { rec = JSON.parse(t); } catch { continue; }
      if (rec.type === "turn/end" && rec.data?.reason?.kind) {
        return { kind: rec.data.reason.kind };
      }
    }
  }
  return { kind: "active" };
}

const KIND_LABEL = {
  completed: "完成", error: "报错", "max-tokens": "上下文超限",
  interrupted: "被打断", aborted: "中止", active: "运行中",
  idle: "闲置", empty: "空会话（从未跑过回合）", unreadable: "不可读", toolarge: "日志过大",
};

// 最后活动在这个时间窗内，才把「尾部没有 turn/end」的会话算作「运行中」
const ACTIVE_WINDOW_MS = 20 * 60 * 1000;

function scanSessions(home) {
  const map = new Map();
  const sroot = join(home, "sessions");
  for (const slug of listDir(sroot)) {
    const slugDir = join(sroot, slug);
    let st;
    try { st = statSync(slugDir); } catch { continue; }
    if (!st.isDirectory()) continue;
    for (const sid of listDir(slugDir)) {
      if (!sid.startsWith("session-")) continue;
      const dir = join(slugDir, sid);
      let mtime = 0, size = 0;
      // 必须用日志文件的 mtime：会话目录的 mtime 停在创建时刻，活跃会话读它会误判成「闲置」
      try { const st2 = statSync(join(dir, "session.v4.jsonl.zstd")); mtime = st2.mtimeMs; size = st2.size; }
      catch { try { mtime = statSync(dir).mtimeMs; } catch {} }
      map.set(sid, { dir, mtime, size });
    }
    if (map.size > MAX_SESSIONS) break;
  }
  return map;
}

function collectTaskBoard(home) {
  const ledger = readJson(join(home, "task-board", "ledger-v2.json"));
  if (!ledger) return null;
  // 真实形状：{ schemaVersion, revision, tasks: [...], scheduler, recentRequests }
  const tasks = Array.isArray(ledger.tasks) ? ledger.tasks : [];
  return tasks.map((t) => ({
    title: t?.title || "(untitled)",
    status: t?.column || t?.status || "unknown",
  }));
}

function collectSchedules(home) {
  const s = readJson(join(home, "storages", "schedule.json"));
  if (!s) return null;
  // 真实形状：{ unit, global, tables: { tasks: { "schedule-<uuid>": { record, status, ... } } } }
  const tasks = s?.tables?.tasks;
  if (!tasks || typeof tasks !== "object") return null;
  return Object.values(tasks).map((v) => {
    const rec = v?.record || {};
    return {
      title: rec.title || "(untitled)",
      status: v?.status || "unknown",
      next: rec.scheduledAtLocal || rec.scheduledAt || null,
    };
  });
}

function renderState(scope) {
  const home = dshHome();
  const sessionMap = scanSessions(home);
  const lines = [];
  const byPath = new Map();

  const reg = readJson(join(home, "storages", "workspace.json"));
  if (reg?.tables?.workspaces) {
    for (const w of Object.values(reg.tables.workspaces)) {
      byPath.set(w.path, {
        title: w.title || basename(w.path),
        sessions: Array.isArray(w.sessionIds) ? w.sessionIds : [],
      });
    }
  }

  // 用本地时间展示：toISOString() 是 UTC，会比本地时间早 8 小时，别用
  const fmtTime = (ms) => {
    if (!ms) return "?";
    const d = new Date(ms);
    const p = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  const tally = {};
  const wantAll = !scope || scope === "all";
  const wantWs = wantAll || scope === "workspaces";

  if (wantWs) {
    lines.push("=== 工作区与会话 ===");
    let total = 0;
    for (const [path, w] of byPath) {
      lines.push("");
      lines.push(`## ${w.title}`);
      lines.push(`  路径: ${path}`);
      lines.push(`  会话 ${w.sessions.length} 个:`);
      for (const sid of w.sessions.slice(0, MAX_SESSIONS)) {
        total++;
        const s = sessionMap.get(sid);
        if (!s) { lines.push(`    - ${sid.slice(0, 12)}  [未知目录]`); continue; }
        const st = lastTurnState(s.dir);
        let kind = st?.kind ?? "unknown";
        // 尾部没有 turn/end 的三种情况要分开：
        //   日志极小（只有会话头+策略记录）= 从没跑过回合的空会话
        //   最近有活动 = 运行中
        //   久没动   = 闲置
        if (kind === "active" && (s.size ?? 0) < 4096) kind = "empty";
        else if (kind === "active" && Date.now() - s.mtime > ACTIVE_WINDOW_MS) kind = "idle";
        tally[kind] = (tally[kind] || 0) + 1;
        lines.push(`    - ${sid.slice(0, 12)}  [${KIND_LABEL[kind] || kind}]  最后活动 ${fmtTime(s.mtime)}`);
      }
    }

    // 未登记工作区（只在 sessions 目录里）
    const known = new Set();
    for (const w of byPath.values()) for (const s of w.sessions) known.add(s);
    const orphanSlugs = new Map();
    const sroot = join(home, "sessions");
    for (const slug of listDir(sroot)) {
      const slugDir = join(sroot, slug);
      let st;
      try { st = statSync(slugDir); } catch { continue; }
      if (!st.isDirectory()) continue;
      const ids = listDir(slugDir).filter((x) => x.startsWith("session-"));
      const extra = ids.filter((x) => !known.has(x));
      if (extra.length > 0) orphanSlugs.set(slug, extra.length);
    }
    if (orphanSlugs.size > 0) {
      lines.push("");
      lines.push("=== 未登记工作区（只存在于 sessions 目录） ===");
      for (const [slug, n] of orphanSlugs) lines.push(`  - ${slug}（${n} 个会话）`);
    }

    lines.push("");
    lines.push(`=== 会话状态统计（共 ${total} 个） ===`);
    for (const [kind, n] of Object.entries(tally)) {
      lines.push(`  - ${KIND_LABEL[kind] || kind}: ${n}`);
    }
  }

  if (wantAll || scope === "tasks") {
    lines.push("");
    lines.push("=== 任务看板 ===");
    const cards = collectTaskBoard(home);
    if (cards === null) {
      lines.push("  (无任务看板数据)");
    } else if (cards.length === 0) {
      lines.push("  (看板上没有任务卡)");
    } else {
      const byStatus = {};
      for (const c of cards) { (byStatus[c.status] ||= []).push(c.title); }
      for (const [st, titles] of Object.entries(byStatus)) {
        lines.push(`  [${st}] ${titles.length} 项`);
        for (const t of titles.slice(0, 20)) lines.push(`    - ${t}`);
      }
    }
  }

  if (wantAll || scope === "schedules") {
    lines.push("");
    lines.push("=== 定时任务 ===");
    const sched = collectSchedules(home);
    if (sched === null || sched.length === 0) {
      lines.push("  (无定时任务)");
    } else {
      for (const t of sched) {
        lines.push(`  - [${t.status}] ${t.title}${t.next ? " · 下次 " + t.next : ""}`);
      }
    }
  }

  return lines.join("\n");
}

// 注意：这里直接给 ctx.tools.register 传普通对象 + 真 JSON Schema。
// profile 插件无法 import @deepseek-ai/dsh-tools（该包不在 profile 的 node_modules 里），
// 所以不能用 defineTool()；register() 只校验 output.{schema,render}（源码已确认）。
export function apply(ctx) {
  ctx.tools.register({
    name: "ds_butler_status",
    description: "总揽全局：列出所有工作区、每个会话最近状态（完成/报错/超限/运行中）、任务看板各状态卡片、定时任务及下次运行时间。回答「哪些任务在跑/做完了/报错」时用它取真实数据。",
    parameters: {
      type: "object",
      properties: {
        scope: {
          type: "string",
          enum: ["all", "workspaces", "tasks", "schedules"],
          description: "可选：只看某一部分。'workspaces' 工作区与会话，'tasks' 任务看板，'schedules' 定时任务。省略或 'all' 返回全部。",
        },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args, exec) {
      if (exec?.signal?.aborted) throw new Error("cancelled");
      return { text: renderState(args?.scope) };
    },
  });

  // 接入微信主动投递：dsh-im 在时装上，不在时插件照常工作（工具仍可用）
  ctx.inject(["dshIm"], (imCtx) => setupImNotify(imCtx));
}

// ── 微信主动投递（第二阶段：智能通知的基础）──────────────────────────────

const BUTLER_TARGET_ID = "butler-notify";

// 从 dsh-im 的微信配置里读出 botId 和主人微信 ID，避免硬编码
function readWechatBot(home) {
  const cfg = readJson(join(home, "integrations", "dsh-weixin", "config.json"));
  const a = cfg?.accounts?.[0];
  if (!a?.botId || !a?.ownerUserId) return null;
  return { botId: a.botId, toUserId: a.ownerUserId };
}

function setupImNotify(imCtx) {
  const im = imCtx.dshIm;
  if (!im) return;
  const home = dshHome();
  const bot = readWechatBot(home);
  if (!bot) return;

  const say = (level, msg) => { try { imCtx.logger?.[level]?.(msg); } catch {} };

  let ensureState = null;   // 最近一次 ensureTarget 的结果
  let ensureInflight = null;

  // 用插件自己的 listBots() 拿权威 botId；它读不到才退回配置文件里的值
  async function resolveBotId() {
    if (typeof im.listBots !== "function") {
      return { botId: bot.botId, bots: null, note: "dshIm 没有 listBots，用配置文件里的 botId" };
    }
    let bots;
    try { bots = await im.listBots(); }
    catch (e) { return { botId: bot.botId, bots: null, note: "listBots 抛错：" + (e?.message ?? e) }; }
    if (!Array.isArray(bots) || bots.length === 0) {
      return { botId: bot.botId, bots, note: "listBots 返回空（微信渠道可能还没连上）" };
    }
    const hit = bots.find((b) => b?.channel === "weixin") ?? bots.find((b) => b?.botId === bot.botId);
    if (hit?.botId) return { botId: hit.botId, bots, note: null };
    return { botId: bot.botId, bots, note: "listBots 里没有 weixin 渠道" };
  }

  // 懒加载 + 可重试：apply 时渠道可能还没注册，不能在那里硬建目标
  async function ensureTarget() {
    if (ensureState?.ok) return ensureState;
    if (ensureInflight !== null) return ensureInflight;
    ensureInflight = (async () => {
      const create = im.createTarget ?? im.createDeliveryTarget;
      if (typeof create !== "function") {
        return { ok: false, botId: bot.botId, error: "dshIm 没有 createTarget 方法", bots: null, note: null };
      }
      const r = await resolveBotId();
      try {
        await create.call(im, r.botId, {
          targetId: BUTLER_TARGET_ID,
          kind: "user",
          route: { toUserId: bot.toUserId },
          name: "管家通知",
        });
        return { ok: true, botId: r.botId, created: true, bots: r.bots, note: r.note };
      } catch (e) {
        const code = String(e?.code ?? "");
        if (code.includes("conflict")) {
          return { ok: true, botId: r.botId, existed: true, bots: r.bots, note: r.note };
        }
        return { ok: false, botId: r.botId, error: `${code} ${e?.message ?? e}`.trim(), bots: r.bots, note: r.note };
      }
    })();
    try { ensureState = await ensureInflight; } finally { ensureInflight = null; }
    return ensureState;
  }

  const sendText = (text, botId) => {
    const fn = typeof im.send === "function" ? im.send
      : typeof im.sendText === "function" ? im.sendText
      : null;
    if (fn === null) throw new Error("dshIm 没有可用的发送方法");
    return fn.call(im, botId, BUTLER_TARGET_ID, text);
  };

  imCtx.tools.register({
    name: "ds_butler_notify",
    description: "给主人的微信推送一条文字消息（走 dsh-im 主动投递）。用于测试推送链路或主动汇报。",
    parameters: {
      type: "object",
      properties: { text: { type: "string", description: "要推送的文字内容" } },
      required: ["text"],
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { sent: { type: "boolean" }, detail: { type: "string" } },
        required: ["sent", "detail"],
      },
      render: (_args, value) => [{ type: "text", text: value.detail }],
    },
    async execute(args) {
      const text = String(args?.text ?? "");
      const t = await ensureTarget();
      if (!t.ok) {
        return {
          sent: false,
          detail: `建投递目标失败：${t.error}｜botId=${t.botId}｜listBots=${JSON.stringify(t.bots)}${t.note ? "｜" + t.note : ""}`,
        };
      }
      try {
        await sendText(text, t.botId);
        return {
          sent: true,
          detail: `已推送到微信（${text.length} 字）｜botId=${t.botId}｜目标 ${BUTLER_TARGET_ID}${t.existed ? "（已存在）" : "（刚新建）"}`,
        };
      } catch (e) {
        ensureState = null;   // 让下次调用重建目标
        return { sent: false, detail: `推送失败：${e?.code ?? ""} ${e?.message ?? e}｜botId=${t.botId}`.trim() };
      }
    },
  });

  // 后台预热：渠道连上后把目标建好。失败只写日志，工具调用时会再试
  void (async () => {
    for (let i = 0; i < 8; i++) {
      const t = await ensureTarget();
      if (t.ok) {
        say("info", `dsh-butler: 投递目标就绪（botId=${t.botId}${t.existed ? "，已存在" : "，新建"}）`);
        return;
      }
      say("warn", `dsh-butler: 第 ${i + 1} 次建投递目标失败：${t.error}；10 秒后重试`);
      ensureState = null;
      await new Promise((r) => setTimeout(r, 10000));
    }
  })();

  // 第二阶段：会话完成监测 + 智能通知
  startWatcher(imCtx, im, bot);
}

// ── 第二阶段：会话完成监测 + 智能通知 ─────────────────────────────────────

const KIND_NOTICE = {
  completed: "✅ 完成",
  error: "❌ 报错",
  "max-tokens": "⚠️ 上下文超限",
  interrupted: "⚠️ 被打断",
  aborted: "⏹ 已中止",
};

// 这些工具名说明本轮动用了队友 / 子智能体
const TEAM_TOOL_RE = /^(spawn_teammate|send_message|wait_agent|list_agents|team_task|subagent)/;

const butlerConfigPath = () => join(dshHome(), "dsh-butler", "config.json");
const butlerStatePath = () => join(dshHome(), "dsh-butler", "notify-state.json");

// 状态版本：扫描逻辑变了就 +1，让老基线自动作废。
// 为什么必须有：插件启动时把状态一次性读进内存，之后只改内存再写回磁盘，
// 外部删除状态文件是无效的（内存那份会被原样写回）。版本号是唯一的自救手段。
//   v1 -> v2：修掉「尾部找标题的兜底把 lastTurn 冲成远古值」的 bug
const STATE_VERSION = 2;

function readButlerConfig() {
  const c = readJson(butlerConfigPath()) ?? {};
  const n = Number(c.intervalSeconds);
  return {
    enabled: c.enabled !== false,
    intervalSeconds: Number.isFinite(n) && n >= 15 ? n : 60,
  };
}

function readNotifyState() {
  const s = readJson(butlerStatePath());
  if (s && s.version === STATE_VERSION && typeof s.sessions === "object" && s.sessions !== null) return s;
  return { version: STATE_VERSION, sessions: {} };
}

function writeNotifyState(state) {
  try {
    mkdirSync(join(dshHome(), "dsh-butler"), { recursive: true });
    writeFileSync(butlerStatePath(), JSON.stringify(state, null, 2), "utf8");
  } catch {}
}

// 从日志尾部读「最后一轮」：轮号、结果、标题、该轮的工具调用名
//   实测：turn/end 的 data = { turn, reason:{kind} }
//         tool/call 的 data = { turn, step, callId, name, arguments }
//         session/title 的 data = { title }
function scanSessionProgress(sessionDir) {
  const log = join(sessionDir, "session.v4.jsonl.zstd");
  let size = 0;
  try { size = statSync(log).size; } catch { return null; }
  if (size === 0 || size > MAX_LOG_BYTES) return null;
  let buf;
  try { buf = readFileSync(log); } catch { return null; }

  const offs = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i += 4; }
  if (offs.length === 0) return null;

  let lastTurn = null;
  let lastKind = null;
  let title = null;
  const toolsByTurn = new Map();

  const eat = (text) => {
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let rec;
      try { rec = JSON.parse(t); } catch { continue; }
      const d = rec.data;
      if (rec.type === "session/title" && typeof d?.title === "string") {
        title = d.title;
      } else if (rec.type === "turn/end" && typeof d?.turn === "number") {
        lastTurn = d.turn;
        lastKind = d?.reason?.kind ?? "unknown";
      } else if (rec.type === "tool/call" && typeof d?.turn === "number" && typeof d?.name === "string") {
        const arr = toolsByTurn.get(d.turn) ?? [];
        arr.push(d.name);
        toolsByTurn.set(d.turn, arr);
      }
    }
  };

  const frameText = (k) => {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    try { return zstdDecompressSync(buf.subarray(offs[k], end)).toString("utf8"); } catch { return null; }
  };

  const TAIL_FRAMES = 150;
  for (let k = Math.max(0, offs.length - TAIL_FRAMES); k < offs.length; k++) {
    const text = frameText(k);
    if (text !== null) eat(text);
  }
  if (lastTurn === null) return { turn: null, kind: null, title, tools: [] };
  return { turn: lastTurn, kind: lastKind, title, tools: toolsByTurn.get(lastTurn) ?? [] };
}

// 找「最近一次」的会话标题：从尾部往回扫，第一个命中就是最新的。
// 只在真要发通知时调用（尾部窗口通常没有标题，所以不能每次 tick 都做）。
// ⚠️ 不要用 scanSessionProgress 的 eat() 来兜底找标题——它会同时覆盖 lastTurn。
function findSessionTitle(sessionDir) {
  const log = join(sessionDir, "session.v4.jsonl.zstd");
  let buf;
  try { buf = readFileSync(log); } catch { return null; }
  const offs = [];
  let i = 0;
  while ((i = buf.indexOf(MAGIC, i)) !== -1) { offs.push(i); i += 4; }
  const CAP = 2000;
  for (let k = offs.length - 1; k >= Math.max(0, offs.length - CAP); k--) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    let text;
    try { text = zstdDecompressSync(buf.subarray(offs[k], end)).toString("utf8"); } catch { continue; }
    let found = null;
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      let rec;
      try { rec = JSON.parse(t); } catch { continue; }
      if (rec.type === "session/title" && typeof rec.data?.title === "string") found = rec.data.title;
    }
    if (found !== null) return found;
  }
  return null;
}

function formatNotice(n, globalLine) {
  const lines = [
    `🐳 管家｜${n.title ?? n.sid.slice(0, 12)}`,
    `${n.wsTitle} · 第 ${n.turn} 轮 ${KIND_NOTICE[n.kind] ?? n.kind}`,
  ];
  // 直接回答「是整任务完了，还是还在等」——turn/end 出现即代表这个回合真的结束了
  if (n.kind === "completed") lines.push("本轮已结束，没有在等待的任务");
  else if (n.kind === "error") lines.push("⚠️ 回合以报错结束，建议看一眼");
  else if (n.kind === "max-tokens") lines.push("⚠️ 上下文超限，需压缩后继续");
  else if (n.kind === "interrupted") lines.push("⚠️ 回合被打断，可能需要重发");
  lines.push(`本轮 ${n.tools.length} 次工具调用`);
  const team = n.tools.filter((t) => TEAM_TOOL_RE.test(t));
  if (team.length > 0) {
    lines.push(`其中队友协作 ${team.length} 次（${[...new Set(team)].slice(0, 4).join("、")}）`);
  }
  if (globalLine) lines.push(globalLine);
  return lines.join("\n");
}

function startWatcher(imCtx, im, bot) {
  const cfg = readButlerConfig();
  if (!cfg.enabled) return;

  const state = readNotifyState();
  let primed = Object.keys(state.sessions).length > 0;
  let busy = false;

  async function tick(dryRun) {
    if (busy) return { skipped: true };
    busy = true;
    try {
      // 试运行用状态副本，避免把真实基线推进掉
      const st = dryRun ? JSON.parse(JSON.stringify(state)) : state;
      const home = dshHome();
      const map = scanSessions(home);

      const wsTitleOf = new Map();
      const reg = readJson(join(home, "storages", "workspace.json"));
      if (reg?.tables?.workspaces) {
        for (const w of Object.values(reg.tables.workspaces)) {
          for (const sid of (w.sessionIds ?? [])) wsTitleOf.set(sid, w.title || basename(w.path));
        }
      }

      const notices = [];
      let changed = false;
      for (const [sid, s] of map) {
        const prev = st.sessions[sid] ?? {};
        if (prev.lastMtime === s.mtime) continue;
        const p = scanSessionProgress(s.dir);
        if (p === null || p.turn === null) {
          st.sessions[sid] = { ...prev, lastMtime: s.mtime };
          changed = true;
          continue;
        }
        const isNew = p.turn > (prev.lastTurn ?? 0);
        // 标题：先用尾部扫到的；只有真要发通知且仍没有时，才做代价较高的「最近标题」查找
        let title = p.title ?? prev.title ?? null;
        if (isNew && primed && title === null) title = findSessionTitle(s.dir);
        st.sessions[sid] = {
          lastTurn: p.turn,
          lastKind: p.kind,
          lastMtime: s.mtime,
          ...(title !== null ? { title } : {}),
        };
        changed = true;
        // 首次只建立基线，不把历史轮次全推一遍
        if (isNew && primed) notices.push({ sid, ...p, title, wsTitle: wsTitleOf.get(sid) ?? "?" });
      }

      const now = Date.now();
      let active = 0;
      for (const s of map.values()) if (now - s.mtime < ACTIVE_WINDOW_MS) active++;
      let errs = 0;
      for (const v of Object.values(st.sessions)) {
        if (v.lastKind === "error" || v.lastKind === "max-tokens") errs++;
      }
      const globalLine = `全局：活跃 ${active} · 报错 ${errs}`;
      const out = notices.map((n) => formatNotice(n, globalLine));

      if (!dryRun) {
        if (changed) writeNotifyState(state);
        for (const text of out) {
          try { await im.send.call(im, bot.botId, BUTLER_TARGET_ID, text); } catch {}
        }
      }
      primed = true;
      return { out, changed };
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => { void tick(false); }, cfg.intervalSeconds * 1000);
  try { imCtx.effect?.(() => () => clearInterval(timer)); } catch {}
  void tick(false);   // 首次只建立基线

  imCtx.tools.register({
    name: "ds_butler_watch",
    description: "会话完成监测：status 看监测状态；dryrun 试运行，返回「会推什么」但不真的推送。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["status", "dryrun"], description: "status=看状态；dryrun=试运行（不真推）" },
      },
    },
    output: {
      schema: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      render: (_args, value) => [{ type: "text", text: value.text }],
    },
    async execute(args) {
      if ((args?.action ?? "status") === "status") {
        const c = readButlerConfig();
        const rows = Object.entries(state.sessions)
          .sort()
          .map(([sid, v]) => (v.lastTurn == null
            ? `  ${sid.slice(0, 12)}  空会话（从未跑过回合）`
            : `  ${sid.slice(0, 12)}  第 ${v.lastTurn} 轮  ${v.lastKind ?? "?"}`));
        return {
          text: [
            `监测：${c.enabled ? "开启" : "关闭"}，间隔 ${c.intervalSeconds} 秒，基线已建立=${primed}`,
            `已记录 ${rows.length} 个会话：`,
            ...rows.slice(0, 30),
          ].join("\n"),
        };
      }
      const r = await tick(true);
      if (r.skipped) return { text: "上一轮还在跑，稍后再试" };
      if (r.out.length === 0) return { text: "试运行：当前没有需要推送的新完成" };
      return { text: `试运行（未真推，共 ${r.out.length} 条）：\n\n${r.out.join("\n---\n")}` };
    },
  });
}
