/**
 * 自动更新 —— 宿主的动作，不是插件能力。
 *
 * 三条设计决定：
 *
 * 1. **走宿主自己的命令，不用更新器的前端包**。于是它的命令不必进权限表，
 *    前端也不多一个依赖；进出只有两个应用自定义命令，各自带同一道主窗口闸门。
 * 2. **启动时那次检查是静默的**：没网、端点没配、代理挡了，全都算正常，不打扰任何人。
 *    所以它**不被 await** —— 更新检查不能成为启动路径的一部分（那条路径已经逐段计时，
 *    一次网络超时会被读成"启动变慢"）。
 * 3. **安装是不可逆的全局动作**：先停掉所有正在运行的子进程（Windows 上更新器是硬退出，
 *    宿主自己的退出钩子不会跑），再替换应用并重启。所以必须由人确认，
 *    而且确认文案要把"会停进程、会重启"说清楚。
 */

import { invoke } from '@tauri-apps/api/core';

import { logger } from '../core/logger.js';
import { toast } from './store.js';

/**
 * 最近一次检查的结果，给不需要响应式的地方看（设置页自己持有 ref）。
 *   null                      → 还没查过
 *   { available: false, current }
 *   { available: true, current, version, notes }
 */
export const updateState = { result: null, checking: false, installing: false, error: null };

const err = (e) => String(e?.message ?? e);

/** 问一次有没有新版本。失败返回 null，并把原因记在 `updateState.error`。 */
export async function checkForUpdate({ silent = true } = {}) {
  if (updateState.checking) return updateState.result;
  updateState.checking = true;
  updateState.error = null;
  try {
    const result = await invoke('host_update_check');
    updateState.result = result;
    logger.info(
      'update',
      result.available
        ? `v${result.version} is available (running ${result.current})`
        : `up to date (${result.current})`,
    );
    if (result.available && !silent) toast(`发现新版本 ${result.version}`, 'info');
    return result;
  } catch (e) {
    updateState.error = err(e);
    logger.warn('update', `check failed: ${updateState.error}`);
    // 静默模式连日志之外的痕迹都不留：这条路径最常见的"失败"就是没网。
    if (!silent) toast(`检查更新失败：${updateState.error}`, 'error');
    return null;
  } finally {
    updateState.checking = false;
  }
}

/**
 * 下载、安装、重启。**先由用户确认。**
 *
 * 返回 `{cancelled}`、`{installed:false, reason}` 或 `{installed:true, version}`。
 * 在 Windows 上通常看不到返回值：安装器被拉起后进程立刻退出，
 * 新版本由安装器自己启动（更新器的默认行为）。
 */
export async function installUpdate() {
  if (updateState.installing) return { cancelled: false, installed: false, reason: 'busy' };

  const version = updateState.result?.version ?? '新版本';
  const ok = window.confirm(
    `安装 ${version} 并重启 Toolbox？\n\n` +
      '会先停止所有正在运行的子进程（进程管理里的那些），然后替换应用。',
  );
  if (!ok) return { cancelled: true };

  updateState.installing = true;
  updateState.error = null;
  try {
    const result = await invoke('host_update_install');
    logger.info('update', `install: ${JSON.stringify(result)}`);
    return result;
  } catch (e) {
    updateState.error = err(e);
    logger.error('update', `install failed: ${updateState.error}`);
    toast(`更新失败：${updateState.error}`, 'error');
    return { installed: false, reason: updateState.error };
  } finally {
    updateState.installing = false;
  }
}
