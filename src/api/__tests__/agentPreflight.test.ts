/**
 * Tests for the formatter half of agentPreflight (P2.2 phase 2).
 *
 * runPreflight() does I/O so isn't unit-tested here — its branches
 * are exercised end-to-end by InvestigatePage and the Investigator
 * eval suite. formatPreflightSignals() is pure, runs on every
 * investigation, and its output is what the LLM reads — worth
 * pinning.
 */
import { describe, it, expect } from 'vitest';
import { formatPreflightSignals, type PreflightResult } from '../agentPreflight';

const emptyResult: PreflightResult = {
  silent: [],
  rateDrops: [],
  errorSpikes: [],
  recentDeploys: [],
};

describe('formatPreflightSignals', () => {
  it('returns a no-anomalies line when nothing is set', () => {
    const lines = formatPreflightSignals(emptyResult);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('No traffic-drop');
    expect(lines[0]).toContain('recent-deploy');
  });

  it('emits a Recent deploys block with age and version when deploys are present', () => {
    const result: PreflightResult = {
      ...emptyResult,
      recentDeploys: [
        { service: 'payment', version: '2.3.0', firstSeenMs: Date.now() - 12 * 60_000, ageMinutes: 12, nSpans: 250 },
        { service: 'cart',    version: '2.2.0', firstSeenMs: Date.now() - 45 * 60_000, ageMinutes: 45, nSpans: 1800 },
      ],
    };
    const lines = formatPreflightSignals(result);
    expect(lines.some((l) => l.includes('Recent deploys'))).toBe(true);
    expect(lines.some((l) => l.includes('`payment`') && l.includes('2.3.0') && l.includes('12m'))).toBe(true);
    expect(lines.some((l) => l.includes('`cart`')    && l.includes('2.2.0') && l.includes('45m'))).toBe(true);
  });

  it('caps the deploy list at 8 rows', () => {
    const tenDeploys = Array.from({ length: 10 }, (_, i) => ({
      service: `svc-${i}`,
      version: '1.0.0',
      firstSeenMs: Date.now() - i * 60_000,
      ageMinutes: i,
      nSpans: 100,
    }));
    const lines = formatPreflightSignals({ ...emptyResult, recentDeploys: tenDeploys });
    const deployBullets = lines.filter((l) => l.startsWith('  - `svc-'));
    expect(deployBullets).toHaveLength(8);
  });

  it('skips the Recent deploys block when the list is empty', () => {
    // Set one of the other signal types so the no-anomalies
    // fallback doesn't fire; check that "Recent deploys" still
    // isn't mentioned anywhere.
    const result: PreflightResult = {
      ...emptyResult,
      silent: [{ service: 'payment', priorRequests: 1000 }],
    };
    const lines = formatPreflightSignals(result);
    expect(lines.some((l) => l.includes('Recent deploys'))).toBe(false);
  });

  it('orders deploys section after the anomaly sections (silent → rate → error → deploys)', () => {
    const result: PreflightResult = {
      silent: [{ service: 'payment', priorRequests: 1000 }],
      rateDrops: [{ service: 'cart', currentRequests: 10, priorRequests: 100, dropPct: 90 }],
      errorSpikes: [{ service: 'ad', currentErrorRate: 0.05, priorErrorRate: 0.01, deltaPp: 4 }],
      recentDeploys: [{ service: 'frontend', version: '3.0.0', firstSeenMs: Date.now(), ageMinutes: 1, nSpans: 50 }],
    };
    const lines = formatPreflightSignals(result);
    const idxSilent  = lines.findIndex((l) => l.includes('Silent services'));
    const idxRate    = lines.findIndex((l) => l.includes('Traffic drops'));
    const idxError   = lines.findIndex((l) => l.includes('Error-rate spikes'));
    const idxDeploys = lines.findIndex((l) => l.includes('Recent deploys'));
    expect(idxSilent).toBeLessThan(idxRate);
    expect(idxRate).toBeLessThan(idxError);
    expect(idxError).toBeLessThan(idxDeploys);
  });
});
