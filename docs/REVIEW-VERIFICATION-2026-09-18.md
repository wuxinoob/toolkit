# 分支评审复核 + 结论（2026-09-18）

范围：`codex/plugin-communication-lifecycle` 相对 `main` 的变更，以及
`COMMUNICATION-REVIEW-2026-09-17.md` 中各项静态发现的**可执行复核**。

复核手段：`git diff` / blob 比对、把工作区改动回退后重跑新测试、`node --test`、
`cargo run --example host-checks`、源码路径核对。

---

## 1. 实际变更范围（比 `git status` 显示的小）

`git status` 列出 3 个修改文件，但 `git status --porcelain=v2` 显示
`proc.rs` 与 `hub.js` 的 **blob 哈希在索引与工作区完全一致**
（`d6e6d9a0…` / `e561d18c…`）—— 只是 stat 缓存过期，**没有文本变更**。

真正的变更：

| 文件 | 性质 |
|---|---|
| `src/protocol/transports/stdioLine.js` | 修改（+18 −6） |
| `tests/stdio-close.test.mjs` | 新增（6 个测试） |
| `docs/COMMUNICATION-REVIEW-2026-09-17.md` | 新增（评审报告） |

**全部处于未提交状态**：`main` 与本分支都指向 `fdd0d79`，本分支尚无自己的提交。

---

## 2. 结论：是真修复，不是重构 —— 已用回退实验证明

把 `stdioLine.js` 回退到 `main` 版本、保留新测试重跑：**6 项中 5 项失败**。

| 新测试 | main 上的结果 | 说明 |
|---|---|---|
| 业务错误（id=0）不结束会话 | **失败** | 旧代码把 `err` 当终止帧 |
| 业务错误（id=17）不结束会话 | **失败** | 同上 |
| 流错误仍然终止会话 | 通过 | 该测试钉的是**未变**的行为，正确 |
| close 只通知一次 onEnd 并清理记录 | **失败** | 旧代码 `finish` 被 `stopped` 守卫吞掉 |
| close 忽略迟到的 recv 结果 | **失败** | 旧代码会处理关闭后的帧 |
| close 真的杀掉子进程且 onEnd 一次 | **失败** | 同第 4 项 |

因此该变更实际修掉 **4 个真实缺陷**：

1. **`close()` 从不发终止帧。** 旧代码 `close()` 先 `stopped = true`，再调
   `finish(Envelope.end(ch))`，而 `finish` 的第一行就是 `if (stopped) return` →
   `onEnd` 永不触发。拆出独立的 `ended` 标志修复。
2. **hub 流记录泄漏。** `ctx` 的清理直接调 `handle.close()`（绕过 `hub.close`），
   记录只能靠 `onEnd` 删除；第 1 项导致它永远删不掉。
3. **`close()` 不幂等。** 并发/重复 close 会重复 kill、重复 onEnd。
   改为缓存同一个 promise。
4. **sidecar 的业务错误回复会杀死整个会话。**
   `TERMINAL = {END, EXIT, ERR}` 且传输层照单全收，于是 sidecar 回一个
   `err(id, 'div_by_zero')` 就终止读取。新代码区分「带 id 的 res/err = 回复」
   与「不带 id 的 err = 流故障」。

测试质量也到位：显式覆盖 **`id = 0`** 这个假值边界（写成真值判断就会漏）、
幂等 close、close 与 recv 的竞态、以及一个**真实子进程**的集成用例。

---

## 3. 对该变更的唯一实质批评：修复放在了错误的层

新规则「带 id 的 res/err 不算终止」写在 `stdioLine.js` 内部，而
`channelJson.js:41` 与 `channelRaw.js:46` 仍然是裸的 `Envelope.isTerminal(env.kind)`。

于是**「什么帧结束一条流」这个语义现在按方案而异** —— 正是本项目要消除的
"方案泄漏成语义"。当前是潜伏的（channel 流不承载请求/应答），但只要加入
**双工/上行通道**（P0 第 1 项）就会立刻踩到：channel 路径会在第一个错误回复处
静默断流。

建议把规则上提为共享谓词，例如 `envelope.js`：

```js
/** 结束本条流的帧。带 id 的 res/err 是同一条通道上的应答，不是流终止。 */
export const endsStream = (env) =>
  isTerminal(env.kind) && !((env.kind === Kind.RES || env.kind === Kind.ERR) && env.id != null);
```

三处传输 + hub 统一改用 `endsStream`。这是小改动，但把它从"一个方案的特例"
变成"协议的规则"。

---

## 4. 对评审报告各项发现的复核

