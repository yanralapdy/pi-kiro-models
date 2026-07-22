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
pi outer loop
  │ streamSimple + active extension catalog
  ├── loopback HTTP MCP (pi_host) ──► Kiro inner loop
  │                                  │ tools/call
  │                                  ▼
  └──── normal Pi tool call ◄── host handoff ──┘
```

1. pi loads the extension, which registers a `kiro` provider with the live model catalog.
2. On the first prompt, the extension writes the `pi-bridge` Kiro agent config, starts an authenticated `127.0.0.1` HTTP MCP adapter, and spawns `kiro-cli-chat acp`. The ACP `session/new` request retains configured stdio MCP servers and adds `pi_host`.
3. Each independent turn rebuilds the active extension-tool catalog. Catalog changes recreate only the internal Kiro session and replay Pi context.
4. Ordinary prompts render Pi's system prompt and transcript delta into `session/prompt`.
5. When Kiro calls a forwarded tool, the adapter suspends its HTTP request; Pi receives the original tool name as a normal tool call and runs its existing validation, hooks, UI, and result persistence.
6. The next Pi turn returns the recorded result to the waiting MCP request, so Kiro continues the original ACP prompt. Forwarded calls are serialized.

### Tools

Kiro still owns the inner agent loop, but forwarded extension calls execute through Pi's outer tool lifecycle. The bridged model sees three distinct tool classes:

1. **Kiro native tools** — `fs_read`, `fs_write`, `execute_bash`, `glob`, `grep`, `web_fetch`, and `web_search`.
2. **Configured Kiro MCP tools** — stdio servers from discovered `mcp.json` files remain direct Kiro MCP tools. See [MCP Tool Passthrough](#mcp-tool-passthrough).
3. **Host-executed Pi extension tools** — active extension-contributed tools are published through the authenticated `pi_host` loopback MCP adapter. Kiro calls the adapter, Pi executes the original tool with its normal validation, hooks, UI, and session recording, then the result returns to Kiro.

Pi built-in coding tools (`read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls`) are intentionally excluded because Kiro already provides native equivalents. Forwarded calls are serialized. A blocked or failed Pi tool is returned to Kiro as an MCP error rather than a false success. Tool names that Kiro rejects receive deterministic aliases.

See [ADR 0001](docs/adr/0001-bridge-active-pi-extension-tools-through-host-execution.md) for the architecture decision.

---

## Features

- **15 models** from Kiro's catalog — Claude Sonnet 5, Opus 4.8/4.7/4.6/4.5, Sonnet 4.6/4.5/4, Haiku 4.5, DeepSeek V3.2, GLM-5, Qwen3 Coder Next, and more
- **Dynamic MCP tool passthrough** — every MCP server in your Kiro `mcp.json` is auto-forwarded to the bridged model. Add a server to `mcp.json`, restart pi, and its tools are callable — no bridge edits. See [MCP Tool Passthrough](#mcp-tool-passthrough).
- **Host-executed Pi extension tools** — active extension tools are discovered each turn and called through the authenticated loopback `pi_host` adapter.
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
| Transport | ACP NDJSON stdio plus authenticated loopback Streamable HTTP MCP |
| Authentication | Kiro CLI auth plus per-session random bearer token for `pi_host` |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ pi outer loop                                               │
│  streamKiro ── catalog + KiroToolCoordinator                │
│       │                                                     │
│       ├── 127.0.0.1:ephemeral /mcp (bearer token) ───────┐  │
│       │                                                    │  │
│       └── ACPClient NDJSON ── kiro-cli-chat acp             │  │
│                                      Kiro inner loop ◄──────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Data flow per prompt:**

1. pi calls `streamSimple(model, context, options)`.
2. The extension discovers active extension metadata, excludes Pi built-ins, and starts/reuses the `pi_host` adapter plus Kiro ACP session.
3. The session retains configured stdio MCP servers and adds the adapter as an HTTP MCP server.
4. Text turns send only the transcript delta. A Kiro `tools/call` suspends its MCP HTTP response and emits a normal Pi `toolCall` event with the original Pi name.
5. Pi executes the tool and appends its authoritative `ToolResultMessage`. The next provider invocation resolves the suspended MCP request without sending another ACP prompt.
6. Kiro continues and streams `agent_message_chunk` notifications. Catalog changes recreate the disposable internal Kiro session before the next independent turn.
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

## Host-executed Pi extension tools

The bridge advertises active extension-contributed tools through a short-lived `pi_host` Streamable HTTP MCP server. The server binds only to `127.0.0.1`, uses an ephemeral port and random bearer token, and accepts Kiro's missing `Origin` header while rejecting supplied untrusted origins.

On a forwarded call:

1. Kiro sends `tools/call` to `pi_host`.
2. Pi emits a normal `toolcall_start`/`toolcall_delta`/`toolcall_end` sequence using the original Pi name.
3. Pi's regular loop validates and executes the tool, including existing blockers and hooks.
4. The next Pi turn returns the recorded result to Kiro. Failures use MCP `isError: true`.

Only active extension tools are exposed. Built-in Pi coding tools are excluded, aliases are deterministic for incompatible names, and calls are serialized in v1. A changed active catalog is applied by recreating the internal Kiro session on the next independent turn.

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
# ACP framing with a mock echo process
jiti test/framing.test.ts

# Active extension catalog and aliases
jiti test/catalog.test.ts

# Authenticated loopback MCP adapter
jiti test/tool-bridge.test.ts

# Existing configured stdio MCP discovery regression
jiti test/mcp-discovery.test.ts

# Suspended Kiro-to-Pi handoff state machine
jiti test/tool-coordinator.test.ts

# Text streaming + Ctrl+C abort
jiti test/stream.test.ts
jiti test/abort.test.ts

# Respawn after external kill
jiti test/lifecycle-cleanup.test.ts

# Transcript rendering + delta-send prompt building
jiti test/transcript.test.ts

# Authenticated Kiro HTTP MCP wire probe (requires Kiro auth)
KIRO_HTTP_MCP_PROBE=1 jiti test/http-mcp-probe.test.ts

# End-to-end multi-turn context passthrough (requires Kiro auth)
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
| Host extension tool is missing | Tool is inactive, built-in, or catalog refresh is pending | Confirm the extension is active; start a new independent turn and check the catalog-change diagnostic |
| Forwarded call is blocked or fails | Pi's normal tool blocker/validation rejected it | Read the returned tool error; Kiro can recover, but the bridge never bypasses Pi policy |
| Kiro cannot connect to `pi_host` | Adapter stopped with the ACP child or the session was replaced | Retry the turn; the bridge recreates the adapter with a new token and port |

---

## Roadmap

- [x] V1: Chat-only bridge with all 15 models
- [x] MCP tool passthrough — dynamically forward configured stdio MCP servers to the bridged model
- [x] Host-executed active Pi extension tools via authenticated loopback HTTP MCP
- [ ] HTTP/SSE MCP servers in the user's `mcp.json` (the existing config reader remains stdio-only)
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
