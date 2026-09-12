import { WebSocket, WebSocketServer } from 'ws';
import { Cdp, type Message, type Target } from './cdp.js';

// Only control-plane metadata is synthetic; target sessions and values stay real.
export async function createAdapter(
  endpoint: string,
  target: Target,
  onTargetLost: () => void = () => {},
) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const disposers = new Set<() => Promise<void>>();
  server.on('connection', (client) => {
    const cdp = new Cdp(endpoint);
    const sessions = new Set<string>();
    const browserId = 'wmpf-browser',
      browserSession = 'wmpf-browser-session';
    const browser = {
      targetId: browserId,
      type: 'browser',
      title: 'WMPF',
      url: '',
      attached: true,
    };
    const send = (m: Message) => {
      if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(m));
    };
    let disposing: Promise<void> | undefined;
    const dispose = () =>
      (disposing ??= (async () => {
        await Promise.all(
          [...sessions].map((sessionId) =>
            cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {}),
          ),
        );
        sessions.clear();
        cdp.close();
        client.terminate();
        disposers.delete(dispose);
      })());
    disposers.add(dispose);
    client.on('close', () => void dispose());
    client.on('error', () => void dispose());
    cdp.ready.catch(() => void dispose());
    cdp.on('disconnected', () => {
      if (!disposing) onTargetLost();
      client.close();
    });
    cdp.on('event', (m: Message) => {
      // Broadcast attach events may belong to Chrome; use only our request replies.
      if (m.method === 'Target.attachedToTarget') return;
      if (m.sessionId && !sessions.has(m.sessionId)) return;
      if (m.method === 'Target.detachedFromTarget') {
        if (!sessions.has(m.params?.sessionId)) return;
        sessions.delete(m.params.sessionId);
      }
      const eventTarget = m.params?.targetInfo?.targetId ?? m.params?.targetId;
      if (eventTarget && eventTarget !== target.targetId) return;
      if (m.method === 'Target.targetDestroyed' && eventTarget === target.targetId) onTargetLost();
      // Root runtime events cannot be attributed to this client.
      if (!m.sessionId && !m.method?.startsWith('Target.')) return;
      send(m);
    });
    client.on('message', async (raw) => {
      let request: Message;
      try {
        request = JSON.parse(raw.toString());
      } catch {
        return;
      }
      const { id, method, params = {}, sessionId } = request;
      if (id === undefined || !method) return;
      try {
        let result: any;
        if (
          [
            'Browser.close',
            'Target.createTarget',
            'Target.createBrowserContext',
            'Target.disposeBrowserContext',
          ].includes(method)
        )
          throw new Error('Host browser mutation is not supported');
        if (method === 'Target.getBrowserContexts') result = { browserContextIds: [] };
        else if (method === 'Target.getTargets') result = { targetInfos: [target] };
        else if (method === 'Target.attachToTarget' && params.targetId === browserId) {
          send({
            method: 'Target.attachedToTarget',
            params: { sessionId: browserSession, targetInfo: browser, waitingForDebugger: false },
          });
          result = { sessionId: browserSession };
        } else if (method === 'Target.detachFromTarget' && params.sessionId === browserSession)
          result = {};
        else if (method === 'Target.setDiscoverTargets') {
          result = {};
          if (params.discover)
            for (const targetInfo of [browser, target])
              send({ method: 'Target.targetCreated', params: { targetInfo } });
        } else if (method === 'Target.setAutoAttach') {
          // Do not enable global auto-attach across unrelated miniapps.
          result = {};
          if (params.autoAttach && !sessions.size) {
            const attached = await cdp.send('Target.attachToTarget', {
              targetId: target.targetId,
              flatten: true,
            });
            sessions.add(attached.sessionId);
            send({
              method: 'Target.attachedToTarget',
              sessionId,
              params: {
                sessionId: attached.sessionId,
                targetInfo: target,
                waitingForDebugger: false,
              },
            });
          }
        } else {
          if (params.targetId && params.targetId !== target.targetId)
            throw new Error('Target outside selected miniapp');
          if (sessionId && sessionId !== browserSession && !sessions.has(sessionId))
            throw new Error('Unknown session');
          if (method === 'Target.detachFromTarget' && !sessions.has(params.sessionId))
            throw new Error('Session not owned');
          result = await cdp.send(
            method,
            params,
            sessionId === browserSession ? undefined : sessionId,
          );
          if (method === 'Target.attachToTarget') {
            sessions.add(result.sessionId);
            send({
              method: 'Target.attachedToTarget',
              sessionId,
              params: {
                sessionId: result.sessionId,
                targetInfo: target,
                waitingForDebugger: false,
              },
            });
          }
          if (method === 'Target.detachFromTarget') sessions.delete(params.sessionId);
        }
        send({ id, result, ...(sessionId ? { sessionId } : {}) });
      } catch (error) {
        send({ id, sessionId, error: { code: -32000, message: String(error) } });
      }
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Adapter failed to listen');
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    async stop() {
      await Promise.all([...disposers].map((fn) => fn()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