| # | 评审主张 | 复核结论 |
|---|---|---|
| 1 | `external.js:36` Rescan 只增量发现，不处理更新/删除/重试 | **成立**（已知限制） |
| 2 | `lifecycle.js:21` Disposer 不等待异步清理、无关闭态 | **成立**：`run()` 同步调用 `fn()`，异步清理变成 fire-and-forget，其 rejection 无人接管 |
| 3 | `proc.rs:267` `kill_all_for` 先 `session::close` 再 `stop_one`，回调已被删除 | **成立，且严重**：`close` 会 `remove` 掉整个 Session（连 stop 闭包一起丢弃），随后 `stop_one` 找不到 → 返回 false。更早那轮还已把 proc 注册表项 `remove`（连 `Child` 句柄一起丢）。**`proc/kill_all` 实际上一个进程都没杀，却回报 `{"killed": N}`** |
| 4 | `stdioLine.js:90` close 的 `finish` 被守卫吞掉 | **成立，且本分支已修**（见 §2） |
| 5 | `envelope.js:28` + `stdioLine.js:62` `err` 一律终止 | **成立，且本分支已修** |
| 6 | `proc.rs:120` 单行 1 MiB、stdout 队列无总量上限 | **成立**：`MAX_LINE_BYTES = 1<<20`，`VecDeque` 无累计上限 |
| 7 | `proc.rs:114` reader 持 Child 锁阻塞 `wait`，kill 需要同一把锁 | **成立**：`kill_handle` 锁 `h.child`，而 reader 在 EOF 后**持锁**调 `wait()`。若 sidecar 关闭 stdout 但继续运行，所有 kill 路径（含退出时的 `session::kill_all()`）会**永久阻塞** |
| 8 | `pty.js:41` drain 不保证尾部输出先于 exit；session 登记晚于创建且失败被忽略 | **成立**（drain 是启发式，已在代码注释中标注） |
| 9 | stdio 默认每行等 50 ms，理论上限约 20 行/秒 | **成立**：`tick()` 每消费一行都 `setTimeout(tick, pollMs=50)`；而 Rust 侧 `recv_from` 是 condvar 驱动、有数据立刻返回。**该上限纯由 JS 侧引入** |

补充修正一处措辞：评审称「`ctx` 的清理直接调用 `handle.close`，存在 hub 残留路径」——
准确，但残留的成因是 `finish` 被吞（第 4 项），本分支修复后该路径已闭合
（新测试断言 `openStreamKeys()` 为空，在旧代码上失败）。

---

## 5. 建议的处理顺序（按性价比）

| 优先级 | 事项 | 成本 |
|---|---|---|
| 1 | `kill_all_for`：删掉那轮 `session::close`，只保留 `stop_one`（或直接 `kill_handle`） | 3 行 |
| 2 | `kill_handle` / reader 的锁冲突：改为按 pid 杀，或 reader 在 `wait()` 期间不持锁 | 小，但要小心 |
| 3 | stdio 轮询上限：**仅当上次 recv 超时**才用 `pollMs`，拿到数据就立即再 poll | 3 行，吞吐从 ~20 行/秒放开到后端实际速度 |
| 4 | 终止语义上提为 `endsStream`，三个传输统一 | 小 |
| 5 | stdout 队列加累计字节上限；Disposer 支持 async 清理 | 中等 |

第 1、3 项是"改了立刻见效、风险极低"的两处，建议先做。

---

## 6. 复核之后已修掉的（更新于 2026-09-18）

上述 1–5 项**已全部完成**，另加两项复核时发现的问题：

| 事项 | 处理 |
|---|---|
| `kill_all_for` 先 close 再 stop，闭包已丢 | 新增 `session::take_stop`（移除并把闭包**交还**调用方），让错误顺序在结构上不可能 |
| kill 与 reader 抢同一把 `Mutex<Child>` | `kill_handle` 改为**按 pid 杀**（复用 `session::pid_stop`）+ `try_lock` 尽力回收 |
| stdio 每行等 `pollMs` 的 ~20 行/秒上限 | 改为「拿到数据立即再 poll，只有空转才退避」 |
| 终止语义按方案而异 | 上提为 `envelope.endsStream`，三个传输统一 |
| stdout 队列累计无界 | `MAX_QUEUED_BYTES = 4 MiB`，丢最旧 + 计数，`recv` 报 `dropped` |
| Disposer 不等待异步清理 | `run()` 改为 await + 幂等，调用点 `await` |
| `registry::unregister` 无人调用 → 卸载过的插件仍被授权 | 新增 `host/unregister`（仅宿主可调），卸载路径调用 |
| pty 用 120ms/1.5s 静默期猜"输出结束" | **见下** |

### pty 的 drain 启发式已被确定性方案取代

复核时只看到"drain 不能保证尾部输出先于 exit"，于是去看依赖内部，发现**根因是信号被 JS wrapper 吞掉了**：
`tauri-pty` 的读循环以 `EOF` 错误结束，然后**静默 return**，而退出码在另一个 promise 上 ——
所以"输出结束"这件事对调用方不可观测，只能靠计时器猜。

改为直接驱动插件自己的命令（`plugin:pty|spawn/read/write/resize/kill/exitstatus`，ACL 的
`pty:default` 已覆盖）后，顺序变成确定的：

```
spawn → session_open（失败则杀子进程，不留下无人回收的进程）
      → read 循环直到输出结束（EOF / EIO / 会话已被移除，三种拼法同一个事实）
      → exitstatus（必须在输出结束之后再问：它会移除插件的会话，
        提前问会让尚未取走缓冲输出的 read 查不到会话，短命令的输出就丢了）
      → 发出 exit 帧
```

**不再有任何 drain 计时器**（测试直接断言这一点）。`tauri-pty` 这个 JS 包因此不再被引用，
已从 `package.json` 移除 —— 顺带消掉了"它没有 `main`/`exports` 字段、必须写显式 dist 路径"
这个长期坑。
