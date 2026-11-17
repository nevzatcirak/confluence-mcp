/**
 * MCP stdio smoke test: spawns the BUILT server (node dist/index.js), speaks
 * JSON-RPC to it over stdio and asserts the contract:
 *   initialize -> serverInfo.name === "confluence-mcp"
 *   tools/list -> exactly the ten read tools + five write tools, on both the
 *                 server and the cloud provider (the registry works without
 *                 any network access); in read-only mode ONLY the ten read
 *                 tools are advertised.
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

const EXPECTED_READ_TOOLS = [
  "cf_get_labels",
  "cf_get_page",
  "cf_get_page_by_title",
  "cf_get_page_hierarchy",
  "cf_get_page_history",
  "cf_get_space",
  "cf_list_attachments",
  "cf_list_pages_in_space",
  "cf_list_spaces",
  "cf_search_cql",
];

const EXPECTED_WRITE_TOOLS = [
  "cf_add_label",
  "cf_create_page",
  "cf_delete_page",
  "cf_remove_label",
  "cf_update_page",
];

const EXPECTED_ALL_TOOLS = [...EXPECTED_READ_TOOLS, ...EXPECTED_WRITE_TOOLS].sort();

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
      serverInfo: { name: "confluence-mcp", version: "0.4.1" },
    });
  });

  it("returns exactly the Phase 1 read + Phase 2 write tools on tools/list", async () => {
    const session = tracked({
      CONFLUENCE_URL: "https://confluence.example.com",
      CONFLUENCE_TOKEN: "smoke-token",
    });
    const init = await session.call("initialize", INIT_PARAMS);
    expect(init.error).toBeUndefined();

    session.notify("notifications/initialized", {});
    const list = await session.call("tools/list", {});
    expect(list.error).toBeUndefined();
    const tools = (list.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual(EXPECTED_ALL_TOOLS);
  });

  it("hides the five write tools in read-only mode (only the ten read tools remain)", async () => {
    const session = tracked({
      CONFLUENCE_URL: "https://confluence.example.com",
      CONFLUENCE_TOKEN: "smoke-token",
      CONFLUENCE_READ_ONLY: "true",
    });
    await session.call("initialize", INIT_PARAMS);
    const list = await session.call("tools/list", {});
    const tools = (list.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual(EXPECTED_READ_TOOLS);
    expect(tools).toEqual(EXPECTED_ALL_TOOLS.filter((name) => !EXPECTED_WRITE_TOOLS.includes(name)));
  });

  it("advertises the same 15 tools with provider=cloud (registry works without network)", async () => {
    const session = tracked({
      CONFLUENCE_URL: "https://confluence.example.com",
      CONFLUENCE_PROVIDER: "cloud",
      CONFLUENCE_CLOUD_EMAIL: "dev@example.com",
      CONFLUENCE_CLOUD_API_TOKEN: "smoke-token",
    });
    const init = await session.call("initialize", INIT_PARAMS);
    expect(init.error).toBeUndefined();

    session.notify("notifications/initialized", {});
    const list = await session.call("tools/list", {});
    expect(list.error).toBeUndefined();
    const tools = (list.result as { tools: Array<{ name: string }> }).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual(EXPECTED_ALL_TOOLS);
  });
});
