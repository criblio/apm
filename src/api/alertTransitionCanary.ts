import {
  ALERT_EVENT_DATATYPE,
  GENERATED_EVENT_SCHEMA_VERSION,
  STORED_DATATYPE_EXPR,
} from './generatedEventContract';

function safeId(value: string, label: string): string {
  if (!/^[a-zA-Z0-9_-]{1,96}$/.test(value)) {
    throw new Error(`${label} must contain only letters, digits, underscores, and dashes`);
  }
  return value;
}

function safeDataset(value: string): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(value)) throw new Error('unsafe canary dataset');
  return value;
}

/**
 * One isolated live traversal step for the production alert state machine.
 * Canary rows use their own alert ID and `is_canary=true`, so every product
 * reader ignores them. A repeated evaluation ID is suppressed before send,
 * which makes this a live producer-side exactly-once check rather than a
 * reader-only dedup check.
 */
export function alertTransitionCanaryStep(
  canaryId: string,
  evaluationId: string,
  isBad: boolean,
  dataset: string,
): string {
  const id = safeId(canaryId, 'canary ID');
  const evaluation = safeId(evaluationId, 'evaluation ID');
  const ds = safeDataset(dataset);
  const alertId = `__canary__:${id}`;
  return `print alert_id="${alertId}", svc="__canary__", signal_type="canary",
               is_bad=${isBad ? 'true' : 'false'}, evaluation_id="${evaluation}"
    | join kind=leftouter (
        dataset="${ds}"
        | where ${STORED_DATATYPE_EXPR} == "${ALERT_EVENT_DATATYPE}"
        | where alert_id == "${alertId}"
        | join kind=inner (
            dataset="${ds}"
            | where ${STORED_DATATYPE_EXPR} == "${ALERT_EVENT_DATATYPE}"
            | where alert_id == "${alertId}"
            | summarize persisted_time=max(_time) by alert_id
          ) on alert_id
        | where _time == persisted_time
        | summarize persisted_evaluation_id=max(tostring(evaluation_id)),
                    persisted_status=max(tostring(alert_status)),
                    persisted_bad=max(tolong(consecutive_bad)),
                    persisted_good=max(tolong(consecutive_good)),
                    persisted_fire_count=max(tolong(fire_count))
          by alert_id
      ) on alert_id
    | extend is_retry=iff(isnotnull(persisted_evaluation_id) and persisted_evaluation_id == evaluation_id, true, false),
             prev_status=iff(isnotnull(persisted_status), persisted_status, "ok"),
             prev_bad=iff(isnotnull(persisted_bad), persisted_bad, 0),
             prev_good=iff(isnotnull(persisted_good), persisted_good, 0),
             prev_fire_count=iff(isnotnull(persisted_fire_count), persisted_fire_count, 0)
    | extend consecutive_bad=iff(is_bad, prev_bad + 1, 0),
             consecutive_good=iff(is_bad, 0, prev_good + 1)
    | extend alert_status=case(
               is_bad and prev_status == "ok", "pending",
               is_bad and prev_status == "pending" and consecutive_bad >= 2, "firing",
               is_bad and prev_status == "pending", "pending",
               is_bad and prev_status == "firing", "firing",
               is_bad and prev_status == "resolving", "firing",
               not(is_bad) and prev_status == "pending", "ok",
               not(is_bad) and prev_status == "firing", "resolving",
               not(is_bad) and prev_status == "resolving" and consecutive_good >= 3, "ok",
               not(is_bad) and prev_status == "resolving", "resolving",
               "ok"),
             fire_count=iff(is_bad and prev_status == "pending" and consecutive_bad >= 2, prev_fire_count + 1, prev_fire_count),
             transitioned_to=case(
               is_bad and prev_status == "pending" and consecutive_bad >= 2, "firing",
               not(is_bad) and prev_status == "resolving" and consecutive_good >= 3, "resolved",
               "")
    | where not(is_retry)
    | extend event_type=iff(transitioned_to != "", transitioned_to, "evaluated"),
             schema_version=tolong(${GENERATED_EVENT_SCHEMA_VERSION}),
             producer="criblapm_alert_transition_canary", record_kind="evaluation",
             evaluated_at=now(), is_canary=true,
             event_id=strcat("criblapm:alert:", evaluation_id, ":", alert_id)
    | project _time=now(), dataset="${ds}", datatype="${ALERT_EVENT_DATATYPE}",
              schema_version, event_id, producer, record_kind, evaluation_id,
              evaluated_at, event_type, alert_id, alert_status, svc,
              signal_type, is_bad, is_canary, fire_count,
              consecutive_bad, consecutive_good
    | send tee=true group="search"`;
}

export function alertTransitionCanaryRead(canaryId: string, dataset: string): string {
  const id = safeId(canaryId, 'canary ID');
  const ds = safeDataset(dataset);
  return `dataset="${ds}"
    | where ${STORED_DATATYPE_EXPR} == "${ALERT_EVENT_DATATYPE}"
    | where alert_id == "__canary__:${id}" and tostring(is_canary) == "true"
    | summarize rows=count(), event_ids=dcount(event_id),
                evaluations=dcount(evaluation_id),
                firing=countif(event_type=="firing"),
                resolved=countif(event_type=="resolved"),
                fire_count=max(tolong(fire_count))`;
}
