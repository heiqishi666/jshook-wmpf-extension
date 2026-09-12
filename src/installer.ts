import { runInstallationCommand as run } from './install-command.js';
import { access, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const revision = 'e65e3ec98ea38de8ea78fc0ad02d01d9b2fd0345';
const repository = 'https://github.com/evi0s/WMPFDebugger.git';
// Both src/ and bundled dist/ resolve to the extension root.
const assets = resolve(dirname(fileURLToPath(import.meta.url)), '../assets');
export const cacheRoot = () =>
  resolve(
    process.env.JSHOOK_WMPF_CACHE || join(process.env.LOCALAPPDATA || homedir(), 'jshook', 'wmpf'),
  );
export const installedBackend = () => join(cacheRoot(), revision + '-managed-v2');
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
async function dependencyDigest() {
  return digest(
    Buffer.concat(
      await Promise.all(
        ['backend-package.json', 'backend-package-lock.json'].map((name) =>
          readFile(join(assets, name)),
        ),
      ),
    ),
  );
}
export async function environmentStatus() {
  const path = installedBackend();
  let error: string | undefined;
  let ready = false;
  let exists = false;
  try {
    await access(path);
    exists = true;
  } catch {}
  let installationLock: unknown;
  try {
    await access(join(cacheRoot(), 'install.lock'));
    installationLock = {
      path: join(cacheRoot(), 'install.lock'),
      message:
        'An installer may be running. Inspect processes and staging logs before removing any lock.',
    };
  } catch {}
  try {
    const marker = JSON.parse(await readFile(join(path, 'jshook-install.json'), 'utf8'));
    if (
      marker.revision !== revision ||
      marker.patch !== digest(await readFile(join(assets, 'managed.patch'))) ||
      marker.dependencies !== (await dependencyDigest()) ||
      digest(await readFile(join(path, 'package.json'))) !==
        digest(await readFile(join(assets, 'backend-package.json'))) ||
      digest(await readFile(join(path, 'package-lock.json'))) !==
        digest(await readFile(join(assets, 'backend-package-lock.json')))
    )
      throw new Error('Installed revision or patch differs');
    await access(join(path, 'node_modules/ts-node/dist/bin.js'));
    await access(join(path, 'node_modules/frida/package.json'));
    const source = await readFile(join(path, 'src/index.ts'), 'utf8');
    if (!source.includes('wmpf_shutdown')) throw new Error('Managed protocol missing');
    ready = true;
  } catch (e) {
    error = String(e);
  }
  return {
    state:
      process.platform !== 'win32'
        ? 'unsupported'
        : ready
          ? 'ready'
          : exists
            ? 'repair_required'
            : 'missing',
    installationLock,
    backendPath: path,
    repository,
    revision,
    error,
    installation:
      'Downloads a pinned WMPF repository and installs npm dependencies, including native Frida and dependency install scripts. Requires Git, npm and network. No administrator rights requested; existing services are not stopped.',
    nextActions:
      exists && !ready
        ? [
            {
              action: 'inspect_installation',
              reason:
                'Existing installation is invalid. Preserve it and use a fresh JSHOOK_WMPF_CACHE directory, or obtain authorization for repair. Do not repeatedly call install.',
            },
          ]
        : ready
          ? [{ tool: 'wmpf_start', args: {} }]
          : [
              {
                tool: 'wmpf_install',
                reason:
                  'If the user already authorized environment setup, pass authorized:true. Otherwise explain installation and path, then ask first. Client approval policies always apply.',
              },
            ],
  };
}
let installing: Promise<unknown> | undefined;
export function installBackend(authorized: boolean) {
  if (!authorized)
    return Promise.resolve({
      state: 'approval_required',
      installationPath: installedBackend(),
      message:
        'Ask for environment installation authorization unless already granted. Do not invent approval.',
    });
  if (!installing)
    installing = performInstall().finally(() => {
      installing = undefined;
    });
  return installing;
}
async function performInstall() {
  const status = await environmentStatus();
  if (status.state === 'unsupported')
    throw new Error('Automatic installation currently supports Windows only');
  if (status.state === 'ready') return status;
  await mkdir(cacheRoot(), { recursive: true });
  const lock = join(cacheRoot(), 'install.lock');
  try {
    await mkdir(lock);
  } catch {
    throw new Error(
      `Installation lock exists: ${lock}. Check for an active installer before removing a stale lock.`,
    );
  }
  const stage = join(cacheRoot(), 'staging-' + randomUUID());
  try {
    // An incomplete existing version is never overwritten.
    try {
      await access(installedBackend());
      throw new Error(`Existing installation needs inspection: ${installedBackend()}`);
    } catch (e: any) {
      if (e.code !== 'ENOENT') throw e;
    }
    await mkdir(stage);
    const log = join(stage, 'install.log');
    await run('git', ['init', '.'], stage, log);
    await run('git', ['remote', 'add', 'origin', repository], stage, log);
    await run('git', ['fetch', '--depth=1', 'origin', revision], stage, log);
    await run('git', ['checkout', '--detach', 'FETCH_HEAD'], stage, log);
    if ((await run('git', ['rev-parse', 'HEAD'], stage, log)) !== revision)
      throw new Error('Source revision mismatch');
    await run('git', ['apply', '--check', join(assets, 'managed.patch')], stage, log);
    await run('git', ['apply', join(assets, 'managed.patch')], stage, log);
    // Resolve npm through PATH; .cmd shims are converted to the standard npm CLI path.
    const paths = (process.env.PATH || '').split(';');
    let npm: { command: string; prefix: string[] } | undefined;
    for (const dir of paths) {
      for (const candidate of ['npm.exe', 'node_modules/npm/bin/npm-cli.js']) {
        const p = join(dir, candidate);
        try {
          await access(p);
          npm = candidate.endsWith('.js')
            ? { command: process.execPath, prefix: [p] }
            : { command: p, prefix: [] };
          break;
        } catch {}
      }
      if (npm) break;
    }
    if (!npm)
      throw new Error('npm executable or npm-cli.js not found on PATH; install Node.js with npm');
    await writeFile(
      join(stage, 'package.json'),
      await readFile(join(assets, 'backend-package.json')),
    );
    await writeFile(
      join(stage, 'package-lock.json'),
      await readFile(join(assets, 'backend-package-lock.json')),
    );
    await run(
      npm.command,
      [
        ...npm.prefix,
        'ci',
        '--include=dev',
        '--registry=https://registry.npmjs.org',
        '--no-audit',
        '--no-fund',
      ],
      stage,
      log,
    );
    await run(
      process.execPath,
      ['-e', "require('frida');require('ts-node/register');require('./src/index.ts')"],
      stage,
      log,
    );
    await writeFile(
      join(stage, 'jshook-install.json'),
      JSON.stringify({
        revision,
        patch: digest(await readFile(join(assets, 'managed.patch'))),
        dependencies: await dependencyDigest(),
      }),
    );
    await rename(stage, installedBackend());
  } finally {
    // Remove only the empty lock created by this attempt; preserve staging evidence.
    const { rmdir } = await import('node:fs/promises');
    await rmdir(lock);
  }
  return environmentStatus();
}
