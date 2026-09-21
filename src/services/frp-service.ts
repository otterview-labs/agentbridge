import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { Logger } from 'pino';

import { ConflictError, DependencyError, NotFoundError, ValidationError } from '../domain/errors.js';
import type { FrpRelayRecord, FrpServerRecord } from '../domain/frp.js';
import type { MachineRecord } from '../domain/machine.js';
import type { MachineService } from './machine-service.js';
import { runCommand } from '../infra/process/command-runner.js';
import type { DatabaseClient } from '../infra/storage/database.js';
import { shellQuote } from '../utils/runtime-command.js';
import type { SshMachineService } from './ssh-machine-service.js';

type FrpServiceOptions = {
  database: DatabaseClient;
  downloadBase: string;
  frpcBin: string | null;
  logger: Logger;
  machines: Pick<MachineService, 'listMachines' | 'registerMachine'>;
  ssh: Pick<SshMachineService, 'connectionForMachine'>;
  stateDir: string;
  version: string;
};

type ChildProcess = ReturnType<typeof spawn>;
type PublicFrpServerRecord = Omit<FrpServerRecord, 'token'>;
type PublicFrpRelayRecord = Omit<FrpRelayRecord, 'secretKey'> & { installPath: string };

const SERVER_STATUSES = new Set(['not_deployed', 'deploying', 'online', 'offline', 'error']);
const RELAY_STATUSES = new Set(['not_deployed', 'deploying', 'online', 'disabled', 'error']);

export class FrpService {
  private visitorProcess: ChildProcess | null = null;
  private visitorGeneration = 0;

