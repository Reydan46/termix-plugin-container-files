import { describe, expect, it } from "vitest";
import { popupTitle } from "../../src/frontend/popup/popupTitle";

describe("popupTitle", () => {
  it("puts what the window is first, then the container, then extra", () => {
    expect(
      popupTitle({ what: "Archive", container: "web", extra: "a.tgz" }),
    ).toBe("Archive — web · a.tgz");
  });
  it("skips empty parts", () => {
    expect(popupTitle({ what: "Terminal", container: "web" })).toBe(
      "Terminal — web",
    );
    expect(popupTitle({ what: "Terminal", container: "", extra: "" })).toBe(
      "Terminal",
    );
  });
});
