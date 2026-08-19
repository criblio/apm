/** One pass of incident-pipeline observation on staging. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const envPath = resolve(process.cwd(), '.env');
for (const line of readFileSync(envPath, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
  if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^"|"$/g, '');
}
import { runQuery } from '../tests/helpers/criblSearch';
const DT = `coalesce(tostring(data_datatype), tostring(datatype)) == "criblapm_alert"`;
async function q(name: string, kql: string, earliest = '-1h') {
  try {
    const rows = await runQuery(kql, earliest, 'now', 40);
    console.log(`--- ${name}: ${rows.length}`);
    for (const r of rows.slice(0, 10)) console.log(JSON.stringify(r).slice(0, 280));
  } catch (e) { console.log(`--- ${name}: FAILED ${String(e).slice(0, 200)}`); }
}
async function main() {
  await q('alert status (evaluator vt)', `dataset="$vt_results" | where jobName == "criblapm__home_alerts"
    | where tostring(alert_status) != "ok" or tostring(is_bad) == "true"
    | project svc, alert_status, signal_type, curr_error_rate, consecutive_bad`);
  await q('firing/resolved transitions -1h', `dataset="otel" | where ${DT}
    | where record_kind == "evaluation" and event_type in ("firing", "resolved")
    | where isnull(is_canary) or tostring(is_canary) != "true"
    | project _time, event_type, svc, alert_id`);
  await q('incident events -1h', `dataset="otel" | where ${DT}
    | where record_kind == "incident"
    | project _time, event_type, incident_id, services, event_id`);
  await q('fold rows (vt)', `dataset="$vt_results" | where jobName == "criblapm__incidents_state"
    | project jobId, incident_id, svc, status, severity, fire_n, n_svcs, title`);
  await q('lookup content via join probe', `print svc="payment" | union (print svc="checkout") | union (print svc="frontend")
    | lookup criblapm_incidents on svc
    | project svc, incident_id, status`);
}
main().catch((e) => { console.error(e); process.exit(1); });
