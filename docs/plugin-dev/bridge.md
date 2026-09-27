# 插件窗口的那一半：`bridge` vs `ctx`

> 开了独立窗口的插件，`mountWindow(bridge)` 拿到的是 **`bridge`**，不是 `ctx`。
> 两者**大部分同形** —— 同一套信封、同一个网关、同一个权限注册表、同一份冻结契约 ——
> 但差异是真实的，而且其中**一处是「连带缺席」而不是设计**（`notifyOS`）。
>
> **这一页是差异的唯一权威清单。** `api.md` 只留摘要并链到这里，不重复列举。
> `tests/plugin-docs.test.mjs` 逐行比对本文的表格与 `ctx.js` / `pluginwin-host.js`，
> 任何一侧增删方法而不更新本文，就是一条红测试。

---

## 一分钟结论

**26 个能力两边都有**，差异只有 8 个（4 + 4）：

| | 只有主窗口 `ctx` | 只有插件窗口 `bridge` |
|---|---|---|
| 能力 | `ui` · `windows` · `registerView` · `focusView` | `label` · `close` · `drag` · `dispose` |
| 为什么 | 视图渲染必须发生在主窗口的 realm；窗口所有权留在创建方 —— 见 §2 与 §3 | 窗口对自己的操作（关自己、拖自己、退场清理）只有窗口做得了 |

`ui` 需要单独说：**它不是「整块属于主窗口」，而是四件不同的事被塞进了同一个命名空间** ——
其中三件确实该留在主窗口，**`notifyOS` 只是被一起跳过了**。见 §4。

> **`onDrop` 曾经也在左边那一列**（2026-09-26 的结论：拖放要按「当前显示的视图」路由，
> 所以只属于主窗口）。那是**把问题想复杂了** —— 一个插件窗口只属于一个插件，
> 归属在 URL 里就已知，**根本不存在路由这一层**，于是它比主窗口**更简单**：
> 谁收到谁处理。2026-09-27 已补上。

---

## 1. 完整矩阵

`✅` = 有；`❌` = 没有。这张表由测试对照代码核对。

| 能力 | 主窗口 `ctx` | 插件窗口 `bridge` | 说明 |
|---|---|---|---|
| `protocol` | ✅ | ✅ | 同一份 `contract.js`，`freeze()` 过，两个窗口面不可能有分歧 |
| `manifest` | ✅ | ✅ | 同一个清单对象（`plugin.json` 覆盖代码里的导出） |
| `id`（窗口里叫 `pluginId`） | ✅ | ✅ | 同一个插件 id，两个名字 |
| `label` | ❌ | ✅ | 窗口自己的 label；主窗口是 `main`，没有这个概念 |
| `log` | ✅ | ✅ | 同形**同落点**：都只到当前 webview 的 console，**都不落盘**（见 §5） |
| `storage` | ✅ | ✅ | 同一份 per-plugin `data.json` |
| `request`（主窗口叫 `rpc`） | ✅ | ✅ | 同一个网关；名字不同，语义与权限规则完全相同 |
| `subscribe` / `once` / `publish` | ✅ | ✅ | 顶层快捷方式，默认 `event-bus`；两边都是异步形状 |
| `events` | ✅ | ✅ | 窗口内 `in-process`，零 IPC |
| `bus` | ✅ | ✅ | 跨窗口广播 |
| `onHotkey` | ✅ | ✅ | 声明式热键（宿主代注册，按 owner 过滤） |
| `onDrop` | ✅ | ✅ | 拖进这个窗口的文件。**两边形状一致**（`fn(paths, info)` + 返回取消函数），只有 `info` 的内容不同 —— 见下 |
| `stream` / `streamRaw` / `uplink` / `sidecar` / `pty` | ✅ | ✅ | 数据面全套都在 |
| `closeStream` | ✅ | ✅ | 关自己开的流，不要权限 |
| `sessions` / `schemes` / `schema` | ✅ | ✅ | 自省与协商面 |
| `clipboard` / `screen` | ✅ | ✅ | 读剪贴板 / 枚举显示器与截屏 |
| `files` | ✅ | ✅ | 原生选择器 / 保存框 / 消息框 |
| `cleanup` | ✅ | ✅ | 登记退场时要跑的清理 |
| `close` / `drag` | ❌ | ✅ | 关自己 / 拖自己 —— 只有窗口有「自己」 |
| `dispose` | ❌ | ✅ | 释放本窗口开的一切（`beforeunload` 里自动调用） |
| `ui` | ✅ | ❌ | **整块不在**：组件工厂 + toast + OS 通知 + overlay，见 §4 |
| `windows` | ✅ | ❌ | 窗口的创建与尺寸控制权**专属创建方** |
| `registerView` / `focusView` | ✅ | ❌ | 视图住在主窗口里 |

