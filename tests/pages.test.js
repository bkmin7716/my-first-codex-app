import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPages } from '../scripts/build-pages.mjs';

const output = await mkdtemp(join(tmpdir(), 'golf-pages-'));
const env = { SUPABASE_URL: 'https://example.supabase.co/', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test-public', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' };
try {
  for (const key of ['', 'sb_secret_private', 'service_role', 'eyJhbGciOiJIUzI1NiJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIn0.sig']) {
    await assert.rejects(buildPages({ output, env: { ...env, SUPABASE_PUBLISHABLE_KEY: key } }), /sb_publishable_/);
    assert.deepEqual(await readdir(output), []);
  }
  await assert.rejects(buildPages({ output, env: { ...env, SUPABASE_URL: 'http://example.supabase.co' } }), /HTTPS/);
  await buildPages({ output, env: { ...env, SUPABASE_SECRET_KEY: 'must-not-be-copied', SERVICE_ROLE_KEY: 'must-not-be-copied' } });
  const config = await readFile(join(output, 'shared-config.js'), 'utf8');
  assert.match(config, /https:\/\/example.supabase.co/);
  assert.match(config, /sb_publishable_test-public/);
  assert.doesNotMatch(config, /must-not-be-copied/);
  assert.match(await readFile(join(output, 'sw.js'), 'utf8'), /golf-hussein-pages-123-2/);
  assert.deepEqual((await readdir(output)).sort(), ['.nojekyll', 'app.js', 'engine.js', 'scorecard.js', 'icon-192.png', 'icon-512.png', 'index.html', 'manifest.webmanifest', 'shared-config.js', 'shared-ui.js', 'shared.js', 'storage.js', 'style.css', 'sw.js'].sort());
  const base = new URL('https://bkmin7716.github.io/my-first-codex-app/');
  const html = await readFile(join(output, 'index.html'), 'utf8');
  for (const [, path] of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    if (!path.startsWith('https:')) assert.ok(new URL(path, base).pathname.startsWith(base.pathname));
  }
  const manifest = JSON.parse(await readFile(join(output, 'manifest.webmanifest'), 'utf8'));
  for (const path of [manifest.start_url, manifest.scope, ...manifest.icons.map(i => i.src), './sw.js', './shared-config.js'])
    assert.ok(new URL(path, base).pathname.startsWith(base.pathname));
  console.log('PASS: Pages config injection, private-key rejection, asset allowlist, cache version and project paths');
} finally { await rm(output, { recursive: true, force: true }); }
