import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
const root = new URL('../',import.meta.url);
test('SDK declarations are generated from the published API schemas', () => {
  execFileSync(process.execPath,['scripts/generate-api-types.mjs','--check'],{cwd:root,stdio:'pipe'});
});
test('generated API checks accept Windows CRLF but still reject stale declarations', t => {
  const prefix = join(resolve(tmpdir()), 'toolkit-api-types-');
  const temporary = mkdtempSync(prefix);
  assert.ok(resolve(temporary).startsWith(prefix) && resolve(temporary).startsWith(resolve(tmpdir()) + sep));
  t.after(() => rmSync(temporary, {recursive:true, force:true}));
  for (const dir of ['scripts','sdk/types']) mkdirSync(join(temporary,dir), {recursive:true});
  for (const file of ['scripts/generate-api-types.mjs','sdk/contracts.json']) copyFileSync(new URL(`../${file}`,import.meta.url),join(temporary,file));
  const declarations = readFileSync(new URL('../sdk/types/contracts.d.ts',import.meta.url),'utf8').replace(/\r?\n/g,'\r\n');
  const target = join(temporary,'sdk/types/contracts.d.ts');
  writeFileSync(target,declarations);
  execFileSync(process.execPath,['scripts/generate-api-types.mjs','--check'],{cwd:temporary,stdio:'pipe'});
  writeFileSync(target,declarations+'export type Stale = never;\r\n');
  assert.throws(() => execFileSync(process.execPath,['scripts/generate-api-types.mjs','--check'],{cwd:temporary,stdio:'pipe'}));
});
test('plugin data API examples compile and reject invalid roles and mutable imported resources', () => {
  execFileSync(process.execPath,['node_modules/typescript/bin/tsc','--noEmit','--strict','--lib','ES2022,DOM','--moduleResolution','node','tests/types/plugin-data.ts'],{cwd:root,stdio:'pipe'});
});
test('every API schema reference resolves, including request and result definitions', () => {
  const schema=JSON.parse(readFileSync(new URL('../sdk/contracts.json',import.meta.url),'utf8'));
  function visit(value) {
    if (!value || typeof value!=='object') return;
    if (value.$ref) assert.ok(schema.$defs[value.$ref.split('/').at(-1)],value.$ref);
    for(const child of Object.values(value)) visit(child);
  }
  visit(schema);
});
