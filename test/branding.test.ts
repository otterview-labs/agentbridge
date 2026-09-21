import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('uses AgentBridge as the public product name', async () => {
  const [readme, index, manifestSource, packageSource] = await Promise.all([
    readFile(path.join(process.cwd(), 'README.md'), 'utf8'),
    readFile(path.join(process.cwd(), 'public', 'index.html'), 'utf8'),
    readFile(path.join(process.cwd(), 'public', 'manifest.webmanifest'), 'utf8'),
    readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
  ]);
  const publicCopy = `${readme}\n${index}\n${manifestSource}`;

  assert.match(readme, /^# AgentBridge$/mu);
  assert.match(index, />AgentBridge</u);
  assert.doesNotMatch(publicCopy, /AI Butler|HAPI 风格|统一 AI 管家|獭维实验室/u);

  const manifest = JSON.parse(manifestSource) as { name?: unknown; short_name?: unknown };
  assert.equal(manifest.name, 'AgentBridge');
  assert.equal(manifest.short_name, 'AgentBridge');

  const packageMetadata = JSON.parse(packageSource) as { name?: unknown };
  assert.equal(packageMetadata.name, 'agentbridge');
});
