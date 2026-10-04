/**
 * First-party plugin: Plugin & Software Store (插件与软件商店)
 *
 * Provides a centralised marketplace for official & community plugins and
 * curated developer tools, with one-click install, hot-update, and uninstall.
 *
 * Architecture:
 * - Built-in plugin: Bundled with Toolkit, zero sidecar bloat.
 * - Plan C download & package management: Uses `ctx.pty` to execute native
 *   Windows commands (PowerShell / Expand-Archive / curl) for 100% reliable
 *   distribution without shipping extra binaries.
 * - Reactive state discovery: Directly synchronises with `store.plugins` and
 *   triggers `reconcilePlugins` on installation / uninstallation for zero-restart
 *   hot-activation.
 */

import { Kind } from '../protocol/envelope.js';

let hostStore = null;
let hostReconcile = null;
let hostOrigin = null;

async function ensureHostBindings() {
  if (!hostStore) {
    const sMod = await import('../host/store.js');
    hostStore = sMod.store;
  }
  if (!hostReconcile) {
    const pMod = await import('../host/plugins.js');
    hostReconcile = pMod.reconcilePlugins;
    hostOrigin = pMod.Origin;
  }
}

export const manifest = {
  id: 'builtin.store',
  name: '插件商店',
  version: '0.1.0',
  description: '官方插件中心与优质开发软件推荐，支持一键安装、更新与卸载。',
  contributes: {
    views: [
      {
        slot: 'tool',
        id: 'store',
        title: '插件商店',
        icon: 'lucide:shopping-bag',
      },
    ],
  },
  permissions: ['rpc:host', 'rpc:stream', 'rpc:storage'],
};

const STORAGE_CATALOG_KEY = 'store_catalog_cache_v1';
const RAW_CATALOG_URL = 'https://raw.githubusercontent.com/wuxinoob/toolkit_plugins/main/catalog.json';
const CDN_CATALOG_URL = 'https://cdn.jsdelivr.net/gh/wuxinoob/toolkit_plugins@main/catalog.json';

