# dsh-butler · DSH 总管家

> 让 DeepSeek Harness 有一个「管家」：跨工作区总览所有会话、任务看板、定时任务的运行状态；**会话跑完一轮就主动推微信**，不用你盯着屏幕。

![icon](icon.svg)

**简体中文** · [English](README.en.md)

---

## 它解决什么问题

DeepSeek Harness 可以同时开很多会话干活。问题是：

- 你**不知道哪个会话还在跑、哪个已经跑完了**
- 跑完了也**没人叫你**，得自己去翻
- 想让 AI 帮你查，它又**看不见别的会话**（每个 agent 只看得见自己）

`dsh-butler` 补上这三块。

## 功能

### 1. 全局状态总览工具 `ds_butler_status`

一次调用，列出**所有工作区**及每个会话最近状态、任务看板、定时任务。

| 参数 | 类型 | 说明 |
| --- | --- | --- |
| `scope` | `"all"` \| `"workspaces"` \| `"tasks"` \| `"schedules"` | 可选，只看某一部分 |

输出示例：

```
=== 工作区与会话 ===

## 我的项目
  路径: /path/to/my-project
  会话 3 个:
    - session-ca60  [完成]                     最后活动 2026-11-14 02:00
    - session-15f4  [运行中]                   最后活动 2026-11-14 02:25
    - session-4e40  [空会话（从未跑过回合）]    最后活动 2026-11-12 12:14

=== 会话状态统计（共 23 个） ===
  - 完成: 18
  - 运行中: 1
  - 报错: 2

=== 定时任务 ===
  - [active] 每日报告 · 下次 2026-11-15T08:00:00+08:00
```

### 2. 智能通知（会话完成自动推微信）

后台每 **60 秒**扫一遍所有会话；某个会话出现新的 `turn/end` 就推一条：

```
🐳 管家｜我的项目会话
01_中文在线 · 第 97 轮 ✅ 完成
本轮已结束，没有在等待的任务
本轮 14 次工具调用
其中队友协作 6 次（spawn_teammate、wait_agent）
全局：活跃 2 · 报错 1
```

每一行都来自会话日志的真实字段，**不是模型编的话**：

| 内容 | 来源 |
| --- | --- |
| 会话标题 | 日志里最近一条 `session/title` |
| 第 N 轮 | 最近一条 `turn/end` 的 `data.turn` |
| ✅完成 / ❌报错 / ⚠️超限 / ⏹中止 | 同一条的 `data.reason.kind` |
| 「没有在等待的任务」 | `turn/end` 已出现 = 该回合真的结束了 |
| 本轮工具调用次数 | `tool/call` 里 `data.turn == 该轮` 的条数 |
| 队友协作次数 | 上述工具名匹配 `spawn_teammate` / `wait_agent` / `send_message` / `list_agents` / `team_task` / `subagent` |
| 全局：活跃 X · 报错 Y | 活跃 = 日志 20 分钟内有改动；报错 = 最近一轮是 `error` / `max-tokens` |

**同轮只推一次**（状态存在 `~/.dsh/dsh-butler/notify-state.json`），首次运行只建立基线、不会把历史轮次刷屏。

### 3. 管家 Agent 预设

一个「总管家」人设 + 18 个工具（shell、文件读写搜索、后台任务、定时任务、目标、待办、联网、办公文档、子 agent、提问等）。

人设里写死了一份**能力清单**，你问「你有哪些功能」它会原样报出来。

### 4. 辅助工具

| 工具 | 用途 |
| --- | --- |
| `ds_butler_notify` | 往微信推一条文字（测试链路或主动汇报） |
| `ds_butler_watch` | `status` 看监测状态；`dryrun` 试运行，返回「会推什么」但不真推 |

## 安装

需要 DeepSeek Harness `0.2.2-rc.1` 或更新、Node.js 22.19+。

**插件本身零依赖**：只用 Node 内置模块，不 import 任何 `@deepseek-ai/*` 包。

### 从 GitHub 安装

```sh
npx -y github:SteelOcean2024/dsh-plugins install
```

### 从 npm 安装

