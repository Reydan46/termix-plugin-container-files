import { afterEach, describe, expect, it } from "vitest";
import { parseShells } from "../../src/backend/shells";
import { startServer, type TestServer } from "./server";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const SHELLS = "/containers/s1/abc123/shells";

describe("parseShells", () => {
  it("collects shells, prefers the passwd shell and ignores refusing ones", () => {
    const out = [
      "shell:/bin/sh",
      "shell:/bin/bash",
      "shell:/bin/bash",
      "shell:/usr/sbin/nologin",
      "shell:relative/sh",
      "passwd:/bin/ash",
      "env:/bin/sh",
    ].join("\n");
    expect(parseShells(out)).toEqual({
      shells: ["/bin/sh", "/bin/bash", "/bin/ash"],
      default: "/bin/ash",
    });
  });

  it("falls back to $SHELL and to null", () => {
    expect(parseShells("env:/bin/zsh\n")).toEqual({
      shells: ["/bin/zsh"],
      default: "/bin/zsh",
    });
    expect(parseShells("")).toEqual({ shells: [], default: null });
    expect(parseShells("passwd:/sbin/nologin")).toEqual({
      shells: [],
      default: null,
    });
  });
});

describe("GET shells", () => {
  it("returns the shells found in the container", async () => {
    server = await startServer();
    await server.request("POST", "/ssh/connect", {
      body: { sessionId: "s1", hostId: 7 },
    });
    server.client.reply(/\/etc\/shells/, {
      stdout: "shell:/bin/sh\nshell:/bin/bash\npasswd:/bin/bash\n",
    });
    const r = await server.request("GET", SHELLS);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      shells: ["/bin/sh", "/bin/bash"],
      default: "/bin/bash",
    });
  });

  it("answers an empty list instead of failing", async () => {
    server = await startServer();
    await server.request("POST", "/ssh/connect", {
      body: { sessionId: "s1", hostId: 7 },
    });
    server.client.reply(/\/etc\/shells/, { code: 1, stderr: "boom" });
    const r = await server.request("GET", SHELLS);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ shells: [], default: null });
  });

  it("is empty for a stopped container", async () => {
    server = await startServer();
    await server.request("POST", "/ssh/connect", {
      body: { sessionId: "s1", hostId: 7 },
    });
    server.client.reply(/'inspect'/, {
      stdout: "abc123def|false|exited|/web\n",
    });
    const r = await server.request("GET", SHELLS);
    expect(r.body).toEqual({ shells: [], default: null });
  });

  it("validates the container id and the permission", async () => {
    server = await startServer();
    await server.request("POST", "/ssh/connect", {
      body: { sessionId: "s1", hostId: 7 },
    });
    const bad = await server.request("GET", "/containers/s1/bad%3Bid/shells");
    expect(bad.status).toBe(400);
    await server.close();
    server = await startServer({ permissions: [] });
    const denied = await server.request("GET", SHELLS);
    expect(denied.status).toBe(403);
  });
});
