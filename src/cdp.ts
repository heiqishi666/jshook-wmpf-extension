import { EventEmitter } from 'node:events';
import { randomInt } from 'node:crypto';
import { WebSocket } from 'ws';

let sequence = randomInt(1_000_000_000, 1_500_000_000);
export type Message = {
  id?: number;
  method?: string;
  params?: any;
  sessionId?: string;
  result?: any;
  error?: { message: string; code?: number };
};
export function loopbackEndpoint(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'ws:' ||
    !['127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.username ||
    url.password
  ) {
    throw new Error('Only literal loopback ws:// endpoints are supported');
  }
  return url.toString();
}

export class Cdp extends EventEmitter {
  private pending = new Map<
    number,
    { resolve: (value: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }
  >();
  private socket: WebSocket;
  readonly ready: Promise<void>;
  constructor(
    endpoint: string,
    readonly timeoutMs = 5000,
  ) {
    super();
    this.socket = new WebSocket(loopbackEndpoint(endpoint));
    this.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error('CDP connect timeout'));
        this.close();
      }, timeoutMs);
      this.socket.once('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.socket.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      this.socket.once('close', () => {
        clearTimeout(timer);
        reject(new Error('CDP closed before ready'));
      });
    });
    this.socket.on('error', () => {});
    this.socket.on('close', () => {
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error('CDP disconnected'));
      }
      this.pending.clear();
      this.emit('disconnected');
    });
    this.socket.on('message', (raw) => {
      let message: Message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (message.id !== undefined) {
        const p = this.pending.get(message.id);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(message.id);
        if (message.error) p.reject(new Error(message.error.message));
        else p.resolve(message.result);
      } else this.emit('event', message);
    });
  }
  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<any> {
    await this.ready;
    if (this.socket.readyState !== WebSocket.OPEN) throw new Error('CDP disconnected');
    return new Promise((resolve, reject) => {
      const id = ++sequence;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  close() {
    this.socket.terminate();
  }
}

export type Target = {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached?: boolean;
};
export async function listTargets(endpoint: string, appId?: string): Promise<Target[]> {
  const cdp = new Cdp(endpoint);
  try {
    const result = await cdp.send('Target.getTargets');
    return (result.targetInfos as Target[]).filter((t) => {
      try {
        const url = new URL(t.url);
        return (
          url.hostname === 'servicewechat.com' && (!appId || url.pathname.split('/')[1] === appId)
        );
      } catch {
        return false;
      }
    });
  } finally {
    cdp.close();
  }
}

export async function verifyTarget(endpoint: string, targetId: string) {
  const cdp = new Cdp(endpoint);
  let session: string | undefined;
  try {
    session = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    if (!session) throw new Error('Target attach returned no session');
    const result = await cdp.send(
      'Runtime.evaluate',
      {
        expression:
          '({url:typeof location==="undefined"?"":location.href,title:typeof document==="undefined"?"":document.title})',
        returnByValue: true,
      },
      session,
    );
    if (result.exceptionDetails || !result.result?.value)
      throw new Error('Target context cannot be read');
    return result.result.value;
  } finally {
    if (session) await cdp.send('Target.detachFromTarget', { sessionId: session }).catch(() => {});
    cdp.close();
  }
}
