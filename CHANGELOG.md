# Changelog

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

