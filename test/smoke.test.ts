/**
 * MCP stdio smoke test: spawns the BUILT server (node dist/index.js), speaks
 * JSON-RPC to it over stdio and asserts the Phase 0 contract:
 *   initialize -> serverInfo.name === "confluence-mcp"
 *   tools/list -> { tools: [] }
 *
 * Requires dist/ to exist. `npm test` guarantees this via the "pretest"
 * script ("npm run build" runs before "vitest run").
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const SERVER_PATH = fileURLToPath(new URL("../dist/index.js", import.meta.url));

interface RpcMessage {
  id?: number;
  result?: unknown;
  error?: unknown;
}

interface Session {
  call: (method: string, params: unknown) => Promise<RpcMessage>;
  notify: (method: string, params: unknown) => void;
  close: () => void;
}

function startServer(env: Record<string, string>): Session {
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map<number, (msg: RpcMessage) => void>();
  let nextId = 1;

  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: RpcMessage;
    try {
      msg = JSON.parse(line) as RpcMessage;
    } catch {
      return;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });
  // Startup logs go to stderr; ignore them.
  child.stderr.on("data", () => {});
  child.on("error", (err) => {
    throw err;
  });

  return {
    call: (method, params) =>
      new Promise<RpcMessage>((resolve, reject) => {
        const id = nextId++;
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`timeout waiting for response to ${method}`));
        }, 15_000);
        pending.set(id, (msg) => {
          clearTimeout(timeout);
          resolve(msg);
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      }),
    notify: (method, params) => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    close: () => child.kill(),
  };
}

const sessions: Session[] = [];
function tracked(env: Record<string, string>): Session {
  const session = startServer(env);
  sessions.push(session);
  return session;
}

afterAll(() => {
  for (const session of sessions) session.close();
});

const INIT_PARAMS = {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "smoke-test", version: "0.0.0" },
};

describe("stdio smoke (built server)", () => {
  it("has a build output to test against", () => {
    expect(existsSync(SERVER_PATH), "dist/index.js missing — run `npm run build` first (npm test does this via pretest)").toBe(true);
  });

  it("answers the initialize handshake with the confluence-mcp server info", async () => {
    const session = tracked({
      CONFLUENCE_URL: "https://confluence.example.com",
      CONFLUENCE_TOKEN: "smoke-token",
    });
    const init = await session.call("initialize", INIT_PARAMS);
    expect(init.error).toBeUndefined();
    expect(init.result).toMatchObject({
      serverInfo: { name: "confluence-mcp", version: "0.1.0" },
    });
  });

  it("returns an empty tools list on tools/list (Phase 0: zero registered tools)", async () => {
    const session = tracked({
      CONFLUENCE_URL: "https://confluence.example.com",
      CONFLUENCE_TOKEN: "smoke-token",
    });
    const init = await session.call("initialize", INIT_PARAMS);
    expect(init.error).toBeUndefined();

    session.notify("notifications/initialized", {});
    const list = await session.call("tools/list", {});
    expect(list.error).toBeUndefined();
    expect(list.result).toMatchObject({ tools: [] });
  });

  it("still returns an empty tools list in read-only mode", async () => {
    const session = tracked({
      CONFLUENCE_URL: "https://confluence.example.com",
      CONFLUENCE_TOKEN: "smoke-token",
      CONFLUENCE_READ_ONLY: "true",
    });
    await session.call("initialize", INIT_PARAMS);
    const list = await session.call("tools/list", {});
    expect(list.result).toMatchObject({ tools: [] });
  });
});
