#!/usr/bin/env node
/**
 * confluence-mcp entry point: stdio MCP server for Confluence Server / DC,
 * with a Cloud adapter seam.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./core/config.js";
import { createCloudProvider } from "./providers/cloud/cloudProvider.js";
import { createServerProvider } from "./providers/server/serverProvider.js";
import { registerAllTools } from "./tools/registry.js";
import { log, registerSecrets } from "./util/logger.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

const HELP = `${SERVER_NAME} v${SERVER_VERSION} — MCP server for Confluence Server / Data Center (Cloud adapter arrives in Phase 4).

Environment:
  CONFLUENCE_PROVIDER        "server" (default) | "cloud"
  CONFLUENCE_URL             Instance base URL, e.g. https://confluence.example.com (required)
  CONFLUENCE_TOKEN           Personal access token -> Authorization: Bearer
  CONFLUENCE_USERNAME        Used with CONFLUENCE_PASSWORD -> Authorization: Basic
  CONFLUENCE_PASSWORD        See CONFLUENCE_USERNAME
  CONFLUENCE_READ_ONLY       "true" hides all write tools
  CONFLUENCE_CUSTOM_HEADERS  Comma-separated "Name: Value" pairs

Usage:
  confluence-mcp [--version] [--help]
`;

function handleCliArgs(argv: readonly string[]): boolean {
  if (argv.includes("--version")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return true;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(HELP);
    return true;
  }
  return false;
}

async function main(): Promise<void> {
  if (handleCliArgs(process.argv.slice(2))) return;

  const { config, problems } = loadConfig();
  registerSecrets(config.token, config.password);
  for (const problem of problems) {
    log(`config: ${problem.field}: ${problem.message}${problem.hint ? ` (hint: ${problem.hint})` : ""}`);
  }

  const provider = config.provider === "cloud" ? createCloudProvider(config) : createServerProvider(config);

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    // Declare the tools capability up front so tools/list returns { tools: [] }
    // even before the first tool is registered (otherwise the SDK answers
    // "Method not found" for tools/list on an empty registry).
    { capabilities: { tools: {} } },
  );
  const advertised = registerAllTools(server, { config, provider });
  log(
    `${SERVER_NAME} v${SERVER_VERSION} ready (provider=${provider.id}, tools advertised: ${advertised.length}, read-only=${config.readOnly})`,
  );

  await server.connect(new StdioServerTransport());
}

main().catch((err: unknown) => {
  log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
  process.exitCode = 1;
});
