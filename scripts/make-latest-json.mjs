#!/usr/bin/env node
/**
 * 由一次发布的产物生成更新清单（`latest.json`）。
 *
 * 为什么是"从签名文件推导"而不是"按名字拼路径"：更新器要的那个地址取决于
 * **产物实际叫什么**，而它随打包器的版本变过（安装器本身、或它的 zip 形态）。
 * 签名文件的命名是确定的：`<产物文件名>.sig`。所以这里以 `.sig` 为准反推产物，
 * 不做任何猜测 —— 猜错的表现是"更新永远装不上"，而且只在用户端出现。
 *
 * 用法：
 *
 *   node scripts/make-latest-json.mjs --bundle src-tauri/target/release/bundle \
 *        --version 0.2.0 --repo owner/name [--notes-file notes.md] [--out latest.json]
 *
 * 没有签名文件时打印告警并成功退出：更新签名是可选的，不该拦住一次普通发布。
 */

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const bundle = args.get('bundle');
const version = args.get('version');
const repo = args.get('repo');
if (!bundle || !version || !repo) {
  console.error('usage: make-latest-json.mjs --bundle <dir> --version <x.y.z> --repo <owner/name>');
  process.exit(2);
}

const out = args.get('out') ?? 'latest.json';
const notesFile = args.get('notes-file');
const notes = notesFile ? readFileSync(notesFile, 'utf8').trim() : '';

/** 递归收集目录下的所有文件。 */
function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (statSync(full).isFile()) found.push(full);
  }
  return found;
}

let files = [];
try {
  files = walk(bundle);
} catch (e) {
  console.error(`cannot read the bundle directory (${bundle}): ${e.message}`);
  process.exit(1);
}

// 每个 .sig 的"去掉 .sig"就是它签的产物。
const payloads = files
  .filter((f) => f.endsWith('.sig'))
  .map((sig) => ({ sig, payload: sig.slice(0, -4) }));

if (payloads.length === 0) {
  console.log('::warning::没有签名文件：这次发布不带自动更新清单（打开更新签名后会自动出现在这里）');
  console.log(`looked in ${bundle}, found ${files.length} file(s)`);
  process.exit(0);
}

/**
 * 挑更新用的那一份。
 *
 * Windows 上更新器两种都能装（NSIS 安装器 / MSI），但 NSIS 那份支持 `/UPDATE` 与
 * "装完重启"这两个参数，是给自更新准备的；MSI 更适合同一台机器上的运维分发。
 * 所以优先 NSIS，其次才轮到 MSI。
 */
const pick = (re) => payloads.find((p) => re.test(p.payload));
const chosen = pick(/[-_]setup\.exe$/i) ?? pick(/\.nsis\.zip$/i) ?? pick(/\.msi$/i) ?? payloads[0];

const signature = readFileSync(chosen.sig, 'utf8').trim();
const asset = relative(bundle, chosen.payload).split('\\').pop();
const url = `https://github.com/${repo}/releases/latest/download/${asset}`;

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  // 只有 Windows：这个应用只在 Windows 上交付，多写别的平台键只会更难看。
  platforms: { 'windows-x86_64': { signature, url } },
};

writeFileSync(out, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`wrote ${out}`);
console.log(`  version  ${version}`);
console.log(`  payload  ${asset} (from ${relative(process.cwd(), chosen.sig)})`);
console.log(`  url      ${url}`);
console.log(`  skipped  ${payloads.length - 1} other signature(s)`);
