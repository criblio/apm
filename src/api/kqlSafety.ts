/** APM policy wrapper around the shared Cribl KQL safety boundary. */

import { KqlSafetyError } from '@criblio/app-utils/kql';

export {
  KqlSafetyError,
  assertKqlPredicate,
  assertReadOnlyKql,
  kqlBracketField,
  kqlDatasetId,
  kqlFieldKey,
  kqlFiniteNumber,
  kqlInteger,
  kqlStringLiteral,
  kqlTime,
} from '@criblio/app-utils/kql';

/** OpenTelemetry trace identifier policy remains an APM domain concern. */
export function kqlTraceId(value: string): string {
  const id = value.trim();
  if (!/^(?:[0-9a-fA-F]{16}|[0-9a-fA-F]{32})$/.test(id)) {
    throw new KqlSafetyError('trace ID must be 16 or 32 hexadecimal characters');
  }
  return id.toLowerCase();
}

/** OpenTelemetry span identifier policy remains an APM domain concern. */
export function kqlSpanId(value: string): string {
  const id = value.trim();
  if (!/^[0-9a-fA-F]{16}$/.test(id)) {
    throw new KqlSafetyError('span ID must be 16 hexadecimal characters');
  }
  return id.toLowerCase();
}