const DEFAULT_CATALOG = {
  version: 1,
  plugins: [
    {
      id: 'devtool',
      type: 'plugin',
      name: '开发助手',
      version: '0.3.0',
      author: 'Tan18',
      description: 'Windows 常用开发与系统小工具：端口占用探测与清理、目录文件锁排查、进程句柄分析、PATH环境变量诊断、系统防休眠 (Awake)、Hosts文件极简编辑。',
      icon: '🔧',
      category: '系统与开发',
      tags: ['端口占用', '文件解锁', 'Hosts编辑', '环境变量', 'Awake'],
      targetDir: 'devtool',
      downloadUrl: 'https://raw.githubusercontent.com/wuxinoob/toolkit_plugins/main/plugins/devtool/package.zip',
      mirrorUrl: 'https://cdn.jsdelivr.net/gh/wuxinoob/toolkit_plugins@main/plugins/devtool/package.zip',
      size: '260 KB',
    },
    {
      id: 'eyecare.demo',
      type: 'plugin',
      name: '护眼助手',
      version: '0.1.0',
      author: 'Tan18',
      description: '定时护眼：自绘悬浮胶囊 + 穿透锁定 + 全屏休息遮罩；键鼠空闲检测由自带 sidecar 提供。',
      icon: '👁️',
      category: '健康与效率',
      tags: ['番茄钟', '休息提醒', '防沉迷', '自绘悬浮窗'],
      targetDir: 'eyecare.demo',
      downloadUrl: 'https://raw.githubusercontent.com/wuxinoob/toolkit_plugins/main/plugins/eyecare/package.zip',
      mirrorUrl: 'https://cdn.jsdelivr.net/gh/wuxinoob/toolkit_plugins@main/plugins/eyecare/package.zip',
      size: '81 KB',
    },
    {
      id: 'custom.moment-notes',
      type: 'plugin',
      name: '拾光便签',
      version: '2.0.0',
      author: 'Tan18',
      description: '基于 WebDAV 同步的高颜值便签插件，支持独立置顶悬浮窗与跨窗口双向同步、分类归档与历史备份。',
      icon: '📝',
      category: '办公与效率',
      tags: ['便签', 'WebDAV同步', '独立悬浮窗', '双向通信'],
      targetDir: 'moment-notes',
      downloadUrl: 'https://raw.githubusercontent.com/wuxinoob/toolkit_plugins/main/plugins/moment-notes/package.zip',
      mirrorUrl: 'https://cdn.jsdelivr.net/gh/wuxinoob/toolkit_plugins@main/plugins/moment-notes/package.zip',
      size: '292 KB',
    },
  ],
  software: [
    {
      id: 'software.vscode',
      type: 'software',
      name: 'Visual Studio Code',
      version: '最新稳定版',
      author: 'Microsoft',
      description: '轻量但功能强大的现代化源代码编辑器，拥有庞大的插件生态系统与调试能力。',
      icon: '💻',
      category: '开发工具',
      tags: ['IDE', '编辑器', '代码调试', 'Git'],
      website: 'https://code.visualstudio.com/',
      wingetId: 'Microsoft.VisualStudioCode',
    },
    {
      id: 'software.git',
      type: 'software',
      name: 'Git for Windows',
      version: '最新稳定版',
      author: 'Git Community',
      description: '世界上最流行的分布式版本控制系统，提供 Git Bash、GUI 和 Windows Credential Manager。',
      icon: '🌿',
      category: '开发工具',
      tags: ['版本控制', 'Git', 'Bash', '命令行'],
      website: 'https://git-scm.com/',
      wingetId: 'Git.Git',
    },
    {
      id: 'software.powertoys',
      type: 'software',
      name: 'Microsoft PowerToys',
      version: '最新版',
      author: 'Microsoft',
      description: '微软官方出品的 Windows 高级系统生产力套件（FancyZones、跑狗启动器、取色器、文本提取等）。',
      icon: '⚡',
      category: '系统增强',
      tags: ['微软官方', '窗口分屏', '快速启动', '生产力'],
      website: 'https://github.com/microsoft/PowerToys',
      wingetId: 'Microsoft.PowerToys',
    },
    {
      id: 'software.snipaste',
      type: 'software',
      name: 'Snipaste',
      version: '2.9.x',
      author: 'Snipaste',
      description: '极致好用的截图与贴图神级工具，支持像素级取色、图片马赛克、画笔标注与贴图置顶浮动。',
      icon: '✂️',
      category: '日常效率',
      tags: ['截图', '贴图', '标注', '取色器'],
      website: 'https://www.snipaste.com/',
      wingetId: 'Snipaste.Snipaste',
    },
    {
      id: 'software.devtoys',
      type: 'software',
      name: 'DevToys',
      version: '2.0.x',
      author: 'DevToys Community',
      description: '开发者 Swiss Army knife（瑞士军刀），涵盖 JSON 格式化、JWT 解码、正则表达式测试、Base64转换等。',
      icon: '🧰',
      category: '开发工具',
      tags: ['瑞士军刀', 'JSON格式化', '正则测试', 'JWT'],
      website: 'https://devtoys.app/',
      wingetId: 'DevToys-app.DevToys',
    },
    {
      id: 'software.clash-verge',
      type: 'software',
      name: 'Clash Verge Rev',
      version: '最新版',
      author: 'Clash Verge Rev Team',
      description: '基于 Tauri 打造的高性能现代化网络代理客户端，界面精致流畅，支持丰富的分流规则与订阅管理。',
      icon: '🌐',
      category: '网络与安全',
      tags: ['网络代理', 'Tauri', '流量分流', '网络诊断'],
      website: 'https://github.com/clash-verge-rev/clash-verge-rev',
      wingetId: 'clash-verge-rev.clash-verge-rev',
    },
  ],
};

const state = {
  ctx: null,
  activeTab: 'all',
  searchQuery: '',
  refreshing: false,
  catalog: DEFAULT_CATALOG,
  tasks: new Map(),
  rootEl: null,
};

function compareSemver(v1, v2) {
  if (!v1 || !v2) return 0;
  const p1 = String(v1).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const p2 = String(v2).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const len = Math.max(p1.length, p2.length);
  for (let i = 0; i < len; i += 1) {
    const a = p1[i] || 0;
    const b = p2[i] || 0;
    if (a < b) return -1;
    if (a > b) return 1;
  }
  return 0;
}

function getPluginStatus(item) {
  const plugins = hostStore?.plugins ?? [];
  const installed = plugins.find((p) => p.manifest?.id === item.id);
  if (!installed) {
    return { state: 'not_installed', label: '未安装', installedVersion: null };
  }
  const instVer = installed.manifest?.version || '0.0.0';
  if (compareSemver(instVer, item.version) < 0) {
    return {
      state: 'can_update',
      label: '可更新',
      installedVersion: instVer,
      targetVersion: item.version,
    };
  }
  return {
    state: 'installed',
    label: '已安装',
    installedVersion: instVer,
  };
}

