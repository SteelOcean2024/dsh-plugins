# dsh-butler v2 路线图：自带微信通道

> **目标**：安装 `@steelocean2024/dsh-butler` 一个包，就自带微信通道——收消息 → 路由到 DSH 会话 → 驱动 agent 回合 → 回消息。装完之后 `@xmanrui/dsh-im` **可以卸载**。

状态：**规划中** · 本文件是可执行的施工图，按阶段推进，每阶段有独立验收标准。

---

## 为什么自己做（决策记录）

用户要求「完整独立的插件，装我的、删旧的」，而不是在 `dsh-im` 上打补丁。参考实现在 GitHub 上公开（MIT）：

- https://github.com/xmanrui/dsh-im
- 它覆盖 **13 个渠道**（微信/飞书/钉钉/企微/QQ/Slack/Telegram/Discord/WhatsApp/iMessage/Matrix/邮件/AI Office），880 文件
- 我们**只做微信一个渠道**，把「够用」当作范围边界

## 参考实现的规模（实测，用来估工）

| 部分 | 路径 | 大小 |
| --- | --- | --- |
| **微信渠道本体** | `plugin-src/host/channels/weixin/{index,production,rpc,connection-supervisor}.mjs` | 2.0 + 12.2 + 13.2 + 4.3 KB |
| 渠道共享框架 | `plugin-src/host/channels/shared/*.mjs` | ≈ 40 KB |
| **驱动 agent 的 API 层** | `plugin-src/host/modern-harness-api.mjs` | **39.8 KB** |
| 会话协调 | `plugin-src/host/harness-session-coordinator.mjs` | 6.8 KB |
| 连接 / 身份 | `harness-connection.mjs` · `harness-peer.mjs` | 0.7 + 0.7 KB |
| 主动投递 | `plugin-src/host/delivery-{adapter,http,rpc,service,suggestions,sync-rpc}.mjs` | ≈ 70 KB |
| 会话标题前缀 | `plugin-src/host/session-title-prefix.mjs` | 5.5 KB |
| 插件入口 | `plugin-src/host/index.mjs` | 13.5 KB |
| 客户端半（设置界面） | `plugin-src/client/**` | 大（本轮不做） |

**估算**：只做「微信 + 会话路由 + 回复 + 主动推送」的最小闭环，目标 **手写 ≤ 150 KB**。

## 已经摸清的接口与配置（不用再逆向）

### 微信（iLink）服务端

| 项 | 值 / 位置 |
| --- | --- |
| baseUrl | `https://ilinkai.weixin.qq.com/` |
| 账号配置 | `accounts[0]` in `~/.dsh/integrations/dsh-weixin/config.json` |
| `botId` | `wx_e0dd15abe6830ab312c80c6f`（本机实例；实现里必须动态读） |
| `accountId` | `35822d86fd85@im.bot` |
| `ownerUserId` | 主人的微信 ID，即发送时的 `toUserId` |
| bot token | DSH 凭据存储，`tokenRef = DSH_WEIXIN_BOT_TOKEN_<BOTID 大写>` |
| 账号状态 | `~/.dsh/integrations/dsh-weixin/accounts/<botId>/state.json` |

`state.json` 里已在用的字段（照抄语义即可）：

```jsonc
{
  "sessions": { "p2p:<userId>": "session-<uuid>" },  // 聊天 → DSH 会话 的绑定
  "seenMessageIds": [ /* 去重用 */ ],
  "getUpdatesBuf": "<长轮询游标>",                     // 必须持久化，否则重启会重复收
  "recentOutboundMessages": [ /* 发件记录，用于排障 */ ],
  "contextTokens": {
    "credentialHash": "...",
    "users": { "<userId>": { "token": "...", "seq": "30", "messageTimeMs": 0, "receivedAt": 0 } }
  }
}
```

**⚠️ 关键约束（已在生产验证过）**：主动发送依赖 `contextTokens.users[<userId>].token`，它是**用户最近一次给机器人发消息**时刷新的。令牌过期时平台会拒发（表现为 `delivery-failed`）。所以：

- 收到消息时**必须**刷新该用户的 context_token
- 发送失败时给出「请先在微信里发一条消息」的可操作提示，**不要盲目重试**

### DSH 侧（驱动 agent 回合）

需要确认并可用的能力（对照 `modern-harness-api.mjs` 与 `harness-session-coordinator.mjs`）：

