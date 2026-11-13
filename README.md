# DSH 插件合集

我自己维护的 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）插件集合。

每个插件一个独立目录，互不依赖，可以单独安装、单独升级。

---

## 插件目录

| 插件 | 作用 | 版本 | 状态 | 文档 |
| --- | --- | --- | --- | --- |
| [`dsh-butler`](plugins/dsh-butler/) | DSH 总管家：跨工作区总览所有会话、任务看板、定时任务的运行状态 | 1.0.0 | 可用 | [说明](plugins/dsh-butler/README.md) |

> 新增插件时，请同步在上表加一行。

---

## 快速开始

### 环境要求

- DeepSeek Harness `0.2.2-rc.1` 或更新
- Node.js 22+（`dsh-butler` 只用到 Node 内置模块，无需额外依赖）

### 方式一：让 DSH 里的 agent 装（推荐）

把插件目录的**绝对路径**告诉 DSH 里的 agent，让它安装：

```
plugin_manager install_bundle target=<插件目录绝对路径>
```

### 方式二：命令行装

```sh
dsh plugin --profile desktop add -w <插件目录绝对路径>
```

或者已发布到 npm 之后：

```sh
dsh plugin --profile desktop add -w <包名>
```

### 安装后

**重启 DSH**（`restart-dsh.bat` 之类），插件才会加载。然后在「设置」里确认对应条目已激活。

---

## 目录约定

```
04_dsh-plugins/
├── README.md                      ← 本文件：总说明 + 插件目录 + 使用方法
├── LICENSE
├── .gitignore
└── plugins/
    └── <插件名>/
        ├── package.json           插件清单，声明 dsh.bundle.patch
        ├── cordis.patch.yml       加载器补丁：插入宿主插件 / agent 预设
        ├── index.js               宿主半代码
        ├── locale/
        │   ├── zh.json            界面文案（中文）
        │   └── en.json            界面文案（英文）
        ├── icon.svg               插件图标
        └── README.md              这个插件自己的说明
```

一个 bundle 可以同时包含两类东西：

1. **宿主插件** —— `index.js` 里的 `apply(ctx)`，用来注册工具、服务、事件监听
2. **agent 预设** —— `cordis.patch.yml` 里插一条 `preset-<id>` 声明

---

## 开发规范（都是踩过的坑）

### 1. profile 插件不能 import `@deepseek-ai/*` 包

`~/.dsh/profiles/<profile>/node_modules/` 里**没有** `@deepseek-ai` 目录。所以插件里写

```js
import { defineTool } from "@deepseek-ai/dsh-tools";   // ❌ 会 ERR_MODULE_NOT_FOUND
```

装上去就会 `failed to import`。

**正确做法**：只用 Node 内置模块，需要宿主能力就用**注入的服务**：

```js
export const inject = ["tools"];

export function apply(ctx) {
  ctx.tools.register({ /* 普通对象 */ });
}
```

### 2. `ctx.tools.register()` 的对象形状

`register()` 的校验（源码 `@deepseek-ai/dsh-tools/lib/index.js`）只检查 `output`：

- `name` —— 工具名，不能是保留名 `run_code`
- `output.schema` —— 输出值的 JSON Schema
- `output.render` —— **函数**，`(args, value) => [{ type: "text", text }]`
- `parameters` —— 真 JSON Schema（**不是** `defineTool` 那套简写 DSL）
- `execute(args, exec)` —— 实现，返回值要匹配 `output.schema`

**注意**：`render` 在 `output` **里面**，不是顶层。官方 `defineTool()` 会把简写 DSL 转成 JSON Schema，但 profile 插件用不了它，所以要自己写全 JSON Schema。

### 3. 先在 DSH 之外自测

插件如果只依赖 Node 内置模块，就能脱离 DSH 跑：

```js
// _selftest.mjs
import { apply } from "./plugins/<插件名>/index.js";
let captured = null;
const ctx = { tools: { register(def) { captured = def; return () => {}; } } };
apply(ctx);
console.log(await captured.execute({}, {}));
```

这样能在重启 DSH 之前就确认工具真的能跑，不用拿重启当调试手段。

### 4. 插件失败 ≠ 宿主崩溃

激活失败的插件只是那一行显示 `failed`（比如工具名冲突），不会拖垮整个宿主。
**例外**：绑定固定端口的插件（如浏览器桥占 9777）失败会 `fatal load failure`，拖垮宿主。写这类插件要特别小心。

---

## 推送到 GitHub

这个目录本身就是一个可以独立成仓的仓库：

```sh
cd <本仓库目录>
git init
git add .
git commit -m "feat: 初始化插件合集，加入 dsh-butler"
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
```

建议在 GitHub 仓库设置里加 Topics：`deepseek-harness`、`dsh-plugin`，方便别人搜到。

---

## 许可

MIT，见 [LICENSE](LICENSE)。
