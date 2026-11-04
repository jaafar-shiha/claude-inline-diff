# Changelog

All notable changes to this project are documented in this file.
The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/).

## [0.5.0] - 2026-11-03

### Changed
- Per-change **Accept / Reject** buttons are now CodeLens actions directly above each change. They used to be inlay hints at the end of the line, which editors can hide.

### Fixed
- A file could show up entirely green when its "before" snapshot was saved under an older naming scheme. Both names are read now. If a snapshot is missing, the file is skipped instead of being treated as new.
- The editor refreshes right after old snapshots are migrated.

## [0.4.0] - 2026-11-03

### Fixed
- Snapshots are stored with a `.snapshot` suffix, so build tools and language servers (Gradle, the Dart analyzer, …) no longer treat them as source files. Existing snapshots are migrated, and stray files are cleaned up.

## [0.3.0] - 2026-11-02

### Added
- Accept/Reject buttons inside the edited file, a file-level **Accept All / Reject All / Compare** bar, and keyboard shortcuts.

### Changed
- The snapshot hook is installed once for the user (`~/.claude/settings.json`). Edits from any Claude Code session (VS Code, terminal or the desktop app) are tracked.

## [0.2.0] - 2026-11-02

### Added
- **Claude Changes** view in the Explorer, a status bar counter, and automatic opening of files as Claude edits them.

## [0.1.0] - 2026-11-01

### Added
- First version: a `PreToolUse` hook snapshots files before Claude edits them, and the extension shows added and removed lines with per-change Accept/Reject.

[0.5.0]: https://github.com/jaafar-shiha/claude-inline-diff/releases/tag/v0.5.0
