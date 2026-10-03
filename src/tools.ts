// The six agent tools. Each calls one of Dexio's MCP tools.

import type { DexioClient, DexioResult } from "./client.ts";

type Schema = Record<string, unknown>;

export type ToolResult = { content: Array<{ type: "text"; text: string }>; details: DexioResult };

export type DexioTool = {
  name: string;
  label: string;
  description: string;
  parameters: Schema;
  resultContentSource: "network";
  execute: (toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<ToolResult>;
};

const s = (description?: string): Schema => (description ? { type: "string", description } : { type: "string" });
const NOTE = s("One line: what changed and why");

function object(properties: Record<string, Schema>, required: string[] = []): Schema {
  return { type: "object", properties, required, additionalProperties: false };
}

type Spec = {
  name: string;
  label: string;
  description: string;
  parameters: Schema;
  writes: boolean;
  run: (p: Record<string, unknown>, agent: string) => [string, Record<string, unknown>];
};

const SPECS: Spec[] = [
  {
    name: "dexio_search",
    label: "Search Dexio",
    description:
      "Search the shared Dexio wiki (paths, titles and text). Matches a question's words, best first, with the matching lines.",
    parameters: object(
      {
        query: s("Words to look for"),
        folder: s("Only search this folder (optional)"),
        limit: { type: "integer", minimum: 1, maximum: 50, description: "Most pages to return (default 10)" },
      },
      ["query"],
    ),
    writes: false,
    run: (p) => {
      if (!String(p.query ?? "").trim()) throw new Error("query is required");
      return ["search_pages", pick(p, "query", "folder", "limit")];
    },
  },
  {
    name: "dexio_read",
    label: "Read a Dexio page",
    description:
      "Read one page of the Dexio wiki: its markdown, plus its version and the pages it links to and from.",
    parameters: object(
      { path: s("Page path, e.g. customers/acme"), section: s("Only this heading's section (optional)") },
      ["path"],
    ),
    writes: false,
    run: (p) => ["read_page", pick(p, "path", "section")],
  },
  {
    name: "dexio_list",
    label: "List Dexio pages",
    description: "List the wiki's pages, or one folder's, with titles and descriptions.",
    parameters: object({ folder: s("Folder to list (optional)") }),
    writes: false,
    run: (p) => ["list_pages", pick(p, "folder")],
  },
  {
    name: "dexio_write",
    label: "Write a Dexio page",
    description:
      "Create a page or replace its whole text in the Dexio wiki. Search first and update the existing page rather than creating a duplicate; use dexio_edit for part of a page. Link related pages with [[path]].",
    parameters: object(
      {
        path: s("Page path, e.g. decisions/pricing"),
        text: s("The whole page, in markdown"),
        note: NOTE,
        base_version: s("Fail if the page changed since this version"),
      },
      ["path", "text"],
    ),
    writes: true,
    run: (p, agent) => ["write_page", { ...pick(p, "path", "text", "note", "base_version"), agent }],
  },
  {
    name: "dexio_edit",
    label: "Edit a Dexio page",
    description:
      "Change part of a Dexio page: replace an exact piece of text (old_text, unique on the page) with new_text.",
    parameters: object(
      {
        path: s("Page path"),
        old_text: s("Exact text to replace"),
        new_text: s("Replacement; empty deletes"),
        note: NOTE,
      },
      ["path", "old_text", "new_text"],
    ),
    writes: true,
    run: (p, agent) => {
      if (!String(p.old_text ?? "")) throw new Error("old_text is required");
      // An empty new_text deletes old_text.
      return ["edit_page", { ...pick(p, "path", "old_text", "note"), new_text: String(p.new_text ?? ""), agent }];
    },
  },
  {
    name: "dexio_append",
    label: "Append to a Dexio page",
    description: "Add text to the end of a Dexio page, creating it if needed (logs, lists).",
    parameters: object({ path: s("Page path"), text: s("Text to add"), note: NOTE }, ["path", "text"]),
    writes: true,
    run: (p, agent) => ["append_page", { ...pick(p, "path", "text", "note"), agent }],
  },
];

export const TOOL_NAMES = SPECS.map((t) => t.name);

export function buildTools(client: DexioClient, agent: string, onWrite: () => void): DexioTool[] {
  return SPECS.map((spec) => ({
    name: spec.name,
    label: spec.label,
    description: spec.description,
    parameters: spec.parameters,
    // Wiki pages are written by other agents and people: treat what comes back as outside content.
    resultContentSource: "network" as const,
    async execute(_toolCallId: string, params: Record<string, unknown>, signal?: AbortSignal) {
      const [tool, args] = spec.run(params ?? {}, agent);
      const out = await client.call(tool, args, signal); // throws DexioError on failure
      if (spec.writes) onWrite(); // the next turn's recall should see the change
      return { content: [{ type: "text" as const, text: render(tool, out) }], details: out };
    },
  }));
}

// A page reads better as its JSON header, then the markdown itself, than as one escaped string.
function render(tool: string, out: DexioResult): string {
  if (tool === "read_page" && typeof out.text === "string") {
    const { text, ...header } = out;
    return `${JSON.stringify(header)}\n\n${text}`;
  }
  return JSON.stringify(out);
}

function pick(p: Record<string, unknown>, ...keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (p[k] !== undefined && p[k] !== null && p[k] !== "") out[k] = p[k];
  return out;
}
