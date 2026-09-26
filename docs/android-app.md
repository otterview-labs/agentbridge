# Android Phone Controller

The Android app is a phone-first controller. It does **not** connect to the Mac
Hub page. On launch it opens a local office-town UI and talks to remote Mac /
Linux machines over SSH directly from the phone.

Current debug version:

```text
versionName: 0.5.25
versionCode: 41
minSdk: 24
targetSdk: 35
package: com.otterview.agentsessionbridge.debug
```

Artifact:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## What runs on the phone

- Local office-town UI in `android/app/src/main/assets/`.
- Pixel employee sprites, desks, status bubbles, and state animations matching
  the web office town.
- Compact office actions: discover tasks, collapse, and a disclosure for
  connection tests, editing, and deletion. Titles and summaries use up to two lines.
- Last connection-check timestamps are separate from configuration edits.
  Existing records without a check timestamp show as unchecked until refreshed.
- Refresh reports partial and total failures without claiming stale data is fresh.
  Task details update their status and output together while preserving reply drafts.
- Idle sessions are labeled idle, not pending acceptance; the phone does not
  infer that a task has passed verification.
- Pending-input tasks sort first within each office. The summary's input count
  opens the pending-input list directly, and its tab includes the count.
- Offline or unchecked machines' employees show historical labels and stop
  animating. A successful connection check still does not imply live monitoring.
- Task replies keep separate in-memory drafts across sheet closes. Drafts do
  not survive a page reload or app restart and are not written to local storage.
  Confirmed sends clear drafts even if the following record reload fails;
  failed sends retain them. Concurrent sends are blocked.
- Reply, discovery, output refresh, and task-planning operations run in native
  background threads. The UI shows a background counter, keeps navigation
  available, starts an Android data-sync foreground service, and posts a system
  notification when the operation succeeds or fails. A failed reply restores its
  draft.
- Sheets lock background scrolling and keyboard focus. Escape and Android Back
  close the active sheet before leaving the app. Task sheets also close on an
  outside tap.
- Per-office sprite collapse/expand. Collapsing hides the task list entirely
  and leaves only an employee/attention summary; the choice is persisted in
  local storage.
- Private machine/task storage in Android app storage.
- LAN `/24` SSH-port scanner.
- Native SSH client using `com.github.mwiede:jsch`.
- Trust-on-first-use SSH host-key pinning.
- Claude/Codex tmux task discovery.
- Claude/Codex process discovery.
- Codex Desktop thread discovery through `~/.codex/thread-writer-locks`,
  `~/.codex/session_index.jsonl`, and rollout transcripts.
- Codex Desktop subagent/review threads are not shown as separate employees;
  only their parent user thread represents the work.
- Multiple Claude processes that reference the same session ID collapse into
  one employee card. The most informative/running process wins, and custom names
  survive the PID-to-session identity migration.
- Employees can be removed from the active office without deleting remote work.
  Removed employees stay in a per-office deleted list, are excluded from task
  planning and normal discovery, and can be restored later.
- Task aliases and a “waiting for input” list.
- Direct replies to tmux panes and resumable CLI sessions.
- Codex replies prefer the newer Codex Desktop binary so paginated Desktop
  threads can resume successfully.
- If Codex Desktop already owns a thread writer lock, the phone does not force a
  second writer. It queues the message with `codex queue --thread` so the
  existing Desktop thread can continue with it after its current turn.
- A successful process reply returns immediately instead of triggering another
  full discovery scan.
- Reply operations run in the background and expose network reachability,
  phase, and elapsed time to the local UI.
- Optional secure public access through FRP. Each machine can be set to
  `off`, `auto`, or `public`; private machines use STCP tunnels and do not
  expose their SSH ports to the internet.
- Butler chat uses a fixed bottom composer, quick prompts, immediate local
  message echo, a typing indicator, and optional Chinese speech playback.
- The butler model is called directly from Android using an OpenAI-compatible
  `/chat/completions` endpoint. There is no Hub address, Hub token, device
  upload, or desktop Hub round trip.
- Butler conversations, explicit memories, and generated task plans are stored
  in Android app-private storage.
- Butler voice input supports press-and-hold, tap-to-toggle, and slide-up
  cancellation. Phones without a system recognizer get a clear local error;
  no recording is uploaded from the Hub-free controller.

## Add a machine

