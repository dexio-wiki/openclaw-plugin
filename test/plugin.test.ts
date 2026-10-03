// Runs against a stub Dexio MCP server; needs no OpenClaw install.
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { DexioClient, DexioError, parseMessage } from "../src/client.ts";
import { agentLabel, parseConfig } from "../src/config.ts";
import plugin from "../src/index.ts";
import { formatRecall, RECALL_CHARS, recallQuery } from "../src/recall.ts";
import { TOOL_NAMES } from "../src/tools.ts";

type Call = { tool: string; args: Record<string, any>; auth?: string; agent?: string };
const calls: Call[] = [];
let mode: "json" | "sse" | "401" | "toolError" = "json";
let url = "";
let server: http.Server;

function reply(tool: string, args: Record<string, any>) {
  if (tool === "search_pages") {
    return [{ type: "text", text: JSON.stringify({ results: [
      { path: "customers/juniper", title: "Juniper Street Cafe",
        matches: [{ line: 1, text: "title: Juniper Street Cafe" }, { line: 9, text: "Tallpine   offered $9.25 a pound" }] },
      { path: "people/owen", title: "Owen Marsh", matches: [{ line: 3, text: "Owns Juniper Street Cafe." }] },
    ] }) }];
  }
  if (tool === "read_page") {
    return [{ type: "text", text: JSON.stringify({ path: args.path, version: "v1" }) },
            { type: "text", text: "# Juniper\n\nBody text." }];
  }
  return [{ type: "text", text: JSON.stringify({ ok: true, path: args.path ?? null }) }];
}

before(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body);
      const { name, arguments: args } = msg.params;
      calls.push({ tool: name, args, auth: req.headers.authorization, agent: req.headers["user-agent"] });
      if (mode === "401") { res.writeHead(401).end("no"); return; }
      const result = mode === "toolError"
        ? { content: [{ type: "text", text: "Page not found: nope" }], isError: true }
        : { content: reply(name, args) };
      const out = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
      if (mode === "sse") {
        res.writeHead(200, { "Content-Type": "text/event-stream" }).end(`event: message\ndata: ${out}\n\n`);
      } else {
        res.writeHead(200, { "Content-Type": "application/json" }).end(out);
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());
beforeEach(() => { calls.length = 0; mode = "json"; });

function fakeApi(config: Record<string, unknown>) {
  const hooks: Array<{ name: string; handler: (e: any, c: any) => any; opts?: any }> = [];
  const factories: Array<{ factory: (ctx: any) => any[]; opts?: any }> = [];
  const logs: string[] = [];
  const api = {
    pluginConfig: config,
    logger: { info: (m: string) => logs.push(m), warn: (m: string) => logs.push(m), debug: (m: string) => logs.push(m) },
    registerTool: (factory: any, opts?: any) => factories.push({ factory, opts }),
    on: (name: string, handler: any, opts?: any) => hooks.push({ name, handler, opts }),
  };
  plugin.register(api as any);
  return { hooks, factories, logs };
}

const authority = (allowed: boolean) => ({ allows: (t: string) => allowed && t === "dexio_search", assertActive: () => {} });

describe("config", () => {
  test("defaults, env fallback and clamps", () => {
    const c = parseConfig({}, { DEXIO_API_KEY: " dxk_env ", DEXIO_URL: "https://wiki.example.com/" });
    assert.equal(c.apiKey, "dxk_env");
    assert.equal(c.url, "https://wiki.example.com");
    assert.equal(c.autoRecall, true);
    assert.equal(c.maxResults, 4);
    assert.equal(c.timeoutMs, 6000);
    const d = parseConfig({ apiKey: "dxk_cfg", maxResults: 99, timeoutSeconds: 0, autoRecall: false }, { DEXIO_API_KEY: "dxk_env" });
    assert.equal(d.apiKey, "dxk_cfg");
    assert.equal(d.url, "https://app.dexio.wiki");
    assert.equal(d.maxResults, 10);
    assert.equal(d.timeoutMs, 1000);
    assert.equal(d.autoRecall, false);
  });
  test("the name on changes", () => {
    const c = parseConfig({}, {});
    assert.equal(agentLabel(c, "main"), "openclaw");
    assert.equal(agentLabel(c, undefined), "openclaw");
    assert.equal(agentLabel(c, "ops"), "ops");
    assert.equal(agentLabel(parseConfig({ agentName: "scout" }, {}), "ops"), "scout");
  });
});