  constructor(private readonly options: FrpServiceOptions) {
    this.options.database.exec(`
      CREATE TABLE IF NOT EXISTS frp_servers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id INTEGER NOT NULL UNIQUE,
        public_address TEXT NOT NULL,
        bind_port INTEGER NOT NULL,
        token TEXT NOT NULL,
        version TEXT NOT NULL,
        download_base TEXT NOT NULL,
        status TEXT NOT NULL,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS frp_relays (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        machine_id INTEGER NOT NULL UNIQUE,
        server_id INTEGER NOT NULL,
        local_port INTEGER NOT NULL DEFAULT 22,
        proxy_name TEXT NOT NULL UNIQUE,
        secret_key TEXT NOT NULL,
        visitor_port INTEGER NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
    try {
      this.options.database.exec('ALTER TABLE frp_relays ADD COLUMN local_port INTEGER NOT NULL DEFAULT 22');
    } catch {
      // The column already exists in newer databases.
    }
  }

  async overview(): Promise<{
    relays: PublicFrpRelayRecord[];
    servers: PublicFrpServerRecord[];
  }> {
    const servers = this.listServers().map(({ token, ...server }) => server);
    const relays = this.listRelays().map((relay) => ({
      ...(({ secretKey, ...publicRelay }) => publicRelay)(relay),
      installPath: `/frp/relays/${relay.id}/install-script`,
    }));
    return { relays, servers };
  }

  listServers(): FrpServerRecord[] {
    const rows = this.options.database.prepare('SELECT * FROM frp_servers ORDER BY id').all();
    return rows.map((row) => mapServerRow(row as Record<string, unknown>));
  }

  listRelays(): FrpRelayRecord[] {
    const rows = this.options.database.prepare('SELECT * FROM frp_relays ORDER BY id').all();
    return rows.map((row) => mapRelayRow(row as Record<string, unknown>));
  }

  async configureServer(input: {
    bindPort?: number;
    downloadBase?: string;
    machineId: number;
    publicAddress?: string;
    version?: string;
  }): Promise<FrpServerRecord> {
    const machine = await this.requireSshMachine(input.machineId);
    const bindPort = input.bindPort ?? 7000;
    const publicAddress = (input.publicAddress || machine.host || '').trim();
    if (!Number.isInteger(bindPort) || bindPort < 1024 || bindPort > 65535) {
      throw new ValidationError('FRP bind 端口必须在 1024–65535。');
    }
    if (!publicAddress || /[^a-zA-Z0-9.-]/u.test(publicAddress)) {
      throw new ValidationError('FRP 公网地址必须是域名或 IP。');
    }
    const version = (input.version || this.options.version).replace(/^v/u, '');
    const downloadBase = (input.downloadBase || this.options.downloadBase).replace(/\/$/u, '');
    const existing = this.options.database.prepare('SELECT id FROM frp_servers WHERE machine_id=?').get(input.machineId) as { id: number } | undefined;
    const now = new Date().toISOString();
    if (existing) {
      this.options.database.prepare(`
        UPDATE frp_servers
        SET public_address=?, bind_port=?, version=?, download_base=?, status='not_deployed',
            last_error='', updated_at=?
        WHERE id=?
      `).run(publicAddress, bindPort, version, downloadBase, now, existing.id);
      return this.requireServer(Number(existing.id));
    }
    const result = this.options.database.prepare(`
      INSERT INTO frp_servers(
        machine_id, public_address, bind_port, token, version, download_base,
        status, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'not_deployed', '', ?, ?)
    `).run(input.machineId, publicAddress, bindPort, randomToken(), version, downloadBase, now, now);
    return this.requireServer(Number(result.lastInsertRowid));
  }

  async deployServer(id: number): Promise<FrpServerRecord> {
    const server = this.requireServer(id);
    const otherOnlineServer = this.listServers().find((item) => item.id !== id && item.status === 'online');
    if (otherOnlineServer) {
      throw new ConflictError(`当前版本只能有一个在线 FRP 入口：${otherOnlineServer.publicAddress}:${otherOnlineServer.bindPort} 已在线。`);
    }
    const { connection } = await this.options.ssh.connectionForMachine(server.machineId);
    await this.setServerStatus(id, 'deploying');
    const config = [
      'bindAddr = "0.0.0.0"',
      `bindPort = ${server.bindPort}`,
      `auth.token = ${tomlString(server.token)}`,
      'transport.tls.force = true',
      '',
    ].join('\n');
    const script = buildFrpsInstaller({
      archive: this.archiveUrl(server.version, 'linux'),
      checksumUrl: this.checksumUrl(server.version),
      config,
      bindPort: server.bindPort,
    });
    try {
      await this.runSsh(connection, script);
      const updated = await this.setServerStatus(id, 'online');
      await this.syncServerCapabilities(server.machineId, updated);
      await this.restartVisitor();
      return updated;
    } catch (error) {
      throw this.failServer(id, error);
    }
  }

  async configureRelay(input: {
    machineId: number;
    serverId: number;
  }): Promise<FrpRelayRecord> {
    const server = this.requireServer(input.serverId);
    await this.requireSshMachine(input.machineId);
    const machine = (await this.options.machines.listMachines()).find((item) => item.id === input.machineId);
    if (!machine) throw new NotFoundError(`Machine "${input.machineId}" was not found`);
    if (server.machineId === input.machineId) {
      throw new ValidationError('FRP 服务端机器不能同时作为自己的 SSH 中转客户端。');
    }
    const existing = this.options.database.prepare('SELECT id FROM frp_relays WHERE machine_id=?').get(input.machineId) as { id: number } | undefined;
    const localPort = readMachineSshPort(machine);
    const proxyName = `asb-${machine.name}-ssh`;
    const now = new Date().toISOString();
    if (existing) {
      this.options.database.prepare(`
        UPDATE frp_relays
        SET server_id=?, local_port=?, proxy_name=?, enabled=1, status='not_deployed', last_error='', updated_at=?
        WHERE id=?
      `).run(input.serverId, localPort, proxyName, now, existing.id);
      return this.requireRelay(Number(existing.id));
    }
    const visitorPort = this.allocateVisitorPort();
    const result = this.options.database.prepare(`
      INSERT INTO frp_relays(
        machine_id, server_id, local_port, proxy_name, secret_key, visitor_port, enabled,
        status, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 'not_deployed', '', ?, ?)
    `).run(input.machineId, input.serverId, localPort, proxyName, randomToken(24), visitorPort, now, now);
    return this.requireRelay(Number(result.lastInsertRowid));
  }

  async deployRelay(id: number): Promise<FrpRelayRecord> {
    let relay = this.requireRelay(id);
    const server = this.requireServer(relay.serverId);
    if (server.status !== 'online') throw new DependencyError('请先部署并启动云端 FRP 服务端。');
    const { connection, machine } = await this.options.ssh.connectionForMachine(relay.machineId);
    await this.setRelayStatus(id, 'deploying');
    const config = this.relayConfig(server, relay);
    const script = buildFrpcInstaller({
      archive: this.archiveUrl(server.version, 'remote'),
      checksumUrl: this.checksumUrl(server.version),
      config,
      name: relay.proxyName,
    });
    try {
      const remoteUser = (await this.runSsh(connection, 'id -un')).stdout.trim();
      if (!remoteUser) throw new DependencyError('无法识别远端 SSH 用户，不能切换到 FRP visitor。');
      await this.runSsh(connection, script);
      await this.options.database.prepare('UPDATE frp_relays SET enabled=1 WHERE id=?').run(id);
      await this.restartVisitor();
      relay = this.requireRelay(id);
      await this.waitForVisitor({
        host: '127.0.0.1',
        port: relay.visitorPort,
        user: remoteUser,
        privateKeyPath: typeof connection.privateKeyPath === 'string' ? connection.privateKeyPath : null,
      });
      await this.useRelayConnection(machine, relay);
      return await this.setRelayStatus(id, 'online');
    } catch (error) {
      throw this.failRelay(id, error);
    }
  }

  async disableRelay(id: number): Promise<FrpRelayRecord> {
    const relay = this.requireRelay(id);
    const machines = await this.options.machines.listMachines();
    const machine = machines.find((item) => item.id === relay.machineId);
    if (machine) {
      await this.runSsh(readMachineDirectConnection(machine), `
        if [ "$(uname -s)" = Darwin ]; then
          launchctl unload "$HOME/Library/LaunchAgents/com.agent-session-bridge.frpc.plist" >/dev/null 2>&1 || true
        elif command -v systemctl >/dev/null 2>&1; then
          if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then
            SUDO=sudo; [ "$(id -u)" = 0 ] && SUDO=''
            $SUDO systemctl disable --now asb-frpc >/dev/null 2>&1 || true
          else
            systemctl --user disable --now asb-frpc >/dev/null 2>&1 || true
          fi
        fi
      `);
      await this.restoreDirectConnection(machine);
    }
    const now = new Date().toISOString();
    this.options.database.prepare(`
      UPDATE frp_relays SET enabled=0, status='disabled', last_error='', updated_at=? WHERE id=?
    `).run(now, id);
    await this.restartVisitor();
    return this.requireRelay(id);
  }

  installScript(id: number): string {
    const relay = this.requireRelay(id);
    if (!relay.enabled) throw new ValidationError('该 FRP 中转已停用，不能生成接入脚本。');
    const server = this.requireServer(relay.serverId);
    const config = this.relayConfig(server, relay);
    return buildFrpcInstaller({
      archive: this.archiveUrl(server.version, 'remote'),
      checksumUrl: this.checksumUrl(server.version),
      config,
      name: relay.proxyName,
    });
  }

  async stop(): Promise<void> {
    this.visitorGeneration += 1;
    this.visitorProcess?.kill('SIGTERM');
    this.visitorProcess = null;
  }

  async start(): Promise<void> {
    try {
      await this.restartVisitor();
    } catch (error) {
      this.options.logger.warn({ err: error }, 'failed to restore local FRP visitor');
      this.options.database.prepare(`
        UPDATE frp_relays
        SET status='error', last_error=?, updated_at=?
        WHERE enabled=1
      `).run(
        error instanceof Error ? error.message : String(error),
        new Date().toISOString(),
      );
    }
  }

  private allocateVisitorPort(): number {
    const used = new Set(this.listRelays().map((relay) => relay.visitorPort));
    for (let port = 22000; port <= 22999; port += 1) {
      if (!used.has(port)) return port;
    }
    throw new DependencyError('可用 visitor 端口已用完（22000–22999）。');
  }

  private async restartVisitor(): Promise<void> {
    const generation = ++this.visitorGeneration;
    this.visitorProcess?.kill('SIGTERM');
    this.visitorProcess = null;
    const relays = this.listRelays().filter((relay) => relay.enabled);
    if (!relays.length) return;
    const servers = new Map(this.listServers().map((server) => [server.id, server]));
    const groups = new Map<number, typeof relays>();
    for (const relay of relays) {
      const list = groups.get(relay.serverId) ?? [];
      list.push(relay);
      groups.set(relay.serverId, list);
    }
    const configs: string[] = [];
    for (const [serverId, group] of groups) {
      const server = servers.get(serverId);
      if (!server) continue;
      configs.push([
        `serverAddr = ${tomlString(server.publicAddress)}`,
        `serverPort = ${server.bindPort}`,
        `auth.token = ${tomlString(server.token)}`,
        'transport.tls.enable = true',
        ...group.flatMap((relay) => [
          '[[visitors]]',
          `name = ${tomlString(`${relay.proxyName}-visitor`)}`,
          'type = "stcp"',
          `serverName = ${tomlString(relay.proxyName)}`,
          `secretKey = ${tomlString(relay.secretKey)}`,
          'bindAddr = "127.0.0.1"',
          `bindPort = ${relay.visitorPort}`,
          '',
        ]),
      ].join('\n'));
    }
    if (!configs.length) return;
    if (groups.size > 1) throw new DependencyError('当前版本只支持一个在线 FRP 公网入口。');
    const binary = await this.ensureLocalFrpc();
    const configPath = path.join(this.options.stateDir, 'visitor-frpc.toml');
    fs.writeFileSync(configPath, configs.join('\n'), { mode: 0o600 });
    const log = fs.openSync(path.join(this.options.stateDir, 'visitor-frpc.log'), 'a');
    const child = spawn(binary, ['-c', configPath], { stdio: ['ignore', log, log] });
    fs.closeSync(log);
    this.visitorProcess = child;
    child.once('exit', (code) => {
      if (generation !== this.visitorGeneration) return;
      this.visitorProcess = null;
      this.options.database.prepare(`
        UPDATE frp_relays
        SET status='error', last_error=?, updated_at=?
        WHERE enabled=1
      `).run(
        `local FRP visitor exited unexpectedly with code ${code ?? 'null'}`,
        new Date().toISOString(),
      );
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    if (child.exitCode !== null) throw new DependencyError('本地 FRP visitor 启动失败，请查看 data/frp/visitor-frpc.log。');
  }

  private relayConfig(server: FrpServerRecord, relay: FrpRelayRecord): string {
    return [
      `serverAddr = ${tomlString(server.publicAddress)}`,
      `serverPort = ${server.bindPort}`,
      `auth.token = ${tomlString(server.token)}`,
      'transport.tls.enable = true',
      '[[proxies]]',
      `name = ${tomlString(relay.proxyName)}`,
      'type = "stcp"',
      `secretKey = ${tomlString(relay.secretKey)}`,
      'localIP = "127.0.0.1"',
      `localPort = ${relay.localPort}`,
      '',
    ].join('\n');
  }

  private async ensureLocalFrpc(): Promise<string> {
    if (this.options.frpcBin) return this.options.frpcBin;
    const cached = path.join(this.options.stateDir, 'bin', `frpc-v${this.options.version}`);
    if (fs.existsSync(cached)) return cached;
    const platform = process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const archive = this.archiveUrl(this.options.version, `${platform}_${arch}`);
    const checksum = this.checksumUrl(this.options.version);
    await this.downloadVerifiedArchive(archive, checksum, `frp_${this.options.version}_${platform}_${arch}.tar.gz`);
    fs.mkdirSync(path.dirname(cached), { recursive: true });
    await runCommand('tar', [
      '-xzf', path.join(this.options.stateDir, 'download.tar.gz'),
      '--strip-components=1', '-C', path.dirname(cached),
      `frp_${this.options.version}_${platform}_${arch}/frpc`,
    ]);
    fs.chmodSync(cached, 0o755);
    return cached;
  }

  private async downloadVerifiedArchive(archiveUrl: string, checksumUrl: string, archiveName: string): Promise<void> {
    fs.mkdirSync(this.options.stateDir, { recursive: true });
    const archivePath = path.join(this.options.stateDir, 'download.tar.gz');
    const [archiveResponse, checksumResponse] = await Promise.all([
      fetch(archiveUrl),
      fetch(checksumUrl),
    ]);
    if (!archiveResponse.ok || !checksumResponse.ok) {
      throw new DependencyError(`下载 FRP 失败：${archiveResponse.status}/${checksumResponse.status}`);
    }
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    const checksumText = await checksumResponse.text();
    const expected = checksumText.split('\n').find((line) => line.includes(archiveName))?.split(/\s+/u)[0];
    if (!expected || crypto.createHash('sha256').update(archive).digest('hex') !== expected) {
      throw new DependencyError('FRP 下载包 SHA256 校验失败。');
    }
    fs.writeFileSync(archivePath, archive, { mode: 0o600 });
  }

  private archiveUrl(version: string, target: string): string {
    const suffix = target === 'remote' ? '__ASB_OS_ARCH__' : target;
    return `${this.options.downloadBase}/v${version}/frp_${version}_${suffix}.tar.gz`;
  }

  private checksumUrl(version: string): string {
    return `${this.options.downloadBase}/v${version}/frp_sha256_checksums.txt`;
  }

  private async useRelayConnection(machine: MachineRecord, relay: FrpRelayRecord): Promise<void> {
    const direct = (typeof machine.capabilities.sshDirect === 'object' && machine.capabilities.sshDirect !== null
      ? machine.capabilities.sshDirect : machine.capabilities.ssh) as MachineRecord['capabilities'];
    await this.options.machines.registerMachine({
      capabilities: {
        ...machine.capabilities,
        frpRole: 'client',
        relayEnabled: true,
        ssh: {
          host: '127.0.0.1',
          port: relay.visitorPort,
          user: typeof direct.user === 'string' ? direct.user : null,
          privateKeyPath: typeof direct.privateKeyPath === 'string' ? direct.privateKeyPath : null,
        },
        sshDirect: direct,
      },
      host: machine.host,
      labels: machine.labels,
      name: machine.name,
      namespace: machine.namespace,
      runnerVersion: machine.runnerVersion,
      status: machine.status,
    });
  }

  private async restoreDirectConnection(machine: MachineRecord): Promise<void> {
    const direct = (machine.capabilities.sshDirect ?? machine.capabilities.ssh) as MachineRecord['capabilities'];
    await this.options.machines.registerMachine({
      capabilities: { ...machine.capabilities, frpRole: 'none', relayEnabled: false, ssh: direct, sshDirect: null },
      host: machine.host,
      labels: machine.labels,
      name: machine.name,
      namespace: machine.namespace,
      runnerVersion: machine.runnerVersion,
      status: machine.status,
    });
  }

  private async syncServerCapabilities(machineId: number, server: FrpServerRecord): Promise<void> {
    const machines = await this.options.machines.listMachines();
    const machine = machines.find((item) => item.id === machineId);
    if (!machine) return;
    await this.options.machines.registerMachine({
      capabilities: { ...machine.capabilities, frpRole: 'server', frpServerId: server.id },
      host: machine.host,
      labels: machine.labels,
      name: machine.name,
      namespace: machine.namespace,
      runnerVersion: machine.runnerVersion,
      status: machine.status,
    });
  }

  private async runSsh(connection: { host: string; port: number; user: string | null; privateKeyPath: string | null }, script: string) {
    const args = ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new', '-p', String(connection.port)];
    if (connection.privateKeyPath) args.push('-i', connection.privateKeyPath);
    args.push(connection.user ? `${connection.user}@${connection.host}` : connection.host, '/bin/sh', '-lc', script);
    return runCommand('ssh', args, { maxOutputCharacters: 40_000 });
  }

  private async waitForVisitor(connection: {
    host: string;
    port: number;
    user: string | null;
    privateKeyPath: string | null;
  }): Promise<void> {
    let lastError: unknown = new Error('visitor connection was not checked');
    for (let attempt = 0; attempt < 12; attempt += 1) {
      try {
        await this.runSsh(connection, 'exit 0');
        return;
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw new DependencyError(
      `FRP visitor ${connection.host}:${connection.port} did not become usable: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    );
  }

