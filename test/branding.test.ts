import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

test('uses agentBridge as the public product name', async () => {
  const [readme, index, studio, phone, manifestSource, packageSource, androidManifest, site] =
    await Promise.all([
      readFile(path.join(process.cwd(), 'README.md'), 'utf8'),
      readFile(path.join(process.cwd(), 'public', 'index.html'), 'utf8'),
      readFile(path.join(process.cwd(), 'public', 'studio.html'), 'utf8'),
      // The Android shell renders this one in a WebView, so its copy is public too.
      readFile(
        path.join(process.cwd(), 'android', 'app', 'src', 'main', 'assets', 'phone.html'),
        'utf8',
      ),
      readFile(path.join(process.cwd(), 'public', 'manifest.webmanifest'), 'utf8'),
      readFile(path.join(process.cwd(), 'package.json'), 'utf8'),
      readFile(
        path.join(process.cwd(), 'android', 'app', 'src', 'main', 'AndroidManifest.xml'),
        'utf8',
      ),
      // Published on GitHub Pages, so it is the most public copy of all.
      readFile(path.join(process.cwd(), 'site', 'index.html'), 'utf8'),
    ]);
  const publicCopy = [
    readme,
    index,
    studio,
    phone,
    manifestSource,
    androidManifest,
    site,
  ].join('\n');

  assert.match(readme, /^# agentBridge$/mu);
  assert.match(index, />agentBridge</u);
  // The blacklist doubles as a regression guard: display copy has drifted to the
  // spaced "Agent Bridge" and PascalCase "AgentBridge" spellings before.
  assert.doesNotMatch(
    publicCopy,
    /AI Butler|HAPI 风格|统一 AI 管家|獭维实验室|Agent Bridge|AgentBridge|AgentSessionBridge/u,
  );
  // The original hyphenated name reached visible copy too, most recently as the
  // "AGENT SESSION BRIDGE / CONTROL" eyebrow on the console. Checked separately
  // and case-insensitively so the all-caps form is covered, but the lowercase
  // "agentbridge" from the clone URL stays legitimate and must not trip this.
  assert.doesNotMatch(publicCopy, /agent[ -]session[ -]bridge/iu);

  // The launcher label is what the phone shows, so it is public copy too.
  assert.match(androidManifest, /android:label="agentBridge"/u);

  const manifest = JSON.parse(manifestSource) as { name?: unknown; short_name?: unknown };
  assert.equal(manifest.name, 'agentBridge');
  assert.equal(manifest.short_name, 'agentBridge');

  const packageMetadata = JSON.parse(packageSource) as { name?: unknown };
  assert.equal(packageMetadata.name, 'agentbridge');

  // The download page is the one link a visitor is meant to follow, and it only
  // survives a release if it is the /releases/latest permalink: a versioned
  // asset URL would 404 the moment the next release ships. The asset name is
  // fixed by the release workflow, so all three have to agree.
  assert.match(
    site,
    /href="https:\/\/github\.com\/otterview-labs\/agentbridge\/releases\/latest\/download\/agentbridge\.apk"/u,
  );
});
