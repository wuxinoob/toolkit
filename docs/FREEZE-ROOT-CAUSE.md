# 界面冻结根因分析：PTY 读取占满 Tokio worker

分析日期：2026-11-02。本文补充 `FREEZE-REPORT.md`，保留原报告作为历史现场记录。

## 结论与证据边界

**已在本机相同版本的底层库上复现：PTY 的同步读取占用异步 worker，子进程退出后读取仍不结束，多轮执行逐步耗尽 worker，最终整个 Tauri 异步运行时无法调度。**

30 分钟定时任务反复创建 PTY，是累积问题的触发入口。具体缺陷在 `tauri-plugin-pty 0.3.1` 的阻塞操作和会话所有权，以及前端完成流时没有取消原生读取的组合中。

这是代码路径分析、历史日志和原生最小复现共同支持的根因。最小复现没有启动完整 Toolkit/WebView2；历史冻结进程已无可用线程栈，因此不能声称已经逐个核实历史现场每个 worker 的栈。根因分析阶段没有修改生产代码；后续修复见第 7 节。

## 1. 报告遗漏了实际执行路径

procman 的调用链是：

```text
procman.js: armSchedules → launchProfile → spawnFromSpec
  → ctx.pty
  → hub.pty
  → pty-stream transport
      → invoke('plugin:pty|spawn')
      → invoke('plugin:pty|read')，循环读取
      → invoke('plugin:pty|exitstatus')，独立等待退出
```

对应位置：

- `src/plugins/procman.js:206`：`await ctx.pty(...)`。
- `src/host/ctx.js:779`、`src/protocol/hub.js:489`：选择 `pty-stream`。
- `src/protocol/transports/pty.js:132`、`:302`、`:322`：直接调用第三方 PTY 命令。
- `src-tauri/src/lib.rs:1444`：注册 `tauri_plugin_pty::init()`。
- `src-tauri/Cargo.lock:4855`：实际解析版本为 `0.3.1`；其底层为 `portable-pty 0.9.0`。

这些 PTY 命令**不经过** `plugin_rpc`、`plugin_stream_open` 或 `plugin_stream_open_raw`。后两者在当前服务表中处理的是 `ticker`、`blob` 等 provider。此前给它们添加 `spawn_blocking`，没有覆盖这条 PTY 路径。

因此 `gw=1` 只表示统一网关剩一个在途请求，不能表示整个运行时只有一个未完成任务；第三方 PTY 读取不在这个统计里。

## 2. 两个相互叠加的缺陷

### 2.1 异步函数直接执行同步 read / wait

本机依赖源码位于：

```text
C:/Users/Tan18/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/
  tauri-plugin-pty-0.3.1/src/lib.rs
```

`read`（第 117–142 行）的关键步骤：

```rust
let session = state.sessions.read().await.get(&pid)
    .ok_or("Unavailable pid")?.clone();
let n = session.reader.lock().await.read(&mut buf)?;
```

锁是异步锁，但 `read` 是 `std::io::Read::read`，没有输出时同步阻塞当前 OS 线程。`.await` 只负责等待取得锁，不会让后面的同步读取自动变成异步 I/O。

`exitstatus`（第 191–213 行）同样直接执行：

```rust
let exitstatus = session.child.lock().await.wait()?.exit_code();
let _ = state.sessions.write().await.remove(&pid);
```

`wait()` 是同步等待；Windows 实现最终调用 `WaitForSingleObject(..., INFINITE)`。`spawn`、`write`、`resize`、`kill` 也直接执行同步操作。最关键的是可能长期不返回的 `read` 和 `wait`。

