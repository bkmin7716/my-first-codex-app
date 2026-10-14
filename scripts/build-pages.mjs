import { mkdir, readFile, writeFile, copyFile, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export async function buildPages({ env = process.env, output = 'site' } = {}) {
  const url = (env.SUPABASE_URL || '').trim();
  const publishableKey = (env.SUPABASE_PUBLISHABLE_KEY || '').trim();
  if (!/^https:\/\/[a-z0-9-]+\.supabase\.co\/?$/i.test(url))
    throw new Error('SUPABASE_URL must be an HTTPS Supabase project URL.');
  // Strict allowlist: reject secret keys and all JWTs (including service_role).
  if (!/^sb_publishable_[A-Za-z0-9_-]+$/.test(publishableKey))
    throw new Error('SUPABASE_PUBLISHABLE_KEY must be an sb_publishable_ key. Secret and JWT keys are forbidden.');
  const version = env.GITHUB_RUN_ID ? `${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT || '1'}` : Date.now().toString();
  if (!/^[0-9-]+$/.test(version)) throw new Error('Invalid deployment cache version.');
  // Validate before writing any deployable files. Copy only public runtime assets.
  await rm(output, { recursive: true, force: true });
  await mkdir(output, { recursive: true });
  const assets = ['index.html', 'style.css', 'app.js', 'engine.js', 'storage.js', 'shared.js', 'shared-ui.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png'];
  for (const asset of assets) await copyFile(asset, resolve(output, asset));
  await writeFile(resolve(output, 'shared-config.js'), `// Generated public browser configuration.\nexport const sharedConfig = ${JSON.stringify({ url: url.replace(/\/$/, ''), publishableKey }, null, 2)};\n`);
  const sw = await readFile('sw.js', 'utf8');
  await writeFile(resolve(output, 'sw.js'), sw.replace(/const CACHE='[^']+'/,
    `const CACHE='golf-hussein-pages-${version}'`));
  await writeFile(resolve(output, '.nojekyll'), '');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildPages().catch(error => { console.error(error.message); process.exitCode = 1; });
}
