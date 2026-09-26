# Changelog

Notable changes to agentBridge are documented here.

## Unreleased

### Added

- Android 0.5.25 employee removal: deleted employees stay in a per-office
  restorable list, do not reappear during discovery, and never delete remote
  projects, session transcripts, or workspace files.
- Android 0.5.24 discovery de-duplication: Claude processes sharing one session
  collapse to one employee, while Codex Desktop subagent/review threads remain
  hidden under their parent user thread.
- Android 0.5.23 Hub-free butler mode: direct OpenAI-compatible model calls,
  local conversations, local memories, and locally generated task plans.
- Public contribution, support, and security documentation.
- CI and dependency-update automation.
- Security regression coverage for configuration, terminal classification, and workspace path containment.
- Android 0.5.22 background operations for employee discovery, task replies,
  output refresh, and task planning, with a foreground service and system
  success/failure notifications.
- Android background operation counters, restore-on-failure reply drafts, and
  a clearer question/answer task timeline.
- Android task planning copy that leads with actionable one-sentence items.
- Queue fallback for Codex Desktop threads that already have an active writer.
- Hub task-planning generation with bounded state-prioritized context, clearer
  one-sentence prompts, a 180-second deadline, and a 1,800-token output cap.
- Recovery of partially generated task-planning JSON so a truncated final string
  does not discard otherwise valid completed sections.

### Changed

- Android now reports missing Codex rollouts and busy writer locks as specific
  user actions instead of a generic remote-command failure.
- Android relays target the local SSH service when deploying an STCP client,
  allowing a public SSH endpoint to differ from the target machine's local port.
- The Studio UI now calls the saved model analysis “任务规划” instead of “日报”.
- Android no longer packages or uses StudioHubClient; model and planning calls
  no longer require a Hub address or Hub token.

### Changed

- Simplified the README and visible product copy around the agentBridge name.
- Remote HTTP binding now requires a strong API token, explicit allowed hosts, and allowed workspace roots.
- Feishu authorization and workspace trust confirmation now fail closed by default.
- Dependency lock data now uses the official npm registry and patched dependency versions.

### Security

- Hardened terminal command classification against shell-composition and write-capable option bypasses.
- Added canonical-path checks to prevent workspace symlink escapes.
- Added bounded JSON request bodies, constant-time token comparison, security headers, and sanitized internal errors.
- Replaced backtracking Bearer parsing with bounded linear parsing.
- Aligned API token configuration and HTTP transport limits to visible ASCII values of at most 4096 characters.
- Removed browser API tokens from Web Storage and purged values left by earlier versions.

## 0.1.0 - 2026-04-18

- Initial private preview of the tmux and SQLite session bridge.
