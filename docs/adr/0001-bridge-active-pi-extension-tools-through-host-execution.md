# ADR 0001: Bridge active Pi extension tools through host execution

- Status: accepted
- Deciders: project maintainer
- Date: 2026-07-21
- Tags: pi, kiro, acp, mcp, tools

## Context and Problem Statement

Kiro-backed models run inside Kiro's ACP agent loop, while Pi owns the
registered tools and their execution lifecycle. Pi can provide the active tool
schemas to a provider, but an extension cannot directly execute another
extension's tool through the public `ExtensionAPI`. As a result, tools such as
`peer_list` and `peer_send` may be registered in Pi yet remain unavailable to
the Kiro model.

The bridge must make active extension-contributed Pi tools genuinely callable,
not merely describe them in a prompt. Kiro's ACP implementation advertises
HTTP MCP support, while ACP does not provide a generic client-side tool
execution method for arbitrary Pi extensions.

## Decision Drivers

- Forwarded tools must execute through Pi's normal lifecycle.
- Existing validation, tool-call hooks, result hooks, UI, and transcript
  recording must remain authoritative.
- Newly registered or activated extension tools must be discovered without
  bridge-specific code for each package.
- The solution should not require a Pi core API change.
- Existing direct Kiro MCP passthrough must continue working.
- Tool-set changes must become effective deterministically.
- The adapter must not expose a local tool-execution endpoint to other hosts or
  unauthenticated local processes.
- Pi tool names that violate Kiro's MCP naming constraints must remain callable.

## Considered Options

- Option A: Local MCP adapter with host-execution handoff
- Option B: Add a cross-extension `executeTool` API to Pi core
- Option C: Forward schemas or prompt instructions only
- Option D: Require every Pi extension to expose a separate Kiro MCP server

## Decision Outcome

Chosen option: **Local MCP adapter with host-execution handoff**.

The bridge will expose the currently active extension-contributed Pi tools via
an authenticated loopback HTTP MCP endpoint. The endpoint obtains tool schemas
from the active Pi provider context. When Kiro invokes one of these tools, the
bridge hands the request back to the normal Pi agent loop as a tool call. Pi
executes it using its existing tool machinery; the bridge then returns the
recorded result to the waiting Kiro turn.

Forwarded calls are serialized initially. If the active extension tool set
changes, the bridge recreates only its internal Kiro ACP session before the
next request and replays the Pi transcript. Existing direct Kiro MCP
passthrough is retained alongside this adapter. Pi's active tool set and
existing hooks are the only policy authority; no second bridge-specific
allow/deny configuration is introduced.

The adapter binds to `127.0.0.1` on an ephemeral port, requires a random
per-session bearer token, and shuts down with the internal Kiro session. Tool
names that Kiro cannot accept are mapped to deterministic safe aliases. A
blocked or failed Pi tool call is returned to Kiro as a tool error so the model
can recover; user cancellation or a lost bridge connection still ends the
turn.

## Consequences

### Positive Consequences

- Kiro can call `peer_list`, `peer_send`, and future active extension tools
  without bridge-specific registrations.
- Pi remains the execution authority, so existing safety hooks and tool result
  behavior are preserved.
- Tool discovery follows Pi's runtime tool registry rather than a duplicated
  catalog.
- Existing Kiro MCP integrations remain available.
- Pi tools with Kiro-incompatible names remain reachable through stable aliases.

### Negative Consequences

- The bridge must maintain a local MCP server and a handoff state machine.
- A forwarded call adds a round trip through Kiro, the bridge, and Pi.
- Calls are initially serialized, so parallel Kiro tool requests may be slower.
- Recreating the internal Kiro session on tool-set changes can discard Kiro's
  hidden session cache; the Pi transcript remains the source of truth for
  replay.
- Loopback authentication, cancellation, disconnect, and stale-request
  cleanup require explicit handling.
- Alias generation and collision handling become part of the compatibility
  contract.

## Pros and Cons of the Options

### Option A: Local MCP adapter with host-execution handoff

- ✅ Standalone bridge change; no Pi core fork or upstream API required.
- ✅ Preserves Pi's normal execution lifecycle and policy hooks.
- ✅ Works for future extension tools discovered at runtime.
- ❌ Requires non-trivial MCP transport and suspended-turn coordination.
- ❌ Adds latency and starts with serialized calls.

### Option B: Add a cross-extension `executeTool` API to Pi core

- ✅ Could make direct adapter callbacks simpler.
- ✅ Avoids part of the suspended-turn protocol.
- ❌ Requires an upstream Pi interface and lifecycle design.
- ❌ Risks bypassing or duplicating agent-loop persistence, rendering, and
  tool-event semantics.
- ❌ Couples this package to a Pi core change that does not currently exist.

### Option C: Forward schemas or prompt instructions only

- ✅ Smallest implementation.
- ❌ Misleading: Kiro can see a tool but cannot actually invoke it.
- ❌ Does not satisfy the required behavior.

### Option D: Require every Pi extension to expose a separate Kiro MCP server

- ✅ Uses Kiro's existing MCP execution path.
- ❌ Duplicates configuration and implementation for every extension.
- ❌ Does not discover arbitrary Pi-registered tools automatically.
- ❌ Makes the bridge dependent on extension authors changing their packages.

## Links

- [Pi extension API](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/extensions.md)
- [Kiro ACP documentation](https://kiro.dev/docs/cli/acp/)
- [ACP initialization and capabilities](https://agentclientprotocol.com/protocol/v1/initialization)
- [ACP MCP-over-ACP RFD](https://agentclientprotocol.com/rfds/mcp-over-acp)
