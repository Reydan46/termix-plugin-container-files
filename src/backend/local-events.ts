import type { Transfer } from "./transfers.js";

export interface LocalEvent {
  type: string;
  [key: string]: unknown;
}

const PROGRESS_INTERVAL_MS = 150;

/** Pushes events to the sockets a user has open on /local-events. */
export class LocalEvents {
  private sinks = new Map<string, Set<(event: LocalEvent) => void>>();

  subscribe(userId: string, send: (event: LocalEvent) => void): () => void {
    let set = this.sinks.get(userId);
    if (!set) this.sinks.set(userId, (set = new Set()));
    set.add(send);
    return () => {
      set.delete(send);
      if (set.size === 0) this.sinks.delete(userId);
    };
  }

  publish(userId: string, event: LocalEvent): void {
    for (const send of this.sinks.get(userId) ?? []) {
      try {
        send(event);
      } catch {
        // A dead socket must not break the transfer.
      }
    }
  }

  clear(): void {
    this.sinks.clear();
  }

  /**
   * Publishes `progress` events for a transfer, at most every 150 ms and only
   * when the byte count moved. The returned stop() sends the final one.
   */
  trackProgress(transfer: Transfer): () => void {
    let last = -1;
    const emit = () => {
      if (transfer.bytes === last) return;
      last = transfer.bytes;
      this.publish(transfer.userId, {
        type: "progress",
        transferId: transfer.id,
        transferred: transfer.total
          ? Math.min(transfer.bytes, transfer.total)
          : transfer.bytes,
        ...(transfer.total ? { total: transfer.total } : {}),
      });
    };
    const timer = setInterval(emit, PROGRESS_INTERVAL_MS);
    timer.unref?.();
    return () => {
      clearInterval(timer);
      emit();
    };
  }
}
