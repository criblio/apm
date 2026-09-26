#!/usr/bin/env tsx
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildApmGoatTownConfiguration } from '../src/api/goatTownProvisioning.js';

const dataset = process.argv[2]?.trim() || 'otel';
const destination = resolve('goattown.config.yaml');
writeFileSync(destination, buildApmGoatTownConfiguration(dataset), { encoding: 'utf8', mode: 0o644 });
console.log(`Generated ${destination} for dataset ${dataset}`);
