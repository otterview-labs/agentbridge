# Security Policy

AgentBridge is a local-first, single-operator control plane. It can read workspace files, send input to local agent sessions, and execute approved commands. Treat every running instance as a privileged developer tool.

## Supported versions

Security fixes are applied to the latest commit on `main`. The historical `v0.1.0` release is not supported for security fixes.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use GitHub's private vulnerability reporting for this repository:

<https://github.com/otterview-labs/agentbridge/security/advisories/new>

Include the affected version or commit, reproduction steps, impact, and any suggested mitigation. Do not include real credentials, private source code, production data, or destructive proof-of-concept payloads.

## Deployment boundary

- Keep `ASB_HTTP_HOST=127.0.0.1` unless remote access is explicitly required.
- A non-loopback bind requires a strong `ASB_API_TOKEN`, `ASB_ALLOWED_HTTP_HOSTS`, and `ASB_ALLOWED_WORKSPACE_ROOTS`.
- Put remote access behind a trusted HTTPS reverse proxy or VPN. The built-in server does not terminate TLS.
- Enabling Feishu requires at least one user or chat allowlist.
- Keep `ASB_AUTO_CONFIRM_WORKSPACE_TRUST=false` unless every configured workspace is trusted.
- Never commit `.env`, SQLite databases, logs, session transcripts, or command output.
- Workspace previews block common credential paths, but this is a safety guard rather than a data-loss-prevention system. Do not place unrelated secrets inside a configured workspace.
- Git status and diff inspection require a normal `.git` directory contained in the workspace. External worktree/submodule metadata pointers are intentionally rejected.
- Review optional external integrations independently; they are outside this repository's security boundary.

## Trust model and limitations

The current API token represents one trusted operator. Client-supplied `actorId` values are audit labels, not authenticated identities, and the approval flow is intended to prevent accidental actions rather than provide multi-user separation of duties. Do not use one instance as a hostile multi-tenant service.

The browser keeps its API token only in the current page's memory and removes values persisted by earlier versions from both `localStorage` and `sessionStorage`. Refreshing or closing the page clears the active token. Scripts running on the same origin can still access in-memory credentials, so use a trusted browser and origin, and rotate the token if the browser or machine may have been compromised.
