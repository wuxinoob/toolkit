# 插件开发手册

面向**写插件的人**。讲的是「我要做一个功能，该怎么落地、怎么排查」。

协议与内部实现不在这里 —— 那些在 `docs/PROTOCOL.md`（信封与方案表）、
`docs/INTERFACES.md`（13 个原生命令 / 9 服务 35 动作）、`docs/UI.md`（样式与令牌）、
`docs/MESSAGE-FRAMEWORK.md`（消息平面的设计来由）。本手册只引用结论，不重复论证。

| 文件 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 五层架构，每层给什么保证、边界在哪 |
| [manifest.md](manifest.md) | `plugin.json` 完整参考 |
| [api.md](api.md) | `ctx` 全表面，按**任务**组织 |
| [bridge.md](bridge.md) | **插件窗口 vs 主窗口**：`bridge` 与 `ctx` 差异的唯一权威清单 + 每处的替代写法 |
| [ui.md](ui.md) | 界面怎么做：组件工厂 + 令牌 |
| [storage.md](storage.md) | 本地读写：能写什么、落在哪、为什么不用 fs/sql/store |
| [FILE-ACCESS-PLAN.md](FILE-ACCESS-PLAN.md) | **已评估（路线 D），fs 读写暂不实施**：文件访问的可行性与四条路线（§七）；插件窗口的 `onDrop` **已实施**、`focusView` 仍是方案（§八） |
| [debugging.md](debugging.md) | 出问题时按什么顺序查（**归因手册**） |
| [recipes.md](recipes.md) | 常见功能的完整最小实现 |
| [SUPPLEMENT.md](SUPPLEMENT.md) | **补充说明与避坑指南**（多窗口 ACL、DOM 碰撞、bridge 差异） |
| [MAINTENANCE.md](MAINTENANCE.md) | **给接口维护者**：改了宿主，怎么保证这份手册不是第二份真相 |

> 接口分了几类、每一类被什么验证、还欠什么，在
> [`docs/INTERFACE-REVIEW-2026-09-27.md`](../INTERFACE-REVIEW-2026-09-27.md)。
> 手册里凡是可以被机器读的事实（服务 / 动作 / 方案 / 权限 / 内置插件数量），
> 都由 `tests/plugin-docs.test.mjs` 盯着 —— 数字写错会是一条红测试，不是一次静默漂移。

---

## 文档状态（核对于 2026-09-27）

「由什么盯着」那一列是**真的测试**，不是承诺：改错这些事实，`npm run test` 会红，
而且报出的是具体哪一行该写什么。

| 页面 | 状态 | 由什么盯着 |
|---|---|---|
| [architecture.md](architecture.md) | 已更新 | 8 个方案 id、15 项自检、内置插件名单 |
| [bridge.md](bridge.md) | **本手册的对等权威清单** | 与 `ctx.js` / `pluginwin-host.js` 逐行比对（含 `onDrop` 的 `info` 差异） |
| [manifest.md](manifest.md) | 已更新 | 权限集合与代码**双向**比对（多写少写都失败） |
| [api.md](api.md) | 已更新 | 摘要里的 26/4/4 与 `bridge.md` 一致；不得再长出第二张对等表 |
| [ui.md](ui.md) | 已更新 | 组件词汇表数量、`.tb-*` 类名必须在 CSS 里真的存在 |
| [debugging.md](debugging.md) | 已更新 | 15 项自检；`ctx.log` 的落点说法 |
| [recipes.md](recipes.md) | 已更新 | 引用的示例路径必须存在 |
| [storage.md](storage.md) | 已核对 | 引用的路径与命令名（存在性由路径测试覆盖） |
| [FILE-ACCESS-PLAN.md](FILE-ACCESS-PLAN.md) | 已标注状态 | §8.1 `onDrop` ✅ 已实施、§8.2 `focusView` ⏳ 仍是方案、§9 fs 评估 ⏳ **未实施（讨论记录）**、路线 D 的示意代码已标注**不存在** |
| [SUPPLEMENT.md](SUPPLEMENT.md) | **历史**，顶部有横幅 | 不参与核对；已并入本手册，保留只为记录来由 |
| [MAINTENANCE.md](MAINTENANCE.md) | 面向维护者 | 改宿主时的操作清单 |