1. Open **发现机器** or **添加 SSH**.
2. Let the app scan the current Wi-Fi subnet, or enter a prefix such as
   `192.168.1`.
3. Pick a host with port 22 open.
4. Enter the SSH username and password/private key.
5. Save the office, then tap **找任务**.

The remote machine does not need this project's Hub or runner installed. It
only needs SSH access and permission to read the relevant Claude/Codex files.

## Optional public access

The **公网** tab uses a three-field quick setup: public server address, SSH
user, and password. FRP address, ports, version, download source, and key auth
are tucked into **高级配置**. Saving automatically inspects the public machine,
reuses a healthy **agentBridge-managed** FRP service when possible, adopts a
healthy third-party `frps` when its port and auth token can be read, and otherwise
installs a separate `asb-frps` service. Adoption is read-only: existing services,
configuration, and proxies are not stopped or overwritten. If an existing service
uses an unreadable token, enter it in **高级配置 → 已有 FRP Token**. The default bind port is 7001; if it is occupied,
the app tries 7000 and 7002–7010. The selected port must be allowed by the server's
firewall/security group. The app can:

1. Install and start a checksum-verified `frps` service on the public entry.
2. Install and start a checksum-verified `frpc` service on each selected
   Mac/Linux machine.
3. Create a unique FRP STCP tunnel and strong secret per machine.
4. Install a visitor on the public entry bound only to `127.0.0.1`.
5. Open an SSH local forwarding channel from the phone through the public entry
   before connecting to the target machine.

Version 0.3.5 fixes installer checksum verification against the downloaded file,
portable shell URL substitution, Mac LaunchAgent absolute/XML-escaped paths,
and visitor config/service naming. Downloads have bounded timeouts and checksum
failures stop installation. Mac LaunchAgents require the target user to be
logged into the desktop; an SSH-only Mac without that GUI session gets an
explicit error rather than false success.

First-time relay installation needs a reachable direct SSH address for the
target. Check this address before deploying; stale LAN addresses cannot be
repaired by installing FRP on the public server. A relay is marked online only
after a fresh SSH connection through the relay succeeds. The phone records
that verification time; it is not a continuous health guarantee.

Deployment errors show the failing stage, including target SSH, download,
checksum, service startup, or end-to-end verification. SSH disconnects and
command deadlines have distinct messages. A deadline does not guarantee the
remote process has stopped: inspect it before retrying.

Per-machine modes:

- `不上公网`: direct LAN SSH only.
- `自动`: use direct LAN access when available, otherwise the secure public
  relay.
- `仅公网`: always use the relay.

The public cloud security group only needs the public machine's SSH port and
the FRP bind port. Do not open target-machine SSH ports to the internet. FRP
uses TLS, a strong random server token, and a unique STCP secret per machine.

## Butler voice setup

Phones without a system speech recognizer previously uploaded audio to a Hub.
The Hub-free controller no longer performs that upload; use a device with a
system recognizer or configure speech input at the OS level.

The server Hub still supports a local Whisper engine for browser Studio users:

```bash
brew install whisper-cpp
mkdir -p ~/.cache/whisper.cpp
curl -L https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin \
  -o ~/.cache/whisper.cpp/ggml-base.bin
```

The defaults resolve to `whisper-cli` and
`~/.cache/whisper.cpp/ggml-base.bin`. Override them with:

```text
ASB_VOICE_ENGINE=local-whisper
ASB_WHISPER_BIN=/opt/homebrew/bin/whisper-cli
ASB_WHISPER_MODEL=/absolute/path/ggml-base.bin
ASB_WHISPER_TIMEOUT_MS=45000
```

The first request after a machine reboot may take several seconds while the
Metal kernels compile; subsequent short requests are much faster. This is a
batched near-real-time flow, not full-duplex streaming recognition.

## Task discovery and replies

The phone executes read-only discovery commands over SSH:

- `uname`, tool lookup, and `tmux -V`
- `tmux list-panes`
- `tmux capture-pane`
- `ps -axo pid=,ppid=,etime=,command=`
- Claude process metadata from `~/.claude/sessions/<pid>.json`
- Codex Desktop thread locks and matching rollout transcripts
- small `tail` reads of Claude/Codex JSONL transcripts

It can send input back:

