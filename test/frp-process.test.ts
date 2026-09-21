import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import pino from 'pino';

import type { FrpRelayRecord } from '../src/domain/frp.js';
import type { MachineRecord } from '../src/domain/machine.js';
import { DatabaseClient } from '../src/infra/storage/database.js';
import { FrpService } from '../src/services/frp-service.js';

/**
 * These tests exercise FrpService's process-management half: the local frpc
 * visitor lifecycle, the generation guard that keeps a killed visitor from
 * rewriting relay state, and the SSH-driven tunnel switching.
 *
 * Both external processes are stubbed on disk rather than mocked at the module
 * level, so the real spawn/argv/signal paths are what gets exercised:
 *
 *   - `frpc` is passed in as `frpcBin`, so `ensureLocalFrpc()` returns our stub.
 *   - `ssh` is reached through `runCommand('ssh', …)`, which resolves the binary
 *     from PATH — so a stub directory is prepended to PATH.
 */

const FRPC_STUB = [
  '#!/bin/sh',
  "dir='@DIR@'",
  'printf "ARGV: %s\\n" "$*" >> "$dir/frpc-argv.log"',
  'cfg=',
  'prev=',
  'for a in "$@"; do',
  '  if [ "$prev" = "-c" ]; then cfg="$a"; fi',
  '  prev="$a"',
  'done',
  '[ -n "$cfg" ] && cp "$cfg" "$dir/frpc-config-copy.toml"',
  'if [ -f "$dir/frpc-die-immediately" ]; then',
  '  printf "IMMEDIATE-EXIT\\n" >> "$dir/frpc-events.log"',
  '  exit 3',
  'fi',
  'lifetime=$(cat "$dir/frpc-lifetime" 2>/dev/null || echo 300)',
  'sleep "$lifetime" &',
  'child=$!',
  "trap 'kill $child 2>/dev/null; printf \"TERM\\n\" >> \"$dir/frpc-events.log\"; exit 0' TERM INT",
  'printf "START\\n" >> "$dir/frpc-events.log"',
  'wait $child',
  'printf "SELF-EXIT\\n" >> "$dir/frpc-events.log"',
  'exit "$(cat "$dir/frpc-exit-code" 2>/dev/null || echo 9)"',
  '',
].join('\n');

const SSH_STUB = [
  '#!/bin/sh',
  "dir='@DIR@'",
  'script=',
  'for a in "$@"; do script="$a"; done',
  'printf "ARGV: %s\\n" "$*" >> "$dir/ssh-argv.log"',
  'printf "%s\\n--8<--\\n" "$script" >> "$dir/ssh-scripts.log"',
  'if [ "$script" = "id -un" ]; then printf "demouser\\n"; fi',
  'if [ -f "$dir/ssh-fail" ]; then echo "ssh stub forced failure" >&2; exit 255; fi',
  'exit 0',
  '',
].join('\n');

type MachineSpec = { id: number; name: string; port?: number };

const DEFAULT_MACHINES: MachineSpec[] = [
  { id: 2, name: 'cloud' },
  { id: 3, name: 'mac-pro', port: 6022 },
];

function machineFixture(spec: MachineSpec): MachineRecord {
  const now = new Date().toISOString();
  return {
    capabilities: {
      connection: 'ssh',
      os: 'Linux',
      ssh: { host: `${spec.name}.local`, port: spec.port ?? 22, user: 'demo', privateKeyPath: null },
    },
    createdAt: now,
    host: `${spec.name}.local`,
    id: spec.id,
    labels: ['ssh'],
    lastSeenAt: now,
    name: spec.name,
    namespace: 'ssh',
    runnerVersion: 'test',
    status: 'online',
    updatedAt: now,
  };
}

function writeStub(file: string, template: string, dir: string) {
  fs.writeFileSync(file, template.replace('@DIR@', dir), { mode: 0o755 });
}

function lines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter((line) => line !== '');
}

