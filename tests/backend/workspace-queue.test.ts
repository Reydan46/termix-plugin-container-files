import { describe, expect, it } from "vitest";
import { TransferQueue } from "../../src/frontend/workspace/transferQueue";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

describe("TransferQueue", () => {
  it("runs jobs one at a time in order", async () => {
    const q = new TransferQueue();
    const log: string[] = [];
    const gate = deferred();
    const a = q.enqueue(async () => {
      log.push("a start");
      await gate.promise;
      log.push("a end");
    });
    const b = q.enqueue(async () => {
      log.push("b");
    });
    await Promise.resolve();
    expect(log).toEqual(["a start"]);
    expect(q.size).toBe(2);
    gate.resolve();
    await Promise.all([a, b]);
    expect(log).toEqual(["a start", "a end", "b"]);
    expect(q.size).toBe(0);
  });

  it("does not reject when a job throws and continues", async () => {
    const q = new TransferQueue();
    let ran = false;
    await q.enqueue(async () => {
      throw new Error("x");
    });
    await q.enqueue(async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  it("cancelAll aborts the running job and drops waiting ones", async () => {
    const q = new TransferQueue();
    let aborted = false;
    let secondRan = false;
    const first = q.enqueue(
      (signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => {
            aborted = true;
            resolve();
          }),
        ),
    );
    const second = q.enqueue(async () => {
      secondRan = true;
    });
    await Promise.resolve();
    q.cancelAll();
    await Promise.all([first, second]);
    expect(aborted).toBe(true);
    expect(secondRan).toBe(false);
  });

  it("notifies subscribers", async () => {
    const q = new TransferQueue();
    let calls = 0;
    const off = q.subscribe(() => calls++);
    await q.enqueue(async () => {});
    expect(calls).toBeGreaterThan(0);
    off();
  });
});
