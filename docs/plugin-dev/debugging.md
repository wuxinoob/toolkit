# 排查手册 — 症状 → 查什么

**先看日志，再猜代码。** 这个项目有完整的观测通道，绝大多数问题看一眼就知道。

---

## 0. 三个观测点，按顺序用

### ① `%APPDATA%\com.tan18.toolbox\debug.log`

**排查运行期问题，先看这个文件。** 它是唯一在 webview 之外留痕的通道。

```
--- boot 2026-09-22T03:07:43.010Z ---
message plane: rpc, channel-json, channel-in, channel-raw, event-bus, stdio-line, pty-stream, in-process
boot timing (ms): debug 42 | reap 58 | schemes 60 | builtins 1722 | external 1891 | hotkey 1899
  plugin load (ms): builtin.notepad 3 | builtin.eyecare 2 | …
boot ok: 9 plugins, 9 views, active=builtin.notepad/notepad
  plugin builtin.notepad: active
  plugin my.plugin: error — [plugin:my.plugin] view "main" not declared in manifest.contributes.views
--- toolbox selftest … : 15/15 passed ---
```

**读法**：
- 每个插件一行状态。`error — <原因>` 就是答案，**不用去猜**
- `boot timing` 看哪一阶段慢；`plugin load` 看**哪个插件**慢
- 插件没出现 → 没被发现（看 [「插件没出现」](#插件没出现)）

### ② 应用内自检（dev 启动自动跑，也可手动）

```
await window.__toolbox.selftest()
```

15 项，覆盖信封契约、编解码、权限闸、存储、流、pty、会话表、视图注册、sidecar。
**改动底层后先跑它** —— 它比你的功能测试更早知道哪里断了。

### ③ `window.__toolbox`（调试句柄）

```js
window.__toolbox.store       // 插件表、视图表、booted…
window.__toolbox.events      // 事件总线
window.__toolbox.logger      // 日志
window.__toolbox.logs        // 最近日志
window.__toolbox.schemes     // 可用方案
window.__toolbox.transports
window.__toolbox.sessions    // 活会话
window.__toolbox.openStreams
window.__toolbox.selftest()
```

在**插件视图里**用 DevTools 控制台直接读 —— 这是看「宿主到底知不知道我的插件」
最快的方式。

---

## 插件没出现

按这个顺序查，每步排除一整类原因：

| 查什么 | 怎么看 |
|---|---|
| 1. 目录对吗 | `%APPDATA%\com.tan18.toolbox\plugins\<你的目录>\` |
| 2. `plugin.json` 在吗 | 宿主靠它发现你 |
| 3. 被禁用了吗 | 显式禁用是**持久**的，会在日志里说明 |
| 4. 加载抛错了吗 | 日志里 `plugin <id>: error — <原因>` |
| 5. `manifest.id` 和 JSON 一致吗 | 不一致时**以 JSON 为准**，有审计测试盯着 |
| 6. 视图声明了吗 | `ctx.registerView(id)` 要求 `contributes.views` 里有这个 id |

**点侧栏的 Rescan** 可以重新扫描，不用重启。

---

## 视图是空白 / 渲染报错

宿主会**捕获你 `render` 里的异常**，把错误写进容器：

> `View render error: <message>`

所以**先看内容区那行红字**，再看控制台。常见原因：

| 症状 | 原因 |
|---|---|
| 什么都没有，也没报错 | `ctx.registerView` 的 id 和 `contributes.views[].id` 不一致 |
| `render is not a function` | `ctx.ui` 解构错了 —— 是 `ctx.ui.render`，不是 `ctx.render` |
| 组件名不认 | 组件工厂的 tag 名 = `.tb-*` 类去前缀。`el('card')` ✓，`el('Card')` ✗ |
| 样式全丢 | 用了 Tailwind 工具类。**外部插件用不了**（见 [ui.md](ui.md)） |

---

## 启动慢

日志里的 `boot timing` 和 `plugin load` 直接指出来：

```
boot timing (ms): debug 42 | reap 58 | schemes 60 | builtins 1722 | external 1891 | hotkey 1899
  plugin load (ms): builtin.notepad 3 | builtin.floatwin 1600 | …
```

**`bootPlugins` 是串行 await 的** —— 一个插件的 `activate()` 慢，
**后面所有插件**的视图都要等它。所以「我的插件让别人的插件也出不来」是真会发生的。

**改法**：
- 慢活（网络、子进程、大文件）不要在 `activate()` 里 await
- 先 `ctx.registerView()` 把视图注册出来，再异步补内容
- 宿主侧另有一个**兜底**：窗口 5 秒内没被前端显示就强制显示，
  所以插件卡死不会让应用完全打不开

---

## 权限被拒

错误信息是**可读的**，直接告诉你缺什么：

> `[plugin:my.plugin] permission denied: rpc:proc`

**两道闸口都要过**：

1. **JS 侧 `ctx`** —— 快速失败，给你这句话
2. **Rust 侧 `host/registry.rs`** —— 权威、fail-closed

所以**光改 `plugin.json` 不够** —— 插件首次加载时要向宿主注册，注册用的就是那份清单。
改完权限**要重新加载插件**（Rescan 或重启）。

**别加不必要的权限**：订阅、读自己的热键、关自己开的流都**不要**权限
（见 [manifest.md](manifest.md#permissions--权限清单)）。

---

## 窗口开不出来

| 错误 | 原因 |
|---|---|
| `window url must be the app's own entry page` | `url` 传了外部地址。**必须是 `index.html?...`** |
| `window option(s) not allowed: xxx` | 用了白名单外的选项，**报错会告诉你是哪个** |
| `window "x" create failed` | 看 payload —— 通常是 label 冲突或窗口参数非法 |
| 窗口开了但空白 | 插件窗口加载的是 `index.html?mode=pluginwin&plugin=<id>&label=<label>`，**三个参数都不能少** |

自绘标题栏时别忘了 `decorations: false`，否则你会画两条标题栏。

---

## 弹层颜色不对 / 弹窗没跟随插件主题

**症状**：按钮是紫的，弹出的对话框是蓝的。

**原因**：`contributes.theme` 作用在 `[data-plugin="<id>"]` 子树上，
而 Dialog / Dropdown / Tooltip **默认 teleport 到 `document.body`** —— 出了那个子树。

**改法**：给这些组件传 `portalTo`，指向你自己的容器。
用**组件工厂**搭的界面宿主已经代办了；**手写**这些组件时要自己传。

---

## 边框是纯黑色 / 颜色不跟随主题

**症状**：某个控件的边框是近黑色，其他控件正常。

**原因**：Tailwind v4 的 preflight 把 `border-color` 默认成 **`currentColor`** ——
写了裸 `border`、没写颜色的元素，边框 = **文字色**。

**改法**：写颜色。用令牌（`var(--color-line)` / `var(--color-line-strong)`），
不要写死颜色 —— 写死就不跟随主题了。

**判据**：`getComputedStyle(el)` 里 border 和 color **是同一个值** → 就是它。

---

## 滚动条出现在奇怪的地方 / 侧栏跟着滚

**症状**：多出一条滚动条，拖它的时候侧栏也跟着动。

**原因**：一个 `overflow: auto` 的盒子里有 `position: absolute` 元素，
**而这个盒子 `position` 是 `static`**。CSS 规范：**滚动容器只裁剪
「以它为包含块」的绝对定位后代** —— 成为包含块需要 `position` 非 static。
所以那些绝对定位元素**逃出了裁剪**，把**文档**撑高了。

**改法**：给滚动容器加 `position: relative`。

**判据**：`document.documentElement.scrollHeight > clientHeight` 但你没想让它能滚。

---

## 浏览器里测不出来

**headless 浏览器打 dev server 只能看到「页面」，看不到「app」** ——
插件激活、原生权限闸、窗口布局都不存在。

**所以浏览器复现不了的问题，别继续在浏览器里找。** 用 WebView2 的远程调试进真实 app：

```bash
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=9222" npm run tauri dev
node scripts/app-eval.mjs "return { views: window.__toolbox.store.views.length }"
```

`scripts/app-eval.mjs` 零依赖，表达式按 **async 函数体**求值（`await` 和 `return` 都能用）。

**判断「是代码还是环境」的顺序**：

1. 同一份代码在**浏览器**里能渲染吗？能 → 前端没问题
2. `npm run test` 过吗？`cargo check` 过吗？
3. 都过 → 去查环境（WebView2 profile、代理、运行时版本）

---

## 改完代码不生效

| 情况 | 处理 |
|---|---|
| 改了 `src/plugins/*.js`（内置） | Vite HMR 自动重载 |
| 改了**外部插件** | 点 **Rescan**（宿主会按 digest 判断是否需要重载） |
| 改了 `plugin.json` 的**权限** | 重新加载插件（注册要重来） |
| 改了 Rust | 重编译（`tauri dev` 会自己做） |
| 改了 `app.css` | HMR，但 Tailwind 要重新扫描，稍慢 |

**HMR 整页重载会留下宿主的会话孤儿**（旧 JS 上下文没了但宿主进程还活着）。
宿主已经在 `boot()` 里自动回收，日志里会有一行 `reaped N session(s)` ——
**看到它是正常的，不是错误**。