function text(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

async function waitFor(predicate: () => boolean, timeoutMs = 4000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function createHarness(options: { frpcBin?: string | null; machines?: MachineSpec[] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asb-frp-process-'));
  const control = path.join(root, 'control');
  const stateDir = path.join(root, 'state');
  fs.mkdirSync(control, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  writeStub(path.join(control, 'frpc'), FRPC_STUB, control);
  writeStub(path.join(control, 'ssh'), SSH_STUB, control);

  const previousPath = process.env.PATH;
  process.env.PATH = `${control}${path.delimiter}${previousPath ?? ''}`;

  const specs = options.machines ?? DEFAULT_MACHINES;
  const store = new Map(specs.map((spec) => [spec.id, machineFixture(spec)]));
  const database = new DatabaseClient(':memory:', pino({ level: 'silent' }));

  const service = new FrpService({
    database,
    downloadBase: 'https://frp.example/download',
    frpcBin: options.frpcBin === undefined ? path.join(control, 'frpc') : options.frpcBin,
    hostKeyPolicy: 'accept-new',
    logger: pino({ level: 'silent' }),
    machines: {
      listMachines: async () => [...store.values()],
      registerMachine: async (input) => {
        const current = [...store.values()].find((machine) => machine.name === input.name);
        assert.ok(current, `registerMachine for unknown machine "${input.name}"`);
        if (input.capabilities) current.capabilities = input.capabilities;
        return current;
      },
    },
    ssh: {
      connectionForMachine: async (id: number) => {
        const machine = store.get(id);
        assert.ok(machine, `connectionForMachine for unknown machine ${id}`);
        return {
          connection: {
            host: `${machine.name}.local`,
            port: 22,
            user: 'demo',
            privateKeyPath: null,
          },
          machine,
        };
      },
    },
    stateDir,
    version: '0.61.1',
  });

  return {
    control,
    root,
    service,
    stateDir,
    /** Everything the stubbed `ssh` was asked to run, concatenated. */
    sshScripts: () => text(path.join(control, 'ssh-scripts.log')),
    sshArgv: () => lines(path.join(control, 'ssh-argv.log')),
    frpcArgv: () => lines(path.join(control, 'frpc-argv.log')),
    frpcEvents: () => lines(path.join(control, 'frpc-events.log')),
    visitorConfig: () => text(path.join(stateDir, 'visitor-frpc.toml')),
    visitorConfigCopy: () => text(path.join(control, 'frpc-config-copy.toml')),
    setControl: (name: string, value: string) => fs.writeFileSync(path.join(control, name), value),
    machine: (name: string) => {
      const machine = [...store.values()].find((item) => item.name === name);
      assert.ok(machine, `unknown machine "${name}"`);
      return machine;
    },
    relay: (): FrpRelayRecord | undefined => service.listRelays()[0],
    server: () => service.listServers()[0],
    async cleanup() {
      await service.stop();
      if (previousPath === undefined) delete process.env.PATH;
      else process.env.PATH = previousPath;
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

async function withHarness(
  t: TestContext,
  run: (harness: ReturnType<typeof createHarness>) => Promise<void>,
  options: Parameters<typeof createHarness>[0] = {},
) {
  const harness = createHarness(options);
  t.after(() => harness.cleanup());
  await run(harness);
}

/**
 * frpc's argv is written by the stub process, not by the service, so the shell
 * needs a moment to land the line. Asserting on it directly after `start()` is
 * a race; wait for the write first.
 */
async function expectFrpcInvocation(harness: ReturnType<typeof createHarness>) {
  const expected = [`ARGV: -c ${path.join(harness.stateDir, 'visitor-frpc.toml')}`];
  assert.ok(await waitFor(() => harness.frpcArgv().length >= expected.length), 'frpc should have been invoked');
  assert.deepEqual(harness.frpcArgv(), expected);
}

/** Configures a deployed-looking entry point + relay without touching SSH. */
async function configureTunnel(harness: ReturnType<typeof createHarness>) {
  const server = await harness.service.configureServer({
    machineId: harness.machine('cloud').id,
    publicAddress: 'frp.example.com',
  });
  const relay = await harness.service.configureRelay({
    machineId: harness.machine('mac-pro').id,
    serverId: server.id,
  });
  return { relay, server };
}

test('start spawns a local visitor whose config is readable only by its owner', async (t) => {
  await withHarness(t, async (harness) => {
    const { relay, server } = await configureTunnel(harness);
    await harness.service.start();

    const configPath = path.join(harness.stateDir, 'visitor-frpc.toml');
    assert.ok(fs.existsSync(configPath), 'visitor config should be written');
    assert.equal(fs.statSync(configPath).mode & 0o777, 0o600, 'visitor config carries the tunnel secret key');

    const config = harness.visitorConfig();
    assert.match(config, /serverAddr = "frp\.example\.com"/u);
    assert.match(config, /serverPort = 7000/u);
    assert.match(config, /\[\[visitors\]\]/u);
    assert.match(config, /name = "asb-mac-pro-ssh-visitor"/u);
    assert.match(config, /type = "stcp"/u);
    assert.match(config, /serverName = "asb-mac-pro-ssh"/u);
    assert.match(config, /bindAddr = "127\.0\.0\.1"/u);
    assert.match(config, new RegExp(`bindPort = ${relay.visitorPort}`, 'u'));
    assert.match(config, new RegExp(`auth\\.token = "${server.token}"`, 'u'));
    assert.match(config, new RegExp(`secretKey = "${relay.secretKey}"`, 'u'));

    // frpc must be handed the very config the service just wrote.
    await expectFrpcInvocation(harness);
    assert.ok(await waitFor(() => harness.frpcEvents().includes('START')), 'stub visitor should report starting');
    assert.equal(harness.relay()?.status, 'not_deployed');
  });
});

test('stop kills the visitor without rewriting relay status', async (t) => {
  await withHarness(t, async (harness) => {
    await configureTunnel(harness);
    await harness.service.start();
    assert.ok(await waitFor(() => harness.frpcEvents().includes('START')));

    await harness.service.stop();

    // The shutdown path bumps the generation before killing, so the exit
    // handler must stay silent. Without that guard every clean shutdown would
    // flip healthy relays to "error" and persist it.
    assert.ok(await waitFor(() => harness.frpcEvents().includes('TERM')), 'visitor should receive SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(harness.relay()?.status, 'not_deployed');
    assert.equal(harness.relay()?.lastError, '');
  });
});

test('restarting kills the previous visitor without it marking relays as error', async (t) => {
  await withHarness(t, async (harness) => {
    await configureTunnel(harness);
    await harness.service.start();
    await harness.service.start();

    assert.ok(await waitFor(() => harness.frpcEvents().filter((event) => event === 'START').length === 2));
    assert.ok(await waitFor(() => harness.frpcEvents().includes('TERM')), 'previous visitor should be terminated');
    await new Promise((resolve) => setTimeout(resolve, 150));

    assert.equal(harness.relay()?.status, 'not_deployed');
    assert.equal(harness.relay()?.lastError, '');
  });
});

test('a visitor that dies on its own marks enabled relays as error', async (t) => {
  await withHarness(t, async (harness) => {
    await configureTunnel(harness);
    harness.setControl('frpc-lifetime', '1');
    harness.setControl('frpc-exit-code', '9');

    await harness.service.start();

    assert.ok(
      await waitFor(() => harness.relay()?.status === 'error'),
      'an unexpected visitor exit must surface as a relay error',
    );
    assert.match(harness.relay()?.lastError ?? '', /exited unexpectedly with code 9/u);
  });
});

test('a visitor that dies during startup fails the start', async (t) => {
  await withHarness(t, async (harness) => {
    await configureTunnel(harness);
    harness.setControl('frpc-die-immediately', '1');

    await harness.service.start();

    assert.equal(harness.relay()?.status, 'error');
    assert.match(harness.relay()?.lastError ?? '', /本地 FRP visitor 启动失败/u);
  });
});

test('no enabled relays means no visitor process at all', async (t) => {
  await withHarness(t, async (harness) => {
    await harness.service.start();

    assert.equal(fs.existsSync(path.join(harness.stateDir, 'visitor-frpc.toml')), false);
    assert.deepEqual(harness.frpcArgv(), []);
  });
});

test('two entry points fail closed before any visitor is spawned', async (t) => {
  await withHarness(
    t,
    async (harness) => {
      const first = await harness.service.configureServer({
        machineId: harness.machine('cloud').id,
        publicAddress: 'frp.example.com',
      });
      const second = await harness.service.configureServer({
        machineId: harness.machine('cloud-b').id,
        publicAddress: 'frp2.example.com',
      });
      await harness.service.configureRelay({ machineId: harness.machine('mac-pro').id, serverId: first.id });
      await harness.service.configureRelay({ machineId: harness.machine('lan-b').id, serverId: second.id });

      await harness.service.start();

      for (const relay of harness.service.listRelays()) {
        assert.equal(relay.status, 'error');
        assert.match(relay.lastError, /只支持一个在线 FRP 公网入口/u);
      }
      assert.equal(fs.existsSync(path.join(harness.stateDir, 'visitor-frpc.toml')), false);
      assert.deepEqual(harness.frpcArgv(), []);
    },
    {
      machines: [
        { id: 2, name: 'cloud' },
        { id: 3, name: 'mac-pro', port: 6022 },
        { id: 4, name: 'cloud-b' },
        { id: 5, name: 'lan-b', port: 6022 },
      ],
    },
  );
});

test('deployServer runs the installer over SSH and flips the entry point online', async (t) => {
  await withHarness(t, async (harness) => {
    const server = await harness.service.configureServer({
      machineId: harness.machine('cloud').id,
      publicAddress: 'frp.example.com',
    });

    const deployed = await harness.service.deployServer(server.id);

    assert.equal(deployed.status, 'online');
    const script = harness.sshScripts();
    assert.match(script, /asb-frps/u);
    assert.match(script, /\/etc\/asb-frp\/frps\.toml/u);
    assert.match(script, /systemctl enable --now asb-frps/u);
    // The host-key policy is enforced on the ssh invocation, not inside the remote script.
    assert.ok(harness.sshArgv().some((entry) => entry.includes('StrictHostKeyChecking=accept-new')));
    // The tunnel token travels base64-encoded, never as plaintext argv.
    assert.doesNotMatch(script, new RegExp(server.token, 'u'));

    assert.equal(harness.machine('cloud').capabilities.frpRole, 'server');
    assert.equal(harness.machine('cloud').capabilities.frpServerId, server.id);
  });
});

test('deployServer refuses a second online entry point', async (t) => {
  await withHarness(
    t,
    async (harness) => {
      const first = await harness.service.configureServer({
        machineId: harness.machine('cloud').id,
        publicAddress: 'frp.example.com',
      });
      const second = await harness.service.configureServer({
        machineId: harness.machine('cloud-b').id,
        publicAddress: 'frp2.example.com',
      });
      await harness.service.deployServer(first.id);

      await assert.rejects(harness.service.deployServer(second.id), /只能有一个在线 FRP 入口/u);
      assert.equal(harness.service.listServers()[1]?.status, 'not_deployed');
    },
    {
      machines: [
        { id: 2, name: 'cloud' },
        { id: 3, name: 'mac-pro', port: 6022 },
        { id: 4, name: 'cloud-b' },
        { id: 5, name: 'lan-b', port: 6022 },
      ],
    },
  );
});

test('deployRelay installs frpc and switches the machine onto the visitor port', async (t) => {
  await withHarness(t, async (harness) => {
    const { relay, server } = await configureTunnel(harness);
    await harness.service.deployServer(server.id);

    const deployed = await harness.service.deployRelay(relay.id);

    assert.equal(deployed.status, 'online');
    const script = harness.sshScripts();
    assert.match(script, /asb-frpc/u);
    assert.match(script, /\$HOME\/\.config\/agent-session-bridge\/frpc\.toml/u);
    assert.match(script, /com\.agent-session-bridge\.frpc\.plist/u);
    assert.doesNotMatch(script, new RegExp(relay.secretKey, 'u'));
    assert.ok(harness.sshArgv().some((entry) => entry.includes('id -un')), 'needs the remote login name');

    // The machine is now reached through the tunnel, with the direct address kept for teardown.
    const machine = harness.machine('mac-pro');
    assert.equal(machine.capabilities.relayEnabled, true);
    assert.equal(machine.capabilities.frpRole, 'client');
    assert.deepEqual(machine.capabilities.ssh, {
      host: '127.0.0.1',
      port: relay.visitorPort,
      user: 'demo',
      privateKeyPath: null,
    });
    assert.equal((machine.capabilities.sshDirect as { host: string }).host, 'mac-pro.local');
  });
});

test('deployRelay refuses to run before the entry point is online', async (t) => {
  await withHarness(t, async (harness) => {
    const { relay } = await configureTunnel(harness);

    await assert.rejects(harness.service.deployRelay(relay.id), /请先部署并启动云端 FRP 服务端/u);
    // Nothing was attempted, so the relay keeps its untouched status rather than
    // being recorded as a failed deployment.
    assert.equal(harness.relay()?.status, 'not_deployed');
    assert.equal(harness.relay()?.lastError, '');
  });
});

test('disableRelay tears down the tunnel and restores the direct connection', async (t) => {
  await withHarness(t, async (harness) => {
    const { relay, server } = await configureTunnel(harness);
    await harness.service.deployServer(server.id);
    await harness.service.deployRelay(relay.id);
    assert.equal(harness.machine('mac-pro').capabilities.relayEnabled, true);

    const disabled = await harness.service.disableRelay(relay.id);

    assert.equal(disabled.status, 'disabled');
    assert.equal(disabled.enabled, false);
    assert.match(harness.sshScripts(), /launchctl unload/u);
    assert.match(harness.sshScripts(), /systemctl --user disable --now asb-frpc|systemctl disable --now asb-frpc/u);

    const machine = harness.machine('mac-pro');
    assert.equal(machine.capabilities.relayEnabled, false);
    assert.equal(machine.capabilities.frpRole, 'none');
    assert.equal(machine.capabilities.sshDirect, null);
    assert.equal((machine.capabilities.ssh as { host: string }).host, 'mac-pro.local');

    // The visitor is gone with the last enabled relay: nothing left to spawn.
    assert.equal(fs.existsSync(path.join(harness.stateDir, 'visitor-frpc.toml')), false);
  });
});

test('the local frpc binary is reused from cache instead of being downloaded', async (t) => {
  await withHarness(
    t,
    async (harness) => {
      const cached = path.join(harness.stateDir, 'bin', 'frpc-v0.61.1');
      fs.mkdirSync(path.dirname(cached), { recursive: true });
      fs.copyFileSync(path.join(harness.control, 'frpc'), cached);
      fs.chmodSync(cached, 0o755);

      const originalFetch = globalThis.fetch;
      globalThis.fetch = (() => {
        throw new Error('the cached binary must not trigger a download');
      }) as typeof fetch;
      t.after(() => {
        globalThis.fetch = originalFetch;
      });

      await configureTunnel(harness);
      await harness.service.start();

      await expectFrpcInvocation(harness);
    },
    { frpcBin: null },
  );
});

test('a download whose checksum does not match is rejected', async (t) => {
  await withHarness(
    t,
    async (harness) => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((input: string | URL) => {
        const url = String(input);
        if (url.endsWith('frp_sha256_checksums.txt')) {
          return Promise.resolve(new Response(`${'0'.repeat(64)}  frp_0.61.1_x.tar.gz\n`, { status: 200 }));
        }
        return Promise.resolve(new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 }));
      }) as typeof fetch;
      t.after(() => {
        globalThis.fetch = originalFetch;
      });

      await configureTunnel(harness);
      await harness.service.start();

      assert.equal(harness.relay()?.status, 'error');
      assert.match(harness.relay()?.lastError ?? '', /SHA256 校验失败/u);
      assert.deepEqual(harness.frpcArgv(), [], 'a rejected download must never be executed');
    },
    { frpcBin: null },
  );
});

test('the local frpc binary is downloaded, checksum-verified and made executable', async (t) => {
  await withHarness(
    t,
    async (harness) => {
      const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
      const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
      const packageDir = `frp_0.61.1_${platform}_${arch}`;
      const archiveName = `${packageDir}.tar.gz`;

      const work = path.join(harness.root, 'download-work');
      fs.mkdirSync(path.join(work, packageDir), { recursive: true });
      fs.copyFileSync(path.join(harness.control, 'frpc'), path.join(work, packageDir, 'frpc'));
      fs.chmodSync(path.join(work, packageDir, 'frpc'), 0o755);
      execFileSync('tar', ['-czf', path.join(work, archiveName), '-C', work, packageDir]);

      const archive = fs.readFileSync(path.join(work, archiveName));
      const digest = crypto.createHash('sha256').update(archive).digest('hex');

      const originalFetch = globalThis.fetch;
      globalThis.fetch = ((input: string | URL) => {
        const url = String(input);
        if (url.endsWith('frp_sha256_checksums.txt')) {
          return Promise.resolve(new Response(`${digest}  ${archiveName}\n`, { status: 200 }));
        }
        return Promise.resolve(new Response(new Uint8Array(archive), { status: 200 }));
      }) as typeof fetch;
      t.after(() => {
        globalThis.fetch = originalFetch;
      });

      await configureTunnel(harness);
      await harness.service.start();

      const cached = path.join(harness.stateDir, 'bin', 'frpc-v0.61.1');
      assert.ok(fs.existsSync(cached), 'the verified binary should be installed at the cached path');
      assert.equal(fs.statSync(cached).mode & 0o777, 0o755);
      assert.equal(harness.relay()?.status, 'not_deployed', harness.relay()?.lastError);
      await expectFrpcInvocation(harness);
    },
    { frpcBin: null },
  );
});