  private async requireSshMachine(id: number): Promise<MachineRecord> {
    const machines = await this.options.machines.listMachines();
    const machine = machines.find((item) => item.id === id);
    if (!machine || machine.capabilities.connection !== 'ssh') {
      throw new ValidationError('请选择一台已连接的 SSH 机器。');
    }
    return machine;
  }

  private requireServer(id: number): FrpServerRecord {
    const row = this.options.database.prepare('SELECT * FROM frp_servers WHERE id=?').get(id);
    if (!row) throw new NotFoundError(`FRP server "${id}" was not found`);
    return mapServerRow(row as Record<string, unknown>);
  }

  private requireRelay(id: number): FrpRelayRecord {
    const row = this.options.database.prepare('SELECT * FROM frp_relays WHERE id=?').get(id);
    if (!row) throw new NotFoundError(`FRP relay "${id}" was not found`);
    return mapRelayRow(row as Record<string, unknown>);
  }

  private async setServerStatus(id: number, status: string) {
    this.options.database.prepare('UPDATE frp_servers SET status=?, last_error=\'\', updated_at=? WHERE id=?')
      .run(status, new Date().toISOString(), id);
    return this.requireServer(id);
  }

  private async setRelayStatus(id: number, status: string) {
    this.options.database.prepare('UPDATE frp_relays SET status=?, last_error=\'\', updated_at=? WHERE id=?')
      .run(status, new Date().toISOString(), id);
    return this.requireRelay(id);
  }

