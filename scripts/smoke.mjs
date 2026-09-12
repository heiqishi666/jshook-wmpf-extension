// Starts a separate MCP process; no changes to the user's running MCP configuration.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { readFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
if (!process.env.JSHOOK_CORE_ROOT) throw new Error('Set JSHOOK_CORE_ROOT to a built jshook checkout for this optional smoke test');
const root = resolve(process.env.JSHOOK_CORE_ROOT);
const plugin = resolve('.');
mkdirSync('logs', { recursive: true });
const log = createWriteStream('logs/mcp-smoke.log');
const env = Object.fromEntries(
  ['PATH', 'SystemRoot', 'SYSTEMROOT', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'USERPROFILE']
    .filter((k) => process.env[k])
    .map((k) => [k, process.env[k]]),
);
Object.assign(env, {
  MCP_TRANSPORT: 'stdio',
  MCP_TOOL_PROFILE: 'full',
  MCP_PLUGIN_ROOTS: plugin,
  MCP_WORKFLOW_ROOTS: resolve('logs/no-workflows'),
  MCP_PLUGIN_STRICT_LOAD: 'true',
  MCP_PLUGIN_ALLOWED_DIGESTS: createHash('sha256')
    .update(readFileSync('dist/manifest.js'))
    .digest('hex'),
  NODE_ENV: 'development',
});
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [resolve(root, 'dist/index.mjs')],
  cwd: plugin,
  env,
  stderr: 'pipe',
});
transport.stderr?.pipe(log);
const client = new Client({ name: 'wmpf-extension-smoke', version: '0.1.0' });
let serviceId;
let breakpointId;
let debuggerEnabled = false;
let networkEnabled = false;
const parse = (result) => {
  if (result.isError) throw Error(JSON.stringify(result));
  const text = result.content?.find((x) => x.type === 'text')?.text;
  const data = text ? JSON.parse(text) : result;
  if (data.success === false) throw Error(JSON.stringify(data));
  return data;
};
const call = async (name, args = {}) =>
  parse(await client.callTool({ name, arguments: args }, undefined, { timeout: 30000 }));
try {
  await client.connect(transport);
  const loaded = await call('reload_extensions');
  console.log(
    'LOAD',
    JSON.stringify({
      errors: loaded.errors,
      plugins: loaded.plugins,
      tools: loaded.tools?.filter((t) => t.name.startsWith('wmpf_')),
    }),
  );
  console.log('STATUS', JSON.stringify(await call('wmpf_status')));
  if (process.env.WMPF_SMOKE_ENDPOINT || process.env.WMPF_SMOKE_BACKEND) {
    if (process.env.WMPF_SMOKE_OPEN === '1')
      console.log(
        'DEVTOOLS',
        JSON.stringify(
          await call('wmpf_open_devtools', { endpoint: process.env.WMPF_SMOKE_ENDPOINT }),
        ),
      );
    const started = await call(
      'wmpf_start',
      process.env.WMPF_SMOKE_BACKEND
        ? { backendPath: process.env.WMPF_SMOKE_BACKEND, debugFrida: true }
        : { endpoint: process.env.WMPF_SMOKE_ENDPOINT },
    );
    console.log('START', JSON.stringify(started));
    console.log('USER_NEXT_ACTION', JSON.stringify(started.nextActions));
    serviceId = started.serviceId;
    if (process.env.WMPF_SMOKE_WAIT === '1') {
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 10000));
        const status = await call('wmpf_status');
        console.log('WAIT', JSON.stringify(status));
        if (status.state === 'target_ready') break;
      }
    }
    const listed = await call('wmpf_list_targets', {
      serviceId,
      ...(process.env.WMPF_SMOKE_APPID ? { appId: process.env.WMPF_SMOKE_APPID } : {}),
    });
    console.log('TARGETS', JSON.stringify(listed));
    const pages = listed.targets.filter((t) => t.type === 'page');
    if (pages.length === 1) {
      const attached = await call('wmpf_attach', { serviceId, targetId: pages[0].targetId });
      console.log('ATTACH', JSON.stringify(attached));
      const scripts = await call('get_all_scripts', { includeSource: false });
      console.log(
        'SCRIPTS',
        JSON.stringify({
          count: scripts.count,
          businessScripts: scripts.scripts?.filter((s) => s.url.startsWith('https://usr/')).length,
        }),
      );
      if (!scripts.count) throw Error('No scripts in selected context');
      await call('debugger_lifecycle', { action: 'enable' });
      debuggerEnabled = true;
      const bp = await call('breakpoint', {
        action: 'set',
        type: 'code',
        url: 'wmpf-extension-smoke.js',
        lineNumber: 2,
      });
      console.log('BREAKPOINT', JSON.stringify(bp));
      breakpointId = bp.breakpointId ?? bp.breakpoint?.breakpointId ?? bp.breakpoint?.id;
      await call('browser_evaluate_cdp_target', {
        code: 'setTimeout(function wmpfExtensionSmoke(){\nconst marker="offline-smoke";\nreturn marker.length;\n},20);\n//# sourceURL=wmpf-extension-smoke.js',
        returnByValue: true,
      });
      const paused = await call('debugger_wait_for_paused', { timeout: 3000 });
      console.log('PAUSED', JSON.stringify(paused).slice(0, 700));
      console.log(
        'FRAME',
        JSON.stringify(await call('debugger_evaluate', { context: 'frame', expression: 'marker' })),
      );
      if (breakpointId) {
        await call('breakpoint', { action: 'remove', breakpointId });
        breakpointId = undefined;
      }
      await call('debugger_resume');
      await call('network_enable');
      networkEnabled = true;
      const requests = await call('network_get_requests', {
        limit: 1,
        fields: ['requestId', 'method'],
        autoEnable: false,
      });
      console.log('NETWORK', JSON.stringify(requests));
    }
  }
} catch (e) {
  console.error(String(e));
  process.exitCode = 1;
} finally {
  if (breakpointId) await call('breakpoint', { action: 'remove', breakpointId }).catch(() => {});
  if (debuggerEnabled) {
    await call('debugger_resume').catch(() => {});
    await call('debugger_lifecycle', { action: 'disable' }).catch(() => {});
  }
  if (networkEnabled) await call('network_disable').catch(() => {});
  if (serviceId) await call('wmpf_stop', { serviceId }).catch((e) => console.error(String(e)));
  await client.close();
  log.end();
}
