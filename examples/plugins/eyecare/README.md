# eyecare.demo — a floating eye-care timer

A port of a **Script Kit** plugin (`~/.kenv/scripts/eye-care.js`) to this host's
plugin contract. It is the widest example in the repo on purpose: five windows
of its own, a shipped native sidecar, a main-window view, and a state machine
driven by a timer — every layer of the contract in one folder.

The original is a good stress test because it does things a plugin "should not
be able to do": inject a stylesheet into another window's DOM, run a compiled
helper every second, cover the whole screen, and read the OS idle timer.

```
                       ┌──────────────── main window ────────────────┐
                       │  view "eyecare"  (ctx.ui factory, .tb-*)    │
                       │  the only writer of state                   │
                       └──┬────────────┬──────────────┬─────────────┘
       eyecare.state ─────┘            │              └───── eyecare.drag
       (bus) broadcast,               │                     (bus) the drag
       full snapshot, deduped         │                     hot path, one
              │                       │                     subscriber
              ▼                       ▼                     ▲
  ┌──────────────┬──────────────┬──────────────┬───────────┴───────┐
  │ ec-pill      │ ec-lock      │ ec-menu      │ ec-rest  ec-restctl│
  │ 159×34 *     │ 22×22 *      │ 186×235 *    │ monitor + 6px pad  │
  │ countdown +  │ unlock hit-  │ actions+cfg  │ 254×39 * buttons   │
  │ right-click  │ box, locked  │ 186×595 *cfg │                    │
  └──────────────┴──────────────┴──────────────┴────────────────────┘
              │
              └── ctx.sidecar('ec-idle') ── stdio-line ── idle.exe
                  GetLastInputInfo @ 4 Hz → evt envelopes

  * every starred size is MEASURED by that window from its own content and
    reported back (`win-size`), never hard-coded — see Performance §6
```

**One controller, four satellites.** The main window owns the clock and is the
only writer; every other window sends commands and renders the broadcast. The
original did the opposite — each window held a copy of the state and patched its
own DOM — and had to defend against duplicated handlers.

**Three topics, not one.** `eyecare.cmd` is for commands *into* the satellites
and is subscribed by all five of them, so the host delivers each message five
times; `eyecare.state` is the broadcast *out*; and `eyecare.drag` exists because
a pointer drag publishes once per animation frame and only the main window ever
acts on it — routing it through `eyecare.cmd` cost five webview deliveries per
frame for one consumer.

## Feasibility: what carried over, and what did not

Every behaviour of the original, checked against `docs/plugin-dev`.