  private failServer(id: number, error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    this.options.database.prepare('UPDATE frp_servers SET status=\'error\', last_error=?, updated_at=? WHERE id=?')
      .run(message, new Date().toISOString(), id);
    throw new DependencyError(`FRP 部署失败：${message}`);
  }

  private failRelay(id: number, error: unknown): never {
    const message = error instanceof Error ? error.message : String(error);
    this.options.database.prepare('UPDATE frp_relays SET status=\'error\', last_error=?, updated_at=? WHERE id=?')
      .run(message, new Date().toISOString(), id);
    throw new DependencyError(`FRP 部署失败：${message}`);
  }
}

function buildFrpsInstaller(input: { archive: string; bindPort: number; checksumUrl: string; config: string }) {
  const configBase64 = Buffer.from(input.config).toString('base64');
  return `
set -eu
[ "$(uname -s)" = Linux ] || { echo 'FRP server deployment currently supports Linux only.' >&2; exit 2; }
case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "Unsupported arch $(uname -m)" >&2; exit 2 ;; esac
if [ "$(id -u)" = 0 ]; then
  SUDO=''
elif sudo -n true 2>/dev/null; then
  SUDO=sudo
else
  echo 'Need root or passwordless sudo.' >&2
  exit 2
fi
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
archive=$(printf '%s' ${shellQuote(input.archive)} | sed "s/__ASB_OS_ARCH__/linux_$arch/")
curl -fsSL "$archive" -o "$work/frp.tar.gz"
curl -fsSL ${shellQuote(input.checksumUrl)} -o "$work/checksums.txt"
(cd "$work" && grep " $(basename "$archive")$" checksums.txt | sha256sum -c -)
tar -xzf "$work/frp.tar.gz" -C "$work"
$SUDO mkdir -p /opt/asb-frp/bin /etc/asb-frp
$SUDO install -m 0755 "$work"/frp_*/frps /opt/asb-frp/bin/frps
printf '%s' ${shellQuote(configBase64)} | base64 -d | $SUDO tee /etc/asb-frp/frps.toml >/dev/null
$SUDO chmod 600 /etc/asb-frp/frps.toml
$SUDO tee /etc/systemd/system/asb-frps.service >/dev/null <<'UNIT'
[Unit]
Description=Agent Session Bridge FRP server
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/opt/asb-frp/bin/frps -c /etc/asb-frp/frps.toml
Restart=always
RestartSec=3
User=root
[Install]
WantedBy=multi-user.target
UNIT
$SUDO systemctl daemon-reload
$SUDO systemctl enable --now asb-frps
systemctl is-active --quiet asb-frps
if command -v ss >/dev/null 2>&1; then
  ss -ltn | grep -q "[:.]${input.bindPort}[[:space:]]"
fi
`;
}

