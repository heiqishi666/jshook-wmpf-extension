import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import { Cdp, listTargets, loopbackEndpoint } from '../src/cdp.js';
import { createAdapter } from '../src/cdp-adapter.js';
import { RuntimeManager } from '../src/runtime-manager.js';
import { devtoolsUrl } from '../src/chrome.js';
import plugin from '../manifest.js';

async function backend() {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const target = {
    targetId: 'miniapp-A',
    type: 'page',
    title: 'Test',
    url: 'https://servicewechat.com/wx_test/1/page-frame.html',
  };
  let session = 0;
  const detached: string[] = [];
  const requests: any[] = [];
  server.on('connection', (socket) =>
    socket.on('message', (raw) => {
      const m = JSON.parse(raw.toString());
      requests.push(m);
      let result: any = {};
      if (m.method === 'Target.getTargets')
        result = {
          targetInfos: [
            target,
            {
              ...target,
              targetId: 'other',
              url: 'https://servicewechat.com/wx_other/1/page-frame.html',
            },
          ],
        };
      if (m.method === 'Target.attachToTarget') result = { sessionId: `session-${++session}` };
      if (m.method === 'Target.detachFromTarget') detached.push(m.params.sessionId);
      if (m.method === 'Runtime.evaluate')
        result = { result: { value: { url: target.url, title: target.title } } };
      if (m.method === 'waitForever') return;
      // Model the upstream broadcast transport.
      for (const client of server.clients)
        client.send(JSON.stringify({ id: m.id, result, sessionId: m.sessionId }));
    }),
  );
  return {
    server,
    target,
    detached,
    requests,
    endpoint: `ws://127.0.0.1:${(server.address() as any).port}`,
    async stop() {
      for (const client of server.clients) client.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

test('loopback validation rejects remote endpoints and credentials', () => {
  assert.throws(() => loopbackEndpoint('ws://example.com'));
  assert.throws(() => loopbackEndpoint('ws://x:y@127.0.0.1'));
  assert.throws(() => loopbackEndpoint('file:///tmp/cdp'));
});
test('DevTools URL preserves a WebSocket target path and query', () => {
  const url = new URL(devtoolsUrl('ws://127.0.0.1:62000/devtools/page/abc?x=1&y=2'));
  assert.equal(url.protocol, 'devtools:');
  assert.equal(url.searchParams.get('ws'), '127.0.0.1:62000/devtools/page/abc?x=1&y=2');
  assert.throws(() => devtoolsUrl('ws://remote.example:62000'));
});
test('target filtering uses exact AppID path component', async () => {
  const b = await backend();
  try {
    assert.equal((await listTargets(b.endpoint, 'wx_test')).length, 1);
    assert.equal((await listTargets(b.endpoint, 'wx')).length, 0);
  } finally {
    await b.stop();
  }
});
test('CDP rejects pending requests on disconnect and enforces timeout', async () => {
  const b = await backend();
  const c = new Cdp(b.endpoint, 50);
  try {
    await assert.rejects(c.send('waitForever'), /timeout/);
    const pending = c.send('waitForever');
    c.close();
    await assert.rejects(pending, /disconnected/);
  } finally {
    c.close();
    await b.stop();
  }
});
test('adapter isolates sessions and does not enable global auto-attach', async () => {
  const b = await backend();
  const adapter = await createAdapter(b.endpoint, b.target);
  const a = new Cdp(adapter.endpoint),
    c = new Cdp(adapter.endpoint);
  try {
    const [sa, sc] = await Promise.all([
      a.send('Target.attachToTarget', { targetId: b.target.targetId }),
      c.send('Target.attachToTarget', { targetId: b.target.targetId }),
    ]);
    assert.notEqual(sa.sessionId, sc.sessionId);
    await assert.rejects(a.send('Runtime.evaluate', {}, sc.sessionId), /Unknown session/);
    await assert.rejects(a.send('Target.attachToTarget', { targetId: 'other' }), /outside/);
    await assert.rejects(a.send('Browser.close'), /not supported/);
    const receivedA: any[] = [],
      receivedC: any[] = [];
    a.on('event', (m) => receivedA.push(m));
    c.on('event', (m) => receivedC.push(m));
    for (const client of b.server.clients)
      client.send(
        JSON.stringify({
          method: 'Debugger.scriptParsed',
          params: { scriptId: 'only-a' },
          sessionId: sa.sessionId,
        }),
      );
    // A request round-trip ensures event delivery before assertion.
    await c.send('Target.getBrowserContexts');
    await a.send('Runtime.evaluate', {}, sa.sessionId);
    assert.equal(receivedA.filter((m) => m.method === 'Debugger.scriptParsed').length, 1);
    assert.equal(receivedC.filter((m) => m.method === 'Debugger.scriptParsed').length, 0);
    await a.send('Target.setAutoAttach', { autoAttach: true });
    assert.equal(
      b.requests.some((m) => m.method === 'Target.setAutoAttach'),
      false,
    );
  } finally {
    a.close();
    c.close();
    await adapter.stop();
    await b.stop();
  }
  assert.ok(b.detached.length >= 2);
});
test('explicit external service stays alive after extension stop', async () => {
  const b = await backend();
  const m = new RuntimeManager();
  try {
    const s: any = await m.start({ endpoint: b.endpoint });
    assert.equal(s.owned, false);
    assert.equal(((await m.start({ endpoint: b.endpoint })) as any).serviceId, s.serviceId);
    await assert.rejects(m.start({ endpoint: 'ws://127.0.0.1:1' }), /Stop/);
    await assert.rejects(m.stop('wrong'), /Unknown/);
    await m.stop(s.serviceId);
    await m.stop(s.serviceId);
    await m.stop();
    assert.ok((await listTargets(b.endpoint)).length);
  } finally {
    await m.stop();
    await b.stop();
  }
});
test('attach failure releases adapter; successful attach verifies before invoking tools', async () => {
  const b = await backend();
  const m = new RuntimeManager();
  const calls: string[] = [];
  try {
    const s: any = await m.start({ endpoint: b.endpoint });
    const result = await m.attach(s.serviceId, { appId: 'wx_test' }, async (name) => {
      calls.push(name);
      return {
        content: [
          { type: 'text', text: JSON.stringify({ success: true, result: { url: b.target.url } }) },
        ],
      };
    });
    assert.equal(result.target.targetId, b.target.targetId);
    assert.deepEqual(calls, [
      'browser_attach',
      'browser_attach_cdp_target',
      'browser_evaluate_cdp_target',
    ]);
    await assert.rejects(
      m.attach(s.serviceId, { appId: 'wx_test' }, async () => ({
        content: [{ type: 'text', text: '{"success":true,"result":{"url":"wrong"}}' }],
      })),
      /different target/,
    );
    await assert.rejects(
      m.attach(s.serviceId, { appId: 'wx_test' }, async () => ({ isError: true })),
      /tool failed/,
    );
  } finally {
    await m.stop();
    await b.stop();
  }
});

async function fakeProcess(code: string) {
  const root = await mkdtemp(join(tmpdir(), 'wmpf-test-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'node_modules/ts-node/dist'), { recursive: true });
  await writeFile(join(root, 'src/index.ts'), '// wmpf_shutdown');
  await writeFile(join(root, 'node_modules/ts-node/dist/bin.js'), code);
  return root;
}
test('managed process acknowledges startup and shuts down via IPC', async () => {
  const root = await fakeProcess(
    `process.send({type:'wmpf',state:'runtime_attached'});process.on('message',m=>{if(m.type==='wmpf_shutdown')process.exit(0)});`,
  );
  const m = new RuntimeManager();
  try {
    const s: any = await m.start({ backendPath: root });
    assert.equal(s.state, 'awaiting_target');
    assert.equal(s.owned, true);
    await m.stop(s.serviceId);
    assert.equal((await m.status()).state, 'stopped');
  } finally {
    await m.stop();
    await rm(root, { recursive: true, force: true });
  }
});
test('startup timeout terminates only the owned child and permits retry', async () => {
  const root = await fakeProcess(
    `process.on('message',m=>{if(m.type==='wmpf_shutdown')process.exit(0)});`,
  );
  const m = new RuntimeManager();
  try {
    await assert.rejects(m.start({ backendPath: root, timeoutMs: 100 }), /timed out/);
    assert.equal((await m.status()).pid, undefined);
    await assert.rejects(m.start({ backendPath: root, timeoutMs: 100 }), /timed out/);
  } finally {
    await m.stop();
    await rm(root, { recursive: true, force: true });
  }
});
const invokePlugin = async (name: string, args: Record<string, unknown>) => {
  const result = await plugin.tools.find((t) => t.name === name)!.handler(args, {} as any);
  return JSON.parse((result.content![0] as any).text);
};
test('plugin guides the agent to open Chrome and deactivation releases its service', async () => {
  const b = await backend();
  try {
    assert.equal(plugin.tools.length, 7);
    const started = await invokePlugin('wmpf_start', { endpoint: b.endpoint });
    assert.equal(started.nextActions[0].action, 'user_open_miniapp_and_devtools');
    assert.ok(started.nextActions[0].url.startsWith('devtools://'));
    await plugin.onDeactivateHandler?.({} as any);
    assert.equal((await invokePlugin('wmpf_status', {})).state, 'stopped');
    assert.ok((await listTargets(b.endpoint)).length);
  } finally {
    await plugin.onDeactivateHandler?.({} as any);
    await b.stop();
  }
});

test('installer requires authorization without changing environment', async () => {
  const result = await invokePlugin('wmpf_install', {});
  assert.equal(result.state, 'approval_required');
});