| # | Original | Verdict | How / why |
|---|---|---|---|
| 1 | Single instance via a named pipe (`eye-care-ipc`) | **not needed** | One module per plugin id, loaded once by the host. `contributes.hotkeys` is itself the declaration and the host registers it, so the handshake has nothing left to guard. |
| 2 | `widget()` — transparent, borderless, always-on-top capsule (186×34) | **yes, and it sizes itself** | `ctx.windows.create` with `transparent`, `decorations:false`, `shadow:false`, `alwaysOnTop`, `skipTaskbar`, `focus:false`. The window is **measured from its contents** (159×34 at the default font) and resized from that report, so a font change cannot leave a dead gap — see Performance §6. |
| 3 | Second 28×28 lock hit-box window | **yes, narrowed** | Same path, but it exists **only while the pill is locked**. Unlocked, the pill's own lock icon is the target and there is no second window at all. It has to exist when locked: a click-through window receives no clicks, so the lock cannot live inside the capsule then. Its size comes from the pill's own measurement of the icon, not from a constant. |
| 4 | `widget.executeJavaScript()` to patch another window's DOM | **replaced** | A plugin cannot reach another window's DOM; the only cross-window channel is the bus. State is broadcast as one full snapshot on `eyecare.state`, deduped by content, and each window patches itself. At 1 Hz a tick that changes nothing costs zero IPC. |
| 5 | `db("eye-care-config")` | **yes** | `ctx.storage` (`rpc:storage`). |
| 6 | `execFileSync` re-running a `csc`-compiled idle detector every second | **replaced** | `ctx.sidecar('idle.exe')` (`stdio-line`, `rpc:proc`) — one long-lived process sampled at 4 Hz by the helper itself, speaking the host's own envelope format. |
| 7 | `electron.screen.getActiveScreen()` for the work area | **yes** | `window.screen` (`availWidth/Height/Left/Top`). Non-standard but implemented by Chromium, and it is the only way: `ctx` exposes no monitor or position API. |
| 8 | `screen-saver` / `GetLastInputInfo` for keyboard+mouse idle | **yes** | The same Win32 call, inside the shipped `idle.c`. |
| 9 | Full-screen rest overlay | **emulated, improved** | The window-option allow-list has no `fullscreen`, so the mask is a decoration-less window sized to the **whole monitor** (`screen.width/height`, not the work area) plus a 6 px overshoot on every side — which is what makes it cover the **taskbar** as well. The monitor's own origin is recovered from the taskbar thickness (`width − availWidth`, `height − availHeight`), and the resolution is re-read **every time a break starts**, so a scale change, a resolution change or a move to another monitor is picked up. It is then made **click-through**, so it can never eat a click. |
| 10 | Buttons on the overlay ("skip", "extend") | **yes, moved, and sized from the buttons** | A click-through window receives no clicks, so they live in a separate window (`ec-restctl`), exactly as in the original. It used to be a hard-coded 250×42 for 244 px of button plus padding: the labels wrapped to two lines and `border-radius: 999px` squashed each into a clipped ellipse. The window now measures both axes (254×39) — see Performance §6. |
| 11 | `Notification` | **yes, substituted** | `ctx.ui.notify` — the host's toast. The plugin has no notification API of its own. |
| 12 | 4 themes (`Dark`/`Light`/`Aqua`/`Minimal`) + 6 fonts | **yes, verbatim** | `THEMES` copied field for field; the background is `rgba(rgb, opacity)` driven by the two opacity settings. |
| 13 | `fields([…11…])` settings dialog | **yes, rebuilt, and extended** | The menu's own settings page, generated from one `FIELDS` table (12 numbers) + one `SWITCHES` table (5 toggles). The host has no form-dialog API; a page in the plugin's own window is the documented equivalent. Three of the twelve and one of the five are additions — see below. |
| 14 | Menu: rest / reset / extend / theme / recenter / config / exit | **yes, on right-click** | The same seven rows, same order. Only the last one changed meaning: a plugin cannot unload itself, so "exit" became "stop and hide". The menu is opened by **right-clicking the capsule** (`contextmenu`, with the default WebView2 menu suppressed); the ☰ button it used to hang off is gone. |
| 15 | Drag to move, remember the position, rescue it off-screen | **yes, re-implemented** | `ctx.windows.control('position', …)` takes absolute coordinates and nothing can read them back, so the plugin tracks the drag itself and persists the **clamped** position when it ends. Absolute, not a delta: a dropped frame can only lag, never drift. Only the pill follows the pointer frame by frame — see Performance §4. |
| 15b | Changing a duration takes effect at the next cycle | **improved** | Editing the current phase's length now **restarts that phase immediately**; editing the other phase's length leaves the running countdown alone. |
| 16 | Wake recovery (`recoverFromWake`) | **yes** | A gap of more than 3.5 s between ticks is a wake, not a missed tick. It re-reads the work area (the machine may have woken on another monitor) and restarts the current phase instead of counting the sleep down. |
| 17 | Gamma-corrected white-noise image + SVG `feImage/feColorMatrix/feComponentTransfer` overlay | **not ported** | It would work — a plugin window has a `document` and can hold an SVG filter — but it means a data-URI bitmap plus a filter chain inside a single-file ESM. The mask uses a flat scrim instead. Deliberate size trade-off, not a contract limit. |
| 18 | Background image from `image_path` | **not ported** | A plugin window cannot reach its own folder: the window URL must be the app's entry page, and no API returns the plugin's path. Nothing to point `<img src>` at. |

**Summary: 14 of 16 behaviours are implemented as-is or with a documented
substitution, 2 are dropped for size/reachability, and 1 (the named pipe) is
obsolete because the host already guarantees what it was guarding.**

## What the port adds, because the contract makes it cheap

- **A main-window view.** The original had no UI outside its floating windows —
  it was launched from the Kit and lived entirely in them. Here the same state
  is also a tool page: status, live countdown, theme and the two headline
  numbers, with the full table behind the menu's settings page.
- **A declared hotkey** (`ctrl+alt+e`) instead of a Kit trigger.
- **Both config surfaces carry everything.** The menu's settings page is
  generated from the same `FIELDS` and `SWITCHES` tables as the view, so
  「随应用一起启动」 and the other four toggles are reachable from the floating
  menu and not only from the tool page.