function buildFrpcInstaller(input: { archive: string; checksumUrl: string; config: string; name: string }) {
  const configBase64 = Buffer.from(input.config).toString('base64');
  const label = input.name.replace(/[^A-Za-z0-9_.-]+/g, '-');
  return `
set -eu
os=$(uname -s)
case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64|arm64) arch=arm64 ;; *) echo "Unsupported arch $(uname -m)" >&2; exit 2 ;; esac
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
archive=$(printf '%s' ${shellQuote(input.archive)} | sed "s/__ASB_OS_ARCH__/$(echo "$os" | tr '[:upper:]' '[:lower:]')_$arch/")
curl -fsSL "$archive" -o "$work/frp.tar.gz"
curl -fsSL ${shellQuote(input.checksumUrl)} -o "$work/checksums.txt"
(cd "$work" && grep " $(basename "$archive")$" checksums.txt | sha256sum -c -)
mkdir -p "$HOME/.asb-frp/bin" "$HOME/.config/agent-session-bridge"
tar -xzf "$work/frp.tar.gz" -C "$work"
install -m 0755 "$work"/frp_*/frpc "$HOME/.asb-frp/bin/frpc"
printf '%s' ${shellQuote(configBase64)} | base64 -d > "$HOME/.config/agent-session-bridge/frpc.toml"
chmod 600 "$HOME/.config/agent-session-bridge/frpc.toml"
if [ "$os" = Darwin ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$HOME/Library/LaunchAgents/com.agent-session-bridge.frpc.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.agent-session-bridge.frpc.${label}</string>
  <key>ProgramArguments</key><array><string>$HOME/.asb-frp/bin/frpc</string><string>-c</string><string>$HOME/.config/agent-session-bridge/frpc.toml</string></array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
</dict></plist>
PLIST
  launchctl unload "$HOME/Library/LaunchAgents/com.agent-session-bridge.frpc.plist" >/dev/null 2>&1 || true
  launchctl load "$HOME/Library/LaunchAgents/com.agent-session-bridge.frpc.plist"
else
  if [ "$(id -u)" = 0 ] || sudo -n true 2>/dev/null; then
    SUDO=sudo; [ "$(id -u)" = 0 ] && SUDO=''
    $SUDO install -m 0755 "$HOME/.asb-frp/bin/frpc" /usr/local/bin/asb-frpc
    $SUDO mkdir -p /etc/asb-frp
    $SUDO cp "$HOME/.config/agent-session-bridge/frpc.toml" /etc/asb-frp/frpc.toml
    $SUDO chmod 600 /etc/asb-frp/frpc.toml
    $SUDO tee /etc/systemd/system/asb-frpc.service >/dev/null <<'UNIT'
[Unit]
Description=Agent Session Bridge FRP client
After=network-online.target
Wants=network-online.target
[Service]
ExecStart=/usr/local/bin/asb-frpc -c /etc/asb-frp/frpc.toml
Restart=always
RestartSec=3
[Install]
WantedBy=multi-user.target
UNIT
    $SUDO systemctl daemon-reload
    $SUDO systemctl enable --now asb-frpc
  else
    systemctl --user daemon-reload 2>/dev/null || true
    mkdir -p "$HOME/.config/systemd/user"
    cat > "$HOME/.config/systemd/user/asb-frpc.service" <<'UNIT'
[Unit]
Description=Agent Session Bridge FRP client
After=default.target
[Service]
ExecStart=%h/.asb-frp/bin/frpc -c %h/.config/agent-session-bridge/frpc.toml
Restart=always
RestartSec=3
[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now asb-frpc
  fi
fi
`;
}

