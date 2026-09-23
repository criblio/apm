/**
 * Stage APM's investigator configuration as a GoatTown proposal.
 *
 * The HTTP and policy parts now come from `@criblio/app-utils/goattown`;
 * what stays here is the APM source tree itself — the skills, the
 * telemetry-reader profile, and the investigator agent.
 *
 * Two things changed with the shared contract and both are deliberate:
 *
 *  - **The YAML no longer declares a producer.** The service assigns one to
 *    each app credential and advertises it at `/protocol` as
 *    `proposalScope.producer` with `producerInput: 'credential'`; a proposal
 *    that declares its own is rejected with `producer_mismatch`. So the
 *    producer is read, not written, and staging refuses outright unless the
 *    scope says `credential` rather than guessing.
 *  - **Activation stays human.** This validates and stores an immutable
 *    revision; a tenant administrator reviews and activates it at the
 *    scope's `reviewPath`.
 */
import {
  GoatTownClient,
  assertProposalOmitsProducer,
  readProposalScope,
  readProposalStatus,
  stageProposal,
  type ProposalStatus,
  type StagedProposal,
} from '@criblio/app-utils/goattown';
import { buildInvestigatorSkills, goatFarmInvestigatorInstructions } from './agentContext';

export const APM_INVESTIGATOR_AGENT = 'apm-investigator';

/**
 * Acting user for configuration work.
 *
 * Sessions are per signed-in Cribl user, but staging a revision is an app
 * action rather than a person's, and the CLI provisioner has no signed-in
 * user at all. The producer itself still comes from the credential — this is
 * only the `x-goattown-user` claim on the configuration route.
 */
export const APM_CONFIGURATION_ACTOR = 'cribl-apm';

export type { ProposalStatus, StagedProposal };

export interface RegistrationOptions {
  /**
   * Bearer for non-browser callers only.
   *
   * The CLI provisioner runs in Node with no platform proxy in front of it,
   * so it must present its own admin token. A browser caller passes nothing:
   * the proxy injects APM's connected-app credential for the declared
   * domain and strips any `authorization` the page sets, so a token shipped
   * from the page buys nothing and leaks something. That is exactly the
   * `kv.sharedCellToken` mistake this app has already made once.
   */
  authorization?: string;
  /** Acting user id. Browser callers resolve the signed-in Cribl user. */
  userId?: () => Promise<string>;
  signal?: AbortSignal;
}

export interface RegistrationResult {
  skills: number;
  revisionId: string;
  changes: number;
  hasConflicts: boolean;
  /** The producer the credential is assigned, shown to the human so the
   *  review page is recognisable. */
  producer: string;
  /** Where a human activates the staged revision. */
  reviewPath: string;
}

/**
 * Build a client for configuration work.
 *
 * `/configurations` takes `application/yaml`, so the shared client exposes
 * `actingUser()` for exactly this and the provisioning helpers drive the
 * route themselves. A non-browser caller's bearer rides on an injected
 * fetch rather than being handed to the client, which has no credential
 * concept by design.
 */
export function configurationClient(
  baseUrl: string,
  options: RegistrationOptions = {},
): GoatTownClient {
  const { authorization } = options;
  return new GoatTownClient({
    baseUrl,
    userId: options.userId ?? (async () => APM_CONFIGURATION_ACTOR),
    fetch: authorization
      ? (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', authorization);
        return fetch(input, { ...init, headers });
      }
      : undefined,
  });
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

  // No `producer:` line on purpose — the service assigns it from the app
  // credential and rejects a proposal that declares one.
  return `version: 1

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

/**
 * Validate and store an immutable revision.
 *
 * Deliberately never calls activate/apply: a human reviews and activates
 * the revision at `reviewPath`. Validate-before-store is not belt and
 * braces — a store writes an immutable revision, so a malformed proposal
 * sent straight to store leaves a permanent bad revision in the tenant's
 * history for someone to read past.
 */
export async function stageApmInvestigatorConfiguration(
  baseUrl: string,
  dataset: string,
  options: RegistrationOptions = {},
): Promise<RegistrationResult> {
  const client = configurationClient(baseUrl, options);
  const scope = await readProposalScope(client, options.signal);
  if (!scope) {
    throw new Error(
      'This GoatTown credential is not assigned a configuration proposal scope, ' +
      'so it cannot stage the APM investigator. A tenant administrator has to ' +
      'grant the app connection proposal rights.',
    );
  }
  const source = buildApmGoatTownConfiguration(dataset);
  // Local guard before the round trip: the service would reject a declared
  // producer with `producer_mismatch`, and the error is clearer from here.
  assertProposalOmitsProducer(source);
  const staged = await stageProposal(client, source, scope, options.signal);
  return {
    skills: buildInvestigatorSkills(dataset).length,
    revisionId: staged.revisionId,
    changes: staged.changes,
    hasConflicts: staged.hasConflicts,
    producer: staged.producer,
    reviewPath: staged.reviewPath,
  };
}

/**
 * Has a human activated what we staged?
 *
 * Reports the tenant's active revision and the agent's presence in the live
 * catalog separately: an active revision whose agent is missing means the
 * activation landed but the agent did not, which is a different
 * conversation to have with the administrator.
 */
export async function readApmProposalStatus(
  baseUrl: string,
  stagedRevisionId: string | null,
  options: RegistrationOptions = {},
): Promise<ProposalStatus> {
  return readProposalStatus(
    configurationClient(baseUrl, options),
    stagedRevisionId,
    APM_INVESTIGATOR_AGENT,
    options.signal,
  );
}
