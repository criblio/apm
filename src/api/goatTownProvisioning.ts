import { buildInvestigatorSkills, goatFarmInvestigatorInstructions } from './agentContext';

export const APM_INVESTIGATOR_AGENT = 'apm-investigator';
export const APM_CONFIGURATION_PRODUCER = 'cribl-apm';
export const APM_GOATTOWN_OWNER = 'cribl-apm';

interface RegistrationOptions {
  authorization?: string;
  signal?: AbortSignal;
}

export interface RegistrationResult {
  skills: number;
  revisionId: string;
  changes: number;
  hasConflicts: boolean;
}

async function configurationRequest(
  baseUrl: string,
  action: string,
  source: string | undefined,
  options: RegistrationOptions,
  params: Record<string, string> = {},
): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    'content-type': 'application/yaml',
    'x-goattown-user': APM_GOATTOWN_OWNER,
  };
  if (options.authorization) headers.authorization = options.authorization;
  const query = new URLSearchParams({ action, ...params });
  const response = await fetch(`${baseUrl.replace(/\/$/, '')}/configurations?${query}`, {
    method: source === undefined ? 'GET' : 'POST',
    headers,
    body: source,
    signal: options.signal,
  });
  if (!response.ok) {
    throw new Error(`GoatTown configuration ${action} failed (${response.status}): ${await response.text()}`);
  }
  return (await response.json()) as Record<string, unknown>;
}

function yamlString(value: string): string {
  return JSON.stringify(value);
}

function yamlList(values: string[]): string {
  return `[${values.map(yamlString).join(', ')}]`;
}

function block(value: string, spaces: number): string {
  const indentation = ' '.repeat(spaces);
  return value.split('\n').map((line) => line ? `${indentation}${line}` : '').join('\n');
}

/** Remove source-code wrapping from prose while preserving intentional
 * paragraph breaks. GoatTown canonicalizes stored strings with folded YAML;
 * hard wraps would otherwise be re-emitted as doubled blank lines. */
function unwrapProse(value: string): string {
  return value
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.split('\n').map((line) => line.trim()).join(' '))
    .join('\n\n');
}

/** Build the canonical source-tree configuration submitted by both browser
 * and CLI provisioning. Human activation remains a separate GoatTown action. */
export function buildApmGoatTownConfiguration(dataset: string): string {
  const skills = buildInvestigatorSkills(dataset);
  const skillNames = skills.map((skill) => skill.name);
  const skillYaml = skills.map((skill) => `  - name: ${skill.name}
    displayName: ${yamlString(skill.displayName)}
    description: ${yamlString(skill.description)}
    kind: prose
    body: |
${block(skill.body, 6)}`).join('\n');

  return `version: 1
producer: ${APM_CONFIGURATION_PRODUCER}

skills:
${skillYaml}

profiles:
  - slug: apm-telemetry-reader
    displayName: "APM telemetry reader"
    description: "Read-only access to the configured APM Search dataset and metrics."
    tools: [cribl-read]
    skills: []
    requiredSkills: ${yamlList(skillNames)}
    mcpTools: []
    net:
      hosts: ["$CRIBL_API_BASE"]
      apiPaths: []
      datasets: [${yamlString(dataset)}]

mcpServers: []

agents:
  - slug: ${APM_INVESTIGATOR_AGENT}
    displayName: "APM Investigator"
    description: "Investigates Cribl APM telemetry and alerts, identifies the root cause, and reports actionable evidence."
    instructions: |
${block(unwrapProse(goatFarmInvestigatorInstructions()), 6)}
    tools: [report]
    skills: []
    requiredSkills: []
    mcpTools: []
    inherits: [apm-telemetry-reader]
    net:
      hosts: []
      apiPaths: []
      datasets: []
    llm: {}
    triggerable: true
    authorizationGrants: []

schedules: []
authorizationGrants: []
`;
}

/** Validate and store an immutable revision. This deliberately never calls
 * activate/apply: a human reviews and activates the revision in GoatTown. */
export async function stageApmInvestigatorConfiguration(
  baseUrl: string,
  dataset: string,
  options: RegistrationOptions = {},
): Promise<RegistrationResult> {
  const source = buildApmGoatTownConfiguration(dataset);
  const skills = buildInvestigatorSkills(dataset);
  await configurationRequest(baseUrl, 'validate', source, options);
  const stored = await configurationRequest(baseUrl, 'store', source, options);
  const revision = stored.revision as { id?: unknown } | undefined;
  if (typeof revision?.id !== 'string' || !revision.id) {
    throw new Error('GoatTown configuration store returned no revision id');
  }
  const diff = await configurationRequest(
    baseUrl,
    'diff',
    undefined,
    options,
    { revision: revision.id },
  );
  return {
    skills: skills.length,
    revisionId: revision.id,
    changes: typeof diff.changes === 'number' ? diff.changes : 0,
    hasConflicts: diff.hasConflicts === true,
  };
}
