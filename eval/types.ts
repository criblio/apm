export interface SurfaceCheck {
  surface: string;
  page: 'home' | 'serviceDetail' | 'systemArch' | 'alerts';
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
  flag: string;
  variant: string;
  expectedService: string;
  telemetryWaitMs: number;
  cooldownMs: number;
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
