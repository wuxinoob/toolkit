import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@tailwindcss/node';
import { Scanner } from '@tailwindcss/oxide';

test('app CSS scans front-end sources and excludes non-UI files', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const file = resolve(root, 'src/assets/app.css');
  const compiler = await compile(readFileSync(file, 'utf8'), {
    base: dirname(file), onDependency() {},
  });
  // Resolve source metadata the same way the Vite adapter does.
  const roots = compiler.root === 'none' ? [] : compiler.root === null
    ? [{ base: root, pattern: '**/*', negated: false }]
    : [{ ...compiler.root, negated: false }];
  const scanner = new Scanner({ sources: [...roots, ...compiler.sources] });
  const candidates = scanner.scan();

  assert.ok(scanner.files.includes(resolve(root, 'src/App.vue')));
  // This valid class exists only in this test, outside the front-end sources.
  assert.ok(!candidates.includes('duration-[1234567ms]'), 'tests and build outputs must not supply app utilities');
  assert.ok(!scanner.files.some((path) => /[\\/]target(?:-check)?[\\/]/.test(path)), 'Cargo output must not be scanned');
  assert.match(compiler.build(candidates), /\.flex\s*\{\s*display:\s*flex\s*;/);
});
