export interface SurfaceCheck {
  surface: string;
  /** `incident` navigates Alerts → the incident row containing the
   * scenario's expectedService → its drill-in page (P4.4). */
  page: 'home' | 'overview' | 'services' | 'serviceDetail' | 'systemArch' | 'alerts' | 'errors' | 'incident';
  locator: string;
  assertion: 'visible' | 'countGt0' | 'textMatches';
  pattern?: string;
  timeoutMs: number;
}

export interface KqlCheck {
  surface: string;
  query: string;
  earliest: string;
  latest: string;
  assertion: 'rowCountGt0' | 'fieldMatches';
  field?: string;
  pattern?: string;
  timeoutMs: number;
  pollIntervalMs?: number;
}

export interface ScenarioDeclaration {
  name: string;
  /** flagd feature-flag this scenario manipulates. Omit for scenarios
   * that observe the natural state of the system (e.g. leak detection)
   * rather than a triggered fault — the engine skips the flag-flip
   * step when flag is absent. */
  flag?: string;
  variant?: string;
  expectedService: string;
  telemetryWaitMs: number;
  cooldownMs: number;
  /** When true (scenarios whose alert reliably fires), the engine
   * appends the standard incident-layer checks from
   * eval/incidentChecks.ts: incident opened containing the service,
   * drill-in page renders, incident events + fold row present. */
  expectsIncident?: boolean;
  surfaceChecks: SurfaceCheck[];
  kqlChecks?: KqlCheck[];
  investigator?: {
    prompt: string;
    expectedRootCausePattern: string;
    waitMs: number;
  };
}

export interface SurfaceResult {
  surface: string;
  detected: boolean;
  latencyMs: number;
  error?: string;
}

export interface InvestigatorResult {
  completed: boolean;
  mentionsRootCause: boolean;
  score: number;
  transcript: string;
}

export interface ScenarioResult {
  name: string;
  surfaces: SurfaceResult[];
  investigator?: InvestigatorResult;
  score: number;
  durationMs: number;
}

export interface RunResult {
  runId: string;
  commitSha: string;
  packVersion: string;
  scenarios: ScenarioResult[];
  meanScore: number;
  durationMs: number;
}
