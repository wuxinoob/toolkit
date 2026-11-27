import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
const root = new URL('../',import.meta.url);
test('SDK declarations are generated from the published API schemas', () => {
  execFileSync(process.execPath,['scripts/generate-api-types.mjs','--check'],{cwd:root,stdio:'pipe'});
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
