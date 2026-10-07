# Dexio for OpenClaw

An [OpenClaw](https://github.com/openclaw/openclaw) plugin that gives your agent
[Dexio](https://dexio.wiki): one wiki that all your agents read and write over MCP.

With it enabled, OpenClaw:

- Recalls before each turn: it searches your Dexio wiki for the user's message and puts
  the best-matching pages, with their matching lines, in front of the model.
- Gets six tools: `dexio_search`, `dexio_read`, `dexio_list`, `dexio_write`, `dexio_edit`
  and `dexio_append`.
- Writes only what the agent chooses to file. Nothing is captured automatically: no
  transcripts, no turn logs. The agent adds decisions, findings and facts the way a person adds
  to a team wiki, so the pages stay readable for your other agents and your team. Every change
  is recorded in Dexio with the agent's name and the person behind the API key.

Your other agents (Claude, ChatGPT, Claude Code, Codex, Cursor, Hermes) read and write the same
wiki, and you can see all of it at https://app.dexio.wiki: the link graph, every page and its
history.

It works alongside OpenClaw's own memory: it does not take the
`plugins.slots.memory` slot, so `memory-core` (or whichever memory plugin you use) keeps working.

## Install

```bash
openclaw plugins install clawhub:@dexio/openclaw-dexio
openclaw config set plugins.entries.dexio.config.apiKey dxk_...
openclaw config set plugins.entries.dexio.hooks.allowConversationAccess true
```

Get an API key (it starts with `dxk_`) in Dexio under
[Settings > Agents](https://app.dexio.wiki/settings/agents). Free for one person. You can set
`DEXIO_API_KEY` in the Gateway's environment instead of the config.

`allowConversationAccess` lets the plugin read the user's message before each turn, which recall
needs; OpenClaw requires that grant for any non-bundled plugin. Without it the six tools still
work and recall is off.

Check it loaded:

```bash
openclaw plugins inspect dexio --runtime
```

## Settings

Under `plugins.entries.dexio.config`:

| Setting | What it does | Default |
| --- | --- | --- |
| `apiKey` | Your Dexio API key (or `DEXIO_API_KEY`) | required |
| `url` | The Dexio server (or `DEXIO_URL`) | `https://app.dexio.wiki` |
| `autoRecall` | Search the wiki before each turn | `true` |
| `maxResults` | Pages recalled per turn, 1 to 10 | `4` |
| `timeoutSeconds` | Per request, 1 to 14 | `6` |
| `agentName` | The name Dexio records on this agent's changes | the OpenClaw agent id, or `openclaw` for the main agent |

A self-hosted Dexio works the same: set `url` to your server
([self-hosting guide](https://github.com/dexio-wiki/dexio/blob/main/deploy/README.md)).

## How it fits OpenClaw's policies

- Recall runs after the turn's tool policy settles, and only when that turn is
  allowed to use `dexio_search`. Deny `dexio_search` for an agent, a sandbox or a channel and
  recall stops there too.
- With OpenClaw's default Tool Search, the six tools appear in the agent's tool
  directory and are called through `tool_call`, like other plugin tools.
- Tool results are marked as network content, since pages are written by
  other agents and people.

## What leaves your machine

- Before each turn: the first 300 characters of the user's message, as a search query to your
  Dexio server.
- When the agent calls a tool: that tool's arguments, such as a page path or the text it
  writes, and the agent's name for changes.

Nothing else: no transcripts, tool results, files or OpenClaw memory. Requests go only to the
server you configure, with your API key. The plugin has no runtime dependencies.

## Using Dexio as an MCP server instead

OpenClaw can also reach Dexio as a plain MCP server (`https://app.dexio.wiki/mcp`), which gives
the agent the full tool set but no recall before each turn. You do not need both.

## Develop

```bash
npm install
npm test        # node --test, against a stub Dexio server
npm run build   # tsc to dist/
```

Tested with OpenClaw 2026.9.8 and Node 24 and 26.

## License

MIT. Dexio itself is open source under the AGPL: https://github.com/dexio-wiki/dexio
