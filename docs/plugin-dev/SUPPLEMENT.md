# Toolkit 插件开发手册 · 补充说明与避坑指南 (SUPPLEMENT)

> **⚠️ 已并入手册（2026-09-22）。** 本文件八条教训已全部写进
> [api.md](api.md) / [ui.md](ui.md)，其中两条还**在宿主里强制**了
> （窗口 label 的 ACL 规则、插件窗口的 `#app` 遮挡）。
> **保留此文件只为记录来由，不要当第二份真相来源** —— 以手册为准。

> 本文档基于 **拾光便签（custom.moment-notes）** 等多窗口复杂应用在 Toolkit 插件体系下的实战迁移经验整理，旨在补充与修正 `docs/plugin-dev/` 中存在遗漏、歧义或容易导致严重运行时异常的关键规范。

---

## 目录

1. [【致命坑点】多窗口 Label 必须遵循 `plugin-*` 命名 ACL](#1-致命坑点多窗口-label-必须遵循-plugin--命名-acl)
2. [【渲染空白】独立窗口 `mountWindow` 与宿主 `#app` 容器高度碰撞](#2-渲染空白独立窗口-mountwindow-与宿主-app-容器高度碰撞)
3. [【窗口关闭与拖拽】`bridge.close()` / `bridge.drag()` 权限与双重保险](#3-窗口关闭与拖拽bridgeclose--bridgedrag-权限与双重保险)
4. [【上下文差异】`ctx` (主窗口宿主) 与 `bridge` (独立窗口) 接口不对等](#4-上下文差异ctx-主窗口宿主-与-bridge-独立窗口-接口不对等)
5. [【透明窗口】`transparent: true` 与背景色缺省](#5-透明窗口transparent-true-与背景色缺省)
6. [【样式隔离】避免插件全局 CSS 污染宿主主窗口](#6-样式隔离避免插件全局-css-污染宿主主窗口)
7. [【事件总线】`ctx.bus` 信封解包规范 (`env.p`)](#7-事件总线ctxbus-信封解包规范-envp)
8. [【自绘标题栏与拖拽】`-webkit-app-region` 拦截点击事件](#8-自绘标题栏与拖拽-webkit-app-region-拦截点击事件)

---

## 1. 【致命坑点】多窗口 Label 必须遵循 `plugin-*` 命名 ACL

### 现状问题
在 `recipes.md` 与 `api.md` 中，创建自定义独立窗口的代码示例均为：
```js
// ❌ 存在隐患的示例写法（直接照抄会导致权限缺失）
const how = await ctx.windows.create('my-win', {
  url: `index.html?mode=pluginwin&plugin=${encodeURIComponent(ctx.id)}&label=my-win`,
  title: 'My Window',
  ...
});
```

### 底层原理与后果
Tauri v2 引入了严格的细粒度 ACL（Capability）权限控制机制。
在 Toolkit 宿主的 `src-tauri/capabilities/pluginwin.json` 中，对插件独立窗口的权限绑定定义为：
```json
{
  "identifier": "pluginwin",
  "windows": ["plugin-*"],
  "permissions": [
    "core:default",
    "core:window:allow-close",
    "core:window:allow-start-dragging"
  ]
}
```
**注意 `"windows": ["plugin-*"]` 这一通配规则！**
- 如果插件在创建窗口时使用了未以 `plugin-` 开头的 label（例如 `'my-win'`、`'moment-notes-main'`、`'calc'`）：
- Tauri 在初始化该 WebviewWindow 时，**匹配不到任何 Capability**（`default.json` 仅匹配 `"main"`）。
- 导致该独立窗口在运行时被剥夺一切核心能力：
  1. 调用 `bridge.close()` (`getCurrentWindow().close()`) 时直接报 **ACL Denied (allow-close 缺失)**；
  2. 调用 `bridge.drag()` (`getCurrentWindow().startDragging()`) 时报 **ACL Denied (allow-start-dragging 缺失)**；
  3. 窗口变得既不能拖动、也不能通过按钮关闭。

### 正确规范
**所有通过 `ctx.windows.create` 创建的窗口 Label，必须强制以 `plugin-` 为前缀：**
```js
// ✅ 推荐的标准命名规范：
const winLabel = `plugin-${ctx.id.replace(/[^a-zA-Z0-9_-]/g, '-')}-main`;
// 或者带有业务语义的：
const noteLabel = `plugin-moment-notes-note-${noteId}`;

await ctx.windows.create(winLabel, {
  url: `index.html?mode=pluginwin&plugin=${encodeURIComponent(ctx.id)}&label=${encodeURIComponent(winLabel)}`,
  ...
});
```

---

## 2. 【渲染空白】独立窗口 `mountWindow` 与宿主 `#app` 容器高度碰撞

### 现状问题
文档说明：独立窗口通过 `index.html?mode=pluginwin&...` 打开，`pluginwin-host.js` 会动态加载插件的入口并调用 `mountWindow(bridge)`。
许多开发者自然地在 `mountWindow` 中执行：
```js
// ❌ 常见踩坑代码
export async function mountWindow(bridge) {
  const container = document.createElement('div');
  container.id = 'my-custom-root';
  document.body.appendChild(container); // 踩坑！
  
  createApp(App).mount(container);
}
```
### 底层原理与后果
Toolkit 宿主的 `index.html` 默认包含如下基础结构：
```html
<div id="app"></div>
```
并且在宿主全局样式中定义了：
```css
#app {
  width: 100%;
  height: 100%;
}
```
在独立窗口中，`#app` 未被宿主使用，但依然保留在 DOM 中，并且占据了 **100% 视口高度**（`100vh`）。
此时插件调用 `document.body.appendChild(container)`，新容器会被挤到 `#app` 的下方（即从 Y = 100vh 开始渲染），**完全超出可视窗口**！
从用户视觉来看，整个窗口一片空白/全透明，看似页面没有加载，但实际上审查元素会发现元素全部排在屏幕底部外部。

### 正确规范
在 `mountWindow` 执行挂载前，**必须先清空 `document.body`**，或直接挂载/复用已有容器：
```js
// ✅ 正确做法：彻底清理 body 默认遗留节点，并重设全屏流式容器
export async function mountWindow(bridge) {
  document.body.innerHTML = '';
  document.body.style.cssText = 'margin:0;padding:0;width:100vw;height:100vh;overflow:hidden;';

  const container = document.createElement('div');
  container.id = 'plugin-root';
  container.style.cssText = 'width:100%;height:100%;overflow:hidden;';
  document.body.appendChild(container);

  const app = createApp(MyComponent);
  app.mount(container);
}
```

---

## 3. 【窗口关闭与拖拽】`bridge.close()` / `bridge.drag()` 权限与双重保险

### 现状问题
在自绘无边框独立窗口（`decorations: false`）中，关闭按钮偶尔点击无响应。

### 原因排查
1. **ACL 未满足**：窗口 label 未带 `plugin-*`（见第 1 条）；
2. **异步 Promise 异常未捕获**：`bridge.close()` 内部调用的是 `@tauri-apps/api/window` 的 `getCurrentWindow().close()`，这是一个异步方法。如果其因权限拒绝而 reject，外层没有 `try...catch` 会导致后续 fallback（如 `window.close()`）无法执行；
3. **独立窗口本身无 `win:manage` 权限**：插件独立窗口内部只持有 `bridge`，无法调用 `windows.control`。

### 正确规范：双重保险关闭方案
插件应在主入口监听关闭请求，并由主窗口 `ctx.windows.control(label, 'close')` 予以强力兜底：

```js
// 1. 在主窗口 activate(ctx) 中注册兜底关闭监听：
ctx.bus?.subscribe?.('plugin:close-window', async (env) => {
  const payload = env?.p ?? env?.payload ?? env;
  if (payload?.label && ctx.windows) {
    try {
      await ctx.windows.control(payload.label, 'close');
    } catch (e) {
      ctx.log?.warn(`Close window fallback failed: ${e}`);
    }
  }
});

// 2. 在独立窗口中的关闭按钮处理函数（三重保险）：
export async function handleCloseWindow() {
  const bridge = window.bridge;
  const label = bridge?.label;

  // 第一层：尝试调用 bridge 原生 close
  try {
    if (bridge?.close) {
      await bridge.close();
      return;
    }
  } catch (err) {
    console.warn('[Window] bridge.close() rejected:', err);
  }

  // 第二层：通过 bus 通知宿主主窗口强制关闭本窗口
  try {
    if (bridge?.bus && label) {
      await bridge.bus.publish('plugin:close-window', { label });
      return;
    }
  } catch (err) {
    console.warn('[Window] bus close fallback failed:', err);
  }

  // 第三层：浏览器原生兜底
  try {
    window.close();
  } catch (_) {}
}
```

---

## 4. 【上下文差异】`ctx` (主窗口宿主) 与 `bridge` (独立窗口) 接口不对等

### 现状问题
文档提到“`bridge` 是一个窗口作用域的 SDK，与 `ctx` 遵循相同的契约”。许多开发者误以为可以在独立窗口中继续调用 `bridge.windows.create(...)` 连环开窗。

### 事实差异对比表

| API 能力 | 主窗口 `ctx` | 独立窗口 `bridge` | 说明 |
|---|---|---|---|
| `storage` (`get`/`set`/`remove`/`keys`) | ✅ 支持 | ✅ 支持 | 底层均走统一 RPC 网关 |
| `bus` (`subscribe`/`publish`/`once`) | ✅ 支持 | ✅ 支持 | 跨窗口事件互通 |
| `windows.create` / `windows.control` | ✅ 支持 | ❌ **不支持** | 窗口创建与尺寸控制权专属于创建方（主窗口） |
| `drag()` / `close()` | ❌ 无需 | ✅ **支持** | 独立窗口专享的自绘拖拽与自我销毁方法 |
| `registerView(...)` | ✅ 支持 | ❌ **不支持** | 独立窗口无需向宿主二级视图注册 |
| `onHotkey(...)` | ✅ 支持 | ✅ 支持 | 独立窗口也可监听快捷键事件 |

### 建议实践
若独立窗口内需要触发打开另一个新窗口（如便签卡片“在独立窗口打开”），应当**通过 `bridge.bus.publish('my-plugin:open-window', { ... })` 向主窗口发指令，由主窗口代为开窗**。

---

## 5. 【透明窗口】`transparent: true` 与背景色缺省

### 现状问题
`recipes.md` 指出：
```js
const win = await ctx.windows.create('widget', {
  transparent: true,
  decorations: false,
});
```
如果开发者在新建常规多功能窗口时开启了 `transparent: true`，但插件内部的 CSS 根节点未设定不透明背景色，窗口在 Windows WebView2 下会呈现**彻底穿透的透明空洞**，只能看到边框或阴影。

### 建议实践
1. **主操作面板 / 综合管理窗口**：
   建议直接设置 `transparent: false`，获得更稳定、更省 GPU 资源的纯色原生渲染。
2. **轻量悬浮挂件 / 异形便签卡片**：
   必须在设置 `transparent: true` 的同时，确保容器拥有明确的兜底背景色：
   ```css
   .my-window-root {
     background-color: var(--color-canvas, #1a1d24);
     border-radius: 12px;
     border: 1px solid var(--color-line, rgba(255, 255, 255, 0.1));
   }
   ```

---

## 6. 【样式隔离】避免插件全局 CSS 污染宿主主窗口

### 现状问题
许多基于 Vue / React 构建的插件在打包时会将组件库、通用重置样式（例如针对 `html, body, button, input` 的样式覆盖）打包进单一的 CSS 文件。
若在插件入口顶层 `import './style.css'`，当该入口被宿主主窗口通过 Blob import 加载时，**会导致宿主自身的 UI 元素（按钮尺寸、字体、外边距）被全局样式篡改污染**。

### 正确规范
1. **主窗口工具视图（`ctx.registerView`）**：
   - 仅使用宿主提供的 `.tb-*` 标准类和 `var(--color-*)` 变量；
   - 严禁在主窗口注入未加命名空间包裹的重置样式（如 `* { box-sizing: border-box; }`、`button { ... }`）。
2. **独立窗口（`mountWindow`）**：
   - 独立窗口拥有专属的 DOM 与 Webview，可以在此时尽情注入完整 CSS（通过内联 `<style>` 或动态 `link` 注入）。
   - 可在构建脚本中将独立窗口所需的样式单独封装为一个挂载函数，仅在 `mountWindow(bridge)` 时动态挂载：
   ```js
   export async function mountWindow(bridge) {
     if (typeof window.__injectPluginStyles === 'function') {
       window.__injectPluginStyles(document);
     }
     ...
   }
   ```

---

## 7. 【事件总线】`ctx.bus` 信封解包规范 (`env.p`)

### 现状问题
在订阅跨窗口广播时，容易误写成获取普通事件的传参：
```js
// ❌ 常见错误：直接认为回调参数就是 payload
ctx.bus.subscribe('my:topic', (data) => {
  console.log(data.title); // undefined！
});
```

### 底层原理
Toolkit 事件总线统一通过协议信封封装，接收到的 `env` 结构为：
```js
{
  kind: 'evt',
  ch: 'event-bus',
  svc: 'plugin-source-id',
  p: { /* 你的真实 payload 放在 p 字段 */ }
}
```

### 正确解包范式
```js
// ✅ 健壮的兼容解包写法
ctx.bus.subscribe('my:topic', (env) => {
  const payload = env?.p ?? env?.payload ?? env;
  console.log(payload.title); // 正确获取
});
```

---

## 8. 【自绘标题栏与拖拽】`-webkit-app-region` 拦截点击事件

### 现状问题
当把整个顶部区域设置为可拖拽区（`-webkit-app-region: drag`）后，位于该区域内的关闭按钮、最小化按钮或搜索框**无法点击**或无法获取焦点。

### 解决方案
在 Windows WebView2 环境下，操作系统会将 `-webkit-app-region: drag` 区域的所有鼠标点击直接转交为窗口移动指令（`WM_NCLBUTTONDOWN`）。
**凡是在拖拽区域内的任何可交互控件（按钮、输入框、下拉菜单），必须显式声明 `-webkit-app-region: no-drag !important;`**：

```css
/* 顶部顶栏可拖拽 */
.window-titlebar {
  -webkit-app-region: drag;
  user-select: none;
}

/* 里面的操作按钮必须禁用拖拽，否则点击事件无法触发 */
.window-titlebar .control-btn,
.window-titlebar input {
  -webkit-app-region: no-drag !important;
}
```
同时可在元素上加上 `data-tauri-drag-region` 属性以提升跨端兼容性。
