// Runs transfers one after another so that several drops do not fight for the
// same SSH connection. Each job gets an AbortSignal; cancelling aborts the
// running job and drops the waiting ones.

export type TransferJob = (signal: AbortSignal) => Promise<void>;

interface Waiting {
  job: TransferJob;
  resolve: () => void;
}

export class TransferQueue {
  private waiting: Waiting[] = [];
  private current: AbortController | null = null;
  private busy = false;
  private listeners = new Set<() => void>();

  /** Jobs running or waiting. */
  get size(): number {
    return this.waiting.length + (this.busy ? 1 : 0);
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Resolves when the job finished or was dropped; never rejects. */
  enqueue(job: TransferJob): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiting.push({ job, resolve });
      this.notify();
      void this.pump();
    });
  }

  /** Aborts the running job and drops everything waiting. */
  cancelAll(): void {
    const dropped = this.waiting;
    this.waiting = [];
    for (const w of dropped) w.resolve();
    this.current?.abort();
    this.notify();
  }

  private notify() {
    for (const l of this.listeners) l();
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      for (let next = this.waiting.shift(); next; next = this.waiting.shift()) {
        const controller = new AbortController();
        this.current = controller;
        try {
          await next.job(controller.signal);
        } catch {
          // jobs report their own errors
        } finally {
          this.current = null;
          next.resolve();
          this.notify();
        }
      }
    } finally {
      this.busy = false;
      this.notify();
    }
  }
}
