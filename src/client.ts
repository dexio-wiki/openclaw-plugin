// One MCP tools/call per request, over Dexio's streamable HTTP endpoint (<url>/mcp).

export const VERSION = "0.1.0";

export class DexioError extends Error {}

export type DexioResult = Record<string, unknown>;

type JsonRpcMessage = {
  result?: { content?: Array<{ type?: string; text?: string }>; isError?: boolean };
  error?: { message?: string } | string;
};

export class DexioClient {
  readonly endpoint: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private ids = 0;

  constructor(url: string, apiKey: string, timeoutMs: number, fetchImpl: typeof fetch = fetch) {
    this.endpoint = url.replace(/\/+$/, "") + "/mcp";
    this.apiKey = apiKey;
    this.timeoutMs = timeoutMs;
    this.fetchImpl = fetchImpl;
  }

  async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<DexioResult> {
    this.ids += 1;
    const body = JSON.stringify({
      jsonrpc: "2.0",
      id: this.ids,
      method: "tools/call",
      params: { name: tool, arguments: args },
    });
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/event-stream",
          "User-Agent": `openclaw-dexio/${VERSION}`,
        },
        body,
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (err) {
      const why = err instanceof Error && err.name === "TimeoutError"
        ? `no answer within ${Math.round(this.timeoutMs / 1000)}s`
        : String(err instanceof Error ? err.message : err);
      throw new DexioError(`could not reach ${this.endpoint}: ${why}`);
    }
    const raw = await res.text();
    if (res.status === 401) {
      throw new DexioError(
        "Dexio refused the API key (401): make a new one in Settings > Agents and set it as the plugin's apiKey",
      );
    }
    if (!res.ok) throw new DexioError(`Dexio answered HTTP ${res.status}`);
    const message = parseMessage(raw);
    if (message.error) {
      const e = message.error;
      throw new DexioError(typeof e === "string" ? e : e.message || JSON.stringify(e));
    }
    const content = message.result?.content ?? [];
    const text = content[0]?.text ?? "";
    if (message.result?.isError) throw new DexioError(text || "Dexio returned an error");
    let data: unknown = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { text };
      }
    }
    const out: DexioResult = data && typeof data === "object" && !Array.isArray(data)
      ? (data as DexioResult)
      : { result: data };
    // read_page answers with a JSON header, then the page's markdown as a second block.
    if (content.length > 1) out.text = content[1]?.text ?? "";
    return out;
  }
}

// The reply is plain JSON or a short server-sent-event stream.
export function parseMessage(raw: string): JsonRpcMessage {
  const s = raw.trim();
  if (s.startsWith("{")) return JSON.parse(s) as JsonRpcMessage;
  for (const line of s.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (!payload.startsWith("{")) continue;
    const msg = JSON.parse(payload) as JsonRpcMessage;
    if ("result" in msg || "error" in msg) return msg;
  }
  throw new DexioError("unreadable reply from Dexio");
}