Tauri 默认运行时使用 `TokioRuntime::new()`，本项目没有替换它。这些命令和网关、心跳共享 worker。Tokio 官方说明了同步阻塞会阻止其他 future 推进，长期运行的阻塞工作应使用独立线程：[Tokio 1.53.1 文档](https://docs.rs/tokio/1.53.1/tokio/task/fn.spawn_blocking.html)。

### 2.2 已退出的进程留下读取任务，读取任务又阻止 PTY 关闭

插件的 `Session` 同时持有 `pair: Mutex<PtyPair>`、reader、writer、child。每次 `read` 先克隆整个 `Arc<Session>`。

在 Windows 下，子进程退出不保证 ConPTY reader 立即 EOF。`portable-pty` 把伪控制台放在 PTY pair 的所有权中，`PsuedoCon::drop` 才调用 `ClosePseudoConsole`。

因此，以下时序会形成资源生命周期上的循环等待：

```text
read 克隆 Arc<Session>，进入同步管道读取
  → 子进程退出
  → exitstatus 从 sessions 表移除 Session
  → read 仍持有 Arc，Session 没有析构
  → Session 内的 PtyPair / 伪控制台没有关闭
  → read 仍等不到 EOF
  → 该 worker 一直停在读取里
```

前端 `pty.js` 文件开头已经记录过“Windows 子进程退出后 reader 仍停住”的现象。目前通过 120 ms 静默等待，前端可以先发布 `exit`；但这只结束逻辑流：

- `finish()` 设置 `stopped = true`，只能让读取**返回之后**的 JavaScript 停止继续处理。
- `releaseNativeSession()` 调用项目自己的 `stream/session_close`，只移除宿主的记录。
- 宿主登记 PTY 时没有 OS pid，对应 stop closure 为空；这条登记也没有持有第三方插件的 reader/master。
- 它们都不能取消已经进入 Rust 的同步读取。

所以界面显示“进程已退出”、宿主 `sessions` 降回 1，也不能证明该进程对应的原生读取已结束。

## 3. 本机原生复现与对照实验

复现源码：[`diagnostics/pty-freeze-repro.rs`](diagnostics/pty-freeze-repro.rs)。

复现使用本项目已编译的 `tokio 1.53.1`、`portable-pty 0.9.0`，保留插件的 `Arc<Session>`、同步 read/wait 和移除 registry 的关键行为，只运行 `cmd.exe /D /C echo PTY_FREEZE_REPRO`。不运行用户的 Python 任务，不操作 Toolkit 窗口。

为缩短实验时间固定 4 个 worker；本机可用逻辑处理器为 20。独立主线程负责观察。复现额外让 PTY pair 可被观察线程取出，**只用于测量后的清理**；正式插件没有这一关闭入口。

编译方法（在项目根目录，使用本机已有缓存）：

```powershell
$reproDeps = 'src-tauri/target-check/debug/deps'
$reproTokio = (Get-ChildItem $reproDeps -Filter 'libtokio-*.rlib' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
$reproPortable = (Get-ChildItem $reproDeps -Filter 'libportable_pty-*.rlib' | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
rustc --edition=2021 docs/diagnostics/pty-freeze-repro.rs -L "dependency=$reproDeps" --extern "tokio=$reproTokio" --extern "portable_pty=$reproPortable" -o src-tauri/target/pty-freeze-repro.exe
.\src-tauri\target\pty-freeze-repro.exe inline
.\src-tauri\target\pty-freeze-repro.exe offload
```

如果 `target-check` 中没有已编译的 rlib，可改用同版本依赖所在的 `src-tauri/target/debug/deps`；这些是本机现有构建缓存，不是新的项目依赖。

原路径实验的实测输出：

```text
mode=inline workers=4 logical_cpus=20
round=1 exit=Some(0) retained_sessions=1 active_reads=1 beat_delta=6
round=2 exit=Some(0) retained_sessions=2 active_reads=2 beat_delta=6
round=3 exit=Some(0) retained_sessions=3 active_reads=3 beat_delta=6
round=4 exit=Some(0) retained_sessions=4 active_reads=4 beat_delta=1
round=5 exit=None retained_sessions=5 active_reads=4 beat_delta=0
STARVED: trivial async heartbeat stopped; main thread still running
blocking_returned=true async_resumed=false trivial_ran=false
after_explicit_master_close active_reads=0
```

前四个命令均已正常退出，但四个读取仍在占用 worker；第五轮的退出状态任务已经无法调度。与此同时，阻塞池上的新任务能够完成，等待它的异步任务和纯原子计数任务无法执行。

对照实验把 read/wait 移到 blocking pool，其他生命周期行为保持相同：

```text
mode=offload workers=4 logical_cpus=20
round=1 exit=Some(0) retained_sessions=1 active_reads=1 beat_delta=6
...
round=8 exit=Some(0) retained_sessions=8 active_reads=8 beat_delta=6
blocking_returned=true async_resumed=true trivial_ran=true
after_explicit_master_close active_reads=0
```

这确认了两件不同的事：

1. 移出 worker 可以消除这次实验中的运行时停摆。
2. 只移动线程仍然留下读取和会话；必须再修复 PTY 主端的关闭与读取取消，才能消除累积。

## 4. 与最近一次真实冻结对齐

`logs/freeze-2026-11-01_230400.txt` 中最后一轮控制台输出，换算北京时间：

```text
2026-11-02 06:33:00.594  上一轮 ch=smvyeophw810 exit code=0
2026-11-02 07:02:59.951  新一轮 spawn，插件句柄 pid=26
2026-11-02 07:02:59.951  launch "auto auth school web" (schedule)
2026-11-02 07:02:59.951  armed ... in 1800s
```

之后没有该轮的 `exit` 记录。这里的 `pid=26` 是插件内部递增的会话句柄，不是 Windows PID，也不能当作“已阻塞 worker 数”。

`flight.jsonl` 的相邻采样：

| 北京时间 | beat | tbeat | calls | 宿主 sessions | 网关状态 |
|---|---:|---:|---:|---:|---|
| 07:02:59 | 46779 | 9354 | 184343 | 前一全量快照为 1 | 正常推进 |
| 07:03:04 | 46780 | 9354 | 184349 | 2 | `proc/recv@main[returned]` |
| 07:03:09 起 | 46780 | 9354 | 184349 | 2 | 同一返回阶段一直保留 |

该现场符合“历次运行留下未完成读取，新一轮再占用剩余 worker，运行时停止调度”的机制。无法从历史文件直接数出当时有多少个 PTY read 已经悬挂；并非每次启动都必然留下读取，退出与下一次 read 的时序会影响结果。

这也解释了：

- 数小时后才出现：累积的是 worker 被占用，而不是单次启动必定卡死。
- 简单点击几次不一定复现：尚未达到线程容量；当前实现对仍运行的 profile 直接返回，也没有真的再次 spawn。
- `inFlight=1`、内存和句柄看起来正常：少量未完成的第三方读取足以耗尽固定数量的 worker，网关计数看不到它们。
- `proc/recv[returned]` 留住数小时：它是运行时停摆时的受害者，服务工作本身已经结束。
- 主线程、记录线程仍正常：它们不属于被占满的 worker。
- reload/recreate 无效：换页面没有关闭旧的 Rust PTY 读取，也没有重建进程级全局运行时。

## 5. 对原报告假设和仪器的校正

**无需全局互斥锁死锁，也能得到 beat/tbeat 同时冻结。** 它们证明异步任务得不到调度，不能进一步唯一指向“worker 都等同一把锁”。同步读取直接占满 worker 也会产生完全相同的签名，复现已验证这一点。

`host::registry` 的临界区只有集合/字符串操作，没有 I/O、回调或 await；当前未发现长期持有路径。`gateway_stats::oldest` 同样没有这种操作，而且飞行记录线程会先阻塞式调用 `gateway_stats::snapshot()` 再写记录：如果该锁永久不释放，持续每 5 秒落盘的现场本身就难以成立。panic unwind 通常通过 RAII 释放 guard 并留下 poisoning，不会自动永久持锁。

另一个独立的诊断缺陷：`renderer=none` **不能用来证明所有渲染器不执行 JavaScript**。`src/host/liveness.js` 写的是 DOM 的 `document.title`；记录器读取的是原生窗口标题。当前源码没有注册 `on_document_title_changed` 来同步二者。Tauri 2.12.1 默认该 handler 为 `None`，wry 只有在配置了 handler 时才订阅 `DocumentTitleChanged`。应先接通这条链，再用标题信标判断渲染器活性。本次定位并不依赖 `renderer=none`。

另外，`tbeat` 实际由记录器的 5 秒 tick 投递，当前并非每秒一次；这不影响停摆判断。

## 6. 修复应落在哪里

需要修复/替换的是第三方 PTY 后端及其生命周期，不是继续在无关的网关函数外包 `spawn_blocking`。

1. **隔离阻塞操作**：PTY 的 read、wait 等不能直接在 Tokio worker 执行。持续读取宜用专用线程向 Tauri Channel 推送；较短操作可放到 blocking pool。
2. **让 PTY 关闭独立于 pending read 的所有权**：读取任务不能因为持有整个 `Arc<Session>` 而阻止 master/pseudoconsole 关闭。进程退出或主动停止时，由明确的所有者关闭主端/取消原生 I/O，让读取真实结束，再回收线程和会话。关闭时要保留尾部输出排空的顺序。
3. **区分逻辑流结束与原生资源回收**：JavaScript 的 `stopped` 和宿主 `session_close` 都不能替代原生关闭。仅加 `Promise.race` 超时或对已进入同步 I/O 的任务调用 abort，也不能取消底层 read。
4. **补充原生生命周期验证**：记录 pending read/wait 数、真实 PTY 存活数；循环运行超过 worker 数量的短命令后，确认 pending read 回零、会话回收、心跳持续增长。

既有 `node --test tests/procman-schedule.test.mjs tests/pty-ordering.test.mjs` 本次 14/14 通过。调度测试验证的是触发次数；PTY 测试 mock 了原生命令，用不阻塞线程的 pending Promise 模拟读取，因此没有覆盖原生 worker 和 ConPTY 资源回收。这是之前测试通过却仍然冻结的原因。

## 7. 已实现的修复（2026-11-02）

`src-tauri/Cargo.toml` 现改用项目内的 `plugins/tauri-plugin-pty`。保留原插件的命令名、参数、返回载荷和权限标识，由新的原生后端管理 IO 和资源：

- 每个活跃 PTY 使用独立 reader/waiter 线程。reader 只持有输出管道和缓冲区，不持有包含主端的会话。
- 子进程退出后，waiter 取出并关闭 PTY pair；reader 持续排空输出直到 EOF；waiter 回收 reader 后发布退出状态。
- `read` 只异步等待数据；spawn/write/resize/kill 的同步操作移至 blocking pool。
- `exitstatus` 在输出被读取或显式丢弃后才移除命令会话，防止过早移除记录丢失尾部数据。
- Stop 和宿主退出通过原生 stop callback 工作，无需前端继续轮询；关闭、取消读取和未交付的 spawn 结果均有回收路径。
- 每个会话的未读输出上限为 8 MiB。超限时明确报告错误、终止生产进程并继续排空底层管道，避免无限增长或关闭时因背压死锁。
- Windows kill 持有独立的真实进程句柄，绕过 `portable-pty 0.9.0` 中 `WinChildKiller::kill` 对 `TerminateProcess` 成功/失败的反向判定，并处理进程已退出的竞态。

前端 `pty.js` 的登记参数新增 `ptyHandle`，只用于获得后端 stop callback，不冒充 OS PID。飞行记录的全量快照和 `host_diag` 新增 `pty: { readers, waiters, consoles }`，可直接观察活跃原生资源。

原生回归位于 `src-tauri/examples/pty-lifecycle-checks.rs`，使用生产后端和真实 Windows ConPTY；异步运行时固定 4 个 worker，并从普通线程设置超时和投递心跳。覆盖：

1. 连续 40 个短进程，每次退出后 reader/waiter/console 均归零。
2. 12 个并发交互进程，验证心跳、输入和 resize。
3. 超过单次 read 大小的输出，保留最终行和尾部标记。
4. 取消读取、前端不存在、完全没有 read 时的停止和资源回收。
5. spawn 结果无人接收时的自动回收。
6. 未读输出超过 8 MiB 后的显式错误和清理。

验证命令：

```powershell
cargo run --offline --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target-check --example pty-lifecycle-checks
cargo build --offline --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target-check
npm test
npm run build
```

前端测试 354/354 通过，前端生产构建和 Rust 开发构建通过。原生检查最终要求 `readers=0, waiters=0, consoles=0`。这些检查覆盖了已定位的累积阻塞机制；尚未完成真实 30 分钟任务的整夜运行验证。应用需要重新编译并重启，单独刷新旧进程的页面不会加载新的 Rust 后端。

## 8. 后续诊断校正（2026-11-04）

网关统计与活性监测现分别位于 `src-tauri/src/gateway_stats.rs` 和 `src-tauri/src/ui_heartbeat.rs`，模块路径不变。

本次原生回归又确认了旧统计的归属问题：请求 A、B 重叠时，A 先结束仍可能作为 `oldest` 保留；同名请求也会串改阶段。现已使用每请求 ticket 修复。因此，旧日志中的名称、年龄与 `[returned]` 本身不能证明对应请求当时仍在等待，历史判断应同时依据 beat/tbeat、调用计数和原生复现。

这些校正不改变已复现的 PTY worker 饥饿与原生回收机制。DOM 标题到原生窗口标题的转发仍未接通，`renderer=none` / `no-beacon` 继续不能单独用于判断渲染器是否执行 JavaScript；完整应用的整夜验证也仍未完成。各阶段检查见 [开发记录](DEVELOPMENT-LOG.md)。