function runPtyCommand(ctx, ch, program, args) {
  return new Promise((resolve, reject) => {
    let output = '';
    const decoder = new TextDecoder();
    ctx.pty(ch, {
      program,
      args,
      cols: 80,
      rows: 24,
      onFrame: (frame) => {
        if (frame.kind === Kind.DATA) {
          output += decoder.decode(frame.p, { stream: true });
        } else if (frame.kind === Kind.EXIT) {
          ctx.closeStream(ch).catch(() => {});
          if (frame.p === 0) resolve(output);
          else reject(new Error(`Exit code ${frame.p}: ${output.slice(-260)}`));
        } else if (frame.kind === Kind.ERR) {
          ctx.closeStream(ch).catch(() => {});
          reject(new Error(frame.msg || 'Stream error'));
        }
      },
    }).catch(reject);
  });
}

async function fetchCatalog(manual = false) {
  const { ctx } = state;
  state.refreshing = true;
  scheduleRender();

  let fetched = null;
  try {
    const res = await fetch(RAW_CATALOG_URL, { cache: 'no-cache' });
    if (res.ok) fetched = await res.json();
  } catch (_) {
    try {
      const res = await fetch(CDN_CATALOG_URL, { cache: 'no-cache' });
      if (res.ok) fetched = await res.json();
    } catch (e) {
      if (manual) ctx.ui.notify(`刷新目录失败: ${e.message ?? e}`, 'error');
    }
  }

  if (fetched && (fetched.plugins || fetched.software)) {
    state.catalog = {
      version: fetched.version || 1,
      plugins: fetched.plugins || DEFAULT_CATALOG.plugins,
      software: fetched.software || DEFAULT_CATALOG.software,
    };
    ctx.storage.set(STORAGE_CATALOG_KEY, state.catalog).catch(() => {});
    if (manual) ctx.ui.notify('插件与软件目录已刷新', 'success');
  } else if (manual && !fetched) {
    ctx.ui.notify('未能获取远程目录，使用本地缓存', 'info');
  }

  state.refreshing = false;
  scheduleRender();
}

async function installPlugin(item) {
  const { ctx } = state;
  if (state.tasks.has(item.id)) return;

  state.tasks.set(item.id, { action: 'install', label: '正在安装...', inProgress: true });
  scheduleRender();

  try {
    const paths = await ctx.rpc('host', 'paths', {});
    const pluginsDir = paths?.pluginsDir;
    if (!pluginsDir) throw new Error('未能获取插件安装目录');

    const targetDir = item.targetDir || item.id;
    const destFolder = `${pluginsDir}\\${targetDir}`;
    const primaryUrl = item.downloadUrl;
    const mirrorUrl = item.mirrorUrl || primaryUrl;
    const tempZip = `$env:TEMP\\toolkit_plugin_${item.id.replace(/[^a-zA-Z0-9_-]/g, '_')}.zip`;

    const powershellCommand = `
$ProgressPreference = 'SilentlyContinue';
[System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12;
$dest = "${destFolder}";
$tmp = "${tempZip}";
$ok = $false;
try {
  Invoke-WebRequest -Uri "${primaryUrl}" -OutFile $tmp -UseBasicParsing -TimeoutSec 35;
  $ok = $true;
} catch {
  Write-Host "Primary URL failed, fallback to mirror...";
  try {
    Invoke-WebRequest -Uri "${mirrorUrl}" -OutFile $tmp -UseBasicParsing -TimeoutSec 35;
    $ok = $true;
  } catch {
    Write-Error "Download failed: $_";
    exit 1;
  }
}
if ($ok -and (Test-Path $tmp)) {
  if (Test-Path $dest) { Remove-Item -Path $dest -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null;
  Expand-Archive -Path $tmp -DestinationPath $dest -Force;
  Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue;
  exit 0;
} else {
  exit 1;
}
`.trim().replace(/\r?\n/g, ' ');

    const ch = `inst-${item.id}-${Date.now().toString(36)}`;
    await runPtyCommand(ctx, ch, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powershellCommand]);

    if (hostReconcile && hostOrigin) {
      await hostReconcile({ silent: false, sources: [hostOrigin.EXTERNAL] });
    }
    state.tasks.delete(item.id);
    ctx.ui.notify(`插件「${item.name}」安装成功！`, 'success');
  } catch (err) {
    state.tasks.delete(item.id);
    ctx.ui.notify(`安装失败: ${err.message ?? err}`, 'error');
  } finally {
    scheduleRender();
  }
}

