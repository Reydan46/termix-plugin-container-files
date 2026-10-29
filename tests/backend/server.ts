import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type Router } from "express";
import {
  createMockCtx,
  type MockContextOptions,
  type MockPluginContext,
} from "@termix-ssh/plugin-sdk/testing";
import type { PluginManifest } from "@termix-ssh/plugin-sdk/manifest";
import manifestJson from "../../manifest.json";
import { activate } from "../../src/backend/index.js";
import { FakeClient } from "./fake-ssh";

export const manifest = manifestJson as unknown as PluginManifest;

export const PS_LINE =
  '{"id":"abc123","name":"web","image":"nginx","status":"Up 2 hours","state":"running","ports":"80/tcp","created":"2026-01-01"}';

export const nul = (...f: string[]) => `${f.join("\0")}\0`;

/** A host owned by user-1, as ctx.ssh.resolveHost sees it. */
export function sshHost(id: number) {
  return {
    id,
    userId: "user-1",
    name: `host-${id}`,
    ip: `10.0.0.${id}`,
    port: 22,
    username: "root",
    authType: "password",
    password: "pw",
  };
}

/** A client that looks like a Linux host with Docker and a GNU container. */
export function dockerClient(): FakeClient {
  return new FakeClient([
    [/command -v docker/, { stdout: "/usr/bin/docker\n" }],
    [/'ps' '-a'/, { stdout: `${PS_LINE}\n` }],
    [/'inspect'/, { stdout: "abc123def|true|running|/web\n" }],
    [
      /findPrintf/,
      { stdout: "tool:find\ntool:tar\nfindPrintf\nstatC\nprobed\n" },
    ],
    [
      /mindepth/,
      {
        stdout: nul("a.txt", "f", "3", "100.0", "644", "root", "root", "", "f"),
      },
    ],
  ]);
}

export interface RawResponse {
  status: number;
  headers: Headers;
  buffer: Buffer;
}

export interface TestServer {
  mock: MockPluginContext;
  /** Absolute URL of a path on this server. */
  url: (path: string) => string;
  client: FakeClient;
  request: (
    method: string,
    path: string,
    options?: { user?: string; body?: unknown },
    // Route bodies vary per test; asserting on them is the point.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ) => Promise<{ status: number; body: any }>;
  raw: (
    method: string,
    path: string,
    options?: { user?: string; body?: Buffer },
  ) => Promise<RawResponse>;
  close: () => Promise<void>;
}

export async function startServer(
  options: {
    permissions?: string[];
    client?: FakeClient;
    mock?: Partial<MockContextOptions>;
  } = {},
): Promise<TestServer> {
  const client = options.client ?? dockerClient();
  let router: Router | null = null;
  const mock = createMockCtx({
    pluginId: manifest.id,
    manifest,
    capabilities: manifest.capabilities,
    router: () => (router = express.Router()),
    permissions: options.permissions ?? ["container-files.use"],
    sshHosts: [sshHost(7), sshHost(8)],
    sshClient: client,
    ...options.mock,
  });

  await activate(mock.ctx);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    mock.setActor(req.header("x-test-user") ?? undefined);
    next();
  });
  app.use((req, res, next) => router!(req, res, next));

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  const url = (path: string) => `http://127.0.0.1:${port}${path}`;

  return {
    mock,
    url,
    client,
    async request(method, path, { user = "user-1", body } = {}) {
      const response = await fetch(url(path), {
        method,
        headers: {
          "x-test-user": user,
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
        body:
          body !== undefined && method !== "GET"
            ? JSON.stringify(body)
            : undefined,
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : null };
    },
    async raw(method, path, { user = "user-1", body } = {}) {
      const response = await fetch(url(path), {
        method,
        headers: {
          "x-test-user": user,
          ...(body ? { "content-type": "application/octet-stream" } : {}),
        },
        body: body as never,
      });
      return {
        status: response.status,
        headers: response.headers,
        buffer: Buffer.from(await response.arrayBuffer()),
      };
    },
    async close() {
      for (const dispose of mock.disposals.reverse()) await dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