- **Two knobs for the capsule's own size** (also new, and also on both
  surfaces): **胶囊缩放** (0.7–1.8×) scales the pill's chrome — height, padding,
  the status dot, the two buttons, the lock ring — and **胶囊字号** (9–20 px)
  scales the label. They are orthogonal on purpose: the width is *not* a setting.
  The pill is as wide as its contents need, measured and reported; letting a user
  pin a width would only let them pin one that does not match the text. Scaling
  up raises the height, the larger font widens the label, and the window follows
  both. The view says so inline: 「胶囊宽度由内容实测决定」.
- **Work-time idle detection.** The original only reacted to input during a
  break. Now the focus countdown does too: **工作时检测键鼠空闲** plus
  **无输入多久重置专注** (default 300 s). After that much silence the focus
  countdown is **reset to the top and held**; the next input releases the hold, so
  the new period starts from the moment the user comes back. See §2 for why it
  resets rather than resumes.
- **The idle helper's failure reason is visible.** `ctx.log.warn` only reaches the
  webview console — not somewhere a user can be asked to look — and a missing
  binary, a refused permission and a channel collision are indistinguishable from
  outside. The view now prints the reason under the badge, and the badge tells
  「待命」 from 「不可用」 instead of collapsing both into silence.
- **`ctx.cleanup` / `ctx.onCloseRequested`.** Every window is closed when the
  app quits; otherwise the transparent always-on-top windows would outlive their
  controller.
- **Degradation.** If `idle.exe` is missing or dies, the plugin says so
  (`idleOk: false`) and keeps counting down — it retries three times, five
  seconds apart. `pauseOnActive` is the only thing that is lost, which is
  exactly what it promises.

## Performance: eight things this port does differently on purpose

All eight came out of the same complaints — *"dragging any window is laggy"*,
*"dragging still stutters while the break mask is up"*, *"the break mask flashes
white for seconds before it appears"*, *"the capsule is too long"*, *"the menu
does not line up with the capsule"*, *"after I shrink the resolution the
click-through control no longer sits on the button"* — and none of them are style
choices.

**1. No `backdrop-filter` anywhere.** The original frosted the pill (`blur(8px)`),
the menu (`16px`), the buttons (`12px`) and the whole break mask
(`scrim × 10px`). On a transparent always-on-top window a backdrop blur is the
most expensive property there is: the compositor has to re-blur everything
behind that window **every time anything behind it changes**. The pill is small
and always on top, so *dragging the main window* — a completely unrelated
window — made the desktop feel sticky, because the pill's backdrop kept
changing. The mask is worse still: it covers the entire work area, it is
click-through so the user keeps working underneath it, and the blur meant a
full-screen recomposite on every keystroke for the whole break. The scrim alone
is the reminder; the blur was paying for it.

**2. The idle helper runs only in the phases that read it.** `idle.exe` samples
at 4 Hz and ships four envelopes a second through the host. The original paid
that for the whole session, most of it consumed by nothing. The rule now is that
the helper is tied to the phases whose countdown actually consumes it: a break
being typed through (`pauseOnActive`), and a work stretch walked away from
(`pauseWorkWhenIdle`). With both switches off it never starts at all.

Two consequences worth stating plainly, because they are the trade this makes:

- **With both switches on — the default — it runs almost continuously**, so the
  cost is back to roughly what the original paid. That is the price of work-time
  idle detection; it is not hidden.
- **A phase flip no longer restarts it.** Both phases read it, so entering a
  break is invisible to the helper, and it is never closed and reopened on a
  cycle. That also removes a race the old design had: `hub.stream` refuses to
  open a channel that is still registered, and closing is an IPC round trip, so a
  short work period could flip back into a break before the close landed. The
  next start now waits out the close it knows about (`S.idleClosing`).

The badge reports which of the four situations applies — 已关闭 (neither switch
wants it), 不可用 (it should be sampling and is not), 空闲 / 输入中, and
**已离开 · 计时已重置** during a work hold — rather than collapsing them into one
word. It used to say 待命 during work, which read as a failure once the work phase
started depending on the same helper.

