# Toolkit 界面冻结问题 — 技术简报

> 交付给外部模型分析用。所有结论都标注了证据来源，未证实的标注为「假设」。
> 日期：2026-11-02

---

## 1. 环境

| 项 | 值 |
|---|---|
| 应用 | Toolkit（Tauri 2 + Vue 3 + Vite，identifier `com.tan18.toolkit`） |
| 运行方式 | `tauri dev`（debug 构建，前端由 vite 在 127.0.0.1:1420 提供） |
| OS | Windows 11，WebView2 运行时 156.0.4314.50 |
| 进程结构 | 1 个宿主 `toolkit.exe`；1 个 WebView2 浏览器进程；每个窗口 1 个独立渲染进程 |
| 窗口 | 主窗口 `main` + 最多 5 个插件窗口（护眼胶囊/休息/休息控制/便签×2） |
| 主窗口配置 | `"visible": false`，由页面 boot 后自己 `show()` |
| 关键参数 | `--disable-features=…CalculateNativeWinOcclusion --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --enable-logging --v=0` |

**架构要点**：所有插件调用走一条统一网关 `plugin_rpc`（`#[tauri::command] async fn`），
内部 `tauri::async_runtime::spawn_blocking(...).await` 执行真正的服务调用。
另有 `plugin_stream_open(_raw)` 用于 pty / sidecar 流。
宿主侧有一个 10 s 一次的看门狗线程（普通 std 线程）与一个 5 s 一次的飞行记录线程（普通 std 线程）。

---

## 2. 现象

**主症状（A）**：应用连续运行数小时后，**界面完全无响应**——按钮点了没反应、插件视图空白、胶囊计时不走。
进程不退出、不崩溃。**只有重启进程能恢复**（reload 页面、重建 webview 都无效）。

**次症状（B）**：关闭主窗口后从托盘「显示主窗口」要等 1 分钟以上。
**已定位并修复**，属于恢复阶梯自身的 bug，与 A 无因果关系（见 §6）。

---

## 3. 已确认的事实（附证据）

### 3.1 宿主本身完全健康

```
pump=ok            # run_on_main_thread 投递的闭包能在 300ms 内执行 → 主线程在正常泵消息
handles=774        # 句柄正常，无泄漏
RSS=54–76 MB
threads=39
```

### 3.2 UI 到宿主的调用流量在某一刻完全停止，且再未恢复

宿主维护一个**单调递增**的调用计数器 `calls`（每次进入 `plugin_rpc` / `plugin_stream_open` 时 +1）：

```
23:4x  calls=266021
00:1x  calls=267191
01:1x  calls=267191   ← 冻结
03:1x  calls=267191
04:49  calls=267191
```

### 3.3 异步运行时停止调度 —— 两个独立探针同时冻结

| 探针 | 实现 | 冻结前 | 冻结后 |
|---|---|---|---|
| `beat` | 在 tokio 运行时上每秒做一次 `spawn_blocking(sleep 1s).await` 并计数 | 64485 | **64787（不再变）** |
| `tbeat` | 由**普通线程**每秒 `tauri::async_runtime::spawn` 一个**只做 `fetch_add`** 的 trivial task | 9354 | **9354（不再变）** |

`tbeat` 不碰阻塞池、不做任何 I/O，只要求运行时能调度一个空任务。它冻结说明**worker 本身不再运行**，
不是「阻塞池被占满」（若是后者，`tbeat` 仍会增长）。

### 3.4 有一个 future 在阻塞任务返回后再也没被轮询

宿主记录「最老的在途调用」，并把阶段写进标签：`[queued] → [running] → [returned]`。
`[returned]` 由**阻塞线程在返回前的最后一行**写入。

```
oldest = Some((63216,    "proc/recv@main[returned]"))
oldest = Some((183270,   "proc/recv@main[returned]"))
oldest = Some((1265257,  "proc/recv@main[returned]"))
oldest = Some((18258660, "proc/recv@main[returned]"))   ← 5 小时
```