> `id` / `pluginId` 与 `rpc` / `request` 是**别名而不是差异**：名字不同，能力相同。
> 测试把它们归一化后比较，所以上表左右两侧的差异**恰好**是那 4 + 4 个。

### `onDrop` 的第二参数：`info` 在两边不一样

这是**唯一一处「同一个能力、`info` 形状不同」**，值得单独说清：

| | `fn(paths, info)` 里的 `info` |
|---|---|
| 主窗口视图（`ctx.onDrop`） | `{ viewId }` —— 拖放落在**哪个视图**上 |
| 插件窗口（`bridge.onDrop`） | `{ label }` —— 就是本窗口自己的 label |

**为什么不一样**：主窗口一个窗口里装着多个插件的视图，所以「这次拖放是给谁的」需要
一个 `viewId` 来回答；插件窗口只属于一个插件（URL 里 `?plugin=<id>`），
**没有第二个可能的目标**，所以没有 `viewId`，只有窗口自己的身份。

**两边相同的部分**：都是 `fn(paths, info)`；`paths` 都是 `string[]`；
都返回「Promise of 取消函数」（`await` 之后拿到 `off`）；**都不需要权限**
（你只会看到用户对着你自己的界面做的动作）。

---

## 2. 两个「主窗口才有的东西」

这两类不是「还没做」，而是**在插件窗口里没有意义**：

| 缺什么 | 为什么它只能是主窗口的 | 插件窗口里怎么办 |
|---|---|---|
| `registerView` / `focusView` | 视图是主窗口侧栏里的一块内容，插件窗口没有侧栏 | 窗口就是你的界面；要「呼出」用 `bridge.request` 请主窗口代劳（见下） |
| `windows` | 创建与尺寸控制权专属**创建方**，否则「能改自己尺寸」和「能被拖动」就混为一谈了 | `bridge.bus.publish('my.plugin:open-window', {...})`，主窗口订阅后调 `ctx.windows.create(...)` |

**呼出窗口的配方**（窗口型插件的热键场景）：

```js
// 主窗口 activate(ctx) —— 唯一有 win:manage 的一侧
ctx.bus.subscribe('my.plugin:raise-window', async (env) => {
  const label = env?.p?.label;
  if (!label) return;
  // 已存在时 create 是 no-op（会 show + focus）
  await ctx.windows.create(label, {
    url: `pluginwin.html?plugin=${encodeURIComponent(ctx.id)}&label=${label}`,
    title: 'My Window', width: 400, height: 300,
  });
  await ctx.windows.control(label, 'raise', true);   // unminimize → show → focus
});
```

---

## 3. `windows`：为什么连「改自己的大小」都要绕

插件窗口的 capability 只给两个窗口权限：`start-dragging` + `close`。
**`win:manage` 只在主窗口那一侧**，所以
`size` / `position` / `alwaysOnTop` / `clickThrough` 这些操作
**必须由创建它的窗口发起** —— 也就是 `activate(ctx)` 里的那份 `ctx`。

**这不是可以顺手补上的缺口，而是刻意的边界**：一个窗口能改自己的尺寸、
也能被拖动，是两件不同的事；把它们合并会让「谁拥有这个窗口」变得无法回答。

所以窗口里想改大小，走广播：

```js
// 插件窗口
await bridge.bus.publish('my.plugin:resize', { label: bridge.label, width: 520, height: 360 });
```

---

## 4. `ui` 为什么整块不在 —— 哪一半是「连带缺席」

`ctx.ui` 有十个成员，但它们**不是一件事**：

| 方法 | 插件窗口 | 为什么 |
|---|---|---|
| `el` / `render` / `native` / `node` | ❌ | 组件工厂的观感**全部来自 Tailwind 工具类**，而插件窗口的样式表**故意不含工具类**（只有令牌 + `.tb-*`）。镜像它意味着给每个窗口加回 ~122 KB utilities，或再维护一套裁剪版组件 |
| `destroy` | ❌ | 只用来卸载工厂挂的 Vue app；没有工厂就没有它 |
| `components` | ❌ | 查组件词汇表（`components()` 返回 `el()` 接受的 tag 名）。它是**工厂的**目录，没有工厂就没有东西可列；插件窗口里也**没有别的途径拿到它**（真需要清单就只能请主窗口从总线发过来，不值得）。窗口里直接用 `.tb-*`，见 [ui.md](ui.md) |
| `notify`（站内 toast） | ❌ | toaster 是外壳的 DOM，插件窗口不加载外壳 |
| `mountOverlay` / `unmountOverlay` | ❌ | overlay 是主窗口外壳预留的一个 DOM 节点 |
| **`notifyOS`** | ❌ | **这是连带缺席，不是设计** —— OS 通知与 DOM / CSS 毫无关系 |