Work-time idle **resets** the focus countdown rather than pausing it in place. A
stretch of work long enough to leave the desk in the middle of is not work, and
once the user has been gone for minutes the cycle has stopped meaning anything —
so the countdown goes back to the top and the break it was about to earn is not
earned. The reset happens once, when the user is judged to have left; coming back
only releases the hold. The hold is a flag of its own (`workIdlePaused`), not
`S.paused`, so returning cannot silently undo a pause the user chose.

**3. Every window is created hidden and shown only once it reports in.** A
plugin window is loaded by `pluginwin-host.js`, which Blob-imports the plugin
entry and calls `mountWindow` — until that finishes, the window is nothing but
the user agent's white page background. That is the multi-second white flash the
original had when the mask appeared. So every window is created with
`visible: false` and shown from the `hello` handler, which each window publishes
once its UI is mounted; a 5 s fallback shows it anyway (and logs a warning) so a
window that never mounts cannot silently disable the feature. The break windows
are additionally **pre-loaded 20 s before a break**, so the mask is already
painted when the break starts — and they are hidden rather than closed
afterwards, so only the first break of a session pays anything.

The visible cost: after the first break, two hidden webviews stay resident until
the plugin is disabled or the app quits. That is the trade for an instant mask.

**4. A drag moves the pill and nothing else — and speaks on its own topic.**
Every `ctx.windows.control` call costs two IPC round trips — `WebviewWindow.getByLabel()`
and then the setter — and the drag runs once per animation frame. Moving the lock
box and the menu along with the pill therefore tripled the per-frame cost of a
drag, which is what made dragging the pill stutter. Only the pill follows the
pointer now; the companion windows are re-positioned once, when the drag ends.
Nothing is seen to lag: the lock box is invisible unless it is hovered, and the
menu is only open on purpose.

The topic matters as much as the calls do. `bus.publish` delivers a message once
**per subscriber**, and `eyecare.cmd` is subscribed by all five of this plugin's
windows — so a per-frame drag message was five webview deliveries for a message
one window acts on. Drag frames go to `eyecare.drag`, which the pill's window is
the sole subscriber of: one delivery per frame instead of five.

**5. The lock hit-box is measured, not guessed.** It used to be a 28×28 window
parked at hard-coded offsets over a 22×22 icon, and its hover glow was drawn
*outside* the window — so it was clipped into a flat, cut-off shape and the
clickable area did not match the button you could see. The pill now measures its
own lock icon and reports the rect (`lock-rect`); the main window sizes and
places the hit-box from that, so the two cannot drift apart. The hover cue is an
inset ring, which cannot be clipped.

**6. Every window is sized from what it measures, not from a constant.** This is
the generalisation of §5, and it is what fixed the two complaints that were
*shape* problems rather than speed problems.

The constants kept being wrong in ways nobody could see in the source: the pill's
186 px left a **35 px dead gap** between the clock and the pause button (the clock
had `flex: 1` and absorbed every spare pixel); the button window's 250×42 was
**smaller than the 244 px of button it had to hold**, so its two labels wrapped
and the 999 px radius squashed each into a clipped ellipse; the settings page
carried **566 px of window for 345 px of content**. Each was a guess, and nothing
re-checked them.

So the rule is now: if a window's size follows from its contents, the window
measures its own contents and reports the size (`win-size`), and the main window
resizes it from that report. Measuring is done with `max-content` and a single
`getBoundingClientRect()` — a forced layout that does not paint, so nothing is
ever shown at the wrong size and nothing flickers. Three details make it work:

- **The report is deduped.** Resizing the window re-runs the measurement, and the
  second measurement is identical — so it publishes nothing and the exchange
  stops. Without the dedupe this is a loop.
- **A one-axis report means "this axis changed".** The other axis keeps what the
  window already has. Defaulting it to 0 collapsed the pill to a zero-height
  sliver the first time it reported a width.
- **The height is measured at a pinned width.** Height depends on width — the
  note under the switches wraps to two lines at 276 px and one at 400 — so
  measuring at whatever width the window happens to have gives a height that is
  right for some other window.

**7. The mask is not animated, and nothing unrelated resizes it.** "Dragging
still stutters *only* while the break mask is up" is a symptom about the mask,
not about dragging. Three things were paying for it:

- The mask's ring used a CSS `animation: … infinite`. On a transparent,
  always-on-top, full-screen window that keeps the **entire surface being
  re-blended sixty times a second** for the whole break — the same class of cost
  as `backdrop-filter`, which §1 already banned. The ring is static now.
