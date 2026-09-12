import { environmentStatus, installBackend, installedBackend } from './src/installer.js';
import { createExtension, jsonResponse, errorResponse } from '@jshookmcp/extension-sdk/plugin';
import { RuntimeManager } from './src/runtime-manager.js';
import { openDevtools, devtoolsUrl } from './src/chrome.js';

const manager = new RuntimeManager();
const string = (description: string) => ({ type: 'string', description });
const requiredString = (args: Record<string, unknown>, key: string) => {
  if (typeof args[key] !== 'string' || !args[key]) throw new Error(`${key} is required`);
  return args[key] as string;
};
const run = async (name: string, fn: () => Promise<any>) => {
  try {
    return jsonResponse({ success: true, ...(await fn()) });
  } catch (e) {
    return errorResponse(name, e);
  }
};
export default createExtension('local.wmpf.bridge', '0.1.0')
  .compatibleCore('~0.3.5')
  .profile(['search', 'workflow', 'full'])
  .allowTool(['browser_attach', 'browser_attach_cdp_target', 'browser_evaluate_cdp_target'])
  .allowCommand('chrome.exe')
  .tool(
    'wmpf_install',
    'Install pinned WMPF in a private cache. First inspect wmpf_status. If setup is already authorized, pass authorized:true; otherwise explain download, native dependency install scripts and path, then ask. Client permissions always apply.',
    { authorized: { type: 'boolean', description: 'True only with user authorization for setup' } },
    (args) => run('wmpf_install', () => installBackend(args.authorized === true)),
  )
  .tool(
    'wmpf_open_devtools',
    'Optional: open Chrome only when the user explicitly requests automatic opening. By default ask the user to open the miniapp and then visit the supplied DevTools URL in Chrome.',
    {
      endpoint: string('Loopback CDP WebSocket URL'),
      chromePath: string('Optional installed chrome.exe path; normally auto-detected'),
    },
    (args) =>
      run('wmpf_open_devtools', () =>
        openDevtools(requiredString(args, 'endpoint'), args.chromePath as string | undefined),
      ),
  )
  .tool(
    'wmpf_status',
    'Inspect this extension service and optional backend dependencies without starting WeChat debugging.',
    { backendPath: string('Optional WMPFDebugger repository path') },
    (args) =>
      run('wmpf_status', async () => ({
        ...(await manager.status(args.backendPath as string | undefined)),
        environment: await environmentStatus(),
      })),
  )
  .tool(
    'wmpf_start',
    'Start a managed WMPF backend or explicitly connect an existing loopback CDP endpoint. Never stops external services.',
    {
      backendPath: string('Managed WMPFDebugger repository with dependencies installed'),
      endpoint: string('Explicit existing ws://127.0.0.1 endpoint; never owned'),
      cdpPort: { type: 'integer', minimum: 1, maximum: 65535 },
      debugPort: { type: 'integer', minimum: 1, maximum: 65535 },
      debugFrida: {
        type: 'boolean',
        description: 'Include hook diagnostics in status logs for managed backend',
      },
    },
    (args) =>
      run('wmpf_start', async () => {
        if (!args.backendPath && !args.endpoint) {
          const environment = await environmentStatus();
          if (environment.state !== 'ready')
            return {
              state: 'environment_required',
              environment,
              nextActions: environment.nextActions,
            };
        }
        const state: any = await manager.start({
          ...args,
          ...(!args.backendPath && !args.endpoint ? { backendPath: installedBackend() } : {}),
        });
        return {
          ...state,
          nextActions: [
            {
              action: 'user_open_miniapp_and_devtools',
              url: devtoolsUrl(state.endpoint!),
              reason:
                'Ask the user to open the miniapp, then visit this URL in Chrome. Keep the service running.',
            },
            {
              tool: 'wmpf_list_targets',
              args: { serviceId: state.serviceId },
              reason: 'Discover and verify the requested miniapp before attach.',
            },
          ],
        };
      }),
  )
  .tool(
    'wmpf_list_targets',
    'List miniapp targets by exact AppID. If empty, inspect backend readiness and ask the user to open the miniapp then visit the supplied DevTools URL in Chrome. Do not open Chrome automatically.',
    {
      serviceId: string('Service handle returned by start'),
      appId: string('Optional exact AppID'),
    },
    (args) =>
      run('wmpf_list_targets', async () => {
        const targets = await manager.targets(
          requiredString(args, 'serviceId'),
          args.appId as string | undefined,
        );
        const state = await manager.status();
        return {
          ...state,
          targets,
          nextActions: targets.length
            ? [
                {
                  tool: 'wmpf_attach',
                  reason:
                    'Select the requested miniapp identity and pass its exact targetId and serviceId.',
                },
              ]
            : [
                {
                  action: 'user_open_miniapp_and_devtools',
                  url: devtoolsUrl(state.endpoint!),
                  reason:
                    'Ask the user to open the miniapp and visit this URL in Chrome if not already done.',
                },
                {
                  action: 'await_miniapp',
                  reason:
                    'Chrome opening does not create a runtime target. Inspect backend readiness; request miniapp opening only if needed.',
                },
              ],
        };
      }),
  )
  .tool(
    'wmpf_attach',
    'Verify one miniapp and attach jshook through a loopback CDP adapter. Replaces the current jshook browser connection.',
    {
      serviceId: string('Service handle'),
      targetId: string('Exact target ID'),
      appId: string('Exact AppID, used only when one page matches'),
    },
    (args, ctx) =>
      run('wmpf_attach', () =>
        manager.attach(requiredString(args, 'serviceId'), args, (name, input) =>
          ctx.invokeTool(name, input),
        ),
      ),
  )
  .tool(
    'wmpf_stop',
    'Release owned sessions and stop only the backend created by this extension.',
    { serviceId: string('Service handle') },
    (args) => run('wmpf_stop', () => manager.stop(requiredString(args, 'serviceId'))),
  )
  .onDeactivate(async () => {
    await manager.stop();
  });
