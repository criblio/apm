/**
 * Incidents — the drill-in unit at the top of the Alerts page (P4.4
 * Phase 2). Incidents sit ABOVE alerts: many alerts roll into one
 * incident, and the incident is what a human opens, reads, and
 * eventually closes. Alerts remain the signal layer underneath
 * (timeline + episode table below this section).
 *
 * Deliberately NOT a new top-level page: the list renders inline and
 * a row expands into the detail (members + warroom timeline), with
 * `?incident=<id>` syncing the expansion for deep links. Read-only in
 * this phase — human warroom writes (notes, status, severity,
 * close/reopen) land in the follow-up PR.
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Card, Tag, type TagColor } from '@capra/core';
import { runQuery } from '../api/cribl';
import * as Q from '../api/queries';
import { serviceColor } from '../utils/spans';
import type { IncidentSummary, IncidentTimelineEntry } from '../api/types';
import s from './IncidentsSection.module.css';

const STATUS_TAG: Record<IncidentSummary['status'], { label: string; color: TagColor }> = {
  open: { label: 'Open', color: 'danger' },
  investigating: { label: 'Investigating', color: 'info' },
  identified: { label: 'Identified', color: 'info' },
  mitigated: { label: 'Mitigated', color: 'warning' },
  resolved: { label: 'Resolved', color: 'success' },
  closed: { label: 'Closed', color: 'info' },
};

const SEVERITY_TAG: Record<IncidentSummary['severity'], TagColor> = {
  sev1: 'danger',
  sev2: 'danger',
  sev3: 'warning',
  sev4: 'info',
};

function fmtAgo(ms: number): string {
  const sec = Math.round((Date.now() - ms) / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

function fmtDurationMs(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  return rm > 0 ? `${hr}h ${rm}m` : `${hr}h`;
}

/** Human line for one warroom timeline event. */
function timelineLine(ev: IncidentTimelineEntry): string {
  switch (ev.eventType) {
    case 'opened':
      return `Incident opened — first signal from ${ev.services || ev.rootService || 'unknown'}`;
    case 'attached':
      return `${ev.services || 'a service'} attached — alert fired`;
    case 'status_change':
      return `Status changed to ${ev.status ?? '?'}`;
    case 'severity_change':
      return `Severity changed to ${ev.severity ?? '?'}`;
    case 'note':
      return ev.note ?? '';
    case 'investigation_linked':
      return `Investigation linked (${ev.investigationId ?? ''})`;
    case 'resolved':
      return 'All alerts cleared — incident resolved';
    case 'closed':
      return 'Incident closed';
    default:
      return ev.eventType;
  }
}

