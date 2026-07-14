#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { inspectPack } from './inspect-pack.mjs';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const artifact = join(root, 'build', `${pkg.name}-${pkg.version}.tgz`);
await inspectPack(artifact);

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');
const artifactBytes = await readFile(artifact);
const lockBytes = await readFile(join(root, 'package-lock.json'));
const frameworkSha = (await readFile(join(root, '.framework-sha'), 'utf8')).trim();
const commit = process.env.GITHUB_SHA ||
  (await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })).stdout.trim();

const lock = JSON.parse(lockBytes.toString('utf8'));

function packageName(path, entry) {
  if (entry.name) return entry.name;
  const marker = 'node_modules/';
  const tail = path.slice(path.lastIndexOf(marker) + marker.length);
  const parts = tail.split('/');
  return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
}

function integrityHash(integrity) {
  if (typeof integrity !== 'string') return undefined;
  const match = integrity.match(/^sha(256|384|512)-(.+)$/);
  if (!match) return undefined;
  return {
    alg: `SHA-${match[1]}`,
    content: Buffer.from(match[2], 'base64').toString('hex'),
  };
}

function npmPurl(name, version) {
  if (name.startsWith('@')) {
    const slash = name.indexOf('/');
    return `pkg:npm/${encodeURIComponent(name.slice(0, slash))}/${encodeURIComponent(name.slice(slash + 1))}@${version}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${version}`;
}

// Generate a deterministic production CycloneDX inventory directly from the
// lockfile. This avoids an npm CLI quirk where nested `npm sbom` invocations
// can exit successfully with empty stdout, which would silently omit release
// evidence in CI.
const components = Object.entries(lock.packages)
  .filter(([path, entry]) => path && entry.dev !== true && entry.version)
  .map(([path, entry]) => {
    const name = packageName(path, entry);
    const component = {
      'bom-ref': `${path}:${name}@${entry.version}`,
      type: 'library',
      name,
      version: entry.version,
      scope: entry.optional ? 'optional' : 'required',
      purl: npmPurl(name, entry.version),
    };
    const hash = integrityHash(entry.integrity);
    if (hash) component.hashes = [hash];
    return component;
  })
  .sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref']));
const rootRefs = new Map(components.map((component) => [component.name, component['bom-ref']]));
const sbomObject = {
  $schema: 'http://cyclonedx.org/schema/bom-1.5.schema.json',
  bomFormat: 'CycloneDX',
  specVersion: '1.5',
  version: 1,
  metadata: {
    component: {
      'bom-ref': `${pkg.name}@${pkg.version}`,
      type: 'application',
      name: pkg.name,
      version: pkg.version,
    },
  },
  components,
  dependencies: [
    {
      ref: `${pkg.name}@${pkg.version}`,
      dependsOn: Object.keys(pkg.dependencies ?? {})
        .map((name) => rootRefs.get(name))
        .filter(Boolean)
        .sort(),
    },
  ],
};
const sbom = JSON.stringify(sbomObject, null, 2);

const prefix = join(root, 'build', `${pkg.name}-${pkg.version}`);
const metadata = {
  artifact: `${pkg.name}-${pkg.version}.tgz`,
  artifact_sha256: sha256(artifactBytes),
  source_commit: commit,
  framework_sha: frameworkSha,
  package_lock_sha256: sha256(lockBytes),
  node: process.version,
};
await writeFile(`${prefix}.sbom.cdx.json`, `${sbom}\n`);
await writeFile(`${prefix}.release-metadata.json`, `${JSON.stringify(metadata, null, 2)}\n`);
await writeFile(
  `${prefix}.checksums.txt`,
  `${metadata.artifact_sha256}  ${metadata.artifact}\n${metadata.package_lock_sha256}  package-lock.json\n`,
);
console.log(`Release evidence created for ${metadata.artifact_sha256}`);
