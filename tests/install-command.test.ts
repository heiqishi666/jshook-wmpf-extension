import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallationCommand as run } from '../src/install-command.js';

test('installation logs retain successful stages and spawn failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wmpf-command-'));
  const log = join(root, 'install.log');
  try {
    assert.equal(
      await run(process.execPath, ['-e', 'console.log("first-stage")'], root, log),
      'first-stage',
    );
    await assert.rejects(run(join(root, 'nonexistent-executable'), [], root, log), /see/);
    const content = await readFile(log, 'utf8');
    assert.match(content, /first-stage/);
    assert.match(content, /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test('installation timeout terminates a hanging command and records the cause', async () => {
  const root = await mkdtemp(join(tmpdir(), 'wmpf-timeout-'));
  try {
    await assert.rejects(
      run(
        process.execPath,
        ['-e', 'setInterval(()=>{},1000)'],
        root,
        join(root, 'install.log'),
        300,
      ),
      /timed out/,
    );
    assert.match(await readFile(join(root, 'install.log'), 'utf8'), /timed out/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
