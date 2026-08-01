import { spawnSync } from 'node:child_process';

const exceptions = new Map([
  [
    'https://github.com/advisories/GHSA-qwww-vcr4-c8h2',
    {
      dependency: 'react-router',
      expires: '2026-08-31T23:59:59Z',
      reason: 'APM is a browser SPA and does not use the affected React Router RSC mode.',
    },
  ],
]);

const severityRank = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const checks = [
  { label: 'all dependencies', args: ['--audit-level=moderate'], threshold: 'moderate' },
  { label: 'production dependencies', args: ['--omit=dev', '--audit-level=low'], threshold: 'low' },
];

function advisoriesFor(name, vulnerabilities, visited = new Set()) {
  if (visited.has(name)) return [];
  visited.add(name);

  const vulnerability = vulnerabilities[name];
  if (!vulnerability) return [];

  return vulnerability.via.flatMap((via) =>
    typeof via === 'string'
      ? advisoriesFor(via, vulnerabilities, visited)
      : [{ ...via, dependency: via.dependency ?? name }],
  );
}

function runAudit({ label, args, threshold }) {
  const result = spawnSync('npm', ['audit', '--json', ...args], { encoding: 'utf8' });
  let report;

  try {
    report = JSON.parse(result.stdout);
  } catch {
    process.stderr.write(result.stderr || result.stdout || `npm audit failed for ${label}\n`);
    process.exit(1);
  }

  if (report.error) {
    console.error(`npm audit failed for ${label}: ${report.error.summary ?? report.error.message}`);
    process.exit(1);
  }

  const vulnerabilities = report.vulnerabilities ?? {};
  const rejected = [];
  const allowed = new Map();

  for (const [name, vulnerability] of Object.entries(vulnerabilities)) {
    if (severityRank[vulnerability.severity] < severityRank[threshold]) continue;

    const advisories = advisoriesFor(name, vulnerabilities);
    if (advisories.length === 0) {
      rejected.push(`${name}: ${vulnerability.severity} vulnerability has no advisory details`);
      continue;
    }

    for (const advisory of advisories) {
      const exception = exceptions.get(advisory.url);
      const expired = exception && Date.now() > Date.parse(exception.expires);
      if (!exception || exception.dependency !== advisory.dependency || expired) {
        rejected.push(
          `${advisory.dependency}: ${advisory.severity} ${advisory.url}` +
            (expired ? ` (exception expired ${exception.expires})` : ''),
        );
      } else {
        allowed.set(advisory.url, exception);
      }
    }
  }

  if (rejected.length > 0) {
    console.error(`npm audit rejected ${label}:`);
    for (const finding of new Set(rejected)) console.error(`- ${finding}`);
    process.exit(1);
  }

  if (result.status !== 0 && allowed.size === 0) {
    process.stderr.write(result.stderr || `npm audit failed for ${label}\n`);
    process.exit(result.status ?? 1);
  }

  for (const [url, exception] of allowed) {
    console.warn(`Temporary audit exception: ${url}`);
    console.warn(`Reason: ${exception.reason}`);
    console.warn(`Expires: ${exception.expires}`);
  }
}

for (const check of checks) runAudit(check);
console.log('Dependency audit passed');
