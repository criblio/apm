#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(await readFile(resolve(root, 'package-lock.json'), 'utf8'));
const denied = /\b(?:AGPL|GPL|LGPL|SSPL|BUSL|Commons Clause|UNLICENSED)\b/i;
const failures = [];
for (const [path, meta] of Object.entries(lock.packages ?? {})) {
  if (!path || !path.startsWith('node_modules/')) continue;
  const license = typeof meta.license === 'string' ? meta.license : '';
  if (denied.test(license)) failures.push(`${path}: ${license || 'missing'}`);
}
if (failures.length > 0) {
  throw new Error(`dependency license policy failed:\n${failures.join('\n')}`);
}
console.log('Dependency license deny-list check passed');
