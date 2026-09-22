import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import pino from 'pino';

import { DatabaseClient } from '../src/infra/storage/database.js';
import { FrpService } from '../src/services/frp-service.js';
import type { MachineRecord } from '../src/domain/machine.js';

function machineFixture(name: string, id: number): MachineRecord {
  const now = new Date().toISOString();
  return {
    capabilities: {
      connection: 'ssh',
      os: 'Linux',
      ssh: { host: `${name}.local`, port: 22, user: 'demo', privateKeyPath: null },
    },
    createdAt: now,
    host: `${name}.local`,
    id,
    labels: ['ssh'],
    lastSeenAt: now,
    name,
    namespace: 'ssh',
    runnerVersion: 'test',
    status: 'online',
    updatedAt: now,
  };
}

function fixture() {
  const database = new DatabaseClient(':memory:', pino({ level: 'silent' }));
  const cloud = machineFixture('cloud', 2);
  const lan = machineFixture('mac-pro', 3);
  lan.capabilities.ssh = {
    ...(lan.capabilities.ssh as { host: string; port: number; user: string; privateKeyPath: null }),
    port: 6022,
  };
  const machines = new Map([[cloud.id, cloud], [lan.id, lan]]);
  const service = new FrpService({
    database,
    downloadBase: 'https://frp.example/download',
    frpcBin: null,
    hostKeyPolicy: 'accept-new',
    logger: pino({ level: 'silent' }),
    machines: {
      listMachines: async () => [...machines.values()],
      registerMachine: async (input) => {
        const current = [...machines.values()].find((machine) => machine.name === input.name);
        assert.ok(current);
        current.capabilities = input.capabilities ?? current.capabilities;
        return current;
      },
    },
    ssh: {
      connectionForMachine: async (id: number) => {
        const machine = machines.get(id);
        assert.ok(machine);
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
    stateDir: '/tmp/asb-frp-test',
    version: '0.61.1',
  });
  return { cloud, lan, machines, service };
}

test('FRP server and relay configuration reserve stable names, keys, and visitor ports', async () => {
  const f = fixture();
  const server = await f.service.configureServer({
    bindPort: 7443,
    machineId: f.cloud.id,
    publicAddress: 'frp.example.com',
  });
  assert.equal(server.status, 'not_deployed');
  assert.equal(server.publicAddress, 'frp.example.com');

  const relay = await f.service.configureRelay({
    machineId: f.lan.id,
    serverId: server.id,
  });
  assert.equal(relay.proxyName, 'asb-mac-pro-ssh');
  assert.equal(relay.localPort, 6022);
  assert.equal(relay.visitorPort, 22000);
  assert.equal(relay.enabled, true);

  await assert.rejects(f.service.configureRelay({ machineId: f.cloud.id, serverId: server.id }), /不能同时/);
});

test('FRP install script is generated without printing plaintext tunnel credentials', async () => {
  const f = fixture();
  const server = await f.service.configureServer({ machineId: f.cloud.id, publicAddress: 'frp.example.com' });
  const relay = await f.service.configureRelay({ machineId: f.lan.id, serverId: server.id });
  const script = f.service.installScript(relay.id);
  assert.match(script, /base64 -d/u);
  assert.match(script, /asb-frpc/u);
  assert.match(script, /frp_0\.61\.1___ASB_OS_ARCH__\.tar\.gz/u);
  execFileSync('/bin/sh', ['-n'], { input: script });
  assert.match(script, /frp_sha256_checksums\.txt/u);
  assert.doesNotMatch(script, new RegExp(server.token, 'u'));
  assert.doesNotMatch(script, new RegExp(relay.secretKey, 'u'));
});

test('FRP overview does not expose server tokens or relay secret keys', async () => {
  const f = fixture();
  const server = await f.service.configureServer({ machineId: f.cloud.id, publicAddress: 'frp.example.com' });
  const relay = await f.service.configureRelay({ machineId: f.lan.id, serverId: server.id });
  const overview = await f.service.overview();
  assert.equal('token' in overview.servers[0]!, false);
  assert.equal('secretKey' in overview.relays[0]!, false);
  assert.equal(overview.relays[0]?.id, relay.id);
});

test('FRP server input rejects unsafe addresses and port ranges', async () => {
  const f = fixture();
  await assert.rejects(f.service.configureServer({ machineId: f.cloud.id, publicAddress: 'bad host' }), /公网地址/u);
  await assert.rejects(f.service.configureServer({ machineId: f.cloud.id, bindPort: 22 }), /端口/u);
});

test('FRP install script downloads from the base configured for that server', async () => {
  const f = fixture();
  const server = await f.service.configureServer({
    downloadBase: 'https://mirror.example/frp',
    machineId: f.cloud.id,
    publicAddress: 'frp.example.com',
  });
  assert.equal(server.downloadBase, 'https://mirror.example/frp');

  const relay = await f.service.configureRelay({ machineId: f.lan.id, serverId: server.id });
  const script = f.service.installScript(relay.id);
  assert.match(script, /https:\/\/mirror\.example\/frp\/v0\.61\.1\/frp_0\.61\.1___ASB_OS_ARCH__\.tar\.gz/u);
  assert.match(script, /https:\/\/mirror\.example\/frp\/v0\.61\.1\/frp_sha256_checksums\.txt/u);
  // The instance-wide default must not leak back in once a server sets its own mirror.
  assert.doesNotMatch(script, /frp\.example\/download/u);
});
