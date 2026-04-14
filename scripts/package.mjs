import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeline } from 'node:stream/promises';
import { createAppPack } from './pkgutil.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const buildOutDir = join(rootDir, 'build');
const packageInfo = JSON.parse(await readFile(join(rootDir, 'package.json'), 'utf8'));
const tgzName = `${packageInfo.name || 'app'}-${packageInfo.version || '0.0.0'}.tgz`;
const tgzPath = join(buildOutDir, tgzName);
await mkdir(buildOutDir, { recursive: true });
const { closePromise, stdout } = await createAppPack(false);
await Promise.all([ pipeline(stdout, createWriteStream(tgzPath)), closePromise ]);

console.log(`\nPackage created: ${tgzPath}`);
