# FRP relay

## Scope

The FRP integration provides one cloud entry and optional secure tunnels for
SSH machines. It uses FRP STCP rather than exposing each machine's SSH port.
The first release supports one online cloud entry, Mac/Linux clients, and a
Linux cloud server with root or passwordless sudo.

## Workflow

1. Add a public Linux machine through SSH discovery.
2. Use **Deploy public FRP** to reuse a healthy existing `frps` when its bind
   port and auth token are readable, or install and start a managed `frps`.
3. Add LAN Mac/Linux machines through SSH discovery.
4. Use **Enable relay** to install `frpc` on the selected LAN machine.
5. The Hub downloads a checksum-verified local `frpc`, starts an STCP visitor,
   and changes that machine's effective SSH target to `127.0.0.1:22xxx`.
6. SSH discovery and remote task management continue to work through the
   visitor. Disabling the relay restores the direct SSH connection.

FRP binaries are downloaded from the configured release base and verified with
the release SHA-256 checksum file. The base comes from `ASB_FRP_DOWNLOAD_BASE`,
but each cloud entry can override it from the **下载源** field when the default
GitHub endpoint is unreachable; the override is stored per server and used for
that server's `frps` and `frpc` downloads. An existing third-party `frps` can be adopted
read-only; agentBridge stores its bind port and token but does not rewrite its
configuration or restart it. When no reusable service exists, cloud `frps` runs
as a systemd service. LAN clients use launchd on macOS and systemd on Linux
(user systemd when sudo is unavailable).

## Host key trust

Every remote SSH call (discovery, task control, and FRP deployment) uses
`ASB_SSH_HOST_KEY_POLICY`:

- `accept-new` (default) trusts an unknown host on first contact but still
  refuses the connection if its key changes later.
- `strict` refuses any host missing from `known_hosts`. Because a machine must
  already be configured for passwordless SSH before it can be added, `strict`
  normally works out of the box on hosts that were reached once manually. For a
  host with no `known_hosts` entry, pre-seed it first:

  ```sh
  ssh-keyscan -p PORT HOST >> ~/.ssh/known_hosts
  ```

  `known_hosts` matches on address *and* port, so the entry must cover the pair
  the Hub actually connects to (non-default ports are stored in bracket form,
  e.g. `[127.0.0.1]:22000`). Once a relay is enabled, a machine is reached at
  `127.0.0.1` with the relay's visitor port rather than its LAN address, so a
  `strict` setup needs an entry for that target as well.

Open the selected FRP bind port in the cloud provider firewall/security group.
Do not open LAN machines' SSH ports to the internet. If the Hub page is opened
through `127.0.0.1`, the displayed repair command cannot be reached from another
computer; open the Hub through a LAN/public hostname when using that command.

## API

- `GET /frp/overview`: server and relay state.
- `POST /frp/servers`: create or update the cloud entry configuration.
- `POST /frp/servers/:id/deploy`: install and start `frps`.
- `POST /frp/relays`: reserve a relay name, secret, and visitor port.
- `POST /frp/relays/:id/deploy`: install the remote client and switch SSH to
  the local visitor.
- `POST /frp/relays/:id/disable`: stop the remote FRP client service, stop
  using the relay, and restore direct SSH.
- `GET /frp/relays/:id/install-script`: return a repair/install shell script.

The install script is protected by the same API authorization as other
management routes. It contains tunnel credentials after configuration is
generated; treat it as secret.

## Limits

- One cloud entry is supported in this first implementation.
- Cloud installation requires Linux with systemd and root/passwordless sudo.
- The visitor runs inside the Hub process and is restored on Hub startup.
- XTCP/P2P optimization, multiple cloud entries, revocation UI, and per-relay
  bandwidth metrics are future work.
