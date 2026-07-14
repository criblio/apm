#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { stdout } = await execFileAsync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
  {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 10 * 1024 * 1024,
  },
);
const patterns = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['Cribl client secret assignment', /CRIBL_CLIENT_SECRET\s*=\s*[A-Za-z0-9_+\/=.-]{20,}/],
];
const failures = [];
for (const relative of stdout.split('\0').filter(Boolean)) {
  if (relative === 'package-lock.json' || relative.endsWith('.snap')) continue;
  const buffer = await readFile(resolve(root, relative)).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (!buffer) continue;
  if (buffer.includes(0) || buffer.length > 5 * 1024 * 1024) continue;
  const text = buffer.toString('utf8');
  for (const [label, pattern] of patterns) {
    if (pattern.test(text)) failures.push(`${relative}: ${label}`);
  }
}
if (failures.length > 0) throw new Error(`potential committed secrets:\n${failures.join('\n')}`);
console.log('Tracked-file secret scan passed');