- The lock hit-box's `lock-rect` report used to run the *full* geometry sync,
  which re-applied the **mask** rect. So a 22 px icon was moving and resizing a
  full-screen window on every state broadcast, all through the break. It now
  touches only the lock box; and the mask resize itself is a no-op unless the
  rect actually changed.
- The mask used to overshoot the monitor by 80 px on every side — 2080×1240 on a
  1920×1080 display, **25 % more transparent surface** than the screen has. It is
  6 px now.

**8. The display is watched, and everything placed from it is re-placed.** "After
I shrink the resolution, the click-through control no longer sits on the button"
is not a hit-box bug — the hit-box was faithfully placed at
`S.pill + lockRect`, from a `S.pill` that had stopped describing reality.

The chain: `readArea()` ran only on wake and on the way into a break, so after a
resolution change `S.area` still described the old screen. `safePill` then
clamped against a work area that no longer existed and could ask the pill to sit
off-screen — at which point **Windows relocates the window itself**, and the
plugin's idea of where the pill is diverges from where it is. The hit-box is
positioned from that stale idea, so it stays where the pill used to be.

Two triggers, because neither alone is enough:

- **The tick compares a six-number signature** of `window.screen` (both sizes,
  both avail sizes, and the work-area origin — docking the taskbar to another edge
  changes the origin without changing either size). Six property reads a second,
  no IPC. This is the one that catches a plain resolution change, which fires no
  event at all.
- **A `resize` listener on the main window** is the fast path for a display-scale
  change, which does fire one.

Either way the response is the same: re-read the area, re-clamp the pill, and
re-place the pill, the hit-box, the menu and the mask from the new numbers —
together, which is the part that was broken.

## Build

`idle.c` is the only build step. It needs a C compiler; on this machine that is
mingw-w64:

```powershell
gcc -O2 -mwindows -o idle.exe idle.c
```

`-mwindows` keeps a console from flashing on every spawn; stdout is still a pipe
the host reads. (The original compiled C# with `csc.exe` at runtime, which is why
it had to re-run the binary every second — and why a missing compiler was fatal.)

If `idle.exe` is absent the plugin still loads; only idle detection degrades.

## Deploy

```powershell
npm run deploy:examples      # discovers every folder with a plugin.json
```

or copy the folder by hand:

```
%APPDATA%\com.tan18.toolbox\plugins\eyecare.demo\
  plugin.json  main.js  idle.exe
```

## Try it

1. Tool page **护眼助手** → status row, countdown, the theme/font `select`s,
   cycle lengths
2. The capsule appears at the work area's top-right; drag it, then restart the
   app to see the position come back
3. **🔒** on the capsule → the capsule becomes click-through and fades to
   `opacityLocked`; only the 22×22 box sitting on the lock icon still takes clicks
4. **Right-click the capsule** (or `ctrl+alt+e`) → the menu, which is a column of
   seven rows (**not** a row of seven squeezed columns — see Notes);
   **⚙️ 集中参数配置** → the settings page, which carries the five switches and
   the two capsule knobs too
5. Set **胶囊缩放** to `1.6` or **胶囊字号** to `18` → the capsule grows on the
   spot and its window follows, with no dead gap and no clipped text
6. Set **专注工作时长** to `0.1` → the countdown restarts at 6 s on the spot, and
   when it reaches zero the mask covers the **whole screen, taskbar included**,
   with skip/extend in their own window — two whole buttons, not two squashed
   ellipses
7. Type during the break → the countdown freezes and the text fades to
   `restTextActiveOpacity` (requires `idle.exe`)
8. Kill `idle.exe` while the mask is up → the countdown keeps running, and the
   view says **why** under the badge instead of only reporting 不可用
9. Set **无输入多久重置专注** to `20`, then leave the mouse alone for 20 s → the
   status row reads **已离开**, the countdown is back at the full focus length and
   it does not move; move the mouse → it starts counting from there
10. Change the display scale (or move the window to another monitor) and start a
    break → the mask is built from the resolution read at that moment
11. Shrink the resolution while the pill is locked → the pill is pulled back
    inside the new work area **and the click-through box follows it**

## Notes

- **Permissions, and why each one:** `rpc:storage` (config), `rpc:proc` (the
  sidecar), `rpc:bus` (broadcasting state to its own windows), `win:manage`
  (five windows). Subscribing to `eyecare.cmd` and `eyecare.drag`, listening for
  its own hotkey and closing its own windows need no permission — observing is
  not a capability. Three topics cost nothing extra: the permission is on the
  bus, not on a topic.