describe("client", () => {
  test("plain JSON and server-sent events", async () => {
    const client = new DexioClient(url, "dxk_test", 3000);
    const a = await client.call("list_pages", { folder: "x" });
    assert.equal(a.ok, true);
    mode = "sse";
    const b = await client.call("list_pages", {});
    assert.equal(b.ok, true);
    assert.equal(calls[0].auth, "Bearer dxk_test");
    assert.match(String(calls[0].agent), /^openclaw-dexio\//);
  });
  test("read_page keeps the markdown", async () => {
    const out = await new DexioClient(url, "k", 3000).call("read_page", { path: "customers/juniper" });
    assert.equal(out.version, "v1");
    assert.equal(out.text, "# Juniper\n\nBody text.");
  });
  test("errors", async () => {
    mode = "401";
    await assert.rejects(new DexioClient(url, "bad", 3000).call("list_pages", {}), /refused the API key/);
    mode = "toolError";
    await assert.rejects(new DexioClient(url, "k", 3000).call("read_page", { path: "nope" }), /Page not found/);
    await assert.rejects(new DexioClient("http://127.0.0.1:9", "k", 1000).call("list_pages", {}), DexioError);
    assert.throws(() => parseMessage("garbage"), /unreadable/);
  });
});

describe("plugin", () => {
  test("no API key: nothing registered, and a pointer to where to get one", () => {
    const saved = process.env.DEXIO_API_KEY;
    delete process.env.DEXIO_API_KEY;
    try {
      const { hooks, factories, logs } = fakeApi({});
      assert.equal(hooks.length + factories.length, 0);
      assert.match(logs.join("\n"), /settings\/agents/);
    } finally {
      if (saved !== undefined) process.env.DEXIO_API_KEY = saved;
    }
  });

  test("six tools, credited to the agent", async () => {
    const { factories } = fakeApi({ apiKey: "dxk_t", url });
    assert.equal(factories.length, 1);
    assert.deepEqual(factories[0].opts.names, TOOL_NAMES);
    const tools = factories[0].factory({ agentId: "ops" });
    assert.deepEqual(tools.map((t: any) => t.name), TOOL_NAMES);
    for (const t of tools) {
      assert.equal(t.parameters.type, "object");
      assert.equal(t.resultContentSource, "network");
      assert.ok(t.label && t.description);
    }
    const byName = Object.fromEntries(tools.map((t: any) => [t.name, t]));

    const r = await byName.dexio_read.execute("c1", { path: "customers/juniper" });
    assert.equal(r.content[0].text, '{"path":"customers/juniper","version":"v1"}\n\n# Juniper\n\nBody text.');
    await byName.dexio_write.execute("c2", { path: "a/b", text: "# B", note: "n", base_version: "" });
    assert.deepEqual(calls.at(-1), { ...calls.at(-1)!, tool: "write_page", args: { path: "a/b", text: "# B", note: "n", agent: "ops" } });
    await byName.dexio_edit.execute("c3", { path: "a/b", old_text: "B", new_text: "" });
    assert.deepEqual(calls.at(-1)!.args, { path: "a/b", old_text: "B", new_text: "", agent: "ops" });
    await byName.dexio_append.execute("c4", { path: "a/log", text: "- x" });
    assert.equal(calls.at(-1)!.args.agent, "ops");
    await byName.dexio_search.execute("c5", { query: "juniper", limit: 3 });
    assert.deepEqual(calls.at(-1)!.args, { query: "juniper", limit: 3 });
    await assert.rejects(byName.dexio_search.execute("c6", { query: "  " }), /query is required/);
    await assert.rejects(byName.dexio_edit.execute("c7", { path: "a", old_text: "", new_text: "x" }), /old_text is required/);
    assert.equal(factories[0].factory({ agentId: "main" })[3].name, "dexio_write");
  });

  test("recall only when the turn may use dexio_search", async () => {
    const { hooks } = fakeApi({ apiKey: "dxk_t", url, maxResults: 2 });
    assert.equal(hooks.length, 2);
    const [guidance, recall] = hooks;
    assert.equal(guidance.name, "before_prompt_build");
    assert.match(guidance.handler({}, {}).appendSystemContext, /Dexio wiki/);
    assert.deepEqual(recall.opts, { requiresToolAuthority: true });

    assert.equal(await recall.handler({ currentUserMessage: "What did Tallpine offer?" }, { toolAuthority: authority(false) }), undefined);
    assert.equal(await recall.handler({ currentUserMessage: "What did Tallpine offer?" }, {}), undefined);
    assert.equal(calls.length, 0);

    const out = await recall.handler({ currentUserMessage: "What did   Tallpine offer?", prompt: "ignored" }, { toolAuthority: authority(true) });
    assert.match(out.prependContext, /^## From your Dexio wiki/);
    assert.match(out.prependContext, /Juniper Street Cafe \(`customers\/juniper`\)\n {4}Tallpine offered \$9\.25 a pound/);
    assert.doesNotMatch(out.prependContext, /title: Juniper/);
    assert.deepEqual(calls[0].args, { query: "What did Tallpine offer?", limit: 2, matches_per_page: 3 });

    await recall.handler({ currentUserMessage: "What did Tallpine offer?" }, { toolAuthority: authority(true) });
    assert.equal(calls.length, 1, "the same message is searched once");
    assert.equal(await recall.handler({ currentUserMessage: "hi" }, { toolAuthority: authority(true) }), undefined);

    mode = "401";
    assert.equal(await recall.handler({ currentUserMessage: "a new question" }, { toolAuthority: authority(true) }), undefined);
  });

  test("autoRecall off registers only the guidance", () => {
    const { hooks } = fakeApi({ apiKey: "dxk_t", url, autoRecall: false });
    assert.equal(hooks.length, 1);
  });
});

describe("recall block", () => {
  test("query and size bounds", () => {
    assert.equal(recallQuery("  a\n b  " + "x".repeat(400)).length, 300);
    const many = Array.from({ length: 10 }, (_, i) => ({
      path: `p/${i}`, title: `T${i}`, matches: [{ text: "y".repeat(500) }, { text: "z".repeat(500) }, { text: "w".repeat(500) }],
    }));
    const block = formatRecall(many, 10);
    assert.ok(block.length <= RECALL_CHARS);
    assert.equal(formatRecall([], 4), "");
    assert.equal(formatRecall(undefined, 4), "");
  });
});