**`notifyOS` 为什么没有**：它被放进了 `ui` 命名空间，而整个命名空间在 bridge 里被跳过了。
技术上没有任何东西挡着它 —— 底层是 `notify` 服务的一个普通动作，不是 UI。

**现成的替代写法**（需要 `plugin.json` 声明 `rpc:notify`）：

```js
// 插件窗口里发系统通知
try {
  const r = await bridge.request('notify', 'send', {
    title: bridge.manifest.name,   // 默认值不是插件名，所以要自己传
    body: '构建完成',
  });
  void r;
} catch (e) {
  // 与 ctx.ui.notifyOS 的区别：这里失败会 reject（那边解析成 false）
  bridge.log.warn('OS notification failed:', e?.message ?? e);
}
```

**两个差异要点**：

- `ctx.ui.notifyOS(body, { title })` 的 `title` **默认是插件名**；直接走
  `notify/send` 时默认是 `"Toolbox"`，所以要自己传 `title`。
- `ctx.ui.notifyOS` **失败不抛**（返回 `false`）；`bridge.request` **失败会 reject** ——
  少一条通知不该弄坏插件正在做的事，所以自己包一层。

> **`ui` 缺席的通用后果**：插件窗口里的富 UI 要用 `.tb-*` 类 + 内联 `style`
> （或自己注入 `<style>`，那个窗口整块 DOM 都是你的）。见 [ui.md](ui.md) 与
> [../UI.md](../UI.md)。**⚠️ Tailwind 工具类在插件窗口里不产生任何 CSS，而且不报错** ——
> 元素就是没样式。

---

## 5. `log`：同形、同落点，而且**两边都不落盘**

这一点曾被文档写错过，所以单独说：

```js
ctx.log.info('…')      // 主窗口：console.info('[plugin:<id>]', …)
bridge.log.info('…')   // 插件窗口：console.info('[plugin:<id>]', …)
```

**两者都只到当前 webview 的 console，都不写 `debug.log`**（`log` 就是三个 `console.*` 包装）。
`window.__toolbox.logs()` 读的是宿主自己的环形缓冲，也**不含**插件的这两者。

**要落盘就得显式走网关**（需要 `rpc:host`）：

```js
await ctx.rpc('host', 'write_debug_log', { content: 'anything' });
// 或插件窗口里：
await bridge.request('host', 'write_debug_log', { content: 'anything' });
```

**能进 `debug.log` 的只有宿主自己**：启动与分插件耗时、`hub.setTrace(true)` 的通信 trace、
自检报告。插件要留下可事后读的证据，就得自己调 `write_debug_log`。

---

## 6. 迁移检查清单

把一段在主窗口视图里跑通的代码搬到插件窗口（或反过来），逐条过一遍：

- [ ] 用了 `ctx.ui.el / render / native`？→ 换成 `.tb-*` + 内联 `style`；
- [ ] 用了 `ctx.ui.notify`？→ 自己画一行状态，或者用 `notifyOS` 的替代写法；
- [ ] 用了 `ctx.ui.notifyOS`？→ 换成 `bridge.request('notify', 'send', { title, body })` 并 catch；
- [ ] 用了 `ctx.windows.*`？→ 改成广播给主窗口代劳；
- [ ] 用了 `ctx.registerView` / `focusView`？→ 这两样在窗口里没有对应物，改结构；
- [ ] 用了 `ctx.onDrop`？→ 窗口里是 `bridge.onDrop`，形状一样；只是 `info` 里是 `{ label }` 而不是 `{ viewId }`；
- [ ] 用了 `ctx.rpc`？→ 窗口里叫 `bridge.request`（同一个东西）；
- [ ] 用了 `ctx.id`？→ 窗口里叫 `bridge.pluginId`；
- [ ] 依赖 `ctx.log` 出现在 `debug.log` 里？→ 不会出现，改调 `host/write_debug_log`；
- [ ] 开了流 / pty / sidecar？→ 不需要额外处理，`dispose()` 在 `beforeunload` 里会关掉它们。

**反过来（窗口 → 视图）**：`bridge.close` / `drag` / `dispose` / `label` 在主窗口里没有对应物，
因为主窗口不关闭（✕ 只是收起到托盘）、自己是外壳、没有 owner。