**自动盯住的事实**：服务与动作清单、权限集合、方案 id、内置插件名、自检项数、
组件词汇表数量、`.tb-*` 类名、文档内相对链接、手册引用的仓库路径、
`ctx` ↔ `bridge` 的能力差异。

**刻意不自动化的**：设计理由（「为什么 `raise` 而不是 `focus`」）、
性能实测数字、以及任何属于「人文」的事实 —— 它们不可推导，只能写清日期与来由。

---

## 五分钟上手

一个插件是**一个目录**，放进 `%APPDATA%\com.tan18.toolbox\plugins\` 即被发现并启用
（首次发现即启用；显式禁用会持久）。两个文件就够：

```
my-plugin/
  plugin.json     ← 权威清单：id / 权限 / 声明式贡献
  main.js         ← 入口，导出一个 { manifest, activate, deactivate }
```

```js
// main.js
export default {
  manifest: { id: 'my.plugin', name: 'My Plugin' },

  activate(ctx) {
    ctx.registerView('main', (root) => {
      const { el, render } = ctx.ui;
      render(root, el('div', { class: 'tb-pane tb-pane-pad' }, 'Hello from a plugin'));
    });
  },
};
```

```json
{
  "id": "my.plugin",
  "name": "My Plugin",
  "version": "0.1.0",
  "api": 2,
  "entry": "main.js",
  "contributes": { "views": [{ "slot": "tool", "id": "main", "title": "My Plugin", "icon": "lucide:puzzle" }] }
}
```

放进去 → 重启或点 Rescan → 侧栏出现一行。

---

## 五层：先看清自己在哪一层

```
① 清单层   plugin.json ──────── 权威。声明 id / 权限 / 贡献点
              ↓
② 契约层   ctx（宿主注入） ──── 你的全部能力边界。没在这上面的就是拿不到
              ↓
③ 视图层   ctx.registerView ─── 主窗口里的一块内容
   窗口层   ctx.windows      ── 或一个独立窗口（自绘标题栏）
              ↓
④ 数据层   storage / rpc / stream / pty / sidecar / bus / uplink
              ↓
⑤ 表现层   .tb-* 类 + 令牌 ──── 自动跟随主题与插件主题覆盖
```

**每一层只依赖下一层的契约，不依赖实现**：

- ① 决定**你能做什么**（权限），② 决定**你怎么做**（API 形状），
  ④ 决定**数据怎么走**（传输 × 编码），⑤ 决定**长什么样**。
- 你**永远不需要** import 宿主的东西 —— 外部插件是 Blob URL 单文件 ESM，
  **import 不到任何模块**，这是刻意的（见 `docs/UI.md` 开篇的约束）。
  宿主把需要的东西**作为参数递给你**（`ctx`、`ctx.ui.el`、`ctx.protocol`）。

---

## 三条会咬人的规矩

1. **能力声明必须为真。** 在 `contributes` 或 `manifest` 里声明了宿主无法兑现的能力，
   调用方会依赖它然后失败。曾经声明过 `channel-json` 支持 backpressure 但没实现 —— 已移除。

2. **观察不等于能力。** 订阅事件、读自己的热键、关闭自己开的流，都**不需要权限**；
   只有发布广播、运行自带二进制、控制窗口才带权限。别给自己加不必要的权限。

3. **激活要快。** `bootPlugins` 是**串行 await** 的，一个插件的 `activate()` 慢，
   后面所有插件的视图都要等它 —— 包括**用户自己装的那些**。
   内置插件现在只剩两个（`builtin.procman`、`builtin.streamlab`），
   所以启动耗时里真正的大头是**外部插件**和你自己的 `activate()`。
   慢活放到 `activate()` 之后异步做，或者用 `ctx.registerView`
   先把视图注册出来（见 [debugging.md](debugging.md#启动慢)）。