async function uninstallPlugin(item) {
  const { ctx } = state;
  if (state.tasks.has(item.id)) return;

  state.tasks.set(item.id, { action: 'uninstall', label: '正在卸载...', inProgress: true });
  scheduleRender();

  try {
    const paths = await ctx.rpc('host', 'paths', {});
    const pluginsDir = paths?.pluginsDir;
    if (!pluginsDir) throw new Error('未能获取插件安装目录');

    const targetDir = item.targetDir || item.id;
    const destFolder = `${pluginsDir}\\${targetDir}`;

    const powershellCommand = `if (Test-Path "${destFolder}") { Remove-Item -Path "${destFolder}" -Recurse -Force }; exit 0;`;
    const ch = `uninst-${item.id}-${Date.now().toString(36)}`;
    await runPtyCommand(ctx, ch, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powershellCommand]);

    if (hostReconcile && hostOrigin) {
      await hostReconcile({ silent: false, sources: [hostOrigin.EXTERNAL] });
    }
    state.tasks.delete(item.id);
    ctx.ui.notify(`插件「${item.name}」已卸载`, 'info');
  } catch (err) {
    state.tasks.delete(item.id);
    ctx.ui.notify(`卸载失败: ${err.message ?? err}`, 'error');
  } finally {
    scheduleRender();
  }
}

async function openWebsite(item) {
  const { ctx } = state;
  if (!item.website) return;
  try {
    const ch = `open-${Date.now().toString(36)}`;
    await runPtyCommand(ctx, ch, 'powershell.exe', ['-NoProfile', '-Command', `Start-Process "${item.website}"`]);
  } catch (e) {
    ctx.ui.notify(`打开网页失败: ${e.message ?? e}`, 'error');
  }
}

async function installWinget(item) {
  const { ctx } = state;
  if (!item.wingetId || state.tasks.has(item.id)) return;

  state.tasks.set(item.id, { action: 'winget', label: 'Winget 安装中...', inProgress: true });
  scheduleRender();
  ctx.ui.notify(`已启动「${item.name}」的 Winget 安装进程，请关注系统提示`, 'info');

  try {
    const ch = `winget-${Date.now().toString(36)}`;
    await runPtyCommand(ctx, ch, 'powershell.exe', [
      '-NoProfile',
      '-Command',
      `winget install --id "${item.wingetId}" -e --accept-package-agreements --accept-source-agreements`,
    ]);
    state.tasks.delete(item.id);
    ctx.ui.notify(`软件「${item.name}」安装成功！`, 'success');
  } catch (err) {
    state.tasks.delete(item.id);
    ctx.ui.notify(`Winget 安装失败: ${err.message ?? err}`, 'error');
  } finally {
    scheduleRender();
  }
}

let renderTimer = null;
function scheduleRender() {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    if (state.rootEl) renderStoreView(state.rootEl);
  }, 16);
}