- **The menu's "vertical text" was a missing `flex-direction`.** `#menu` had no
  rule of its own, and the page switch set its `display` to `flex` inline — which
  makes it a flex **row**, not a column. Seven rows were then squeezed into
  174 px of width, and a flex row's bare text runs are *anonymous flex items*
  whose minimum size is **one character** for CJK: every label wrapped to a
  single character per line. It was never a `writing-mode`. The fix is
  `#menu { display:flex; flex-direction:column }` plus switching the page with a
  **class** rather than `style.display`, so the `display` value lives in the
  stylesheet next to the `flex-direction` it depends on. The same class of bug
  hid the settings page's inputs entirely: a flex item does not shrink below its
  min-content width, so the labels pushed the inputs out of the card and
  `overflow: hidden` clipped them away.
- **Known limit: multi-monitor.** `window.screen` describes **the monitor the
  window is on**, and the host exposes no monitor enumeration or position API
  (`ctx.windows.control` has no `getPosition`; `window.screenX` is not the
  window's top-left corner, even without decorations). The mask therefore covers
  the display the main window is on, fully — including the taskbar — and a
  second display keeps showing through. Covering every display would need either
  a monitor list or a way to read a window's absolute origin; neither exists in
  the plugin contract today.
- **The menu is aligned on its right edge, and that is the only edge that
  works.** It hangs off the pill like a dropdown, and the pill is anchored to the
  top-right of the work area. Aligning left edges is the obvious thing to write
  and it cannot work: the menu (186 px) is wider than the pill (159 px at the
  default font), so the menu's right edge lands past the screen margin, the clamp
  shoves the whole thing left, and **neither** edge ends up matching. Anchoring
  the shared right edge also survives the pill being measured rather than fixed —
  a left-aligned menu would drift by exactly as much as the font and scale knobs
  move the pill.
- **Known limit: one window cannot toggle its own click-through.**
  `clickThrough` is `setIgnoreCursorEvents(true)`, a window-level flag that
  removes the window from hit-testing entirely. A click-through window receives
  no `pointermove`, no `pointerover`, no `click` — so the event that would turn
  click-through *off* cannot come from inside it. That is what the flag means,
  not a limitation of this host, and Electron's equivalent has the same shape
  (with a `forward: true` option that Tauri v2 does not expose).
  A single window is therefore only possible with an **out-of-band cursor
  source**, and the one available here is the helper this plugin already ships:
  extend `idle.c` with `GetCursorPos`, have the main window push the interactive
  rect(s) in screen coordinates (it already computes them — `S.pill` plus
  `lockRect()`), and let the **helper do the hit-test**, emitting only
  enter/leave transitions. Then the IPC cost is two messages per hover rather
  than 60 a second. On `enter` the main window clears the flag; on `leave` it
  sets it again. Two caveats: the flip costs an IPC round trip, so a very fast
  click can land in the gap (pad the hit rect), and `GetCursorPos` is in physical
  pixels while window placement is logical, so the scale factor has to be part of
  the exchange. Feasible — but today's two-window design (pill goes
  click-through, a 22 px always-clickable box sits on the lock icon) has no race
  and no native code, so the single-window version is worth building when the
  pill needs **several** hotspots, not one. That is the real prize: with three
  buttons the current design would need three windows.
- `plugin.json` and the in-code `manifest` declare the same set; a static audit
  (`tests/plugins.test.mjs`) fails if they drift, if a tag name is misspelled,
  or if the plugin calls a function it never declares.
- `tests/eyecare-plugin.test.mjs` drives the real `activate()` against a
  recording fake of the host: the tick, the work/rest transitions, the
  click-through lock, the position clamping, the self-reported window sizes, the
  work-idle reset, the display-change re-placement and the view tree all execute.
  The plugin can be tested this way because it imports nothing and touches no DOM
  at module scope — a property worth keeping.
- Each window is a separate `document` and injects its own `<style>`. That is
  the documented path for a plugin that wants its own look, and it is
  structurally isolated: an unlayered stylesheet in one window cannot reach
  another. The four palettes are hardcoded on purpose — this plugin brings its
  own colours rather than following the app theme, which is what the original
  did.
