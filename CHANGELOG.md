# Changelog

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