即：**工作已经做完，`spawn_blocking` 的 JoinHandle 已经完成，但 await 它的那个 future 从未被再次轮询。**
同时 `inFlight` 恒为 **1**（若阻塞池被 512 个卡死任务占满，这里会是几百）。

### 3.5 WebView2 浏览器进程没有卡死

Chromium 自己的日志（`--enable-logging` 写到 `EBWebView/chrome_debug.log`）在冻结**之后**仍在持续写入：

```
16:46:56 OnWidgetActivationChanged - active: 1
16:46:56 OnWidgetActivationChanged - active: 0
```

这是用户点击窗口时浏览器进程对焦点变化的响应。冻结前后也持续有网络请求记录。

### 3.6 没有崩溃、没有显卡复位、没有系统睡眠

- `EBWebView/Crashpad/reports` 里只有 9/14 和 10/5 两个旧 dump，冻结时段**无新 dump** → 没有进程崩溃。
- 事件日志无 TDR（4101/4102）→ 不是显卡驱动复位。
- 宿主 5 s 记录线程整夜无 >30 s 空档 → 进程未被挂起；`Kernel-Power` 566（`InputHid`）只表明显示器熄屏/亮屏。

### 3.7 无渲染器发布存活信标

宿主每 5 s 读一次各窗口的**窗口标题**（`GetWindowText`，**完全绕开 IPC**）。页面在检测到桥接异常时
会把 `#hb:<n>` 写进 `document.title`，宿主据此判断渲染器是否还在跑 JS。
所有冻结现场的判定都是 `renderer=none` —— **没有任何窗口发布过信标**，即冻结后没有任何页面再执行定时器。

---

## 4. 已排除的假设

| 假设 | 排除依据 |
|---|---|
| 主线程被阻塞 | `pump=ok` 持续成立 |
| 阻塞池被占满 | `inFlight=1`，且那一条已 `[returned]`；`tbeat` 也冻结（它不走阻塞池） |
| 渲染进程崩溃 | 无 crash dump；窗口与标题都在 |
| WebView2 浏览器进程卡死 | Chromium 日志在冻结后仍响应焦点事件 |
| 句柄/资源泄漏 | 774 句柄、54–76 MB，稳定 |
| 系统睡眠导致 | 无 sleep 记录；事件日志只显示熄屏/亮屏 |
| 显卡驱动复位 | 无 TDR 事件 |
| 机器负载/CPU 打满 | 宿主 CPU 空闲，GPU 进程占用升高但非饱和 |

---

## 5. 当前主要假设（未证实）

**某个全局 `std::sync::Mutex` 被一个 worker 在 await 之前获取后长期不释放，导致所有 worker 停在同一把锁上。**

代码里在**任何 await 之前**被每次网关调用碰到的锁只有两把：

1. `host/registry.rs::registry()` — `Mutex<HashMap<String, HashSet<String>>>`
   由 `is_allowed(plugin_id, perm)` 在 `plugin_rpc` / `plugin_stream_open` 的**第一行**获取。
2. `lib.rs::gateway_stats::oldest()` — `Mutex<Option<(Instant, String)>>`
   由 `enter()`（每次 `plugin_rpc` 开头）与 `mark()`（阻塞线程内）与 `snapshot()`（记录线程每 5 s）获取。

两者按设计都只持有极短时间（一次 HashMap 查找 / 一次赋值）。**尚未找到能长期持有的路径**，
这是需要外部视角的地方。

相关代码（`plugin_rpc` 主体）：

```rust
async fn plugin_rpc(app, window: WebviewWindow, plugin_id, msg) -> Result<Envelope, String> {
    msg.validate()?;
    let what = format!("{svc}/{act}@{}", window.label());
    let _in_flight = gateway_stats::enter(what.clone());   // ← 锁 oldest()
    ui_heartbeat::touch();
    host::registry::is_allowed(&plugin_id, &format!("rpc:{svc}"))?;  // ← 锁 registry()
    let in_task = what.clone();
    tauri::async_runtime::spawn_blocking(move || {
        gateway_stats::mark(&in_task, "running");           // ← 锁 oldest()
        let out = services::route(&app, &plugin_id, &svc, &act, params);
        gateway_stats::mark(&in_task, "returned");          // ← 锁 oldest()
        out
    })
    .await
    .map_err(|e| format!("rpc task failed: {e}"))?
}
```

