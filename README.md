# pi-kiro-models

Bridge Kiro CLI's premium AI models into the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) via the Agent Client Protocol (ACP).

![Status](https://img.shields.io/badge/status-chat%20%2B%20MCP%20passthrough-brightgreen)
![Platform](https://img.shields.io/badge/platform-macOS%20%7C%20Linux-lightgrey)
![Runtime](https://img.shields.io/badge/runtime-Node.js%2020%2B-green)

---

## Overview

[pi](https://github.com/earendil-works/pi-coding-agent) is a terminal-based AI coding agent. [Kiro](https://kiro.dev) is Amazon's AI coding agent that gives you access to 15 premium models (Claude Sonnet 5, Opus 4.8, DeepSeek V3.2, etc.) through a single subscription.

**This extension bridges Kiro's models into pi.** Once installed, you select a Kiro model in pi with `/model` and chat with it — token-by-token streaming, full conversation context, and the same workflow you use with any other provider.

### How it works

```
pi TUI  →  Extension (streamSimple)  →  ACP Client (NDJSON over stdio)  →  kiro-cli-chat acp --agent pi-bridge  →  Kiro API
```

1. pi loads the extension, which registers a `kiro` provider with 15 models.
2. On the first prompt, the extension writes a `pi-bridge` Kiro agent config to `~/.config/kiro/agents/pi-bridge.json` (idempotent) and spawns `kiro-cli-chat acp --agent pi-bridge` as a child process. It completes the ACP handshake (`initialize` + `session/new`), then issues `session/set_model` for the pi-selected model.
3. For each prompt, the extension renders pi's `systemPrompt` and any new turns in `context.messages` into a tagged transcript and sends only the delta as `session/prompt`. Kiro's own session state persists prior turns.
4. Kiro streams `agent_message_chunk` notifications, which the extension maps to pi's `text_delta` events.

### Tools

Inference for Kiro models runs inside **Kiro's own agent loop** — Kiro executes tool calls itself and streams back text. pi forwards the transcript and displays the result; pi does not execute tools on Kiro's behalf.

Two classes of tools are available to the bridged model:

1. **Kiro's native tools** — `fs_read`, `fs_write`, `execute_bash`, `glob`, `grep`, `web_fetch`, `web_search`.
2. **MCP servers you've configured** — the bridge discovers every MCP server in your Kiro `mcp.json` files and forwards them to the session, so their tools are callable directly by the model. See [MCP Tool Passthrough](#mcp-tool-passthrough).

> **Why not forward pi's own tools?** pi's `ExtensionAPI` exposes tool *definitions* (`getAllTools()`) but no way for one extension to *execute* another's tool, and Kiro — not pi — drives the agent loop for Kiro models. So pi's in-process tools (`read`/`edit`/etc.) can't be handed to Kiro generically. The forwardable, future-proof surface is **MCP**, which Kiro runs natively. Any tool you want available to a Kiro model should be exposed as an MCP server.

---

## Features

- **15 models** from Kiro's catalog — Claude Sonnet 5, Opus 4.8/4.7/4.6/4.5, Sonnet 4.6/4.5/4, Haiku 4.5, DeepSeek V3.2, GLM-5, Qwen3 Coder Next, and more
- **Dynamic MCP tool passthrough** — every MCP server in your Kiro `mcp.json` is auto-forwarded to the bridged model. Add a server to `mcp.json`, restart pi, and its tools are callable — no bridge edits. See [MCP Tool Passthrough](#mcp-tool-passthrough).
- **Model routing via `session/set_model`** — pi's `/model` selection actually reaches Kiro (not just the `auto` default)
- **Token-by-token streaming** into pi's TUI
- **Full pi context passthrough** — `systemPrompt`, prior turns, tool calls, and tool results are rendered as a tagged transcript (`<pi-system-prompt>`, `<pi-transcript>`, `<user>`, `<assistant>`, `<tool_call>`, `<tool_result>`). Only the delta since the last send is forwarded per turn; Kiro's own session state persists prior turns.
- **Automatic process management** — spawns on first use, cleans up on pi exit, respawns if the child dies
- **Ctrl+C cancellation** — sends `session/cancel` to Kiro
- **No API key needed** — uses your existing Kiro CLI authentication (AWS IAM Identity Center)

---

## Stack

| Component | Technology |
|---|---|
| Runtime | Node.js 20+ (loaded by pi's jiti) |
| Language | TypeScript |
| Protocol | Agent Client Protocol (ACP) over stdio |
| Framing | NDJSON (newline-delimited JSON-RPC 2.0) |
| Transport | Child process spawn with stdio pipes |
| Authentication | Inherited from `kiro-cli` (IAM Identity Center) |

---

## Architecture

```
┌──────────────────────────────────────────────────────────┐
│ pi (host)                                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │ kiro-provider extension (index.ts)                 │  │
│  │  ┌──────────────┐  ┌─────────────────────────────┐  │  │
│  │  │ 15 models    │  │ streamKiro() — bridges ACP  │  │  │
│  │  │ registered   │  │ to pi's AssistantMessage    │  │  │
│  │  └──────────────┘  │ EventStream                 │  │  │
│  │                    └──────────────┬──────────────┘  │  │
│  │  ┌─────────────────────────────────▼──────────────┐  │  │
│  │  │ ACPClient (NDJSON, request/response,           │  │  │
│  │  │ notification dispatch)                         │  │  │
│  │  └─────────────────────────────────┬──────────────┘  │  │
│  └────────────────────────────────────┼─────────────────┘  │
└─────────────────────────────────────┼────────────────────┘
                                      │ stdin/stdout (NDJSON)
                                      │
┌─────────────────────────────────────▼────────────────────┐
│ kiro-cli-chat acp (child process)                        │
│  - ACP session state                                     │
│  - Built-in tool execution (read, write, shell, etc.)   │
│  - IAM Identity Center auth                              │
└──────────────────────────────────────────────────────────┘
```

**Data flow per prompt:**

1. pi calls `streamSimple(model, context, options)`
2. Extension ensures the `pi-bridge` Kiro agent config exists at `~/.config/kiro/agents/pi-bridge.json` and spawns `kiro-cli-chat acp --agent pi-bridge` on the first call (cached across turns). It forwards every MCP server found in your Kiro `mcp.json` files via `session/new` `mcpServers`, so their tools are callable by the model.
3. Extension issues `session/set_model` if pi's selected model differs from Kiro's current model.
4. Extension renders `context.systemPrompt` and any new `context.messages` into a tagged transcript (`<pi-system-prompt>`, `<pi-transcript>`, `<user>`, `<assistant>`, `<tool_call>`, `<tool_result>`) and sends it as `session/prompt`. Only the delta since the previous send is included — Kiro maintains its own session history for prior turns.
5. Kiro streams `session/update` notifications with `agent_message_chunk`.
6. Extension maps each chunk to a `text_delta` event on pi's stream.
7. Kiro responds to `session/prompt` with `stopReason: "end_turn"`.
8. Extension pushes `done`, records `lastMessageCount` on the session, and ends the stream.

**Context passthrough limits:**

- pi's `systemPrompt` reaches the model as authoritative context (facts, conventions, project details) and is respected in the model's answers.
- Kiro's underlying agent has a fixed self-identity ("I'm Kiro") that its ACP `--agent` mode overlay does not override. Attempts to force identity change via pi's systemPrompt will be refused by the model. This is a Kiro-side limitation; pi's operational context still works.

---

## Models

All 15 models from the Kiro catalog:

| Model | Context | Notes |
|---|---|---|
| `auto` | 1M | Auto-routing |
| `claude-sonnet-5` | 1M | Experimental preview |
| `claude-opus-4.8` | 1M | |
| `claude-opus-4.7` | 1M | |
| `claude-opus-4.6` | 1M | |
| `claude-sonnet-4.6` | 1M | |
| `claude-opus-4.5` | 200K | |
| `claude-sonnet-4.5` | 200K | |
| `claude-sonnet-4` | 200K | |
| `claude-haiku-4.5` | 200K | Cheapest/fastest |
| `deepseek-3.2` | 164K | Experimental |
| `minimax-m2.5` | 196K | |
| `minimax-m2.1` | 196K | Experimental |
| `glm-5` | 200K | |
| `qwen3-coder-next` | 256K | Experimental, cheap |

---

## Prerequisites

- [pi coding agent](https://github.com/earendil-works/pi-coding-agent) installed (`pi` on PATH)
- [Kiro CLI](https://kiro.dev) installed (`kiro-cli-chat` available)
- Kiro CLI authenticated (`kiro-cli-chat whoami` shows your IAM user)
- An active Kiro subscription
- Node.js 20+ (bundled with pi's installer)

---

## Installation

### Method 1: Clone from GitHub

```bash
cd ~/.pi/agent/extensions/
git clone https://github.com/yanralapdy/pi-kiro-models.git kiro-provider
```

### Method 2: Symlink from a dev location

```bash
ln -s ~/sites/js/node/pi-kiro-models ~/.pi/agent/extensions/kiro-provider
```

### Method 3: Register in `settings.json`

If auto-discovery doesn't pick up the extension, add it explicitly to `~/.config/pi/agent/settings.json`:

```json
{
  "extensions": [
    "~/sites/js/node/pi-kiro-models/index.ts"
  ]
}
```

---

## Usage

```bash
pi
```

In pi, run:

```
/model
```

Scroll to the `kiro` provider. Select any model (e.g., `kiro/claude-haiku-4.5` for cheap/fast testing or `kiro/claude-sonnet-5` for premium quality).

Start chatting. Text streams token-by-token. Ctrl+C cancels.

---

## MCP Tool Passthrough

The bridge gives Kiro models access to [Model Context Protocol](https://modelcontextprotocol.io) servers. On each session it discovers the MCP servers configured for Kiro and forwards them two ways:

- **ACP `session/new` `mcpServers`** — connects the servers for the bridged ACP session (the mechanism that makes the tools callable).
- **`@server` entries in the generated `pi-bridge` agent config** — allows the servers' tools.

This is fully dynamic: add a server to any Kiro `mcp.json`, start a fresh pi session, and the model can call its tools. No changes to this extension are needed for new tools.

### Where servers are read from

Discovered and unioned by name (later overrides earlier, so a workspace entry overrides a global one):

1. `~/.config/kiro/settings/mcp.json` (global)
2. `~/.kiro/settings/mcp.json` (global)
3. `<cwd>/.kiro/settings/mcp.json` (per-project)

Only **stdio** (command-based) servers are forwarded. HTTP/SSE (`url`) servers are currently skipped.

### Register a server

Use the Kiro CLI (writes global config unless run inside a project, which writes the workspace config):

```bash
# stdio server on PATH or by absolute path
kiro-cli-chat mcp add --name my-tool --command /absolute/path/to/my-mcp-server

# with arguments and environment variables
kiro-cli-chat mcp add --name notion \
  --command npx --args "-y,@notionhq/notion-mcp-server" \
  --env NOTION_TOKEN=secret
```

Or edit `mcp.json` directly:

```json
{
  "mcpServers": {
    "my-tool": {
      "command": "/absolute/path/to/my-mcp-server",
      "args": [],
      "env": {}
    }
  }
}
```

Then start a fresh pi session. On startup you'll see the servers being forwarded:

```
[kiro-provider] Wrote Kiro agent config at ~/.config/kiro/agents/pi-bridge.json (mcp: notion, my-tool)
[kiro-provider] Forwarding 2 MCP server(s) to Kiro: notion, my-tool
```

Ask the model to call one of the server's tools to confirm.

### Verify

```
# in pi, with a Kiro model selected
call the list_projects tool          # example: codebase-memory-mcp
```

Or test the underlying agent directly, bypassing pi:

```bash
kiro-cli-chat chat --agent pi-bridge --no-interactive --trust-all-tools \
  "Call the list_projects tool and paste its output."
```

### Notes

- The `pi-bridge` agent config at `~/.config/kiro/agents/pi-bridge.json` is **generated** — it's regenerated each session from your `mcp.json`. Don't hand-edit it; edit `mcp.json` instead.
- Servers with `"disabled": true` in `mcp.json` are skipped.
- Server env values are copied into the ACP session config; treat the Kiro config tree as you would any file holding secrets.

---

## Testing

Test scripts in `test/`:

```bash
# NDJSON framing with a mock echo process
jiti test/framing.test.ts

# ACP handshake with the real kiro-cli-chat binary
jiti test/lifecycle.test.ts

# Text streaming + Ctrl+C abort
jiti test/stream.test.ts
jiti test/abort.test.ts

# Respawn after external kill
jiti test/lifecycle-cleanup.test.ts

# Transcript rendering + delta-send prompt building (pure, no ACP)
jiti test/transcript.test.ts

# End-to-end multi-turn passthrough with a real Kiro session
jiti test/context.test.ts
```

Run with pi's bundled jiti:

```bash
/Users/tnkapdy/.nvm/versions/node/v24.17.0/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/.bin/jiti test/framing.test.ts
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `[kiro-provider] Extension loaded` not in output | Extension not discovered | Add path to `settings.json` → `extensions` |
| `baseUrl is required` error | Missing `baseUrl` in provider config | Update to latest version |
| `Provider kiro: "baseUrl" is required when defining models` | Same as above | Same |
| `spawn ~/.local/bin/kiro-cli-chat ENOENT` | Kiro CLI not installed or wrong path | Set `KIRO_CLI_CHAT` env var to absolute path |
| `Authentication failed` | Kiro not logged in | Run `kiro-cli-chat login` |
| Text doesn't stream, hangs for 30s | Kiro backend slow or network issue | Retry; check `kiro-cli-chat whoami` |
| Orphaned `kiro-cli-chat` processes after pi exit | Process exit handler not firing | Report an issue; manually `pkill -f kiro-cli-chat` |
| Model self-identifies as "Kiro" not pi | Kiro's built-in identity system prompt overrides `pi-bridge` mode overlay | Expected. pi's `systemPrompt` still delivers factual context (project name, tools, conventions). Identity swap is a Kiro-side limitation. |
| Selecting different `kiro/*` models has no effect | `session/set_model` failed silently | Check `stderr` for `session/set_model failed`; verify model id is in the [Kiro model list](#models); ensure Kiro subscription includes the model |
| pi's `systemPrompt` seems ignored | pi-bridge Kiro agent missing or stale | Delete `~/.config/kiro/agents/pi-bridge.json` and let the extension recreate it on the next run |
| MCP tool not available to the model | Server not in a discovered `mcp.json`, is `disabled`, or is a `url` (HTTP/SSE) server | Add it to a [discovered `mcp.json`](#where-servers-are-read-from) as a stdio (`command`) server; check startup log for `Forwarding N MCP server(s)`; start a fresh session |
| MCP server registered but tools still missing | Session started before the server was added | Restart pi — servers are forwarded at session creation |

---

## Roadmap

- [x] V1: Chat-only bridge with all 15 models
- [x] MCP tool passthrough — dynamically forward configured MCP servers to the bridged model (`session/new` `mcpServers` + generated `@server` agent config)
- [ ] HTTP/SSE MCP server support (currently stdio only)
- [ ] Multi-session support (concurrent pi processes)
- [ ] Image input (Kiro ACP supports images; pi has ImageContent)

---

## Legal & Compliance

- This extension uses ACP, an official open protocol documented at [agentclientprotocol.com](https://agentclientprotocol.com)
- Kiro CLI explicitly supports ACP for third-party integrations (see [kiro.dev/docs/cli/acp](https://kiro.dev/docs/cli/acp))
- No reverse engineering or unofficial APIs used
- Requires valid Kiro subscription

---

## License

MIT

---

## Contributing

Issues and PRs welcome. Test with Kiro CLI v2.5.0+.
