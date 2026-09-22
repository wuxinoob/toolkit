# 插件开发手册

面向**写插件的人**。讲的是「我要做一个功能，该怎么落地、怎么排查」。

协议与内部实现不在这里 —— 那些在 `docs/PROTOCOL.md`（信封与方案表）、
`docs/INTERFACES.md`（8 个原生命令 / 6 服务 29 动作）、`docs/UI.md`（样式与令牌）、
`docs/MESSAGE-FRAMEWORK.md`（消息平面的设计来由）。本手册只引用结论，不重复论证。

| 文件 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 五层架构，每层给什么保证、边界在哪 |
| [manifest.md](manifest.md) | `plugin.json` 完整参考 |
| [api.md](api.md) | `ctx` 全表面，按**任务**组织 |
| [ui.md](ui.md) | 界面怎么做：组件工厂 + 令牌 |
| [debugging.md](debugging.md) | 出问题时按什么顺序查（**归因手册**） |
| [recipes.md](recipes.md) | 常见功能的完整最小实现 |

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
  "contributes": { "views": [{ "slot": "tool", "id": "main", "title": "My Plugin", "icon": "🧩" }] }
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
   后面所有插件的视图都要等它。实测九个内置插件总共 ~1.7s ——
   这是启动时侧栏空几秒的原因。慢活放到 `activate()` 之后异步做，
   或者用 `ctx.registerView` 先把视图注册出来（见 [debugging.md](debugging.md#启动慢)）。
