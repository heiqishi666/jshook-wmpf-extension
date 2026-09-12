import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('backend lock pins direct and transitive packages to public registry with integrity', async () => {
  const root = new URL('../assets/', import.meta.url);
  const pkg = JSON.parse(await readFile(new URL('backend-package.json', root), 'utf8'));
  const lock = JSON.parse(await readFile(new URL('backend-package-lock.json', root), 'utf8'));
  assert.equal(lock.lockfileVersion, 3);
  for (const group of ['dependencies', 'devDependencies']) {
    assert.deepEqual(pkg[group], lock.packages[''][group]);
    for (const [name, version] of Object.entries(pkg[group])) {
      assert.match(version as string, /^\d+\.\d+\.\d+$/);
      assert.equal(lock.packages['node_modules/' + name].version, version);
    }
  }
  for (const [name, entry] of Object.entries(lock.packages) as [string, any][]) {
    if (!name) continue;
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity, /^sha512-/);
  }
});
