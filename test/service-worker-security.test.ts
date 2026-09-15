import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

test('service worker upgrades safe shell assets without caching private routes', async () => {
  const source = await readFile(path.join(process.cwd(), 'public', 'service-worker.js'), 'utf8');
  const listeners = new Map<string, (event: unknown) => void>();
  let cacheWrites = 0;
  let installedAssets: string[] = [];
  const deletedCaches: string[] = [];
  const context = {
    URL,
    caches: {
      delete: async (key: string) => {
        deletedCaches.push(key);
        return true;
      },
      keys: async () => [
        'asb-shell-v2',
        'asb-shell-v3',
        'asb-shell-v4',
        'asb-shell-v5',
        'unrelated-cache',
      ],
      match: async () => undefined,
      open: async () => ({
        addAll: async (assets: string[]) => {
          installedAssets = [...assets];
        },
        match: async () => undefined,
        put: async () => {
          cacheWrites += 1;
        },
      }),
    },
    fetch: async () => ({
      clone: () => ({}),
      ok: true,
    }),
    self: {
      addEventListener: (name: string, listener: (event: unknown) => void) => {
        listeners.set(name, listener);
      },
      clients: {
        claim: () => undefined,
      },
      location: {
        origin: 'https://asb.example.test',
      },
      skipWaiting: () => undefined,
    },
  };
  vm.runInNewContext(source, context, { filename: 'service-worker.js' });
  const fetchListener = listeners.get('fetch');
  assert.ok(fetchListener);

  const installListener = listeners.get('install');
  assert.ok(installListener);
  let installation: Promise<unknown> | undefined;
  installListener({
    waitUntil: (promise: Promise<unknown>) => {
      installation = promise;
    },
  });
  assert.ok(installation);
  await installation;
  assert.equal(installedAssets.includes('/api-token-state.js'), true);

  const activateListener = listeners.get('activate');
  assert.ok(activateListener);
  let activation: Promise<unknown> | undefined;
  activateListener({
    waitUntil: (promise: Promise<unknown>) => {
      activation = promise;
    },
  });
  assert.ok(activation);
  await activation;
  assert.deepEqual(deletedCaches, ['asb-shell-v2', 'asb-shell-v3', 'asb-shell-v4', 'asb-shell-v5']);

  let intercepted = false;
  fetchListener({
    request: {
      method: 'GET',
      mode: 'navigate',
      url: 'https://asb.example.test/sessions',
    },
    respondWith: () => {
      intercepted = true;
    },
  });
  assert.equal(intercepted, false, 'API navigation must bypass the shell cache');

  fetchListener({
    request: {
      method: 'GET',
      mode: 'cors',
      url: 'https://asb.example.test/app.js?token=do-not-cache',
    },
    respondWith: () => {
      intercepted = true;
    },
  });
  assert.equal(intercepted, false, 'query-bearing static requests must bypass Cache Storage');
  assert.equal(cacheWrites, 0);
});

test('static assets prefer fresh network data and use cache only while offline', async () => {
  const source = await readFile(path.join(process.cwd(), 'public', 'service-worker.js'), 'utf8');
  const listeners = new Map<string, (event: unknown) => void>();
  const cached = { body: 'old stylesheet' };
  const fresh = { body: 'new stylesheet', ok: true, clone: () => ({ body: 'new stylesheet' }) };
  let offline = false;
  let writes = 0;
  const context = {
    URL,
    caches: { open: async () => ({ match: async () => cached, put: async () => { writes += 1; } }) },
    fetch: async () => { if (offline) throw new Error('offline'); return fresh; },
    self: { addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener), location: { origin: 'https://asb.example.test' } },
  };
  vm.runInNewContext(source, context);
  const readAsset = async () => {
    let response: Promise<unknown> | undefined;
    listeners.get('fetch')!({ request: { method: 'GET', mode: 'cors', url: 'https://asb.example.test/app.css' }, respondWith: (value: Promise<unknown>) => { response = value; } });
    return response;
  };
  assert.equal(await readAsset(), fresh);
  assert.equal(writes, 1);
  offline = true;
  assert.equal(await readAsset(), cached);
  assert.equal(writes, 1);
});
