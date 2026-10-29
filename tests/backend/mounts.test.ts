import { afterEach, describe, expect, it } from "vitest";
import { parseMounts } from "../../src/backend/mounts";
import {
  indexMounts,
  mountAt,
  mountTarget,
  MOUNT_LETTERS,
  mountTitle,
  type MountInfo,
} from "../../src/frontend/mountLookup";
import { startServer, type TestServer } from "./server";

let server: TestServer | null = null;
afterEach(async () => {
  await server?.close();
  server = null;
});

const URL_MOUNTS = "/containers/s1/abc123/mounts";

const DOCKER = JSON.stringify([
  {
    Type: "bind",
    Source: "/srv/www",
    Destination: "/var/www",
    Mode: "ro",
    RW: false,
    Propagation: "rprivate",
  },
  {
    Type: "volume",
    Name: "data",
    Source: "/var/lib/docker/volumes/data/_data",
    Destination: "/data",
    Driver: "local",
    Mode: "z",
    RW: true,
  },
  { Type: "tmpfs", Source: "", Destination: "/run", Mode: "", RW: true },
]);

const PODMAN = JSON.stringify([
  {
    Type: "bind",
    Source: "/home/u/app",
    Destination: "/app",
    Driver: "",
    Mode: "",
    Options: ["rbind", "ro"],
    RW: false,
  },
  {
    Type: "volume",
    Name: "pg",
    Source: "/home/u/.local/share/containers/storage/volumes/pg/_data",
    Destination: "/var/lib/postgresql/",
    Options: ["nosuid", "nodev", "rbind"],
  },
]);

describe("parseMounts", () => {
  it("reads docker output", () => {
    expect(parseMounts(DOCKER)).toEqual([
      {
        type: "bind",
        source: "/srv/www",
        destination: "/var/www",
        readOnly: true,
      },
      {
        type: "volume",
        source: "/var/lib/docker/volumes/data/_data",
        destination: "/data",
        readOnly: false,
        name: "data",
      },
      { type: "tmpfs", source: "", destination: "/run", readOnly: false },
    ]);
  });

  it("reads podman output (Options instead of RW, trailing slash)", () => {
    const mounts = parseMounts(PODMAN);
    expect(mounts[0]).toMatchObject({ destination: "/app", readOnly: true });
    expect(mounts[1]).toMatchObject({
      destination: "/var/lib/postgresql",
      readOnly: false,
      type: "volume",
      name: "pg",
    });
  });

  it("accepts lowercase keys, infers a missing type and skips junk", () => {
    const out = parseMounts(
      JSON.stringify([
        { name: "v", source: "/x", destination: "/v", rw: true },
        { source: "/h", destination: "/h", mode: "ro" },
        { destination: "relative" },
        { destination: "/v" },
        null,
        "x",
      ]),
    );
    expect(out.map((m) => [m.type, m.destination, m.readOnly])).toEqual([
      ["volume", "/v", false],
      ["bind", "/h", true],
    ]);
  });

  it("gives an empty list for empty, null and invalid output", () => {
    for (const text of ["", "null\n", "{}", "not json", "[", "[]"]) {
      expect(parseMounts(text)).toEqual([]);
    }
  });
});

describe("mount lookup", () => {
  const mounts: MountInfo[] = [
    {
      type: "bind",
      source: "/srv/www",
      destination: "/var/www/",
      readOnly: true,
    },
    { type: "tmpfs", source: "", destination: "/run", readOnly: false },
  ];
  it("matches only the exact destination", () => {
    const index = indexMounts(mounts);
    expect(mountAt(index, "/var/www")?.type).toBe("bind");
    expect(mountAt(index, "/var/www/")?.type).toBe("bind");
    expect(mountAt(index, "/var")).toBeNull();
    expect(mountAt(index, "/var/www/html")).toBeNull();
    expect(mountAt(index, "/")).toBeNull();
    expect(mountAt(indexMounts([]), "/run")).toBeNull();
  });
  it("builds the tooltip", () => {
    const label = (t: MountInfo["type"]) => `Mount: ${t}`;
    const access = { rw: "read-write", ro: "read-only" };
    expect(mountTitle(mounts[0], label, access)).toBe(
      "Mount: bind — /srv/www (read-only)",
    );
    expect(mountTitle(mounts[1], label, access)).toBe(
      "Mount: tmpfs (read-write)",
    );
  });
});

async function connect(): Promise<TestServer> {
  const s = await startServer();
  await s.request("POST", "/ssh/connect", {
    body: { sessionId: "s1", hostId: 7 },
  });
  return s;
}

describe("GET mounts", () => {
  it("returns docker mounts", async () => {
    server = await connect();
    server.client.reply(/json \.Mounts/, { stdout: `${DOCKER}\n` });
    const r = await server.request("GET", URL_MOUNTS);
    expect(r.status).toBe(200);
    expect(r.body.mounts).toHaveLength(3);
    expect(r.body.mounts[0]).toMatchObject({
      type: "bind",
      destination: "/var/www",
      readOnly: true,
    });
  });

  it("returns podman mounts", async () => {
    server = await connect();
    server.client.reply(/json \.Mounts/, { stdout: `${PODMAN}\n` });
    const r = await server.request("GET", URL_MOUNTS);
    expect(
      r.body.mounts.map((m: { destination: string }) => m.destination),
    ).toEqual(["/app", "/var/lib/postgresql"]);
  });

  it("answers an empty list for failures and bad output", async () => {
    server = await connect();
    server.client.reply(/json \.Mounts/, { code: 1, stderr: "boom" });
    expect((await server.request("GET", URL_MOUNTS)).body).toEqual({
      mounts: [],
    });
    server.client.reply(/json \.Mounts/, { stdout: "<no value>\n" });
    const s2 = await server.request("GET", "/containers/s1/abc123def/mounts");
    expect(s2.body).toEqual({ mounts: [] });
  });

  it("maps a missing container like the sibling routes", async () => {
    server = await connect();
    server.client.reply(/'inspect'/, { code: 1, stderr: "no such container" });
    const r = await server.request("GET", URL_MOUNTS);
    expect(r.status).toBe(404);
  });

  it("rejects an invalid container id", async () => {
    server = await connect();
    const r = await server.request("GET", "/containers/s1/bad%20id/mounts");
    expect(r.status).toBe(400);
  });
});

describe("mountTarget", () => {
  it("names the host path, the volume or tmpfs", () => {
    const mounts = parseMounts(DOCKER);
    expect(mountTarget(mounts[0])).toBe("/srv/www");
    expect(mountTarget(mounts[1])).toBe("data");
    expect(mountTarget(mounts[2])).toBe("tmpfs");
  });
});

describe("mount letters geometry", () => {
  it("keeps RW/RO inside the folder body and centred on it", () => {
    const g = MOUNT_LETTERS;
    // Folder body is x 2..22, y 6..20 of the 24-unit viewBox.
    expect(g.x - g.textLength / 2).toBeGreaterThanOrEqual(2.5);
    expect(g.x + g.textLength / 2).toBeLessThanOrEqual(21.5);
    const cap = g.fontSize * 0.72;
    expect(g.y - cap).toBeGreaterThanOrEqual(8);
    expect(g.y).toBeLessThanOrEqual(19);
    expect(g.y - cap / 2).toBeCloseTo(13, 0);
  });
  it("is at least 4.5px cap height at the 14px tree icon", () => {
    const g = MOUNT_LETTERS;
    expect(((g.fontSize * 0.72) / g.viewBox) * 14).toBeGreaterThanOrEqual(4.5);
  });
});
