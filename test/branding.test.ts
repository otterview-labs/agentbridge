import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('uses agentBridge as the public product name', async () => {
  const [readme, index, manifestSource, packageSource, androidManifest] = await Promise.all([
    readFile(path.join(process.cwd(), 'README.md'), 'utf8'),
    readFile(path.join(process.cwd(), 'public', 'index.html'), 'utf8'),
    readFile(path.join(process.cwd(), 'public', 'manifest.webmanifest'), 'utf8'),
    readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
    readFile(
      path.join(process.cwd(), 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
      'utf8',
    ),
  ]);
  const publicCopy = `${readme}\n${index}\n${manifestSource}\n${androidManifest}`;

  assert.match(readme, /^# agentBridge$/mu);
  assert.match(index, />agentBridge</u);
  // The blacklist doubles as a regression guard: display copy has drifted to the
  // spaced "Agent Bridge" and PascalCase "AgentBridge" spellings before.
  assert.doesNotMatch(
    publicCopy,
    /AI Butler|HAPI 风格|统一 AI 管家|獭维实验室|Agent Bridge|AgentBridge/u,
  );

  // The launcher label is what the phone shows, so it is public copy too.
  assert.match(androidManifest, /android:label="agentBridge"/u);

  const manifest = JSON.parse(manifestSource) as { name?: unknown; short_name?: unknown };
  assert.equal(manifest.name, 'agentBridge');
  assert.equal(manifest.short_name, 'agentBridge');

  const packageMetadata = JSON.parse(packageSource) as { name?: unknown };
  assert.equal(packageMetadata.name, 'agentbridge');
});
