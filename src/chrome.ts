import { access } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, join } from 'node:path';
import { loopbackEndpoint } from './cdp.js';

export function devtoolsUrl(endpoint: string) {
  const ws = new URL(loopbackEndpoint(endpoint));
  return `devtools://devtools/bundled/inspector.html?ws=${encodeURIComponent(ws.host + ws.pathname + ws.search)}`;
}
export async function findChrome(explicit?: string) {
  if (process.platform !== 'win32')
    throw new Error('Chrome opening is currently implemented for Windows');
  const candidates: string[] = explicit ? [explicit] : [];
  if (!explicit) {
    for (const key of ['PROGRAMFILES', 'PROGRAMFILES(X86)', 'LOCALAPPDATA']) {
      if (process.env[key])
        candidates.push(join(process.env[key]!, 'Google/Chrome/Application/chrome.exe'));
    }
    for (const hive of ['HKCU', 'HKLM']) {
      try {
        const { stdout } = await promisify(execFile)(
          'reg.exe',
          [
            'query',
            `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe`,
            '/ve',
          ],
          { windowsHide: true, timeout: 2000 },
        );
        const path = stdout.match(/REG_SZ\s+(.+)/)?.[1]?.trim();
        if (path) candidates.push(path);
      } catch {
        /* Try known install locations next. */
      }
    }
  }
  for (const path of candidates) {
    if (basename(path).toLowerCase() !== 'chrome.exe') continue;
    try {
      await access(path);
      return path;
    } catch {
      /* Try next location. */
    }
  }
  throw new Error('Chrome not found; provide chromePath to the installed chrome.exe');
}
export async function openDevtools(endpoint: string, chromePath?: string) {
  const url = devtoolsUrl(endpoint);
  const executable = await findChrome(chromePath);
  const child = spawn(executable, ['--new-tab', url], {
    shell: false,
    windowsHide: true,
    stdio: 'ignore',
  });
  await new Promise<void>((resolve, reject) => {
    child.once('spawn', resolve);
    child.once('error', reject);
  });
  child.unref();
  return {
    launched: true,
    url,
    chromePath: executable,
    message:
      'Chrome launch requested. Verify targets separately; this does not prove a miniapp is connected.',
  };
}
