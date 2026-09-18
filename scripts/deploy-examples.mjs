#!/usr/bin/env node
/**
 * Deploy the example plugins into the running app's plugins directory.
 *
 * The examples are the app's integration check: `probe.demo` runs its whole
 * interface sweep inside `activate()`, so if it is stale the app reports a
 * failure that was fixed days ago. Copying by hand has caused exactly that
 * twice, so it is a script now:
 *
 *   npm run deploy:examples
 *
 * The target is derived from the app identifier in tauri.conf.json, so this
 * follows the app rather than hard-coding a path.
 */

import { cp, mkdir, readFile, rm, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** `<dir>/<plugin folder>` -> the id it must be deployed under. */
const EXAMPLES = [
  ['examples/plugins/probe', 'probe.demo'],
  ['examples/plugins/hello', 'hello.demo'],
  ['examples/calc-plugin', 'calc.demo'],
];

/** Where the app keeps its data, per platform, from the app identifier. */
function pluginsDir(identifier) {
  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), identifier, 'plugins');
    case 'darwin':
      return join(home, 'Library', 'Application Support', identifier, 'plugins');
    default:
      return join(process.env.XDG_DATA_HOME ?? join(home, '.local', 'share'), identifier, 'plugins');
  }
}

const conf = JSON.parse(await readFile(join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
const identifier = conf.identifier;
if (!identifier) throw new Error('tauri.conf.json has no `identifier`');

const target = pluginsDir(identifier);
await mkdir(target, { recursive: true });

console.log(`app:      ${conf.productName} (${identifier})`);
console.log(`plugins:  ${target}`);

for (const [from, id] of EXAMPLES) {
  const src = join(ROOT, from);
  const dest = join(target, id);
  if (!existsSync(src)) throw new Error(`missing example: ${from}`);
  // Replace, not merge: a file deleted from the example must disappear here too,
  // or the deployed copy drifts in the other direction.
  await rm(dest, { recursive: true, force: true });
  await cp(src, dest, { recursive: true });
  const files = await readdir(dest);
  console.log(`  ${id.padEnd(12)} <- ${from}  (${files.length} files)`);
}

console.log('\ndone — the app picks these up on its next boot or Rescan.');
