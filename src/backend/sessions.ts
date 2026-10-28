import type { Client } from "ssh2";
import type { PluginSchedule } from "@termix-ssh/plugin-sdk/backend";
import type { ContainerRuntime } from "./shell-quote.js";
import type { Logger } from "./helpers.js";
import type { Capabilities } from "./capabilities.js";
import type { ContainerState } from "./containers.js";

const SESSION_IDLE_MS = 60 * 60 * 1000;
const PENDING_SWEEP_MS = 60 * 1000;

/** A live SSH connection behind the plugin tab, owned by one user. */
export interface ContainerSession {
  id: string;
  client: Client;
  dispose: () => void;
  hostId: number;
  userId: string;
  runtime: ContainerRuntime;
  /** Engine version shown in the header; null when unknown. */
  runtimeVersion: string | null;
  lastActive: number;
  activeOperations: number;
  cancelIdle?: () => void;
  /** Short-lived inspect results by container id. */
  states: Map<string, { at: number; state: ContainerState }>;
  /** Probe results by container id and running flag. */
  capabilities: Map<string, Capabilities>;
}

/** A connect still waiting on a person (TOTP, a browser sign-in). */
export interface PendingEntry {
  userId: string;
  hostId: number;
  expiresAt: number;
  /** Gives up: answers the open prompt with nothing. */
  cancel: () => void;
}

export interface Sessions {
  add: (session: ContainerSession) => void;
  /** The session when `userId` owns it. */
  get: (id: string, userId: string) => ContainerSession | undefined;
  close: (id: string) => void;
  touch: (session: ContainerSession) => void;
  /** Runs `fn` with the session marked busy, so idle cleanup waits. */
  run: <T>(session: ContainerSession, fn: () => Promise<T>) => Promise<T>;
  setPending: (id: string, entry: PendingEntry) => void;
  getPending: (id: string) => PendingEntry | undefined;
  clearPending: (id: string) => void;
  closeAll: () => void;
}

export function createSessions(
  schedule: PluginSchedule,
  log: Logger,
): Sessions {
  const sessions = new Map<string, ContainerSession>();
  const pending = new Map<string, PendingEntry>();

  const end = (session: ContainerSession) => {
    session.cancelIdle?.();
    sessions.delete(session.id);
    session.dispose();
  };

  const scheduleIdle = (session: ContainerSession) => {
    session.cancelIdle?.();
    session.cancelIdle = schedule.after(SESSION_IDLE_MS, () => {
      if (sessions.get(session.id) !== session) return;
      if (session.activeOperations > 0) {
        scheduleIdle(session);
        return;
      }
      log.info("Closing idle session", { hostId: session.hostId });
      end(session);
    });
  };

  schedule.every(PENDING_SWEEP_MS, () => {
    const now = Date.now();
    for (const [id, entry] of pending) {
      if (now < entry.expiresAt) continue;
      pending.delete(id);
      entry.cancel();
    }
  });

  return {
    add: (session) => {
      const existing = sessions.get(session.id);
      if (existing) end(existing);
      sessions.set(session.id, session);
      session.client.once("close", () => {
        if (sessions.get(session.id) === session) {
          session.cancelIdle?.();
          sessions.delete(session.id);
        }
      });
      scheduleIdle(session);
    },

    get: (id, userId) => {
      const session = sessions.get(id);
      return session && session.userId === userId ? session : undefined;
    },

    close: (id) => {
      const session = sessions.get(id);
      if (session) end(session);
      const entry = pending.get(id);
      if (entry) {
        pending.delete(id);
        entry.cancel();
      }
    },

    touch: (session) => {
      session.lastActive = Date.now();
      scheduleIdle(session);
    },

    run: async (session, fn) => {
      session.lastActive = Date.now();
      session.activeOperations++;
      try {
        return await fn();
      } finally {
        session.activeOperations--;
      }
    },

    setPending: (id, entry) => {
      const existing = pending.get(id);
      if (existing) existing.cancel();
      pending.set(id, entry);
    },

    getPending: (id) => pending.get(id),

    clearPending: (id) => {
      pending.delete(id);
    },

    closeAll: () => {
      for (const session of [...sessions.values()]) end(session);
      for (const entry of pending.values()) entry.cancel();
      pending.clear();
    },
  };
}
