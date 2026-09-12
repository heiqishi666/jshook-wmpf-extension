import { spawn, type ChildProcess } from 'node:child_process';
import { access, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Cdp, listTargets, loopbackEndpoint, verifyTarget } from './cdp.js';
import { createAdapter } from './cdp-adapter.js';

type StartOptions = {
  backendPath?: string;
  cdpPort?: number;
  debugPort?: number;
  endpoint?: string;
  timeoutMs?: number;
  debugFrida?: boolean;
};
export class RuntimeManager {
  private child?: ChildProcess;
  private adapter?: Awaited<ReturnType<typeof createAdapter>>;
  private id?: string;
  private endpoint?: string;
  private state = 'stopped';
  private owned = false;
  private starting?: Promise<unknown>;
  private stopping?: Promise<unknown>;
  private attaching?: Promise<any>;
  private error?: string;
  private logs = '';
  private configKey?: string;
  private attachedTarget?: string;
  private lastStoppedId?: string;
  async status(backendPath?: string) {
    let backend: unknown;
    if (backendPath) {
      const root = resolve(backendPath);
      try {
        const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
        await access(join(root, 'node_modules/ts-node/dist/bin.js'));
        await access(join(root, 'src/index.ts'));
        backend = { path: root, name: pkg.name, version: pkg.version, dependenciesAvailable: true };
      } catch (e) {
        backend = { path: root, dependenciesAvailable: false, error: String(e) };
      }
    }
    return {
      serviceId: this.id,
      state: this.state,
      owned: this.owned,
      pid: this.child?.pid,
      endpoint: this.endpoint,
      targetId: this.attachedTarget,
      error: this.error,
      logs: this.logs,
      node: process.version,
      platform: process.platform,
      backend,
    };
  }
  start(options: StartOptions) {
    if (this.stopping) return Promise.reject(new Error('Service is stopping'));
    const key = JSON.stringify(options);
    if (this.starting) {
      if (key !== this.configKey)
        return Promise.reject(new Error('Another configuration is starting'));
      return this.starting;
    }
    if (this.id && this.state !== 'failed') {
      if (key !== this.configKey)
        return Promise.reject(new Error('Stop the existing service before changing configuration'));
      return this.status();
    }
    this.configKey = key;
    this.starting = this.startInternal(options).finally(() => {
      this.starting = undefined;
    });
    return this.starting;
  }
  private async startInternal(options: StartOptions) {
    this.error = undefined;
    this.logs = '';
    this.state = 'starting';
    this.id = randomUUID();
    try {
      if (options.endpoint) {
        this.endpoint = loopbackEndpoint(options.endpoint);
        this.owned = false;
        const cdp = new Cdp(this.endpoint);
        this.state = 'external_connected';
        try {
          await cdp.ready;
          await cdp.send('Target.getTargets');
        } catch (e) {
          if (!String(e).includes('CDP timeout: Target.getTargets')) throw e;
          this.state = 'awaiting_target';
          this.error =
            'WebSocket is reachable, but no Target.getTargets reply yet. The external runtime identity is unverified.';
        } finally {
          cdp.close();
        }
        return this.status();
      }
      if (!options.backendPath)
        throw new Error('backendPath or explicit external endpoint is required');
      const root = resolve(options.backendPath);
      const cdpPort = options.cdpPort ?? 62000,
        debugPort = options.debugPort ?? 9421;
      if (debugPort !== 9421)
        throw new Error('The managed runtime currently requires debugPort 9421');
      for (const port of [cdpPort, debugPort])
        if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid port');
      if (cdpPort === debugPort) throw new Error('CDP and debug ports must differ');
      const entry = join(root, 'src/index.ts'),
        runner = join(root, 'node_modules/ts-node/dist/bin.js');
      await access(entry);
      await access(runner);
      const source = await readFile(entry, 'utf8');
      if (!source.includes('wmpf_shutdown'))
        throw new Error(
          'Backend lacks managed IPC support; use the managed branch or explicit external endpoint',
        );
      this.endpoint = `ws://127.0.0.1:${cdpPort}`;
      this.owned = true;
      const child = spawn(
        process.execPath,
        [
          runner,
          entry,
          '--cdp-port',
          String(cdpPort),
          '--debug-port',
          String(debugPort),
          ...(options.debugFrida ? ['--debug-frida'] : []),
        ],
        {
          cwd: root,
          shell: false,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        },
      );
      this.child = child;
      for (const stream of [child.stdout, child.stderr])
        stream?.on('data', (chunk) => {
          this.logs = (this.logs + chunk.toString()).slice(-12000);
        });
      child.on('exit', (code, signal) => {
        if (!['stopping', 'stopped'].includes(this.state)) {
          this.state = 'failed';
          this.error = `Backend exited: ${code ?? signal}`;
        }
      });
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(
          () => reject(new Error('Backend startup timed out')),
          options.timeoutMs ?? 20000,
        );
        const fail = (e: Error) => {
          clearTimeout(timer);
          reject(e);
        };
        child.once('error', fail);
        child.once('exit', (code) =>
          fail(new Error(`Backend exited before ready (${code}): ${this.logs}`)),
        );
        child.on('message', (m: any) => {
          if (m?.type !== 'wmpf') return;
          if (m.state === 'failed') {
            this.state = 'failed';
            this.error = String(m.error);
            fail(new Error(m.error));
          }
          if (m.state === 'server_ready') this.state = 'server_ready';
          if (m.state === 'runtime_attached') {
            this.state = 'awaiting_target';
            clearTimeout(timer);
            resolveReady();
          }
          if (m.state === 'target_connected' && this.state !== 'attached')
            this.state = 'target_ready';
          if (m.state === 'target_disconnected') {
            this.state = 'awaiting_target';
            this.attachedTarget = undefined;
          }
        });
      });
      return this.status();
    } catch (e) {
      await this.cleanup();
      this.state = 'failed';
      this.error = String(e);
      throw e;
    }
  }
  private requireService(serviceId: string) {
    if (
      !this.id ||
      serviceId !== this.id ||
      !this.endpoint ||
      ['failed', 'stopped', 'stopping'].includes(this.state)
    )
      throw new Error('Service not active or unknown serviceId');
    return this.endpoint;
  }
  async targets(serviceId: string, appId?: string) {
    try {
      const targets = await listTargets(this.requireService(serviceId), appId);
      this.error = undefined;
      if (targets.length && this.state === 'awaiting_target') this.state = 'target_ready';
      return targets;
    } catch (e) {
      if (!String(e).includes('CDP timeout: Target.getTargets')) throw e;
      this.state = 'awaiting_target';
      this.error = String(e);
      return [];
    }
  }
  attach(
    serviceId: string,
    selector: { targetId?: string; appId?: string },
    invoke: (name: string, args: Record<string, unknown>) => Promise<any>,
  ) {
    if (this.attaching || this.stopping || this.starting)
      return Promise.reject(new Error('Service operation in progress'));
    this.attaching = this.attachInternal(serviceId, selector, invoke).finally(() => {
      this.attaching = undefined;
    });
    return this.attaching;
  }
  private async attachInternal(
    serviceId: string,
    selector: { targetId?: string; appId?: string },
    invoke: (name: string, args: Record<string, unknown>) => Promise<any>,
  ) {
    const endpoint = this.requireService(serviceId);
    if (!selector.targetId && !selector.appId) throw new Error('targetId or appId required');
    const candidates = (await listTargets(endpoint, selector.appId)).filter((t) =>
      selector.targetId ? t.targetId === selector.targetId : t.type === 'page',
    );
    if (candidates.length !== 1)
      throw new Error(
        `Target must be unique; found ${candidates.length}. Use wmpf_list_targets and targetId.`,
      );
    const target = candidates[0]!;
    const context = await verifyTarget(endpoint, target.targetId);
    if (context.url !== target.url) throw new Error('Target URL changed during verification');
    await this.adapter?.stop();
    this.adapter = undefined;
    this.attachedTarget = undefined;
    this.state = this.owned ? 'target_ready' : 'external_connected';
    const adapter = await createAdapter(endpoint, target, () => {
      this.attachedTarget = undefined;
      if (!['stopping', 'stopped', 'failed'].includes(this.state)) this.state = 'awaiting_target';
    });
    this.adapter = adapter;
    try {
      const connect = await invoke('browser_attach', { wsEndpoint: adapter.endpoint });
      this.checkTool(connect);
      const attached = await invoke('browser_attach_cdp_target', { targetId: target.targetId });
      this.checkTool(attached);
      const verification = await invoke('browser_evaluate_cdp_target', {
        code: '({url:location.href,title:document.title})',
        returnByValue: true,
      });
      const verified = this.checkTool(verification);
      if (verified?.result?.url !== target.url)
        throw new Error('jshook is bound to a different target context');
      this.state = 'attached';
      this.attachedTarget = target.targetId;
      return {
        ...(await this.status()),
        target,
        context,
        verification,
        adapterEndpoint: adapter.endpoint,
      };
    } catch (e) {
      await adapter.stop();
      this.adapter = undefined;
      throw e;
    }
  }
  private checkTool(result: any) {
    if (result?.isError) throw new Error('jshook tool failed: ' + JSON.stringify(result));
    let parsed: any;
    for (const item of result?.content ?? [])
      if (item.type === 'text') {
        let data;
        try {
          data = JSON.parse(item.text);
        } catch {
          continue;
        }
        if (data?.success === false || data?.error)
          throw new Error('jshook tool failed: ' + item.text);
        parsed = data;
      }
    return parsed;
  }
  async stop(serviceId?: string) {
    if (serviceId && !this.id && serviceId === this.lastStoppedId) return this.status();
    if (serviceId && serviceId !== this.id) throw new Error('Unknown serviceId');
    if (!this.stopping)
      this.stopping = (async () => {
        await this.starting?.catch(() => {});
        await this.attaching?.catch(() => {});
        this.state = 'stopping';
        await this.cleanup();
        this.lastStoppedId = this.id;
        this.id = undefined;
        this.endpoint = undefined;
        this.owned = false;
        this.error = undefined;
        this.state = 'stopped';
        return this.status();
      })().finally(() => {
        this.stopping = undefined;
      });
    return this.stopping;
  }
  private async cleanup() {
    await this.adapter?.stop();
    this.adapter = undefined;
    this.attachedTarget = undefined;
    const child = this.child;
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      await new Promise<void>((resolveExit, reject) => {
        const timer = setTimeout(() => child.kill(), 2500);
        const deadline = setTimeout(
          () => reject(new Error('Owned backend did not exit after shutdown')),
          6000,
        );
        child.once('exit', () => {
          clearTimeout(timer);
          clearTimeout(deadline);
          resolveExit();
        });
        if (child.connected) child.send({ type: 'wmpf_shutdown' }, () => {});
        else child.kill();
      });
    }
    this.child = undefined;
  }
}
