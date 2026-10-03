// Plugin settings: plugins.entries.dexio.config in the OpenClaw config, with the API key and
// server also readable from DEXIO_API_KEY and DEXIO_URL.

export const DEFAULT_URL = "https://app.dexio.wiki";
export const KEYS_URL = "https://app.dexio.wiki/settings/agents";

export type DexioConfig = {
  apiKey: string;
  url: string;
  autoRecall: boolean;
  maxResults: number;
  timeoutMs: number;
  agentName: string;
};

function clamp(value: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function parseConfig(
  raw: unknown,
  env: Record<string, string | undefined> = process.env,
): DexioConfig {
  const c = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const url = str(c.url) || str(env.DEXIO_URL) || DEFAULT_URL;
  return {
    apiKey: str(c.apiKey) || str(env.DEXIO_API_KEY),
    url: url.replace(/\/+$/, ""),
    autoRecall: c.autoRecall === undefined ? true : c.autoRecall !== false,
    maxResults: Math.round(clamp(c.maxResults, 1, 10, 4)),
    timeoutMs: Math.round(clamp(c.timeoutSeconds, 1, 14, 6) * 1000),
    agentName: str(c.agentName),
  };
}

// The name Dexio records on every change this agent makes: the configured agentName, else the
// OpenClaw agent id, else "openclaw" for the default agent.
export function agentLabel(config: DexioConfig, agentId?: string): string {
  if (config.agentName) return config.agentName;
  const id = str(agentId);
  return id && id !== "main" && id !== "default" ? id : "openclaw";
}