### 触发条件（相关性，未证实因果）

冻结时刻多次与「procman 的 30 分钟定时任务启动一个子进程」重合：

- 2026-10-29 10:56:20：`sessions` 1→2、`python.exe` 创建、procman 的 `lastRunAt` 三处时间戳精确到同一秒，随后 UI 冻结。
- 但**用户手动重复点击「运行」无法复现**，说明「启动子进程」不是充分条件。

### 待回答的问题

1. 在这份代码结构下，`registry()` 或 `oldest()` 有没有可能被长期持有？（重入？panic 后未释放？
   某个阻塞调用发生在持锁区内？）
2. Tauri 2 是否存在「webview 被 destroy/create 后 async runtime 停止调度」的已知问题？
3. 还有什么机制能同时冻结「纯异步 trivial task」与「spawn_blocking 往返」，而 tao 主线程与普通 std 线程完全正常？
4. `spawn_blocking` 的 JoinHandle 已完成但 future 不被唤醒，除了「所有 worker 停摆」还有什么解释？

---

## 6. 次症状 B：已定位并修复（供参考，不是 A 的原因）

`debug.log` 里曾出现**精确 3 分钟一圈、连续十几圈**的循环：

```
04:13:14  the UI is still silent after 189s — rebuilding the webview
          the main window DESTROYED            ← 阶梯自己 destroy()
04:13:15  the main webview was rebuilt
04:13:24  recovery step 2 verified             ← 假阳性
04:14:24  the UI has been silent for 69s
```

原因是我自己引入的两个 bug：`reset_silence()` 里清了 `ATTEMPTS`（阶梯永远从第一级重来）、
且恢复验证用「静默时长 < 60 s」而该函数正好把静默清零（每一级都自我验证成功）。
已改为：`reset_silence()` 只重置时钟；验证改用**调用计数器增量**。

**结论：窗口被反复销毁重建是阶梯的行为，不是用户关闭导致，也不是 A 的原因。**

---

## 7. 现成的仪器与判读表

### 日志文件

| 文件 | 内容 |
|---|---|
| `%APPDATA%\com.tan18.toolkit\logs\flight.jsonl` | 5 s 一条：`beat` `tbeat` `calls` `silent` `gw` `oldest` `sessions` `windows[hb]` |
| `logs\freeze-<UTC>.txt` | 每级恢复动作**之前**落盘：完整快照 + 最近 300 条 tick + Chromium 日志最后 200 行 |
| `debug.log` | 恢复阶梯的每一级决策（含 `diag()` 输出） |
| `EBWebView\chrome_debug.log` | Chromium 内部日志 + **每个窗口的 console**（`INFO:CONSOLE`） |

### 判读表

| `beat` | `tbeat` | 结论 |
|---|---|---|
| 冻结 | 冻结 | worker 停摆（共享锁/死锁） ← **当前现场** |
| 冻结 | 增长 | 阻塞池满 |
| 增长 | 增长 | 运行时正常，问题在别处（IPC/渲染器） |

### 已加但尚未被触发的探针

记录线程每 5 s 对 `registry()` 与 `oldest()` 各做一次 `try_lock`；连续 3 拍（15 s）拿不到就写一条：

```json
{"k":"lock","registryTicks":3,"gatewayTicks":0,"beat":46780,"tbeat":9354}
```

这条事件一旦出现，就能直接点名是哪把锁——这是下一步的主要指望。

---

## 8. 现场数据摘要（最近一次冻结，2026-11-02 04:49 UTC）

```
pump      = ok
beat      = 46780   (冻结)
tbeat     = 9354    (冻结)
calls     = 184349  (冻结)
inFlight  = 1
oldest    = proc/recv@main[returned], 18258660 ms
sessions  = 2
renderer  = none
handles   = 774
```
