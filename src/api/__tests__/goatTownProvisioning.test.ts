import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildInvestigatorSkills,
  goatFarmInvestigatorInstructions,
} from '../agentContext';
import {
  APM_CONFIGURATION_ACTOR,
  APM_INVESTIGATOR_AGENT,
  buildApmGoatTownConfiguration,
  configurationClient,
  stageApmInvestigatorConfiguration,
} from '../goatTownProvisioning';

/** `/protocol` advertising a credential-assigned proposal scope. */
const PROTOCOL = {
  protocolVersion: 1,
  capabilities: ['session-execution'],
  proposalScope: {
    appConnectionId: 'conn-1',
    appId: 'cribl-apm',
    producer: 'cribl-apm',
    producerInput: 'credential',
    reviewPath: '/configurations/review',
  },
};

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
    // The service assigns the producer from the app credential and rejects a
    // proposal that declares its own with `producer_mismatch`.
    expect(source).not.toMatch(/^producer:/m);
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

  it('reads the credential-assigned scope, then validates, stores, and diffs without activating', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(PROTOCOL), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ valid: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: { id: 'rev-123' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ changes: 3, hasConflicts: false }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const result = await stageApmInvestigatorConfiguration(
      'https://goattown.example/',
      'custom-otel',
    );

    expect(result).toEqual({
      skills: 1,
      revisionId: 'rev-123',
      changes: 3,
      hasConflicts: false,
      producer: 'cribl-apm',
      reviewPath: '/configurations/review',
    });
    const urls = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(urls).toEqual([
      'https://goattown.example/protocol',
      'https://goattown.example/configurations?action=validate',
      'https://goattown.example/configurations?action=store',
      'https://goattown.example/configurations?action=diff&revision=rev-123',
    ]);
    // Staging never activates: no agent or skill mutation is issued.
    expect(urls.every((url) => !url.includes('/agents') && !url.includes('/skills'))).toBe(true);
    expect((fetchMock.mock.calls[1][1] as RequestInit).body).toBe(
      (fetchMock.mock.calls[2][1] as RequestInit).body,
    );
    expect(new Headers((fetchMock.mock.calls[1][1] as RequestInit).headers).get('x-goattown-user'))
      .toBe(APM_CONFIGURATION_ACTOR);
    expect(fetchMock.mock.calls[3][1]).toMatchObject({ method: 'GET' });
  });

  it('refuses to stage when the credential has no proposal scope', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ protocolVersion: 1, capabilities: [] }), { status: 200 }),
    ));
    await expect(
      stageApmInvestigatorConfiguration('https://goattown.example/', 'custom-otel'),
    ).rejects.toThrow(/advertises no configuration proposal scope/);
  });

  // app-utils 0.11.0 moved the proposal routes onto the client's transport,
  // and GoatTownClient snapshots globalThis.fetch when it is constructed. A
  // stub installed after construction would then be silently ignored: the
  // assertions still run, against the real network. Resolving the global at
  // call time is what keeps stub ordering from being load-bearing, so pin it
  // by stubbing AFTER the client exists.
  it('resolves fetch at call time, not at client construction', async () => {
    const client = configurationClient('https://goattown.example/');
    const late = vi.fn(async () => new Response(JSON.stringify(PROTOCOL), { status: 200 }));
    vi.stubGlobal('fetch', late);

    await client.protocol();

    expect(late).toHaveBeenCalled();
  });

  it('sets no authorization header for a browser caller', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(PROTOCOL), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ valid: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ revision: { id: 'rev-1' } }), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ changes: 0 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await stageApmInvestigatorConfiguration('https://goattown.example/', 'otel');

    // The platform proxy injects APM's connected-app credential and strips
    // any authorization the page sets; shipping one from the browser buys
    // nothing and leaks a long-lived secret (the kv.sharedCellToken mistake).
    for (const call of fetchMock.mock.calls) {
      expect(new Headers((call[1] as RequestInit)?.headers).get('authorization')).toBeNull();
    }
  });
});
