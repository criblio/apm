import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildInvestigatorSkills,
  goatFarmInvestigatorInstructions,
} from '../agentContext';
import {
  APM_CONFIGURATION_PRODUCER,
  APM_INVESTIGATOR_AGENT,
  buildApmGoatTownConfiguration,
  stageApmInvestigatorConfiguration,
} from '../goatTownProvisioning';

afterEach(() => vi.unstubAllGlobals());

describe('GoatTown declarative configuration', () => {
  it('keeps instructions and skills inside registry limits', () => {
    const skills = buildInvestigatorSkills('otel');
    expect(skills).toHaveLength(1);
    expect(goatFarmInvestigatorInstructions().length).toBeLessThanOrEqual(128_000);
    expect(skills[0].body.length).toBeLessThanOrEqual(128_000);
    expect(skills.every((skill) => skill.description.length <= 200)).toBe(true);
    expect(skills.every((skill) => !skill.body.includes('present_investigation_summary'))).toBe(true);
    expect(skills.every((skill) => !skill.body.includes('`render_trace`'))).toBe(true);
    expect(skills[0].name).toBe('cribl-apm-investigator');
    expect(skills[0].body).not.toMatch(/\n{3,}/);
  });

  it('generates a complete least-privileged source-tree configuration', () => {
    const source = buildApmGoatTownConfiguration('custom-otel');
    expect(source).toContain(`producer: ${APM_CONFIGURATION_PRODUCER}`);
    expect(source).toContain(`slug: ${APM_INVESTIGATOR_AGENT}`);
    expect(source).toContain('tools: [report]');
    expect(source).toContain('tools: [cribl-read]');
    expect(source).toContain('inherits: [apm-telemetry-reader]');
    expect(source).toContain('datasets: ["custom-otel"]');
    expect(source).toContain('requiredSkills: ["cribl-apm-investigator"]');
    expect(source).not.toMatch(/^\s+$/m);
    expect(source).toContain('mcpServers: []');
    expect(source).toContain('schedules: []');
    expect(source).toContain('authorizationGrants: []');
    expect(source).not.toContain('source: code');
    const instructions = / {4}instructions: \|\n([\s\S]*?)\n {4}tools:/.exec(source)?.[1] ?? '';
    expect(instructions).not.toMatch(/[^\n]\n[^\n]/);
  });

  it('keeps the checked-in source-tree configuration generated from code', () => {
    expect(readFileSync(resolve('goattown.config.yaml'), 'utf8')).toBe(
      buildApmGoatTownConfiguration('otel'),
    );
  });

  it('validates, stores, and diffs without activating', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ valid: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: { id: 'rev-123' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ changes: 3, hasConflicts: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await stageApmInvestigatorConfiguration(
      'https://goattown.example/',
      'custom-otel',
    );

    expect(result).toEqual({ skills: 1, revisionId: 'rev-123', changes: 3, hasConflicts: false });
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      'https://goattown.example/configurations?action=validate',
      'https://goattown.example/configurations?action=store',
      'https://goattown.example/configurations?action=diff&revision=rev-123',
    ]);
    expect(urls.every((url) => !url.includes('/agents') && !url.includes('/skills'))).toBe(true);
    expect((fetchMock.mock.calls[0][1] as RequestInit).body).toBe(
      (fetchMock.mock.calls[1][1] as RequestInit).body,
    );
    expect(new Headers((fetchMock.mock.calls[0][1] as RequestInit).headers).get('x-goattown-user'))
      .toBe('cribl-apm');
    expect(fetchMock.mock.calls[2][1]).toMatchObject({ method: 'GET' });
  });
});
