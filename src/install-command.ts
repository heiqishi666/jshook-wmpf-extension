import { spawn } from 'node:child_process';
import { appendFile } from 'node:fs/promises';

// Preserve every stage; shell-free commands and only the spawned process tree are stopped.
export async function runInstallationCommand(
  command: string,
  args: string[],
  cwd: string,
  log: string,
  timeoutMs = 600000,
) {
  await appendFile(log, `\n[command] ${command} ${JSON.stringify(args)}\n`);
  return new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    let failure: Error | undefined;
    const timer = setTimeout(() => {
      failure = new Error(`Installation command timed out after ${timeoutMs}ms`);
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
        killer.on('exit', (code) => {
          if (code !== 0) child.kill();
        });
      } else child.kill();
    }, timeoutMs);
    for (const stream of [child.stdout, child.stderr])
      stream.on('data', (chunk) => {
        output = (output + chunk).slice(-100000);
      });
    child.on('error', (error) => {
      failure = error;
    });
    child.on('close', async (code) => {
      clearTimeout(timer);
      try {
        await appendFile(log, `${output}\n[exit] ${code}; ${failure?.message || ''}\n`);
        if (failure || code !== 0)
          throw new Error(`${failure?.message || 'Command failed (' + code + ')'}; see ${log}`);
        resolve(output.trim());
      } catch (error) {
        reject(error);
      }
    });
  });
}