1. 创建 / 恢复一个会话（拿到 `sessionId`）
2. 把一条用户消息提交给该会话，并等待本轮结束
3. 取回本轮**最终回答文本**（不是过程拼接）
4. 订阅轮次结束（`turn/end`）、审批请求等事件
5. 会话工作目录、Agent Preset、模型等设置

> 参考实现里的 `docs/client-integration.md`、`docs/bot-commands.md`、`docs/上下文增强.md` 值得先读。

## 阶段计划

### P0 · 参考实现离线留存

- 把 `xmanrui/dsh-im` 的**源码**（不是发布包）克隆到本地只读目录供对照
- 目的：协议细节、边界情况、错误码语义有据可查；**代码不直接抄进来**，只作参考
- 验收：本地能打开 `plugin-src/host/channels/weixin/production.mjs` 并读懂主流程

### P1 · iLink 客户端（纯协议，不碰 DSH）

独立成一个模块，可单测：

- `getUpdates` 长轮询（游标 `getUpdatesBuf` 持久化、超时/退避、断线重连）
- 发送文本（含分段；微信单条上限约 1800 字）
- `context_token` 的读取与刷新
- `seenMessageIds` 去重
- 验收：写一个 `test/ilink.mjs`，只读模式跑通「收一条 → 打印；发一条 → 送达」

### P2 · 会话路由

- 聊天键 `<type>:<id>`（私聊 `p2p:<userId>`）↔ DSH `sessionId` 的绑定表，持久化
- 首次消息：新建会话并绑定；已有绑定：恢复该会话
- `/new`、`/session`、`/workspace` 等最小命令集
- 验收：同一私聊连续两条消息进同一个会话；`/new` 后进新会话

### P3 · 驱动 agent 回合

- 提交用户消息、等待本轮结束、取回最终回答
- 过程反馈：先回「已收到」，跑完再回结果（微信没有流式卡片）
- 错误映射：把 `turn/end` 的 `reason.kind` 翻成人话
- 审批：`dsh-approval-gate` 的请求要不要转到微信（**可选**，先不做）
- 验收：在微信里问「现在几点」，30 秒内收到 agent 回答

### P4 · 回复渲染

- Markdown → 微信可读的降级（表格转文本、代码块加围栏、去掉微信不认的语法）
- 超长分段、消息顺序保证
- 验收：让 agent 回一张 Markdown 表格，微信里读得通

### P5 · 叠加管家能力（复用 dsh-butler 现有实现）

- 保留 `ds_butler_status` / `ds_butler_watch` / 管家预设
- 把「会话完成主动提醒」的投递出口从 `ctx.dshIm.send()` 换成自带通道的发送函数
- 验收：会话跑完 → 微信收到 `🐳 管家｜…`，且不再依赖 dsh-im

### P6 · 设置界面（客户端半）— 可选

- 机器人列表、二维码登录/绑定、投递目标、通用设置
- 界面是这类插件最费时的部分；**没有界面也能用**（配置走 JSON），所以放最后
- 验收：能扫码绑定一个新机器人

### P7 · 打包发布

- 包名不变（`@steelocean2024/dsh-butler`），版本升到 `2.0.0`
- `dsh.compatibility` 按实测更新
- 发布 npm；GitHub Release 写清「从 v1 升级：可以卸载 dsh-im」
- 验收：干净机器上只装这一个包就能收微信

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| **iLink 协议未公开**，靠参考实现反推 | P0 先离线留存源码；P1 单独成模块、可单测，协议层与业务层解耦 |
| **驱动 agent 的 API 层复杂**（参考实现 40 KB） | P3 单独成阶段；先做「提交一条、等一个回复」的最小闭环，不做流式 |
| **微信主动推送受平台规则限制**（context_token 时效） | v1 已踩过；P1 就把「刷新 + 可操作错误提示」做进去 |
| **上游协议变更** | 参考实现可随时对照；本项目只覆盖微信，改动面小 |
| 界面工作量被低估 | P6 明确标为可选，允许长期只有 JSON 配置 |

## 当前状态

- [x] 摸清参考实现的文件结构与规模
- [x] 记录已确认的接口、配置路径与关键约束
- [ ] P0 参考实现离线留存
- [ ] P1 iLink 客户端
- [ ] P2 会话路由
- [ ] P3 驱动 agent 回合
- [ ] P4 回复渲染
- [ ] P5 叠加管家能力
- [ ] P6 设置界面（可选）
- [ ] P7 打包发布
