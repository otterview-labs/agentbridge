# Contributing

Thanks for helping improve agentBridge.

## Before opening a change

- Use GitHub Issues for confirmed bugs and focused feature proposals.
- Report security problems privately as described in [`SECURITY.md`](SECURITY.md).
- Keep changes narrowly scoped and avoid committing credentials, `.env` files, databases, logs, session transcripts, or machine-specific paths.

## Development setup

Requirements:

- Node.js 22 or later
- npm
- `tmux` for runtime integration testing

```bash
npm ci
npm run check
npm audit --omit=dev --audit-level=moderate
```

`npm run check` performs strict TypeScript checking, runs the test suite, and builds the project.

## Pull requests

- Add or update tests for behavioral changes.
- Treat authentication, path handling, terminal execution, approvals, and external integrations as security-sensitive boundaries.
- Preserve secure defaults: loopback-only HTTP, fail-closed allowlists, bounded workspaces, and explicit approval for write-capable commands.
- Do not copy source code, prose, assets, or protocol implementations from HAPI or any other project without first establishing license compatibility and attribution requirements.
- Update README and configuration examples when behavior or environment variables change.
- Explain remaining risks and manual verification in the pull request description.
