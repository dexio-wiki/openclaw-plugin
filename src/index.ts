// Dexio for OpenClaw: the shared Dexio wiki as a memory for your agents.
//
// Before each turn, one search of your Dexio wiki for the user's message puts the best-matching
// pages in front of the model, and six tools let the agent search, read and write pages your
// other agents and your team also use. Nothing is written automatically.

import { DexioClient, DexioError } from "./client.ts";
import { agentLabel, KEYS_URL, parseConfig } from "./config.ts";
import { formatRecall, GUIDANCE, RecallCache, recallQuery } from "./recall.ts";
import { buildTools, TOOL_NAMES } from "./tools.ts";

// The slice of OpenClaw's plugin API this plugin uses (openclaw/plugin-sdk, 2026.9.8).
type Logger = { info: (msg: string) => void; warn: (msg: string) => void; debug?: (msg: string) => void };
type ToolAuthority = { allows: (tool: string) => boolean; assertActive: () => void };
type PromptBuildEvent = { prompt?: string; currentUserMessage?: string };
type PromptBuildCtx = { toolAuthority?: ToolAuthority };
type ToolCtx = { agentId?: string };
type Api = {
  pluginConfig?: unknown;
  logger: Logger;
  registerTool: (factory: (ctx: ToolCtx) => unknown[], opts?: { names?: string[] }) => void;
  on: (hook: string, handler: (event: any, ctx: any) => unknown, opts?: Record<string, unknown>) => void;
};

const plugin = {
  id: "dexio",
  name: "Dexio",
  description:
    "Your shared Dexio wiki as agent memory: recall before each turn, and tools to search, read and write the pages your other agents and team use.",
  register(api: Api) {
    const config = parseConfig(api.pluginConfig);
    if (!config.apiKey) {
      api.logger.warn(
        `dexio: no API key, so no tools or recall. Make one at ${KEYS_URL} and set plugins.entries.dexio.config.apiKey (or DEXIO_API_KEY).`,
      );
      return;
    }
    const client = new DexioClient(config.url, config.apiKey, config.timeoutMs);
    const cache = new RecallCache();

    api.registerTool((ctx: ToolCtx) => buildTools(client, agentLabel(config, ctx?.agentId), () => cache.clear()), {
      names: TOOL_NAMES,
    });

    // Static guidance, appended to the system prompt so providers can cache it.
    api.on("before_prompt_build", () => ({ appendSystemContext: GUIDANCE }));

    if (config.autoRecall) {
      // Runs after the turn's tool policy settles: no recall unless this turn may use dexio_search.
      api.on(
        "before_prompt_build",
        async (event: PromptBuildEvent, ctx: PromptBuildCtx) => {
          const authority = ctx?.toolAuthority;
          if (!authority?.allows("dexio_search")) return;
          const q = recallQuery(event?.currentUserMessage ?? event?.prompt ?? "");
          if (q.length < 3) return;
          let block = cache.get(q);
          if (block === undefined) {
            try {
              const found = await client.call("search_pages", {
                query: q,
                limit: config.maxResults,
                matches_per_page: 3,
              });
              block = formatRecall(found.results, config.maxResults);
              cache.set(q, block);
            } catch (err) {
              api.logger.debug?.(`dexio: recall skipped: ${err instanceof DexioError ? err.message : String(err)}`);
              return;
            }
          }
          authority.assertActive();
          return block ? { prependContext: block } : undefined;
        },
        { requiresToolAuthority: true },
      );
    }
    api.logger.info(`dexio: ready, server ${config.url}`);
  },
};

export default plugin;
