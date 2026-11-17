/**
 * Central tool registry.
 *
 * Every tool is described by a ToolManifest declaring:
 * - `providers`: which deployment flavors the tool supports. Tools whose
 *   manifest does not list the active provider are NOT advertised to the
 *   MCP client at all.
 * - `readOnly`: under CONFLUENCE_READ_ONLY=true, write tools are also
 *   omitted from the advertised set.
 *
 * Phase 1 ships the Server/DC read tools; Phase 2 adds the Server/DC write
 * tools; Phase 4 adds the Cloud implementations (both providers behind the
 * same manifests, dispatched by ctx.provider.id). Manifests live in the
 * domain modules imported below and are aggregated into `toolManifests`.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { requireCompleteConfig } from "../core/config.js";
import type { ConfluenceConfig } from "../core/config.js";
import { ERROR_CODES, mcpError, mcpText, toMcpError } from "../core/errors.js";
import type { ProviderContext, ProviderId } from "../core/provider.js";
import { pageToolManifests } from "./pageTools.js";
import { spaceToolManifests } from "./spaceTools.js";
import { contentToolManifests } from "./contentTools.js";
import { writeToolManifests } from "./writeTools.js";

export interface ToolCallContext {
  readonly config: ConfluenceConfig;
  readonly provider: ProviderContext;
}

export interface ToolArgs {
  [key: string]: unknown;
}

export interface ToolManifest {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly inputSchema: Record<string, z.ZodTypeAny>;
  readonly providers: readonly ProviderId[];
  readonly readOnly: boolean;
  readonly handler: (args: ToolArgs, ctx: ToolCallContext) => Promise<unknown>;
}

/** Phase 1+ Confluence tool manifests, grouped by domain. */
export const toolManifests: ToolManifest[] = [
  ...pageToolManifests,
  ...spaceToolManifests,
  ...contentToolManifests,
  ...writeToolManifests,
];

export function selectManifests(
  manifests: readonly ToolManifest[],
  provider: ProviderId,
  readOnly: boolean,
): ToolManifest[] {
  return manifests.filter(
    (manifest) => manifest.providers.includes(provider) && (!readOnly || manifest.readOnly),
  );
}

export function registerAllTools(
  server: McpServer,
  ctx: ToolCallContext,
  manifests: readonly ToolManifest[] = toolManifests,
): string[] {
  const advertised: string[] = [];
  for (const manifest of selectManifests(manifests, ctx.provider.id, ctx.config.readOnly)) {
    server.registerTool(
      manifest.name,
      {
        title: manifest.title,
        description: manifest.description,
        inputSchema: manifest.inputSchema,
      },
      async (args: ToolArgs) => {
        if (!ctx.provider.available) {
          return mcpError(
            ERROR_CODES.PROVIDER_UNAVAILABLE,
            `The "${ctx.provider.id}" provider is not available.`,
            { provider: ctx.provider.id, tool: manifest.name },
          );
        }
        const configProblems = requireCompleteConfig(ctx.config);
        if (configProblems.length > 0) {
          return mcpError(ERROR_CODES.CONFIG_MISSING, "Confluence configuration is incomplete.", {
            problems: configProblems,
          });
        }
        try {
          return mcpText(await manifest.handler(args ?? {}, ctx));
        } catch (err) {
          return toMcpError(err);
        }
      },
    );
    advertised.push(manifest.name);
  }
  return advertised;
}
