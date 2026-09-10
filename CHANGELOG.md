# Changelog

## [0.4.2] - 2026-09-10

### Fixed
- Bridged models now receive the `shell` tool again. The native tool list
  requested `execute_bash`, the pre-rename kiro-cli name. Current kiro-cli
  exposes the shell tool as `shell` (`execute_bash` is a legacy alias that no
  longer surfaces the tool to the ACP `--agent` overlay), so the bridged model
  silently lost shell access — it could read, write, glob, grep, and hit the
  web, but could not run commands. `PI_BRIDGE_NATIVE_TOOLS` now uses kiro-cli's
  current primary tool names: `read`, `write`, `shell`, `glob`, `grep`,
  `web_fetch`, `web_search`.

### Changed
- Native tool entries `fs_read`/`fs_write` updated to their current primary
  names `read`/`write` (behavior unchanged; the old names were aliases).

### Notes
- The generated `~/.config/kiro/agents/pi-bridge.json` is rewritten with the
  corrected names on the next session start (or immediately, if already
  updated). Restart pi to pick up the shell tool.

## [0.4.1] - 2026-07-26

### Fixed
- Spawn `kiro-cli-chat acp` with `--agent-engine rust` instead of the removed `v2` value. Kiro CLI 2.3.0 rejects `v2` and exits immediately, so every bridged prompt failed with `ACP process exited with code 2`.

## [0.4.0] - 2026-07-21

### Added
- Authenticated loopback HTTP MCP adapter for active Pi extension tools.
- Host-executed handoff through Pi's normal tool lifecycle, including cancellation and cleanup.
- Deterministic Kiro-safe aliases and catalog refresh when active extension tools change.

### Changed
- Kiro-backed turns now expose active extension tools only; Pi built-in coding tools remain excluded.
- Forwarded calls are serialized and return Pi tool failures to Kiro as MCP errors.

### Security
- Adapter binds to `127.0.0.1`, uses an ephemeral port and per-session bearer token, and rejects untrusted `Origin` values.

## [0.3.0] - 2026-07-17

### Added
- Dynamic model discovery from `kiro-cli chat --list-models --format json`
- Automatic sync with Kiro's live model catalog on pi startup/reload
- Fallback to minimal safe set if kiro-cli is unavailable

### Changed
- Extension factory now async (breaking change for pi < 0.80)
- Models are fetched at load time instead of hardcoded static list

### Removed
- Hardcoded 15-model static list

