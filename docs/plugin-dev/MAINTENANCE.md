# 接口文档怎么维护

> 这一页是给**接口维护者**（改宿主的人）看的，不是给插件作者看的。
> 它只回答一个问题：**改了宿主，怎么保证这套文档不是第二份真相？**

配套阅读：[`../INTERFACE-REVIEW-2026-09-27.md`](../INTERFACE-REVIEW-2026-09-27.md)（接口分了几类、
每类被什么验证、还欠什么）。

---

## 一句话原则

**文档里能被机器读的事实，就不要靠人去记。**

这个仓库已经这么做了两处，插件文档此前是例外：

| 已有的守卫 | 盯什么 | 在哪 |
|---|---|---|
| `tests/hygiene.test.mjs` | `INTERFACES.md` 的命令数 == 代码里的 `#[tauri::command]` 数量 | 已有 |
| `tests/codes.test.mjs` | Rust 与 JS 的错误码清单逐名逐值一致 | 已有 |
| **`tests/plugin-docs.test.mjs`** | 服务/动作/方案/权限/内置插件/自检项/文档链接，以及 **`ctx` ↔ `bridge` 对等表**与代码是否一致 | **本次新增** |

第三行是这套机制的**入口**。它失败时的报错会直接告诉你哪个数字、文档里该写什么。

---

## 事实分三种，处理方式不同

| 事实 | 例子 | 处理 |
|---|---|---|
| **可枚举的** | 「9 服务 36 动作」「8 个方案」「权限名清单」「内置插件名单」 | 写进文档，**并由测试比对**。不一致 → 测试失败 |
| **可推导的** | 哪个权限管哪个能力、`ctx` 与 `bridge` 谁有什么 | **测试从代码推导**，与文档里的表比对 |
| **人文的** | 「为什么 `raise` 而不是 `focus`」「那次静默失败怎么来的」 | 不自动化。但要写**日期**和**来由**，否则下一个人会「简化」掉它 |

**反例（要避免的写法）**：在文档里写一段 `params` 的字段表。
它既不可枚举也不可推导，只会和代码漂移 —— 正确做法是让它出现在
`host/schema` 里（见 `INTERFACE-REVIEW` 的 O4），文档只留一句「用 `ctx.schema()` 查」。

---

## 改宿主的操作清单

### 插件从哪来：两个 source，**一份**簿记

插件只有两个来处：**内置**（`src/host/registry.js` 静态 import 的模块）与
**外部**（`{appData}/plugins` 里的目录，Blob URL 动态 import）。

**「哪些插件被加载了、各自从哪来」只有一个归属地：`src/host/plugins.js`。**
这条规则是有代价换来的 —— 在此之前 `registry.js` 管内置、`external.js` 管外部，
于是每个想拿一个插件模块的调用方都得写同一个分支：

```js
const mod = resolveBuiltin(id) || getExternal(id);   // 旧写法，两处真相
const mod = pluginModule(id);                        // 现在
```

所以：

- **加载/重载只有两个入口**：`reconcilePlugins({ sources })` 与 `reloadPlugin(id)`。
  再加第三个之前，先问它是不是其中一个的特例。
- `src/host/external.js` **不持有状态** —— 它只剩磁盘那半边（扫描、读入口、撤销授权）。
  往里加 `Map` = 把两份簿记重新引回来。
- 两种来源的**差异**必须留在各自的 pass 里，并且是有理由的差异：
  内置没有 digest（bundle 不会在运行时变）、永不被移除、失败只报一次；
  外部按 digest 增量、删除要撤销授权、失败要记住到内容变化为止。
  加第三条差异前，先确认它属于哪一种「因为来源不同」。
- 守卫：`tests/plugins-catalogue.test.mjs`（外部那半边 + 共用簿记）与
  `tests/boot.test.mjs`（内置那半边 + 「重扫目录不得卸载内置」那条回归）。

### 加一个**网关动作**（service action）

1. 在 `src-tauri/src/services/<svc>.rs` 的 `actions()` 数组里加名字；
2. 在 `dispatch` 里实现；
3. 更新 `docs/INTERFACES.md` §2 的表格（服务名 + 动作）；
4. 若该动作需要新权限，更新 `docs/plugin-dev/manifest.md` 的权限表；
5. `node --test` —— 计数/清单对不上会被 `plugin-docs` 与 `hygiene` 拦下。

> 动作清单是**权威声明**：网关按它校验，`host/schema` 由它生成。
> 加动作 = 加表项，**不要在 `lib.rs` 里写 `if svc == "…"`**（`hygiene.test.mjs` 会失败）。

### 加一个**流提供者**（push provider）

1. 在 `src-tauri/src/services/stream.rs` 里实现 `StreamProvider`，登记进 `providers()`；
2. 若它需要自己的权限，覆盖 `permission()`（`clipboard` 就是这么做的）；
3. 更新 `docs/INTERFACES.md` §3 的提供者一句话说明；
4. `host/schema.providers` / `providerPermissions` 会自动带上它。

### 加一个**上行 sink**

1. 在 `src-tauri/src/services/uplink.rs` 的 `sinks()` 表里加一项；
2. 更新 `docs/INTERFACES.md` §3 末段的 sink 说明；
3. `host/schema.sinks` 自动公布。

### 加一个**`ctx` 方法**

这是最容易漏的一类，因为**没有自动校验**（见 `INTERFACE-REVIEW` 的 P1）。