function renderStoreView(root) {
  if (!root) return;
  state.rootEl = root;
  const { el, render } = state.ctx.ui;

  const q = state.searchQuery.trim().toLowerCase();
  const filterItem = (it) => {
    if (!q) return true;
    const hay = `${it.name} ${it.description} ${it.category || ''} ${(it.tags || []).join(' ')} ${it.author || ''}`.toLowerCase();
    return hay.includes(q);
  };

  const allPlugins = (state.catalog.plugins || []).filter(filterItem);
  const allSoftware = (state.catalog.software || []).filter(filterItem);

  let displayedPlugins = [];
  let displayedSoftware = [];

  if (state.activeTab === 'all') {
    displayedPlugins = allPlugins;
    displayedSoftware = allSoftware;
  } else if (state.activeTab === 'plugins') {
    displayedPlugins = allPlugins;
  } else if (state.activeTab === 'software') {
    displayedSoftware = allSoftware;
  } else if (state.activeTab === 'installed') {
    displayedPlugins = allPlugins.filter((p) => getPluginStatus(p).state !== 'not_installed');
  }

  const installedCount = (state.catalog.plugins || []).filter(
    (p) => getPluginStatus(p).state !== 'not_installed',
  ).length;

  const tabButton = (id, labelText, count) => {
    const active = state.activeTab === id;
    return el(
      'button',
      {
        variant: active ? 'default' : 'outline',
        size: 'sm',
        class: active ? 'font-medium' : 'text-muted-foreground',
        onClick: () => {
          state.activeTab = id;
          scheduleRender();
        },
      },
      count !== undefined ? `${labelText} (${count})` : labelText,
    );
  };

  const renderPluginCard = (p) => {
    const status = getPluginStatus(p);
    const task = state.tasks.get(p.id);

    let statusBadgeClass = 'tb-badge text-muted-foreground';
    let statusBadgeText = '未安装';
    if (status.state === 'installed') {
      statusBadgeClass = 'tb-badge tb-t-ok';
      statusBadgeText = `已安装 v${status.installedVersion}`;
    } else if (status.state === 'can_update') {
      statusBadgeClass = 'tb-badge tb-t-warn';
      statusBadgeText = `可更新 (当前 v${status.installedVersion})`;
    }

    const actionButtons = [];
    if (task?.inProgress) {
      actionButtons.push(
        el('button', { variant: 'outline', size: 'sm', disabled: true }, task.label || '处理中...'),
      );
    } else if (status.state === 'not_installed') {
      actionButtons.push(
        el('button', { variant: 'default', size: 'sm', onClick: () => installPlugin(p) }, '📥 一键安装'),
      );
    } else if (status.state === 'can_update') {
      actionButtons.push(
        el(
          'button',
          { variant: 'default', size: 'sm', onClick: () => installPlugin(p) },
          `🔄 更新至 v${status.targetVersion}`,
        ),
      );
      actionButtons.push(
        el('button', { variant: 'destructive', size: 'sm', onClick: () => uninstallPlugin(p) }, '🗑️ 卸载'),
      );
    } else {
      actionButtons.push(
        el('button', { variant: 'outline', size: 'sm', disabled: true }, '✓ 已安装'),
      );
      actionButtons.push(
        el('button', { variant: 'destructive', size: 'sm', onClick: () => uninstallPlugin(p) }, '🗑️ 卸载'),
      );
    }

    return el(
      'div',
      {
        class: 'tb-card flex flex-col justify-between p-4 transition-all hover:border-primary/50',
        style: 'border-radius:8px;',
      },
      el(
        'div',
        { class: 'flex flex-col gap-2.5' },
        el(
          'div',
          { class: 'flex items-start justify-between gap-2' },
          el(
            'div',
            { class: 'flex items-center gap-2.5 min-w-0' },
            el('span', { class: 'text-2xl shrink-0' }, p.icon || '🧩'),
            el(
              'div',
              { class: 'min-w-0' },
              el('h3', { class: 'text-sm font-semibold truncate m-0' }, p.name),
              el('span', { class: 'text-xs text-muted-foreground' }, `${p.author || '未知'} · v${p.version}`),
            ),
          ),
          el('span', { class: statusBadgeClass }, statusBadgeText),
        ),
        el(
          'p',
          { class: 'text-xs text-muted-foreground line-clamp-2 m-0 min-h-[32px] leading-relaxed' },
          p.description,
        ),
        el(
          'div',
          { class: 'flex flex-wrap items-center gap-1.5' },
          el('span', { class: 'tb-badge text-[11px]' }, p.category || '扩展'),
          ...(p.tags || []).map((t) => el('span', { class: 'tb-badge tb-t-dim text-[11px]' }, t)),
          p.size ? el('span', { class: 'tb-hint text-[11px] ml-auto' }, p.size) : null,
        ),
      ),
      el(
        'div',
        { class: 'flex items-center justify-end gap-2 pt-3 mt-3 border-t border-border' },
        ...actionButtons,
      ),
    );
  };

  const renderSoftwareCard = (s) => {
    const task = state.tasks.get(s.id);
    const actionButtons = [];

    if (task?.inProgress) {
      actionButtons.push(
        el('button', { variant: 'outline', size: 'sm', disabled: true }, task.label || '安装中...'),
      );
    } else {
      if (s.website) {
        actionButtons.push(
          el('button', { variant: 'outline', size: 'sm', onClick: () => openWebsite(s) }, '🌐 官方网站'),
        );
      }
      if (s.wingetId) {
        actionButtons.push(
          el('button', { variant: 'default', size: 'sm', onClick: () => installWinget(s) }, '⚡ Winget 安装'),
        );
      }
    }

    return el(
      'div',
      {
        class: 'tb-card flex flex-col justify-between p-4 transition-all hover:border-primary/50',
        style: 'border-radius:8px;',
      },
      el(
        'div',
        { class: 'flex flex-col gap-2.5' },
        el(
          'div',
          { class: 'flex items-start justify-between gap-2' },
          el(
            'div',
            { class: 'flex items-center gap-2.5 min-w-0' },
            el('span', { class: 'text-2xl shrink-0' }, s.icon || '🚀'),
            el(
              'div',
              { class: 'min-w-0' },
              el('h3', { class: 'text-sm font-semibold truncate m-0' }, s.name),
              el('span', { class: 'text-xs text-muted-foreground' }, `${s.author || '精选'} · ${s.version}`),
            ),
          ),
          el('span', { class: 'tb-badge tb-t-brand' }, '推荐软件'),
        ),
        el(
          'p',
          { class: 'text-xs text-muted-foreground line-clamp-2 m-0 min-h-[32px] leading-relaxed' },
          s.description,
        ),
        el(
          'div',
          { class: 'flex flex-wrap items-center gap-1.5' },
          el('span', { class: 'tb-badge text-[11px]' }, s.category || '工具'),
          ...(s.tags || []).map((t) => el('span', { class: 'tb-badge tb-t-dim text-[11px]' }, t)),
        ),
      ),
      el(
        'div',
        { class: 'flex items-center justify-end gap-2 pt-3 mt-3 border-t border-border' },
        ...actionButtons,
      ),
    );
  };

  const totalResults = displayedPlugins.length + displayedSoftware.length;

  render(
    root,
    el(
      'div',
      { class: 'flex flex-col gap-4 h-full max-w-[1200px] mx-auto' },
      el(
        'div',
        { class: 'flex flex-col md:flex-row md:items-center justify-between gap-3 pb-3 border-b border-border' },
        el(
          'div',
          {},
          el('h2', { class: 'text-lg font-bold flex items-center gap-2 m-0' }, '🛍️ 插件与推荐软件中心'),
          el(
            'p',
            { class: 'text-xs text-muted-foreground m-0 mt-1' },
            '发现官方扩展与开发者必备软件，支持一键无感安装、自动更新与完整卸载。',
          ),
        ),
        el(
          'div',
          { class: 'flex items-center gap-2' },
          el('input', {
            type: 'text',
            value: state.searchQuery,
            placeholder: '搜索插件或软件名称、分类、标签...',
            class: 'tb-input text-xs w-[240px]',
            onInput: (e) => {
              state.searchQuery = e.target.value;
              scheduleRender();
            },
          }),
          el(
            'button',
            {
              variant: 'outline',
              size: 'sm',
              disabled: state.refreshing,
              onClick: () => fetchCatalog(true),
            },
            state.refreshing ? '⏳ 刷新中...' : '🔄 刷新',
          ),
        ),
      ),
      el(
        'div',
        { class: 'flex flex-wrap items-center gap-2' },
        tabButton('all', '全部', (state.catalog.plugins?.length || 0) + (state.catalog.software?.length || 0)),
        tabButton('plugins', '🧩 扩展插件', state.catalog.plugins?.length || 0),
        tabButton('software', '🚀 推荐软件', state.catalog.software?.length || 0),
        tabButton('installed', '✓ 已安装插件', installedCount),
      ),
      el(
        'div',
        { class: 'flex-1 overflow-auto pr-1' },
        totalResults === 0
          ? el(
              'div',
              { class: 'flex flex-col items-center justify-center p-12 text-center text-muted-foreground gap-2' },
              el('span', { class: 'text-3xl' }, '🔍'),
              el('p', { class: 'text-sm font-medium m-0' }, '未找到匹配的插件或软件'),
              el('p', { class: 'text-xs m-0' }, '尝试调整搜索关键词或点击右上角刷新目录。'),
            )
          : el(
              'div',
              {
                style:
                  'display:grid;grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));gap:14px;padding-bottom:16px;',
              },
              ...displayedPlugins.map(renderPluginCard),
              ...displayedSoftware.map(renderSoftwareCard),
            ),
      ),
    ),
  );
}

export async function activate(ctx) {
  state.ctx = ctx;
  await ensureHostBindings().catch(() => {});

  try {
    const cached = await ctx.storage.get(STORAGE_CATALOG_KEY);
    if (cached && (cached.plugins || cached.software)) {
      state.catalog = cached;
    }
  } catch (_) {}

  ctx.registerView('store', (root) => {
    state.rootEl = root;
    renderStoreView(root);
  });

  fetchCatalog(false).catch(() => {});
}

export async function deactivate() {
  state.tasks.clear();
  state.rootEl = null;
  state.ctx = null;
}

export default { manifest, activate, deactivate };
