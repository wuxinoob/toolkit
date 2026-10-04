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
 * - Software downloads & custom install paths: Supports official website jump,
 *   winget default install, winget interactive install (custom path wizard),
 *   and direct installer package download to any user-specified folder.
 */

import { h } from 'vue';
import { Kind } from '../protocol/envelope.js';
import { resolveIcon } from '../host/icons.js';

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
  permissions: ['rpc:host', 'rpc:stream', 'rpc:storage', 'rpc:dialog'],
};

const STORAGE_CATALOG_KEY = 'store_catalog_cache_v2';
const CDN_CATALOG_URL = 'https://cdn.jsdelivr.net/gh/wuxinoob/toolkit_plugins@main/catalog.json';
const RAW_CATALOG_URL = 'https://raw.githubusercontent.com/wuxinoob/toolkit_plugins@main/catalog.json';

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
      icon: 'lucide:wrench',
      category: '系统与开发',
      tags: ['端口占用', '文件解锁', 'Hosts编辑', '环境变量', 'Awake'],
      targetDir: 'devtool',
      downloadUrl: 'https://cdn.jsdelivr.net/gh/wuxinoob/toolkit_plugins@main/plugins/devtool/package.zip',
      mirrorUrl: 'https://raw.githubusercontent.com/wuxinoob/toolkit_plugins/main/plugins/devtool/package.zip',
      size: '260 KB',
    },
    {
      id: 'eyecare.demo',
      type: 'plugin',
      name: '护眼助手',
      version: '0.1.0',
      author: 'Tan18',
      description: '定时护眼：自绘悬浮胶囊 + 穿透锁定 + 全屏休息遮罩；键鼠空闲检测由自带 sidecar 提供。',
      icon: 'lucide:eye',
      category: '健康与效率',
      tags: ['番茄钟', '休息提醒', '防沉迷', '自绘悬浮窗'],
      targetDir: 'eyecare.demo',
      downloadUrl: 'https://cdn.jsdelivr.net/gh/wuxinoob/toolkit_plugins@main/plugins/eyecare/package.zip',
      mirrorUrl: 'https://raw.githubusercontent.com/wuxinoob/toolkit_plugins/main/plugins/eyecare/package.zip',
      size: '81 KB',
    },
    {
      id: 'custom.moment-notes',
      type: 'plugin',
      name: '拾光便签',
      version: '2.0.0',
      author: 'Tan18',
      description: '基于 WebDAV 同步的高颜值便签插件，支持独立置顶悬浮窗与跨窗口双向同步、分类归档与历史备份。',
      icon: 'lucide:sticky-note',
      category: '办公与效率',
      tags: ['便签', 'WebDAV同步', '独立悬浮窗', '双向通信'],
      targetDir: 'moment-notes',
      downloadUrl: 'https://cdn.jsdelivr.net/gh/wuxinoob/toolkit_plugins@main/plugins/moment-notes/package.zip',
      mirrorUrl: 'https://raw.githubusercontent.com/wuxinoob/toolkit_plugins/main/plugins/moment-notes/package.zip',
      size: '292 KB',
    },
  ],
  software: [
    {
      id: 'software.geek-uninstaller',
      type: 'software',
      name: 'Geek Uninstaller',
      version: '1.5.2 绿色便携版',
      author: 'Thomas Koen',
      description: '极其小巧高效的 Windows 强力卸载清理利器，单文件免安装，支持深度扫描注册表与残留文件强力清除。',
      icon: 'lucide:trash',
      category: '系统清理',
      packageType: 'portable',
      tags: ['绿色免安装', '单文件ZIP', '强力卸载', '深度清理'],
      website: 'https://geekuninstaller.com/',
      installerUrl: 'https://geekuninstaller.com/geek.zip',
      installerFileName: 'geek.zip',
      wingetId: 'GeekUninstaller.GeekUninstaller',
    },
    {
      id: 'software.everything',
      type: 'software',
      name: 'Everything 极速全盘搜索',
      version: '1.4.1 绿色便携版',
      author: 'voidtools',
      description: '基于 NTFS MFT 索引的毫秒级全盘文件名搜索工具，解压即用，占用极低内存秒搜数百万文件。',
      icon: 'lucide:search',
      category: '日常效率',
      packageType: 'portable',
      tags: ['绿色免安装', '便携ZIP', '秒级搜索', '必备神器'],
      website: 'https://www.voidtools.com/',
      installerUrl: 'https://www.voidtools.com/Everything-1.4.1.1026.x64.zip',
      installerFileName: 'Everything-x64.zip',
      wingetId: 'voidtools.Everything',
    },
    {
      id: 'software.snipaste',
      type: 'software',
      name: 'Snipaste 截图贴图',
      version: '2.9.x 便携版',
      author: 'Snipaste',
      description: '极致好用的截图与贴图神级工具，支持像素级取色、图片马赛克、画笔标注与贴图置顶浮动。',
      icon: 'lucide:crop',
      category: '日常效率',
      packageType: 'portable',
      tags: ['绿色免安装', '便携ZIP', '截图贴图', '取色标注'],
      website: 'https://www.snipaste.com/',
      installerUrl: 'https://dl.snipaste.com/win-x64',
      installerFileName: 'Snipaste-x64.zip',
      wingetId: 'Snipaste.Snipaste',
    },
    {
      id: 'software.devtoys',
      type: 'software',
      name: 'DevToys 开发者瑞士军刀',
      version: '2.0.x 便携版',
      author: 'DevToys Community',
      description: '开发者 Swiss Army knife，涵盖 JSON 格式化、JWT 解码、正则表达式测试、Base64转换等。',
      icon: 'lucide:hammer',
      category: '开发工具',
      packageType: 'portable',
      tags: ['绿色免安装', '便携ZIP', '开发工具箱', '离线可用'],
      website: 'https://devtoys.app/',
      installerUrl: 'https://github.com/DevToys-app/DevToys/releases/latest/download/devtoys_win_x64.zip',
      installerFileName: 'devtoys_win_x64.zip',
      wingetId: 'DevToys-app.DevToys',
    },
    {
      id: 'software.7zip',
      type: 'software',
      name: '7-Zip 压缩解压',
      version: '24.09 稳定版',
      author: 'Igor Pavlov',
      description: '知名高压缩比开源压缩解压工具，全面支持 7z、ZIP、RAR、TAR、GZ 等主流格式，轻巧高效无广告。',
      icon: 'lucide:package',
      category: '系统工具',
      packageType: 'installer',
      tags: ['开源解压', '直链下载EXE', '右键菜单', '轻量必备'],
      website: 'https://www.7-zip.org/',
      installerUrl: 'https://www.7-zip.org/a/7z2409-x64.exe',
      installerFileName: '7z2409-x64.exe',
      wingetId: '7zip.7zip',
    },
    {
      id: 'software.vscode',
      type: 'software',
      name: 'Visual Studio Code',
      version: '最新稳定版',
      author: 'Microsoft',
      description: '轻量但功能强大的现代化源代码编辑器，拥有庞大的插件生态系统与调试能力。',
      icon: 'lucide:code-2',
      category: '开发工具',
      packageType: 'installer',
      tags: ['IDE', '官方安装包', '代码调试', 'Git'],
      website: 'https://code.visualstudio.com/',
      wingetId: 'Microsoft.VisualStudioCode',
      installerUrl: 'https://code.visualstudio.com/sha/download?build=stable&os=win32-x64-user',
      installerFileName: 'VSCodeUserSetup-x64.exe',
    },
    {
      id: 'software.git',
      type: 'software',
      name: 'Git for Windows',
      version: '最新稳定版',
      author: 'Git Community',
      description: '世界上最流行的分布式版本控制系统，提供 Git Bash、GUI 和 Windows Credential Manager。',
      icon: 'lucide:git-branch',
      category: '开发工具',
      packageType: 'installer',
      tags: ['版本控制', '官方安装包', 'Bash', '命令行'],
      website: 'https://git-scm.com/',
      wingetId: 'Git.Git',
      installerUrl: 'https://registry.npmmirror.com/-/binary/git-for-windows/v2.47.1.windows.1/Git-2.47.1-64-bit.exe',
      installerFileName: 'Git-64-bit-setup.exe',
    },
    {
      id: 'software.powertoys',
      type: 'software',
      name: 'Microsoft PowerToys',
      version: '最新版',
      author: 'Microsoft',
      description: '微软官方出品的 Windows 高级系统生产力套件（FancyZones、跑狗启动器、取色器、文本提取等）。',
      icon: 'lucide:cpu',
      category: '系统增强',
      packageType: 'installer',
      tags: ['微软官方', '官方安装包', '分屏管理', '生产力'],
      website: 'https://github.com/microsoft/PowerToys',
      wingetId: 'Microsoft.PowerToys',
      installerUrl: 'https://github.com/microsoft/PowerToys/releases/latest/download/PowerToysUserSetup-x64.exe',
      installerFileName: 'PowerToysUserSetup-x64.exe',
    },
    {
      id: 'software.clash-verge',
      type: 'software',
      name: 'Clash Verge Rev',
      version: '最新版',
      author: 'Clash Verge Rev Team',
      description: '基于 Tauri 打造的高性能现代化网络代理客户端，界面精致流畅，支持丰富的分流规则与订阅管理。',
      icon: 'lucide:globe',
      category: '网络与安全',
      packageType: 'installer',
      tags: ['网络代理', '官方安装包', '流量分流', '网络诊断'],
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
  directDownload: {
    url: '',
    targetDir: '',
    fileName: '',
    autoInferred: true,
    isDownloading: false,
    progressMsg: '',
  },
};

function inferFileNameFromUrl(url) {
  if (!url || typeof url !== 'string') return '';
  try {
    const cleanUrl = url.trim().split('?')[0].split('#')[0];
    const parts = cleanUrl.split('/').filter(Boolean);
    const last = parts[parts.length - 1];
    if (last) {
      return decodeURIComponent(last);
    }
  } catch {}
  return '';
}

const DIRECT_DOWNLOAD_PRESETS = [
  {
    name: 'Geek Uninstaller',
    badge: '绿色单文件',
    url: 'https://geekuninstaller.com/geek.zip',
    fileName: 'geek.zip',
    desc: '单文件免安装，强力深度卸载清理',
  },
  {
    name: 'Everything 全盘搜索',
    badge: '便携ZIP',
    url: 'https://www.voidtools.com/Everything-1.4.1.1026.x64.zip',
    fileName: 'Everything-x64.zip',
    desc: '秒级极速全盘文件名检索，解压即用',
  },
  {
    name: 'Snipaste 截图贴图',
    badge: '便携ZIP',
    url: 'https://dl.snipaste.com/win-x64',
    fileName: 'Snipaste-x64.zip',
    desc: '截图、贴图、取色与画笔标注神器',
  },
  {
    name: 'DevToys 瑞士军刀',
    badge: '便携ZIP',
    url: 'https://github.com/DevToys-app/DevToys/releases/latest/download/devtoys_win_x64.zip',
    fileName: 'devtoys_win_x64.zip',
    desc: '离线开发实用工具集合，免安装',
  },
  {
    name: '7-Zip 压缩解压',
    badge: '官方安装包EXE',
    url: 'https://www.7-zip.org/a/7z2409-x64.exe',
    fileName: '7z2409-x64.exe',
    desc: '轻量高效知名开源压缩解压工具',
  },
];

function renderIcon(rawIcon, defaultEmoji = '🧩') {
  if (!rawIcon) {
    return state.ctx.ui.el('span', { class: 'text-2xl shrink-0 select-none' }, defaultEmoji);
  }
  const IconComp = resolveIcon(rawIcon);
  if (IconComp) {
    return h(IconComp, { class: 'size-7 shrink-0 text-primary' });
  }
  if (rawIcon.startsWith('http://') || rawIcon.startsWith('https://') || rawIcon.startsWith('data:')) {
    return state.ctx.ui.el('img', { src: rawIcon, class: 'size-7 shrink-0 object-contain rounded' });
  }
  return state.ctx.ui.el('span', { class: 'text-2xl shrink-0 select-none' }, rawIcon);
}

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
    const res = await fetch(CDN_CATALOG_URL, { cache: 'no-cache' });
    if (res.ok) fetched = await res.json();
  } catch (_) {
    try {
      const res = await fetch(RAW_CATALOG_URL, { cache: 'no-cache' });
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
$dest = "${destFolder}";
$tmp = "${tempZip}";
if (Test-Path $tmp) { Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue }
$downloadOk = $false;
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  curl.exe -fLs --connect-timeout 10 --retry 1 "${primaryUrl}" -o $tmp;
  if ((Test-Path $tmp) -and ((Get-Item $tmp).Length -gt 100)) { $downloadOk = $true }
  else {
    curl.exe -fLs --connect-timeout 15 --retry 1 "${mirrorUrl}" -o $tmp;
    if ((Test-Path $tmp) -and ((Get-Item $tmp).Length -gt 100)) { $downloadOk = $true }
  }
}
if (-not $downloadOk) {
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12;
  try {
    Invoke-WebRequest -Uri "${primaryUrl}" -OutFile $tmp -UseBasicParsing -TimeoutSec 20;
    $downloadOk = $true;
  } catch {
    Invoke-WebRequest -Uri "${mirrorUrl}" -OutFile $tmp -UseBasicParsing -TimeoutSec 25;
    $downloadOk = $true;
  }
}
if ($downloadOk -and (Test-Path $tmp)) {
  if (Test-Path $dest) { Remove-Item -Path $dest -Recurse -Force -ErrorAction SilentlyContinue }
  New-Item -ItemType Directory -Path $dest -Force | Out-Null;
  Expand-Archive -Path $tmp -DestinationPath $dest -Force;
  Remove-Item -Path $tmp -Force -ErrorAction SilentlyContinue;
  exit 0;
} else {
  Write-Error "Download or extraction failed";
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

async function installWinget(item, { interactive = false } = {}) {
  const { ctx } = state;
  if (!item.wingetId || state.tasks.has(item.id)) return;

  const modeText = interactive ? '自定义交互安装' : '标准静默安装';
  state.tasks.set(item.id, { action: 'winget', label: `${modeText}中...`, inProgress: true });
  scheduleRender();

  if (interactive) {
    ctx.ui.notify(`已呼出「${item.name}」安装向导，可在向导中自选安装盘符与路径`, 'info');
  } else {
    ctx.ui.notify(`正在后台安装「${item.name}」，请稍候...`, 'info');
  }

  try {
    const args = ['-NoProfile', '-Command'];
    if (interactive) {
      args.push(`winget install --id "${item.wingetId}" -e --interactive --accept-source-agreements`);
    } else {
      args.push(
        `winget install --id "${item.wingetId}" -e --accept-package-agreements --accept-source-agreements --silent`,
      );
    }

    const ch = `winget-${Date.now().toString(36)}`;
    await runPtyCommand(ctx, ch, 'powershell.exe', args);
    state.tasks.delete(item.id);
    ctx.ui.notify(`软件「${item.name}」安装完成！`, 'success');
  } catch (err) {
    state.tasks.delete(item.id);
    ctx.ui.notify(`Winget 安装提示: ${err.message ?? err}`, 'error');
  } finally {
    scheduleRender();
  }
}

async function downloadSoftwareInstaller(item) {
  const { ctx } = state;
  if (state.tasks.has(item.id)) return;

  let downloadUrl = item.installerUrl;
  let fileName = item.installerFileName || `${item.id.replace(/^software\./, '')}-setup.exe`;

  if (!downloadUrl) {
    openWebsite(item);
    return;
  }

  let picked = [];
  try {
    picked = await ctx.files.pick({
      folder: true,
      title: `选择「${item.name}」安装包保存目录`,
    });
  } catch (e) {
    ctx.ui.notify(`打开选择目录失败: ${e.message ?? e}`, 'error');
    return;
  }

  if (!picked || !picked.length || !picked[0]) {
    return;
  }

  const saveDir = picked[0];
  ctx.storage.set('toolkit_store_last_dl_dir', saveDir).catch(() => {});
  state.directDownload.targetDir = saveDir;
  const saveFilePath = `${saveDir}\\${fileName}`;
  const isPortable = item.packageType === 'portable';
  const itemTypeLabel = isPortable ? '绿色便携包' : '安装包';

  state.tasks.set(item.id, { action: 'download', label: '正在下载到指定目录...', inProgress: true });
  scheduleRender();
  ctx.ui.notify(`开始下载「${item.name}」到：${saveDir}`, 'info');

  try {
    const powershellCommand = `
$ProgressPreference = 'SilentlyContinue';
$target = "${saveFilePath}";
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  curl.exe -fL --connect-timeout 20 --retry 2 -o $target "${downloadUrl}";
} else {
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12;
  Invoke-WebRequest -Uri "${downloadUrl}" -OutFile $target -UseBasicParsing;
}
if (Test-Path $target) {
  Start-Process explorer.exe -ArgumentList "/select,\`"$target\`"";
  exit 0;
} else {
  exit 1;
}
`.trim().replace(/\r?\n/g, ' ');

    const ch = `dl-${Date.now().toString(36)}`;
    await runPtyCommand(ctx, ch, 'powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', powershellCommand]);

    state.tasks.delete(item.id);
    ctx.ui.notify(`「${item.name}」${itemTypeLabel}已下载完成！已在资源管理器中定位，请手动解压或安装`, 'success');
  } catch (err) {
    state.tasks.delete(item.id);
    ctx.ui.notify(`下载失败: ${err.message ?? err}`, 'error');
  } finally {
    scheduleRender();
  }
}

async function executeDirectDownload() {
  const { ctx } = state;
  const { url, targetDir, fileName } = state.directDownload;
  if (!url || !/^https?:\/\//i.test(url.trim())) {
    ctx.ui.notify('请输入有效的 HTTP / HTTPS 下载直链', 'warning');
    return;
  }

  let dir = targetDir;
  if (!dir) {
    try {
      const picked = await ctx.files.pick({
        folder: true,
        title: '选择文件保存目录',
      });
      if (picked && picked[0]) {
        dir = picked[0];
        state.directDownload.targetDir = dir;
        ctx.storage.set('toolkit_store_last_dl_dir', dir).catch(() => {});
        scheduleRender();
      } else {
        return;
      }
    } catch (e) {
      ctx.ui.notify(`选择保存目录失败: ${e.message ?? e}`, 'error');
      return;
    }
  }

  let finalName = (fileName || inferFileNameFromUrl(url) || 'downloaded_software.zip').trim();
  finalName = finalName.replace(/[\\/:*?"<>|]/g, '_');
  const saveFilePath = `${dir}\\${finalName}`;

  state.directDownload.isDownloading = true;
  state.directDownload.progressMsg = '正在连接并高速下载...';
  scheduleRender();
  ctx.ui.notify(`开始下载「${finalName}」到指定目录...`, 'info');

  try {
    const powershellCommand = `
$ProgressPreference = 'SilentlyContinue';
$target = "${saveFilePath}";
$url = "${url.trim()}";
if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
  curl.exe -fL --connect-timeout 20 --retry 2 -o $target $url;
} else {
  [System.Net.ServicePointManager]::SecurityProtocol = [System.Net.SecurityProtocolType]::Tls12;
  Invoke-WebRequest -Uri $url -OutFile $target -UseBasicParsing;
}
if (Test-Path $target) {
  Start-Process explorer.exe -ArgumentList "/select,\`"$target\`"";
  exit 0;
} else {
  exit 1;
}
`.trim().replace(/\r?\n/g, ' ');

    const ch = `directdl-${Date.now().toString(36)}`;
    await runPtyCommand(ctx, ch, 'powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      powershellCommand,
    ]);

    ctx.ui.notify(`「${finalName}」下载完成！已在资源管理器中定位，请手动解压或安装`, 'success');
  } catch (err) {
    ctx.ui.notify(`下载失败: ${err.message ?? err}`, 'error');
  } finally {
    state.directDownload.isDownloading = false;
    state.directDownload.progressMsg = '';
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
        el('button', { variant: 'default', size: 'sm', onClick: () => installPlugin(p) }, '📥 一键安装到插件库'),
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
            renderIcon(p.icon, '🧩'),
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
    const isPortable = s.packageType === 'portable';

    if (task?.inProgress) {
      actionButtons.push(
        el('button', { variant: 'outline', size: 'sm', disabled: true }, task.label || '处理中...'),
      );
    } else {
      if (s.installerUrl) {
        actionButtons.push(
          el(
            'button',
            {
              variant: isPortable ? 'default' : 'outline',
              size: 'sm',
              title: isPortable
                ? '自选保存路径，下载绿色便携包(ZIP)到指定文件夹并定位'
                : '自选保存路径，下载安装包(EXE)到指定文件夹并定位',
              onClick: () => downloadSoftwareInstaller(s),
            },
            isPortable ? '📦 便携版下载 (自选目录)' : '📁 自选路径下载 (EXE)',
          ),
        );
      }
      if (s.wingetId) {
        actionButtons.push(
          el(
            'button',
            {
              variant: 'outline',
              size: 'sm',
              title: '启动安装向导，可在安装窗口中自定义安装盘符与路径',
              onClick: () => installWinget(s, { interactive: true }),
            },
            '⚙️ 交互安装(自选路径)',
          ),
        );
        actionButtons.push(
          el(
            'button',
            {
              variant: isPortable ? 'outline' : 'default',
              size: 'sm',
              title: '使用 Winget 默认静默安装',
              onClick: () => installWinget(s, { interactive: false }),
            },
            '⚡ 默认安装',
          ),
        );
      } else if (s.website) {
        actionButtons.push(
          el('button', { variant: 'outline', size: 'sm', onClick: () => openWebsite(s) }, '🌐 官方网站'),
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
            renderIcon(s.icon, isPortable ? '📦' : '🚀'),
            el(
              'div',
              { class: 'min-w-0' },
              el('h3', { class: 'text-sm font-semibold truncate m-0' }, s.name),
              el('span', { class: 'text-xs text-muted-foreground' }, `${s.author || '精选'} · ${s.version}`),
            ),
          ),
          el(
            'span',
            { class: isPortable ? 'tb-badge tb-t-ok' : 'tb-badge tb-t-brand' },
            isPortable ? '绿色便携' : '推荐软件',
          ),
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
        { class: 'flex flex-wrap items-center justify-end gap-2 pt-3 mt-3 border-t border-border' },
        ...actionButtons,
      ),
    );
  };

  const renderDirectDownloadView = () => {
    return el(
      'div',
      { class: 'flex flex-col gap-4 max-w-[800px] mx-auto w-full py-2' },
      el(
        'div',
        { class: 'tb-card p-5 flex flex-col gap-4', style: 'border-radius:10px;' },
        el(
          'div',
          { class: 'flex items-start justify-between gap-3 border-b border-border pb-3' },
          el(
            'div',
            { class: 'flex items-center gap-3' },
            renderIcon('lucide:download', '📥'),
            el(
              'div',
              {},
              el('h3', { class: 'text-base font-bold m-0' }, '🔗 互联网直链 / 绿色免安装软件高速下载'),
              el(
                'p',
                { class: 'text-xs text-muted-foreground m-0 mt-0.5' },
                '支持任何网盘直链、CDN 加速、GitHub Release、官网软件等 .exe / .zip / .7z 高速下载。只提供下载并自动打开定位，由您手动解压或安装。',
              ),
            ),
          ),
          el('span', { class: 'tb-badge tb-t-ok shrink-0' }, '纯净下载 · 手动安装'),
        ),
        el(
          'div',
          { class: 'flex flex-col gap-3.5' },
          el(
            'div',
            { class: 'flex flex-col gap-1.5' },
            el('label', { class: 'text-xs font-semibold text-foreground' }, '下载直链 URL *'),
            el('input', {
              type: 'text',
              value: state.directDownload.url,
              placeholder: '粘贴 http:// 或 https:// 直链，如网盘直链、CDN 绿化软件、GitHub Release...',
              class: 'tb-input w-full text-xs font-mono',
              onInput: (e) => {
                const val = e.target.value;
                state.directDownload.url = val;
                const guessed = inferFileNameFromUrl(val);
                if (guessed && (!state.directDownload.fileName || state.directDownload.autoInferred)) {
                  state.directDownload.fileName = guessed;
                  state.directDownload.autoInferred = true;
                }
                scheduleRender();
              },
            }),
          ),
          el(
            'div',
            { class: 'flex flex-col gap-1.5' },
            el('label', { class: 'text-xs font-semibold text-foreground' }, '保存目标目录 *'),
            el(
              'div',
              { class: 'flex items-center gap-2' },
              el('input', {
                type: 'text',
                readOnly: true,
                value: state.directDownload.targetDir || '（尚未指定保存路径，请点击右侧按钮选择）',
                class: 'tb-input flex-1 text-xs text-muted-foreground',
              }),
              el(
                'button',
                {
                  variant: 'outline',
                  size: 'sm',
                  onClick: async () => {
                    try {
                      const picked = await state.ctx.files.pick({
                        folder: true,
                        title: '选择下载文件保存目录',
                      });
                      if (picked && picked[0]) {
                        state.directDownload.targetDir = picked[0];
                        state.ctx.storage.set('toolkit_store_last_dl_dir', picked[0]).catch(() => {});
                        scheduleRender();
                      }
                    } catch (e) {
                      state.ctx.ui.notify(`选择目录失败: ${e.message ?? e}`, 'error');
                    }
                  },
                },
                '📁 自选保存目录',
              ),
            ),
          ),
          el(
            'div',
            { class: 'flex flex-col gap-1.5' },
            el('label', { class: 'text-xs font-semibold text-foreground' }, '保存文件名 (可选修改)'),
            el('input', {
              type: 'text',
              value: state.directDownload.fileName,
              placeholder: '例如: my-tool.zip 或 setup.exe (建议保留正确文件扩展名)',
              class: 'tb-input w-full text-xs font-mono',
              onInput: (e) => {
                state.directDownload.fileName = e.target.value;
                state.directDownload.autoInferred = false;
                scheduleRender();
              },
            }),
          ),
          el(
            'div',
            { class: 'flex items-center justify-end gap-2 pt-2 border-t border-border mt-1' },
            el(
              'button',
              {
                variant: 'outline',
                size: 'sm',
                onClick: () => {
                  state.directDownload.url = '';
                  state.directDownload.fileName = '';
                  state.directDownload.autoInferred = true;
                  scheduleRender();
                },
              },
              '↺ 清空',
            ),
            el(
              'button',
              {
                variant: 'default',
                size: 'sm',
                disabled: state.directDownload.isDownloading,
                onClick: () => executeDirectDownload(),
              },
              state.directDownload.isDownloading
                ? state.directDownload.progressMsg || '⏳ 高速下载中...'
                : '🚀 开始高速下载到指定目录',
            ),
          ),
        ),
      ),
      el(
        'div',
        { class: 'tb-card p-4 flex flex-col gap-3', style: 'border-radius:10px;' },
        el(
          'div',
          { class: 'flex items-center gap-2 text-xs font-semibold text-muted-foreground' },
          renderIcon('lucide:link', '🔗'),
          '常用便携软件高速直链 (点击快速填入体验)',
        ),
        el(
          'div',
          { style: 'display:grid;grid-template-columns:repeat(auto-fill, minmax(220px, 1fr));gap:10px;' },
          ...DIRECT_DOWNLOAD_PRESETS.map((preset) =>
            el(
              'button',
              {
                variant: 'outline',
                class: 'text-left p-2.5 flex flex-col gap-1 transition-all hover:border-primary/50 cursor-pointer',
                style: 'border-radius:6px;height:auto;align-items:flex-start;',
                onClick: () => {
                  state.directDownload.url = preset.url;
                  state.directDownload.fileName = preset.fileName;
                  state.directDownload.autoInferred = false;
                  state.ctx.ui.notify(`已填入「${preset.name}」直链`, 'info');
                  scheduleRender();
                },
              },
              el(
                'div',
                { class: 'flex items-center justify-between w-full' },
                el('span', { class: 'text-xs font-semibold truncate' }, preset.name),
                el('span', { class: 'tb-badge tb-t-dim text-[10px]' }, preset.badge),
              ),
              el('span', { class: 'text-[11px] text-muted-foreground line-clamp-1' }, preset.desc),
            ),
          ),
        ),
      ),
      el(
        'div',
        { class: 'tb-card p-3.5 text-xs text-muted-foreground leading-relaxed flex flex-col gap-1.5' },
        el('div', { class: 'font-semibold text-foreground flex items-center gap-1.5' }, '🛡️ 纯净安全保障声明'),
        el(
          'div',
          {},
          '1. 本工具仅负责将互联网上的合法文件高速落盘到您指定的文件夹，不附加任何广告弹窗或篡改。',
        ),
        el(
          'div',
          {},
          '2. 下载完成后，系统将自动呼出 Windows 资源管理器并高亮选中文件，方便您手动解压便携包或运行安装。',
        ),
        el(
          'div',
          {},
          '3. 依托系统原生多线程 curl 引擎，支持 301/302 重定向追踪与断点恢复，适用各种网盘与 CDN 直链。',
        ),
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
            '发现官方扩展与开发者必备软件，支持一键无感安装、自选路径下载、交互安装向导与完整卸载。',
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
        tabButton('direct', '🔗 自定义直链下载'),
        tabButton('installed', '✓ 已安装插件', installedCount),
      ),
      el(
        'div',
        { class: 'flex-1 overflow-auto pr-1' },
        state.activeTab === 'direct'
          ? renderDirectDownloadView()
          : (totalResults === 0
              ? el(
                  'div',
                  { class: 'flex flex-col items-center justify-center p-12 text-center text-muted-foreground gap-2' },
                  el('span', { class: 'text-3xl' }, '🔍'),
                  el('p', { class: 'text-sm font-medium m-0' }, '未找到匹配的插件或软件'),
                  el('p', { class: 'text-xs m-0' }, '尝试调整搜索关键词或点击右上角刷新目录。'),
                )
              : el(
                  'div',
                  { class: 'flex flex-col gap-3' },
                  state.activeTab === 'software' || state.activeTab === 'all'
                    ? el(
                        'div',
                        {
                          class:
                            'tb-card p-2.5 px-3.5 flex items-center justify-between gap-2 text-xs text-muted-foreground',
                          style: 'border-radius:6px;',
                        },
                        el(
                          'span',
                          {},
                          '💡 想要下载网盘、CDN 或论坛上的绿色便携软件 (.zip / .exe)？可直接使用直链下载器。',
                        ),
                        el(
                          'button',
                          {
                            variant: 'outline',
                            size: 'sm',
                            onClick: () => {
                              state.activeTab = 'direct';
                              scheduleRender();
                            },
                          },
                          '🔗 打开自定义直链下载',
                        ),
                      )
                    : null,
                  el(
                    'div',
                    {
                      style:
                        'display:grid;grid-template-columns:repeat(auto-fill, minmax(320px, 1fr));gap:14px;padding-bottom:16px;',
                    },
                    ...displayedPlugins.map(renderPluginCard),
                    ...displayedSoftware.map(renderSoftwareCard),
                  ),
                )),
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

  try {
    const lastDir = await ctx.storage.get('toolkit_store_last_dl_dir');
    if (lastDir) {
      state.directDownload.targetDir = lastDir;
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
