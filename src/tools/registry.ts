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
 * Phase 0 ships no concrete tools; Confluence tool manifests land here in
 * Phase 1+.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { requireCompleteConfig } from "../core/config.js";
import type { ConfluenceConfig } from "../core/config.js";
import { ERROR_CODES, mcpError, mcpText, toMcpError } from "../core/errors.js";
import type { ProviderContext, ProviderId } from "../core/provider.js";

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

/** Phase 1+ Confluence tool manifests, grouped by domain. Phase 0: empty. */
export const toolManifests: ToolManifest[] = [];

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
            `The "${ctx.provider.id}" provider adapter is not implemented yet — Cloud v2 API arrives in Phase 4.`,
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