```sh
dsh plugin --profile desktop add -w @steelocean2024/dsh-butler
```

### 从本地目录安装

把插件目录的**绝对路径**交给 DSH 里的 agent：

```
plugin_manager install_bundle target=<插件目录绝对路径>
```

或命令行：

```sh
dsh plugin --profile desktop add -w <插件目录绝对路径>
```

**装完重启 DSH。**

## 快速开始

### 桌面端

直接问就行：

> 看一下所有工作区，哪个任务没跑完？

### 微信 / IM 里

1. 装 `@xmanrui/dsh-im` 并接好机器人
2. **设置 → IM机器人 → 机器人卡片 → Agent Preset 选「管家」**
3. 建议在微信里发 `/new` 建一个**专属会话**，再在界面里改名成「管家」——这样管家对话和你的工作会话不会互相污染
4. 之后：

| 你说 | 它做 |
| --- | --- |
| 「看看所有工作区」 | 列出全部工作区 + 会话状态 |
| 「哪个任务没跑完」 | 报出运行中 / 报错的会话 |
| 「看定时任务」 | 列出定时任务与下次运行时间 |
| 「你有哪些功能」 | 复述管家人设里的能力清单 |
| 「在 XX 工作区做 YY」 | 派 agent 去干 |

### 微信推送（主动投递）

插件启动时会自动完成：

1. 读 `~/.dsh/integrations/dsh-weixin/config.json` 拿 `botId` 与 `ownerUserId`
2. 调 `ctx.dshIm.createTarget()` 建一个投递目标 `butler-notify`（已存在则跳过）
3. 渠道还没连上时**每 10 秒重试一次，最多 8 次**

> **你不需要去界面里点「新建目标」。** `dsh-im` 的那个按钮在目标列表读取完成前是灰的，位置也藏在机器人卡片的「更多设置」里；本插件直接用接口创建。

**注意**：微信主动投递依赖你**最近一次给机器人发消息**时产生的 `context_token`。如果推送报 `delivery-failed`，先在微信里给机器人随便发一句，再重试。

## 配置

`~/.dsh/dsh-butler/config.json`（不存在则用默认值）：

```json
{
  "enabled": true,
  "intervalSeconds": 60
}
```

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 关闭自动监测（推送工具仍可用） |
| `intervalSeconds` | `60` | 轮询间隔，最小 15 |

## 已知限制

- **只读**：不修改任何会话、配置或文件（除了自己的状态文件与投递目标）。
- **「运行中」是近似判定**：尾部没有 `turn/end` 时，按日志文件 mtime 是否在 20 分钟内区分「运行中 / 闲置」；日志小于 4 KB 的算「空会话」。
- **通知与其它插件的通知共存**：本插件的消息一律带 `🐳 管家｜` 前缀。
- **「队友协作 N 次」统计的是该回合用过哪些队友类工具**，不代表此刻还有队友在跑——回合已 `turn/end` 就不再等待任何东西。
- **不写会话日志**：全部状态来自读取现有事件。
- 单会话最多回看 150 帧；超过 64 MB 的日志跳过细扫。

## 兼容性

| 项 | 值 |
| --- | --- |
| DSH | `0.2.2-rc.1` 及以上 |
| Node.js | `>=22.19`（用到内置 `zlib.zstdDecompressSync`） |
| 依赖 | 无 |
| 可选 | `@xmanrui/dsh-im`（不装也能用，只是推不了微信） |

## 开发

```sh
# 离线自测：不需要 DSH 就能验证两个工具与推送链路
node test/selftest.mjs

# 监测循环集成测试：读本机真实会话日志
node test/watcher.mjs
```

写这类插件最容易踩的坑（都写进仓库根目录的 README）：
1. **profile 插件不能 `import "@deepseek-ai/*"`** —— profile 的 `node_modules` 里没有这些包，只能用注入的服务
2. `ctx.tools.register()` 收的是**普通对象 + 真 JSON Schema**，且 `render` 必须在 `output` **里面**
3. 会话日志是**多帧 zstd**，必须按 magic `28 B5 2F FD` 切帧逐帧解压

## 许可

[MIT](LICENSE)
