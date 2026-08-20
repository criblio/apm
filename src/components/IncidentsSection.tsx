/**
 * Incidents — the drill-in unit at the top of the Alerts page (P4.4
 * Phase 2). Incidents sit ABOVE alerts: many alerts roll into one
 * incident, and the incident is what a human opens, reads, and
 * eventually closes. Alerts remain the signal layer underneath
 * (timeline + episode table below this section).
 *
 * Deliberately NOT a new top-level nav concept: this is a section on
 * the Alerts page, and each row navigates to the incident's detail
 * page (/incident/:id) — summary, correlated investigations, member
 * services, warroom timeline.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Card, Tag, type TagColor } from '@capra/core';
import { serviceColor } from '../utils/spans';
import type { IncidentSummary } from '../api/types';
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

export default function IncidentsSection({ incidents }: { incidents: IncidentSummary[] | null }) {
  const navigate = useNavigate();
  const [showClosed, setShowClosed] = useState(false);

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
              return (
                <tr
                  key={inc.incidentId}
                  className={s.row}
                  onClick={() => navigate(`/incident/${encodeURIComponent(inc.incidentId)}`)}
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
              );
            })}
          </tbody>
        </table>
      )}
    </Card>
  );
}
