import type { RunResult, ScenarioResult } from './types.js';

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function fmtDuration(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return `${min}m ${rem}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

function surfacesSummary(r: ScenarioResult): string {
  const detected = r.surfaces.filter((s) => s.detected).length;
  return `${detected}/${r.surfaces.length}`;
}

function investigatorSummary(r: ScenarioResult): string {
  if (!r.investigator) return '—';
  if (!r.investigator.completed) return 'timed out';
  if (r.investigator.mentionsRootCause) return '✓ root cause';
  return '✗ wrong/missing';
}

export function printReport(result: RunResult): void {
  const line = '═'.repeat(62);
  console.log(`\n${line}`);
  console.log(
    ` Eval run ${result.runId}  Commit: ${result.commitSha.slice(0, 7)}  Pack: ${result.packVersion}`,
  );
  console.log(` Duration: ${fmtDuration(result.durationMs)}`);
  console.log(line);
  console.log('');
  console.log(
    ` ${pad('Scenario', 26)} ${pad('Surfaces', 10)} ${pad('Investigator', 16)} Score`,
  );
  console.log(
    ` ${pad('─'.repeat(26), 26)} ${pad('─'.repeat(10), 10)} ${pad('─'.repeat(16), 16)} ${'─'.repeat(5)}`,
  );

  for (const s of result.scenarios) {
    console.log(
      ` ${pad(s.name, 26)} ${pad(surfacesSummary(s), 10)} ${pad(investigatorSummary(s), 16)} ${s.score.toFixed(2)}`,
    );
  }

  const fullyDetected = result.scenarios.filter((s) => s.score >= 0.99).length;
  console.log('');
  console.log(
    ` Mean score: ${result.meanScore.toFixed(2)}  |  ${result.scenarios.length} scenarios  |  ${fullyDetected} fully detected`,
  );
  console.log(`${line}\n`);

  // Print details for any failing surfaces
  const failing = result.scenarios.filter((s) => s.score < 0.99);
  if (failing.length > 0) {
    console.log('Failures detail:\n');
    for (const s of failing) {
      console.log(`  ${s.name}:`);
      for (const surf of s.surfaces) {
        if (!surf.detected) {
          console.log(
            `    ✗ ${surf.surface} — ${surf.error ?? 'not detected within timeout'}`,
          );
        }
      }
      if (s.investigator && !s.investigator.mentionsRootCause) {
        console.log(
          `    ✗ investigator — ${s.investigator.completed ? 'summary produced but root cause not mentioned' : 'timed out'}`,
        );
      }
      console.log('');
    }
  }
}