1. 先想清楚：它是 `ctx` 独有，还是 `bridge` 也要有？
   - **只有主窗口才有的**：视图、拖放路由、窗口所有权 → 只加 `ctx`；
   - **是「插件能做的某件事」** → 两侧都要加（`files` / `log` / `closeStream` 曾经只加了一侧，
     结果是同一段代码在视图里能用、在插件窗口里 `undefined is not a function`）；
2. 加完更新 [`bridge.md`](bridge.md) 的**完整矩阵**（那是差异的唯一权威清单；
   只加一侧就要把它写进「只有某一边」的列，并且在正文里给出**为什么**和**替代写法**）；
3. 若改了插件的可见形状，**必须**在 `src/protocol/contract.js` 里 **bump `HOST_API`**
   并补历史注释 —— 老插件靠 `manifest.api` 对上号，否则它收到的是
   `off is not a function` 这种与自己无关的报错；
4. `node --test`。

### 改一个**组件 prop 的翻译**（表单控件）

1. 表在 `src/host/ui.js` 的 `FORM_PROP_RULES`：`tag -> 插件可能写的原生键`，
   翻译逻辑只有一处（`normalizeFormProps`），别在组件里再补一套；
2. **翻译过的原生键必须删掉**，不能留在 props 上 —— 留下来的会被 Vue 当 DOM property
   写回真实元素，症状是「输入字符回退」，而插件状态是对的（实测记录见 `docs/UI.md`）；
3. 先确认组件**没有**声明同名 prop 再删：reka 的 `switch` / `checkbox` 有合法的
   `value`（表单提交值），那里只翻译 `checked`；
4. 同步 `docs/plugin-dev/ui.md` 的那张表，然后 `node --test` ——
   `tests/ui-form-props.test.mjs` 驱动整张表，漏一个就红。

> 只改 prop 翻译**不动 `ctx` 的形状**，所以不用 bump `HOST_API`；
> 增删 `ctx.ui` 上的成员才走上面那条。

### 改 **render 管线**（组件工厂怎么把描述树画上去）

1. **`render()` 必须保持同步。** 插件会在下一行读自己的容器
   （`procman`：`renderProfiles(root); renderDetail();` → `document.querySelector('.pm-term-area')`）。
   异步化（`shallowRef` 之类）会静默把那些调用点变成"读到空容器"。
   现在走 `app._instance.update()` 同步 patch —— 这是 Vue 的内部 API，
   所以 **拿不到就回退到"重建"**，别把这个回退删掉；
2. **一个容器一个持久 app。** 退回"每次 render 都重建"会把失焦/光标丢失重新引入；
   容器离开文档时由 `pruneDisconnected()` 释放，且**只回收"曾经在文档里"的容器**，
   插件"先渲染、后挂载"的容器不受影响；
3. 复用节点带来的两条插件可见行为 —— **列表要 `key`**、**`defaultValue` 只是初始值**
   （活值用 `value` / `modelValue`）—— 写进 [ui.md](ui.md)，取舍与实测在 `docs/UI.md`；
4. 改完 `node --test` + `npx vite build`，并在 `ui-probe.html` 上跑一遍探针
   （要看的是：重渲染后 `sameNode` 仍为 true、焦点还在、`render()` 后同一行能读到 DOM）。

### 加一个**权限**

1. **一个能力一个权限**，且先问：这是「观察」还是「能力」？观察不要权限；
2. 权限名形如 `rpc:<服务名>`（由网关按服务判），或一个显式的独立名（`win:manage`、`rpc:dialog`）；
3. 更新 `docs/plugin-dev/manifest.md` 的权限表 —— **测试会比对「文档列的」与「代码能闸的」两个集合**，
   多写一个（文档里有、代码里没有）和少写一个（代码里有、文档里没有）都会失败；
4. 想清楚默认值：新权限不应该悄悄出现在已有插件的清单里。

### 加一个**方案**（transport × codec）

1. 加一个 descriptor（`src/protocol/registry.js`）+ 一个 transport 模块（`src/protocol/transports/`）；
2. 更新 `docs/PROTOCOL.md` §3 的方案表与 `docs/plugin-dev/architecture.md` §④；
3. `tests/protocol.test.mjs` 会检查「声明的方案都有实现」，`plugin-docs` 会比对文档里的方案 id 集合。

### 加一个 **`contributes` 键**

1. 在 `docs/plugin-dev/manifest.md` 里加一节；
2. 注意 `mergeManifest` 是 `contributes` 逐键合并、`plugin.json` 覆盖代码导出；
3. 拼错的键名目前**会静默忽略**（`INTERFACE-REVIEW` 的 O5 建议用 JSON Schema 补上）。

---

## 文档卫生的三条硬规则

1. **不重复论证。** 设计取舍写在 `PROTOCOL.md` / `UI.md` / `INTERFACE-REVIEW` 里，
   `plugin-dev/*` 只引用结论。同一个论点出现两遍，就会有一份先过期。
2. **不写第二份清单。** 清单只有一份，其余地方链接过去。数量写在文档里时，
   测试必须盯着它（这就是 `plugin-docs` 存在的原因）。
3. **删掉的东西要说明去了哪。** 例：`SUPPLEMENT.md` 顶部的「已并入手册」横幅 ——
   它比直接删除更有用，因为老读者会回来找。

---

## 什么时候该跑什么

```bash
npm run test                 # 241 项，含 plugin-docs / hygiene / codes / plugins 审计
cd src-tauri && cargo run --example host-checks   # 29 条纯逻辑断言（Windows 上 cargo test 不可用）
```

`plugin-docs` 的失败信息是**可直接执行**的：它告诉你「文档说 N，代码是 M，改哪个文件」。
**不要靠改测试让它变绿** —— 那是把守卫变成装饰。
