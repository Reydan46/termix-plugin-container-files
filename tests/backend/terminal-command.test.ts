import { describe, expect, it } from "vitest";
import {
  isShellPath,
  isTerminalShell,
  pickShell,
} from "../../src/frontend/terminalCommand";

describe("terminal shell choice", () => {
  it("whitelists shell names and paths", () => {
    expect(isTerminalShell("zsh")).toBe(true);
    expect(isTerminalShell("auto")).toBe(true);
    expect(isTerminalShell("bash; id")).toBe(false);
    expect(isTerminalShell("python")).toBe(false);
    expect(isTerminalShell("/usr/local/bin/fish")).toBe(true);
  });

  it("rejects unsafe shell paths", () => {
    for (const bad of [
      "/bin/sh -c id",
      "/bin/sh;id",
      "/bin/'sh'",
      "/bin/$HOME",
      "bin/sh",
      "/bin/../sh",
      "/bin/./sh",
      "/",
      "",
      "/bin/sh\nid",
      "/" + "a".repeat(250),
    ]) {
      expect(isShellPath(bad)).toBe(false);
    }
  });

  it("picks the default shell, then bash, ash, sh", () => {
    const shells = ["/bin/sh", "/bin/ash", "/bin/bash"];
    expect(pickShell({ shells, default: "/bin/zsh" })).toBe("/bin/zsh");
    expect(pickShell({ shells, default: null })).toBe("/bin/bash");
    expect(pickShell({ shells: ["/bin/sh", "/bin/ash"], default: null })).toBe(
      "/bin/ash",
    );
    expect(pickShell({ shells: ["/bin/sh"], default: null })).toBe("/bin/sh");
    expect(pickShell({ shells: [], default: null })).toBeNull();
    expect(pickShell({ shells, default: "/bin/x y" })).toBe("/bin/bash");
  });
});