function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function readMachineSshPort(machine: MachineRecord): number {
  const port = readMachineDirectConnection(machine).port;
  return typeof port === 'number' && Number.isInteger(port) && port > 0 && port < 65536
    ? port
    : 22;
}

function readMachineDirectConnection(machine: MachineRecord): {
  host: string;
  port: number;
  user: string | null;
  privateKeyPath: string | null;
} {
  const direct = (machine.capabilities.sshDirect ?? machine.capabilities.ssh) as {
    host?: unknown;
    port?: unknown;
    user?: unknown;
    privateKeyPath?: unknown;
  } | null;
  return {
    host: typeof direct?.host === 'string' ? direct.host : String(machine.host ?? ''),
    port: typeof direct?.port === 'number' ? direct.port : 22,
    user: typeof direct?.user === 'string' && direct.user ? direct.user : null,
    privateKeyPath: typeof direct?.privateKeyPath === 'string' && direct.privateKeyPath ? direct.privateKeyPath : null,
  };
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function mapServerRow(row: Record<string, unknown>): FrpServerRecord {
  const status = String(row.status);
  return {
    bindPort: Number(row.bind_port),
    createdAt: String(row.created_at),
    downloadBase: String(row.download_base),
    id: Number(row.id),
    lastError: String(row.last_error ?? ''),
    machineId: Number(row.machine_id),
    publicAddress: String(row.public_address),
    status: SERVER_STATUSES.has(status) ? status as FrpServerRecord['status'] : 'offline',
    token: String(row.token),
    updatedAt: String(row.updated_at),
    version: String(row.version),
  };
}

function mapRelayRow(row: Record<string, unknown>): FrpRelayRecord {
  const status = String(row.status);
  return {
    createdAt: String(row.created_at),
    enabled: Number(row.enabled) === 1,
    id: Number(row.id),
    lastError: String(row.last_error ?? ''),
    localPort: Number(row.local_port ?? 22),
    machineId: Number(row.machine_id),
    proxyName: String(row.proxy_name),
    secretKey: String(row.secret_key),
    serverId: Number(row.server_id),
    status: RELAY_STATUSES.has(status) ? status as FrpRelayRecord['status'] : 'error',
    updatedAt: String(row.updated_at),
    visitorPort: Number(row.visitor_port),
  };
}
