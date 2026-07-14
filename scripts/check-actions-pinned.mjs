#!/usr/bin/env node
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function yamlFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await yamlFiles(path));
    else if (/\.ya?ml$/.test(entry.name)) out.push(path);
  }
  return out;
}

const failures = [];
for (const file of await yamlFiles(join(root, '.github'))) {
  const text = await readFile(file, 'utf8');
  for (const [index, line] of text.split('\n').entries()) {
    const match = line.match(/\buses:\s*([^\s#]+)/);
    if (!match || match[1].startsWith('./')) continue;
    if (!/@[0-9a-f]{40}$/.test(match[1])) {
      failures.push(`${file.slice(root.length + 1)}:${index + 1}: ${match[1]}`);
    }
  }
}
if (failures.length > 0) {
  throw new Error(`GitHub Actions must be pinned to full commit SHAs:\n${failures.join('\n')}`);
}
console.log('GitHub Action pin check passed');
