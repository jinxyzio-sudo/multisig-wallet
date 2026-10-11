import { DurableObject } from 'cloudflare:workers';
import { handle, type SessionStore, type Stored } from './handler.js';

interface Env {
  SESSIONS: DurableObjectNamespace<SessionObject>;
}

/** One Durable Object per session id, so reads after writes are strongly consistent. */
export class SessionObject extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const storage = this.ctx.storage;
    const store: SessionStore = {
      get: <T>(key: string) => storage.get<Stored<T>>(key),
      put: async <T>(key: string, value: Stored<T>) => {
        await storage.put(key, value);
        const alarm = await storage.getAlarm();
        if (alarm === null || alarm > value.expiresAt) await storage.setAlarm(value.expiresAt);
      },
      delete: async (key: string) => {
        await storage.delete(key);
      },
    };
    return handle(request, store);
  }

  async alarm(): Promise<void> {
    await this.ctx.storage.deleteAll();
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const match = /^\/v1\/session\/([0-9a-f]{32})(\/phone)?$/.exec(new URL(request.url).pathname);
    if (!match?.[1]) return handle(request, { get: async () => undefined, put: async () => {}, delete: async () => {} });
    return env.SESSIONS.get(env.SESSIONS.idFromName(match[1])).fetch(request);
  },
} satisfies ExportedHandler<Env>;
