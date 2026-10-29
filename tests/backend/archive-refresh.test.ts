import { describe, expect, it, vi } from "vitest";
import {
  notifyArchiveChanged,
  subscribeArchiveChanged,
} from "../../src/frontend/archiveRefresh";

describe("archive refresh registry", () => {
  it("notifies every window of the archive and reports how many", () => {
    const a = vi.fn();
    const b = vi.fn();
    const off1 = subscribeArchiveChanged("c1", "/data/a.zip", a);
    const off2 = subscribeArchiveChanged("c1", "/data/a.zip", b);
    expect(notifyArchiveChanged("c1", "/data/a.zip")).toBe(2);
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
    off1();
    off2();
  });
  it("leaves other archives and other containers alone", () => {
    const other = vi.fn();
    const otherContainer = vi.fn();
    const offA = subscribeArchiveChanged("c1", "/data/b.zip", other);
    const offB = subscribeArchiveChanged("c2", "/data/a.zip", otherContainer);
    expect(notifyArchiveChanged("c1", "/data/a.zip")).toBe(0);
    expect(other).not.toHaveBeenCalled();
    expect(otherContainer).not.toHaveBeenCalled();
    offA();
    offB();
  });
  it("stops notifying after unsubscribe", () => {
    const fn = vi.fn();
    const off = subscribeArchiveChanged("c1", "/x.zip", fn);
    off();
    off();
    expect(notifyArchiveChanged("c1", "/x.zip")).toBe(0);
    expect(fn).not.toHaveBeenCalled();
  });
  it("copes with a listener that unsubscribes while being called", () => {
    const calls: string[] = [];
    let offFirst = () => undefined as void;
    offFirst = subscribeArchiveChanged("c1", "/y.zip", () => {
      calls.push("first");
      offFirst();
    });
    const offSecond = subscribeArchiveChanged("c1", "/y.zip", () =>
      calls.push("second"),
    );
    expect(notifyArchiveChanged("c1", "/y.zip")).toBe(2);
    expect(calls).toEqual(["first", "second"]);
    expect(notifyArchiveChanged("c1", "/y.zip")).toBe(1);
    offSecond();
  });
});