- tmux task: `tmux send-keys`
- Codex process: `codex exec resume --skip-git-repo-check`
- Busy Codex Desktop thread: `codex queue --thread <thread>`
- Claude process: `claude --resume ... --print`

## Security notes

- Credentials are currently stored in Android private SharedPreferences. They
  are not exported to other apps, but they are not yet encrypted with Android
  Keystore.
- The first host key is pinned automatically. A changed host key is rejected.
- Discovery uses the SSH account's own permissions.
- Reply commands are intentionally limited to the discovered tmux pane or
  resumed CLI session.
- Claude replies no longer add a permission-bypass flag. The remote CLI's
  existing session/account permissions still apply; this is not an additional
  approval system. Actions requiring permissions may need handling on the host.
- Codex resume only runs if entering the recorded workspace succeeds.
- LAN scanning only probes TCP port 22 in the selected `/24`.

## Build

```bash
cd android
export JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home
./gradlew --no-daemon :app:assembleDebug
```

The output is:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

## Release

The published APK is at
<https://github.com/otterview-labs/agentbridge/releases/latest/download/agentbridge.apk>,
linked from the download page at <https://otterview-labs.github.io/agentbridge/>.
Both are stable permalinks: the release URL always resolves to the newest
release, so neither has to be updated when a version ships. `site/index.html`
holds the page and `.github/workflows/pages.yml` publishes it.

The page is served from a generated `gh-pages` branch, which the workflow
force-pushes on every change under `site/`. Pages is configured for that branch
rather than for the workflow-artifact pipeline because
`actions/upload-pages-artifact` is a composite action that references
`actions/upload-artifact` by tag, and this repository requires every action to
be pinned to a full-length commit SHA. Publishing a static page is not worth
relaxing that rule repo-wide. The branch is generated output, so edit
`site/index.html` — not `gh-pages`.

Pushing a tag matching `android-v*` makes
`.github/workflows/android-release.yml` build, sign, verify, and publish the
APK as `agentbridge.apk`. `workflow_dispatch` builds an existing tag again.
The same tag is what makes `/releases/latest` resolve to this release, so do
not publish a newer non-Android release without checking the download page.

Signing material is supplied out of band in two equivalent ways, both read by
`android/app/build.gradle`:

- `android/keystore.properties` (gitignored) for local builds —
  `storeFile`, `storePassword`, `keyAlias`, `keyPassword`.
- `ASB_ANDROID_STORE_FILE`, `ASB_ANDROID_STORE_PASSWORD`,
  `ASB_ANDROID_KEY_ALIAS`, `ASB_ANDROID_KEY_PASSWORD` in CI, with the keystore
  itself in the `ASB_ANDROID_KEYSTORE_BASE64` secret.

A checkout with neither still compiles; `assembleRelease` then just emits an
unsigned APK. CI therefore verifies the signature explicitly rather than
trusting the build to have succeeded, and also rejects a debuggable artifact —
a debuggable build stores SSH credentials where any process on the device can
read them.

> [!IMPORTANT]
> Back up the release keystore and its passwords somewhere outside this
> repository. Android only allows an update to be installed over an existing
> app when both are signed with the same key, so losing it means no future
> build can update a copy already on a phone.

## UI regression tests

Run with Node.js and Playwright (including its Chromium browser) available:

```bash
node --test android/tests/phone-ui.test.cjs
```

If Playwright is supplied by a shared runtime, set `PLAYWRIGHT_MODULE` to its
absolute module directory. Optionally set `SCREENSHOT_DIR` to retain a screenshot.
Tests render the actual Android assets with a mock native bridge; they do not
scan networks, deploy FRP, or send commands to real machines.

Installer regression tests run the shared Java-generated shell fragments with
mock downloads and launchctl, confined to temporary directories:

```bash
JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
  node --test android/tests/frp-install.test.cjs
```

These tests verify renamed-archive checksums, missing/duplicate/corrupt checksum
rejection, download failure, XML-safe absolute Mac paths, and missing GUI sessions.
They do not change real launch agents or system services.

## Current limitations

- Windows SSH is not yet handled as a first-class target.
- There is no background poll/foreground service yet. Launch loads saved
  records; discovery runs on explicit refresh or task-discovery actions.
- Credential encryption and biometric lock are future hardening work.
- Public relay functionality is implemented, but UI-only tests do not verify
  live SSH or FRP connectivity.
