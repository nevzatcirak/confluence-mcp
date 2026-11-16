import { describe, expect, it } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { loadConfig } from "../core/config.js";
import { createCloudProvider } from "../providers/cloud/cloudProvider.js";
import { createServerProvider } from "../providers/server/serverProvider.js";
import type { ToolCallContext, ToolManifest } from "./registry.js";
import { registerAllTools, selectManifests, toolManifests } from "./registry.js";

interface RegisteredTool {
  name: string;
  config: { title: string; description: string; inputSchema: unknown };
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

class FakeServer {
  readonly tools = new Map<string, RegisteredTool>();

  registerTool(
    name: string,
    config: { title: string; description: string; inputSchema: unknown },
    handler: (args: Record<string, unknown>) => Promise<unknown>,
  ): void {
    this.tools.set(name, { name, config, handler });
  }
}

function serverCtx(): ToolCallContext {
  const { config } = loadConfig({ CONFLUENCE_URL: "https://confluence.example.com", CONFLUENCE_TOKEN: "t" });
  return { config, provider: createServerProvider(config) };
}

const READ_ONLY_ENV = {
  CONFLUENCE_URL: "https://confluence.example.com",
  CONFLUENCE_TOKEN: "t",
  CONFLUENCE_READ_ONLY: "true",
};

const MANIFESTS: ToolManifest[] = [
  {
    name: "cf_get_page",
    title: "Get page",
    description: "Reads one page",
    inputSchema: {},
    providers: ["server", "cloud"],
    readOnly: true,
    handler: async () => ({ ok: true }),
  },
  {
    name: "cf_server_only",
    title: "Server-only",
    description: "Only on Server/DC",
    inputSchema: {},
    providers: ["server"],
    readOnly: true,
    handler: async () => ({ ok: true }),
  },
  {
    name: "cf_write_page",
    title: "Write something",
    description: "A write tool",
    inputSchema: {},
    providers: ["server", "cloud"],
    readOnly: false,
    handler: async () => ({ ok: true }),
  },
];

describe("selectManifests", () => {
  it("omits tools whose manifest does not list the active provider", () => {
    const names = selectManifests(MANIFESTS, "cloud", false).map((m) => m.name);
    expect(names).toEqual(["cf_get_page", "cf_write_page"]);
  });

  it("omits write tools in read-only mode", () => {
    const names = selectManifests(MANIFESTS, "server", true).map((m) => m.name);
    expect(names).toEqual(["cf_get_page", "cf_server_only"]);
  });
});

describe("registerAllTools", () => {
  it("registers only the advertised set and wires handlers", async () => {
    const fake = new FakeServer();
    const advertised = registerAllTools(fake as unknown as McpServer, serverCtx(), MANIFESTS);

    expect(advertised).toEqual(["cf_get_page", "cf_server_only", "cf_write_page"]);
    expect(fake.tools.size).toBe(3);

    const handler = fake.tools.get("cf_get_page")!.handler;
    await expect(handler({})).resolves.toMatchObject({ content: [{ type: "text" }] });
  });

  it("hides provider-unsupported and write tools under read-only cloud", () => {
    const fake = new FakeServer();
    const { config } = loadConfig(READ_ONLY_ENV);
    const advertised = registerAllTools(
      fake as unknown as McpServer,
      { config, provider: createCloudProvider(config) },
      MANIFESTS,
    );
    expect(advertised).toEqual(["cf_get_page"]);
  });

  it("returns structured PROVIDER_UNAVAILABLE for tools on the unimplemented cloud provider", async () => {
    const fake = new FakeServer();
    const { config } = loadConfig({ CONFLUENCE_URL: "https://confluence.example.com", CONFLUENCE_TOKEN: "t" });
    const cloudCtx: ToolCallContext = { config, provider: createCloudProvider(config) };
    const anyProvider: ToolManifest = {
      name: "cf_any_provider",
      title: "Any provider",
      description: "Listed for cloud too",
      inputSchema: {},
      providers: ["server", "cloud"],
      readOnly: true,
      handler: async () => ({ ok: true }),
    };
    registerAllTools(fake as unknown as McpServer, cloudCtx, [anyProvider]);

    const result = await fake.tools.get("cf_any_provider")!.handler({});
    expect(result).toMatchObject({ isError: true });
    const text = JSON.stringify((result as { content: [{ text: string }] }).content[0].text);
    expect(text).toContain("PROVIDER_UNAVAILABLE");
    expect(text).toContain("Phase 4");
  });

  it("converts handler throws into structured errors", async () => {
    const fake = new FakeServer();
    const failing: ToolManifest = {
      name: "cf_failing",
      title: "Failing",
      description: "Throws",
      inputSchema: {},
      providers: ["server"],
      readOnly: true,
      handler: async () => {
        throw new Error("boom");
      },
    };
    registerAllTools(fake as unknown as McpServer, serverCtx(), [failing]);

    const result = (await fake.tools.get("cf_failing")!.handler({})) as { content: [{ text: string }] };
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "INTERNAL_ERROR", message: "boom" } });
  });

  it("returns CONFIG_MISSING when the config is incomplete on the request path", async () => {
    const fake = new FakeServer();
    const { config } = loadConfig({ CONFLUENCE_TOKEN: "t" }); // URL missing
    const advertised = registerAllTools(fake as unknown as McpServer, { config, provider: createServerProvider(config) }, MANIFESTS);
    expect(advertised).toHaveLength(3);

    const result = (await fake.tools.get("cf_get_page")!.handler({})) as { content: [{ text: string }] };
    expect(JSON.parse(result.content[0].text)).toMatchObject({ error: { code: "CONFIG_MISSING" } });
  });
});

describe("toolManifests (Phase 1 read + Phase 2 write tools)", () => {
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

  it("ships exactly the ten read tools", () => {
    expect(toolManifests.filter((m) => m.readOnly).map((m) => m.name).sort()).toEqual(EXPECTED_READ_TOOLS);
  });

  it("ships exactly the five write tools", () => {
    expect(toolManifests.filter((m) => !m.readOnly).map((m) => m.name).sort()).toEqual(EXPECTED_WRITE_TOOLS);
  });

  it("marks every tool Server/DC-only and every read tool read-only", () => {
    for (const manifest of toolManifests) {
      expect(manifest.providers).toEqual(["server"]);
      expect(manifest.readOnly).toBe(EXPECTED_READ_TOOLS.includes(manifest.name));
    }
  });

  it("advertises 15 tools on server in normal mode, only the 10 read tools in read-only mode, nothing on cloud", () => {
    expect(selectManifests(toolManifests, "server", false)).toHaveLength(15);
    expect(selectManifests(toolManifests, "server", true).map((m) => m.name).sort()).toEqual(EXPECTED_READ_TOOLS);
    expect(selectManifests(toolManifests, "cloud", false)).toEqual([]);
    expect(selectManifests(toolManifests, "cloud", true)).toEqual([]);
  });
});
