#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function tarText(args) {
  const { stdout } = await execFileAsync('tar', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024,
  });
  return stdout;
}

export async function inspectPack(artifactPath) {
  const artifact = resolve(artifactPath);
  const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const listing = (await tarText(['-tzf', artifact]))
    .split('\n')
    .map((entry) => entry.replace(/^\.\//, ''))
    .filter(Boolean);
  const files = listing.filter((entry) => !entry.endsWith('/'));
  const unexpected = files.filter(
    (entry) =>
      entry !== 'package.json' &&
      entry !== 'default/proxies.yml' &&
      !entry.startsWith('static/'),
  );
  if (unexpected.length > 0) {
    throw new Error(`pack contains unexpected files: ${unexpected.join(', ')}`);
  }
  for (const required of ['package.json', 'default/proxies.yml']) {
    if (!files.includes(required)) throw new Error(`pack is missing ${required}`);
  }

  const manifest = JSON.parse(await tarText(['-xOzf', artifact, './package.json']));
  if (manifest.name !== packageJson.name || manifest.version !== packageJson.version) {
    throw new Error(
      `pack identity ${manifest.name}@${manifest.version} does not match package.json ${packageJson.name}@${packageJson.version}`,
    );
  }
  if ('scripts' in manifest || 'dependencies' in manifest || 'devDependencies' in manifest) {
    throw new Error('pack manifest unexpectedly contains executable or dependency metadata');
  }

  const proxies = await tarText(['-xOzf', artifact, './default/proxies.yml']);
  const activeProxyLines = proxies
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  if (activeProxyLines.length > 0) {
    throw new Error(`pack declares external proxy capability: ${activeProxyLines.join(' ')}`);
  }
  if (/authorization|cookie|x-api-key|inject\s*:/i.test(proxies)) {
    throw new Error('pack proxy manifest contains a sensitive header declaration');
  }
  if (!files.some((entry) => /^static\/assets\/.*\.js$/.test(entry))) {
    throw new Error('pack contains no compiled JavaScript asset');
  }
  console.log(`Pack inspection passed: ${basename(artifact)} (${files.length} files, empty proxy manifest)`);
  return { artifact, files, manifest };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let artifact = process.argv[2];
  if (!artifact) {
    const packageJson = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    artifact = join(root, 'build', `${packageJson.name}-${packageJson.version}.tgz`);
  }
  inspectPack(artifact).catch((error) => {
    console.error(`Pack inspection failed: ${error.message}`);
    process.exit(1);
  });
}