function IncidentDetail({ incident }: { incident: IncidentSummary }) {
  const [events, setEvents] = useState<IncidentTimelineEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Window from the incident's own opened time (+1h slack), not a
    // fixed -7d: dataset scans cost the whole window regardless of the
    // sparse filter, and a -7d live scan from the browser takes >60s
    // on the staging pool.
    const sinceHours = Math.max(2, Math.ceil((Date.now() - incident.openedAtMs) / 3_600_000) + 1);
    runQuery(Q.incidentEvents(incident.incidentId), `-${sinceHours}h`, 'now', 500)
      .then((rows) => {
        if (cancelled) return;
        setEvents(rows.map((r) => ({
          timeMs: Number(r._time) * 1000,
          eventId: String(r.event_id ?? ''),
          eventType: String(r.event_type ?? ''),
          incidentId: String(r.incident_id ?? ''),
          author: (String(r.author ?? 'system') as IncidentTimelineEntry['author']),
          status: String(r.status ?? '') || undefined,
          severity: String(r.severity ?? '') || undefined,
          rootService: String(r.root_service ?? '') || undefined,
          services: String(r.services ?? '') || undefined,
          note: String(r.note ?? '') || undefined,
          investigationId: String(r.investigation_id ?? '') || undefined,
          alertEventId: String(r.alert_event_id ?? '') || undefined,
          title: String(r.title ?? '') || undefined,
          producer: String(r.producer ?? ''),
        })));
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); });
    return () => { cancelled = true; };
  }, [incident.incidentId, incident.openedAtMs]);

  return (
    <div className={s.detail}>
      <div className={s.detailCol}>
        <h3 className={s.detailTitle}>Services ({incident.services.length})</h3>
        <table className={s.memberTable}>
          <thead>
            <tr><th>Service</th><th>First fired</th><th>Last fired</th><th>Fires</th></tr>
          </thead>
          <tbody>
            {incident.services.map((m) => (
              <tr key={m.service}>
                <td>
                  <Link
                    to={`/service/${encodeURIComponent(m.service)}?range=-1h`}
                    className={s.svcLink}
                    style={{ color: serviceColor(m.service) }}
                  >
                    {m.service}
                  </Link>
                  {m.service === incident.rootService && (
                    <span className={s.rootMark} title="First-firing service (derived root)"> · root</span>
                  )}
                </td>
                <td>{new Date(m.firstSeenMs).toLocaleString()}</td>
                <td>{new Date(m.lastFireMs).toLocaleString()}</td>
                <td>{m.fireCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className={s.detailCol}>
        <h3 className={s.detailTitle}>Timeline</h3>
        {error && <div className={s.empty}>{error}</div>}
        {!error && events === null && <div className={s.empty}>Loading timeline…</div>}
        {events !== null && events.length === 0 && (
          <div className={s.empty}>No timeline events yet.</div>
        )}
        {events !== null && events.length > 0 && (
          <ul className={s.timeline}>
            {events.map((ev) => (
              <li key={ev.eventId} className={s.timelineRow}>
                <span className={s.timelineTime}>{new Date(ev.timeMs).toLocaleString()}</span>
                <span className={s.timelineAuthor}>{ev.author}</span>
                <span>{timelineLine(ev)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function IncidentsSection({ incidents }: { incidents: IncidentSummary[] | null }) {
  const [params, setParams] = useSearchParams();
  const expandedId = params.get('incident');
  const [showClosed, setShowClosed] = useState(false);

  const toggle = useCallback((id: string) => {
    setParams((p) => {
      const next = new URLSearchParams(p);
      if (next.get('incident') === id) next.delete('incident');
      else next.set('incident', id);
      return next;
    }, { replace: true });
  }, [setParams]);

  const visible = useMemo(() => {
    if (!incidents) return [];
    return showClosed ? incidents : incidents.filter((i) => i.status !== 'closed');
  }, [incidents, showClosed]);

  const closedCount = (incidents?.length ?? 0) - (incidents?.filter((i) => i.status !== 'closed').length ?? 0);

  return (
    <Card className={s.card}>
      <div className={s.titleRow}>
        <h2 className={s.sectionTitle}>Incidents ({visible.length})</h2>
        {closedCount > 0 && (
          <button className={s.closedToggle} onClick={() => setShowClosed((v) => !v)}>
            {showClosed ? 'Hide closed' : `Show closed (${closedCount})`}
          </button>
        )}
      </div>
      {incidents === null && <div className={s.empty}>Loading incidents…</div>}
      {incidents !== null && visible.length === 0 && (
        <div className={s.empty}>
          No incidents. Incidents open automatically when alerts fire and group
          related services into one drill-in unit.
        </div>
      )}
      {visible.length > 0 && (
        <table className={s.table}>
          <thead>
            <tr>
              <th>Status</th>
              <th>Sev</th>
              <th>Incident</th>
              <th>Services</th>
              <th>Opened</th>
              <th>Duration</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((inc) => {
              const st = STATUS_TAG[inc.status] ?? STATUS_TAG.open;
              const isOngoing = inc.status === 'open' || inc.status === 'investigating'
                || inc.status === 'identified' || inc.status === 'mitigated';
              const expanded = expandedId === inc.incidentId;
              return (
                <Fragment key={inc.incidentId}>
                  <tr
                    className={s.row}
                    aria-expanded={expanded}
                    onClick={() => toggle(inc.incidentId)}
                  >
                    <td><Tag color={st.color}>{st.label}</Tag></td>
                    <td><Tag color={SEVERITY_TAG[inc.severity] ?? 'info'}>{inc.severity.toUpperCase()}</Tag></td>
                    <td className={s.titleCell}>{inc.title}</td>
                    <td>
                      {inc.services.map((m, i) => (
                        <span key={m.service}>
                          {i > 0 && ', '}
                          <span style={{ color: serviceColor(m.service) }}>{m.service}</span>
                        </span>
                      ))}
                    </td>
                    <td title={new Date(inc.openedAtMs).toLocaleString()}>{fmtAgo(inc.openedAtMs)}</td>
                    <td>
                      {isOngoing
                        // eslint-disable-next-line react-hooks/purity -- live "so far" duration
                        ? <span className={s.ongoing}>{fmtDurationMs(Date.now() - inc.openedAtMs)} so far</span>
                        : fmtDurationMs(Math.max(inc.lastFireMs - inc.openedAtMs, 60_000))}
                    </td>
                  </tr>
                  {expanded && (
                    <tr className={s.detailRow}>
                      <td colSpan={6}><IncidentDetail incident={inc} /></td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
