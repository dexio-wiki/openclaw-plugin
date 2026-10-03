// Recall before each turn: one search of the wiki for the user's message.

export const RECALL_CHARS = 3000; // the most one turn's recall block adds to the prompt
export const QUERY_CHARS = 300; // long messages are searched by their opening

type Hit = { path?: string; title?: string; matches?: Array<{ text?: string }> };

export function recallQuery(message: string): string {
  return message.split(/\s+/).filter(Boolean).join(" ").slice(0, QUERY_CHARS);
}

export function formatRecall(results: unknown, maxResults: number): string {
  if (!Array.isArray(results) || results.length === 0) return "";
  const lines = [
    "## From your Dexio wiki",
    "Pages that match this message. Read one with dexio_read before relying on it.",
  ];
  for (const hit of results.slice(0, maxResults) as Hit[]) {
    const title = hit.title || hit.path || "";
    lines.push(`- ${title} (\`${hit.path ?? ""}\`)`);
    for (const m of (hit.matches ?? []).slice(0, 3)) {
      const text = String(m?.text ?? "").split(/\s+/).filter(Boolean).join(" ");
      if (text && text !== `title: ${title}`) lines.push(`    ${text.slice(0, 240)}`);
    }
  }
  const block = lines.join("\n");
  if (block.length <= RECALL_CHARS) return block;
  const cut = block.slice(0, RECALL_CHARS);
  return cut.slice(0, cut.lastIndexOf("\n"));
}

export const GUIDANCE =
  "# Dexio wiki\n" +
  "You share a wiki with the user's other agents and their team. Before a turn, pages that " +
  'match the user\'s message may appear under "From your Dexio wiki". Use dexio_search and ' +
  "dexio_read to look things up. When you learn something other agents or people should know " +
  "later (a decision and its reason, how a system works, a fact about a customer or project), " +
  "file it with dexio_write, dexio_edit or dexio_append: search first and update the existing " +
  "page instead of making a duplicate, link related pages with [[path]], and give a one-line " +
  "note. Do not file secrets or passing chatter.";

// A small cache so a rebuilt prompt for the same message does not search twice.
export class RecallCache {
  private readonly entries = new Map<string, string>();
  get(q: string): string | undefined {
    return this.entries.get(q);
  }
  set(q: string, block: string): void {
    if (this.entries.size > 32) this.entries.clear();
    this.entries.set(q, block);
  }
  clear(): void {
    this.entries.clear();
  }
}
