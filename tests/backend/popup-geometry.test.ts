import { describe, expect, it } from "vitest";
import {
  POINTER_FRESH_MS,
  POINTER_OFFSET,
  POPUP_MARGIN,
  chooseAnchor,
  placePopup,
  pointerAnchor,
  type Box,
} from "../../src/frontend/popup/popupGeometry";
import { isOrphaned } from "../../src/frontend/popup/popupFamily";
import {
  defaultArchiveName,
  finalArchiveName,
} from "../../src/frontend/compressHelpers";

const container: Box = { left: 100, top: 50, width: 1000, height: 600 };
const size = { width: 560, height: 300 };

describe("placePopup", () => {
  it("opens near the pointer, relative to the container", () => {
    const p = placePopup({ kind: "point", x: 300, y: 200 }, size, container);
    expect(p).toEqual({
      x: 200 + POINTER_OFFSET,
      y: 150 + POINTER_OFFSET,
      width: 560,
      height: 300,
    });
  });

  it("keeps a popup near the right and bottom edge inside", () => {
    const p = placePopup({ kind: "point", x: 1090, y: 640 }, size, container);
    expect(p.x).toBe(container.width - size.width - POPUP_MARGIN);
    expect(p.y).toBe(container.height - size.height - POPUP_MARGIN);
  });

  it("keeps a popup near the top-left corner inside", () => {
    const p = placePopup({ kind: "point", x: 0, y: 0 }, size, container);
    expect(p.x).toBe(POPUP_MARGIN);
    expect(p.y).toBe(POPUP_MARGIN);
  });

  it("centers in the pane when there is no pointer", () => {
    const pane: Box = { left: 100, top: 50, width: 400, height: 600 };
    const p = placePopup(
      { kind: "center", rect: pane },
      { width: 300, height: 200 },
      container,
    );
    expect(p).toEqual({ x: 50, y: 200, width: 300, height: 200 });
  });

  it("centers in the container without any anchor", () => {
    const p = placePopup(null, { width: 500, height: 100 }, container);
    expect(p).toEqual({ x: 250, y: 250, width: 500, height: 100 });
  });

  it("opens over a parent at its top-left corner", () => {
    const parent: Box = { left: 300, top: 150, width: 560, height: 300 };
    const p = placePopup({ kind: "over", rect: parent }, size, container);
    expect(p.x).toBe(200);
    expect(p.y).toBe(100);
  });

  it("shrinks a popup larger than the container", () => {
    const small: Box = { left: 0, top: 0, width: 300, height: 200 };
    const p = placePopup(null, { width: 560, height: 400 }, small);
    expect(p).toEqual({
      x: POPUP_MARGIN,
      y: POPUP_MARGIN,
      width: 300 - 2 * POPUP_MARGIN,
      height: 200 - 2 * POPUP_MARGIN,
    });
  });
});

describe("pointer and anchor choice", () => {
  const pointer = { x: 10, y: 20, at: 1000 };
  const pane: Box = { left: 0, top: 0, width: 100, height: 100 };

  it("uses a fresh pointer and ignores a stale one", () => {
    expect(pointerAnchor(pointer, 1000 + POINTER_FRESH_MS)).toEqual({
      kind: "point",
      x: 10,
      y: 20,
    });
    expect(pointerAnchor(pointer, 1001 + POINTER_FRESH_MS)).toBeNull();
    expect(pointerAnchor(null, 0)).toBeNull();
  });

  it("prefers the parent, then the pane, then a fresh pointer", () => {
    const parent: Box = { left: 5, top: 5, width: 50, height: 50 };
    expect(
      chooseAnchor({ parentRect: parent, pointer, now: 1500, paneRect: pane }),
    ).toEqual({ kind: "over", rect: parent });
    expect(
      chooseAnchor({ parentRect: null, pointer, now: 1500, paneRect: pane }),
    ).toEqual({ kind: "center", rect: pane });
    expect(
      chooseAnchor({ parentRect: null, pointer, now: 1500, paneRect: null }),
    ).toEqual({ kind: "point", x: 10, y: 20 });
    expect(
      chooseAnchor({ parentRect: null, pointer, now: 99999, paneRect: null }),
    ).toBeNull();
    expect(
      chooseAnchor({ parentRect: null, pointer: null, now: 0, paneRect: null }),
    ).toBeNull();
  });
});

describe("popup family", () => {
  it("is orphaned only once its parent is gone", () => {
    expect(isOrphaned(undefined, [])).toBe(false);
    expect(isOrphaned("window-1", ["window-1", "window-2"])).toBe(false);
    expect(isOrphaned("window-1", ["window-2"])).toBe(true);
  });
});

describe("compress helpers", () => {
  it("suggests a name from a single file or a generic one", () => {
    expect(defaultArchiveName(["notes.txt"])).toBe("notes");
    expect(defaultArchiveName(["a", "b"])).toBe("archive");
  });

  it("appends the extension unless already present", () => {
    expect(finalArchiveName(" data ", "zip")).toBe("data.zip");
    expect(finalArchiveName("data.tar.gz", "tar.gz")).toBe("data.tar.gz");
    expect(finalArchiveName("data", "tar")).toBe("data.tar");
    expect(finalArchiveName("  ", "zip")).toBe("");
  });
});
