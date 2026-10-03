/**
 * 版本号不是一个，是四个 —— 这一份守卫管住其中三个的**关系**。
 *
 * | 版本 | 是什么 | 谁在读它 |
 * |---|---|---|
 * | 应用版本 | 这一次发布叫什么 | 安装包名字、自动更新（比对"我是不是旧了"） |
 * | 线路协议版本 | 信封里那个 `v` 字段 | 两端握手；不一致就拒绝 |
 * | 插件接口版本 | 插件代码面对的那套 API（`ctx`/`bridge` 的形状） | 插件清单声明自己按哪版写的；宿主不匹配只告警 |
 * | 插件自身版本 | 每个插件的发布号 | 插件列表；与宿主版本无关 |
 *
 * 前三者**互相独立**（一个是产品、一个是线协议、一个是编程接口），但各自有内部一致性要求，
 * 而且都曾经是"人写的、没人比对"：
 *
 *   1. 应用版本在**三处各写了一遍**（前端包描述、Rust 包描述、应用配置）。
 *      漂移的后果不是"字符串不好看"：安装包与自动更新读的是配置里那份，
 *      而插件能问到的"宿主版本"读的是 Rust 包描述那份 —— 两边不一致时，
 *      更新器会拿错误的前提去比版本。
 *   2. 线路协议版本在前端与 Rust 各一份，靠人肉同步；不一致就是握手失败。
 *   3. 插件接口版本只有一个数字，但示例插件都在清单里声明了它 —— 声明得比宿主新，
 *      插件可能调用不存在的东西，而宿主只在加载时**告警**、不会拒绝。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const read = (...parts) => readFileSync(path.join(root, ...parts), 'utf8');

/** 应用版本的三处声明。`version = "x"` 的第一处就是 Rust 包的版本。 */
function appVersions() {
  const pkg = JSON.parse(read('package.json'));
  const cargo = read('src-tauri', 'Cargo.toml').match(/^version\s*=\s*"([^"]+)"/m);
  assert.ok(cargo, 'Cargo.toml 里找不到包版本');
  const conf = JSON.parse(read('src-tauri', 'tauri.conf.json'));
  return {
    'package.json': pkg.version,
    'Cargo.toml': cargo[1],
    'tauri.conf.json': conf.version,
  };
}

test('the app version is written in three places and they agree', () => {
  const v = appVersions();
  const distinct = [...new Set(Object.values(v))];
  assert.equal(
    distinct.length,
    1,
    '应用版本必须一致：安装包与自动更新读的是应用配置，插件问到的宿主版本读的是 Rust 包描述 ——\n' +
      `  现在：${Object.entries(v)
        .map(([k, x]) => `${k}=${x}`)
        .join('  ')}\n` +
      '  发布前先统一（改版本号是发布动作的一部分，不是顺手改）。',
  );
  assert.match(distinct[0], /^\d+\.\d+\.\d+/, '自动更新按语义化版本比较，版本号要是 semver');
});

test('the wire protocol version is the same on both sides of the boundary', () => {
  const js = read('src', 'protocol', 'envelope.js').match(/PROTOCOL_VERSION\s*=\s*(\d+)/);
  const rs = read('src-tauri', 'src', 'protocol', 'envelope.rs').match(
    /PROTOCOL_VERSION:\s*u8\s*=\s*(\d+)/,
  );
  assert.ok(js, '前端找不到 PROTOCOL_VERSION');
  assert.ok(rs, 'Rust 找不到 PROTOCOL_VERSION');
  assert.equal(
    js[1],
    rs[1],
    '线路协议版本不一致：一端会拒收另一端的每一条消息（信封里的 v 字段就是它）',
  );
});

test('the plugin API version is a number the host can actually serve', () => {
  const api = read('src', 'protocol', 'contract.js').match(/HOST_API\s*=\s*(\d+)/);
  assert.ok(api, '找不到 HOST_API');
  const host = Number(api[1]);
  assert.ok(Number.isInteger(host) && host >= 1, `HOST_API 必须是正整数，现在是 ${api[1]}`);

  // 仓库自带的示例插件是"当前接口"的集成样本：它们声明得比宿主新，说明样本跑在宿主没有的
  // API 上；声明得比宿主旧，说明接口升级时忘了更新样本（宿主只会告警，不会拒绝，
  // 于是这种陈旧要等到有人真去跑它才暴露）。两边都要求相等。
  const manifests = [];
  const examples = path.join(root, 'examples');
  for (const dir of readdirSync(examples, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    for (const inner of readdirSync(path.join(examples, dir.name), { withFileTypes: true })) {
      if (!inner.isDirectory()) continue;
      const file = path.join(examples, dir.name, inner.name, 'plugin.json');
      if (existsSync(file)) manifests.push([`${dir.name}/${inner.name}`, JSON.parse(readFileSync(file, 'utf8'))]);
    }
  }
  assert.ok(manifests.length >= 3, `没找到示例插件清单（找到 ${manifests.length} 个）—— 抽取规则过期了`);

  const stale = manifests
    .filter(([, m]) => m.api !== undefined && m.api !== host)
    .map(([where, m]) => `${where}: api=${m.api}`);
  assert.deepEqual(
    stale,
    [],
    `示例插件声明的接口版本与宿主（HOST_API=${host}）不一致 —— 它们是当前接口的样本：\n  ${stale.join('\n  ')}`,
  );
});
