import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { environmentStatus, installedBackend, installBackend } from '../src/installer.js';

test(
  'partial installation is diagnosed without overwriting it',
  { skip: process.platform !== 'win32' },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'wmpf-status-'));
    const previous = process.env.JSHOOK_WMPF_CACHE;
    process.env.JSHOOK_WMPF_CACHE = root;
    try {
      assert.equal((await environmentStatus()).state, 'missing');
      await mkdir(installedBackend());
      const result = await environmentStatus();
      assert.equal(result.state, 'repair_required');
      assert.ok('action' in result.nextActions[0]);
      assert.equal(result.nextActions[0].action, 'inspect_installation');
      await assert.rejects(installBackend(true), /needs inspection/);
      await mkdir(join(root, 'install.lock'));
      assert.ok((await environmentStatus()).installationLock);
    } finally {
      if (previous === undefined) delete process.env.JSHOOK_WMPF_CACHE;
      else process.env.JSHOOK_WMPF_CACHE = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);
