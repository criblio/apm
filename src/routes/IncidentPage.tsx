/**
 * Incident detail — the rich drill-in page (P4.4 Phase 2B). One
 * incident's full story: what happened (deterministic summary), who's
 * affected (members with episode data), what the machines found
 * (correlated server-side investigations with conclusions + transcript
 * links), and the warroom timeline (incident events interleaved with
 * investigation lifecycle events).
 *
 * Reached from the Incidents section on the Alerts page — a drill-in
 * route, not a new nav concept. Correlation with investigations is
 * svc + time-overlap based until Phase 4 stamps incident_id on
 * investigation events.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Button, Card, Menu, Tag, type TagColor } from '@capra/core';
import { ChevronDown } from '@capra/icons';
import StatusBanner from '../components/StatusBanner';
import InvestigateButton from '../components/InvestigateButton';
import { buildAlertSeed } from '../api/agentContext';
import { runQuery } from '../api/cribl';
import * as Q from '../api/queries';
import { serviceColor } from '../utils/spans';
import { listCachedIncidents, readCachedAlertHistory } from '../api/panelCache';
import { commitHumanIncidentAction, type HumanIncidentAction } from '../api/incidents';
import { fetchInvestigationStatus, listInvestigations } from '../api/investigationTransport';
import { useServerInvestigations } from '../hooks/useServerInvestigations';
import type { IncidentSummary, IncidentTimelineEntry } from '../api/types';
import type { IncidentSeverity, IncidentStatus } from '../api/generatedEventContract';
import s from './IncidentPage.module.css';

const STATUS_TAG: Record<IncidentSummary['status'], { label: string; color: TagColor }> = {
  open: { label: 'Open', color: 'danger' },
  investigating: { label: 'Investigating', color: 'info' },
  identified: { label: 'Identified', color: 'info' },
  mitigated: { label: 'Mitigated', color: 'warning' },
  resolved: { label: 'Resolved', color: 'success' },
  closed: { label: 'Closed', color: 'info' },
};

const SEVERITY_TAG: Record<IncidentSummary['severity'], TagColor> = {
  sev1: 'danger', sev2: 'danger', sev3: 'warning', sev4: 'info',
};

interface InvestigationRow {
  timeMs: number;
  eventType: string;   // started | investigated | investigation_failed
  investigationId: string;
  svc: string;
  signalType: string;
  conclusion: string;
}

interface MemberEpisode {
  peakErrorRate: number;
  signalTypes: Set<string>;
}

function fmtDurationMs(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rm = min % 60;
  return rm > 0 ? `${hr}h ${rm}m` : `${hr}h`;
}

function timelineLine(ev: IncidentTimelineEntry): string {
  switch (ev.eventType) {
    case 'opened': return `Incident opened — first signal from ${ev.services || ev.rootService || 'unknown'}`;
    case 'attached': return `${ev.services || 'a service'} attached — alert fired`;
    case 'status_change': return `Status changed to ${ev.status ?? '?'}`;
    case 'severity_change': return `Severity changed to ${ev.severity ?? '?'}`;
    case 'note': return ev.note ?? '';
    case 'investigation_linked': return `Investigation linked (${ev.investigationId ?? ''})`;
    case 'resolved': return 'All alerts cleared — incident resolved';
    case 'closed': return 'Incident closed';
    default: return ev.eventType;
  }
}

/** Window slack for correlating investigations to the incident. */
const CORRELATE_BEFORE_MS = 15 * 60_000;
const CORRELATE_AFTER_MS = 30 * 60_000;

/** Statuses a human can set directly (closed goes through Close). */
const HUMAN_STATUSES: IncidentStatus[] = ['open', 'investigating', 'identified', 'mitigated', 'resolved'];
const HUMAN_SEVERITIES: IncidentSeverity[] = ['sev1', 'sev2', 'sev3', 'sev4'];

export default function IncidentPage() {
  const { incidentId = '' } = useParams();
  const serverInvestigations = useServerInvestigations();
  const [incident, setIncident] = useState<IncidentSummary | null | undefined>(undefined);
  const [events, setEvents] = useState<IncidentTimelineEntry[]>([]);
  const [investigations, setInvestigations] = useState<InvestigationRow[]>([]);
  const [episodes, setEpisodes] = useState<Map<string, MemberEpisode>>(new Map());
  const [error, setError] = useState<string | null>(null);
  // Warroom write state: which action is in flight, the note draft,
  // and a nudge counter that refetches the timeline after commits.
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [writeNudge, setWriteNudge] = useState(0);
  const [syncNote, setSyncNote] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    listCachedIncidents()
      .then((incs) => {
        if (cancelled) return;
        setIncident(incs?.find((i) => i.incidentId === incidentId) ?? null);
      })
      .catch((e) => { if (!cancelled) { setError(e instanceof Error ? e.message : String(e)); setIncident(null); } });
    return () => { cancelled = true; };
  }, [incidentId]);

  /** Commit a human action; optimistically reflect status/severity on
   *  the header (the folded read model catches up within a cadence). */
  const act = useCallback((label: string, action: HumanIncidentAction, optimistic?: Partial<IncidentSummary>) => {
    setPendingAction(label);
    // Honesty over optimism: a close committed while the incident is
    // still deriving open (members firing) WILL be superseded by the
    // next fire — the fold's refire-beats-close reopen semantics.
    const closingWhileActive = action.kind === 'close'
      && (incident?.status === 'open' || incident?.status === 'investigating'
          || incident?.status === 'identified' || incident?.status === 'mitigated');
    commitHumanIncidentAction(incidentId, action)
      .then(() => {
        if (optimistic) {
          setIncident((cur) => (cur ? { ...cur, ...optimistic } : cur));
          setSyncNote(closingWhileActive
            ? 'Close recorded — but members of this incident may still be firing. A new fire after the close reopens the incident (by design); it stays closed only once its alerts have cleared.'
            : "Recorded on the incident's event log. The list and status chips re-fold from events within ~5 minutes; this page shows your change immediately.");
        }
        if (action.kind === 'note') setNoteDraft('');
        setWriteNudge((n) => n + 1);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setPendingAction(null));
  }, [incidentId, incident?.status]);

  // Timeline + investigations + member episode stats, windowed from the
  // incident's own age, CAPPED at 48h — a week-old retained incident
  // (or a fold row whose opened_at read as 0) must not fire multi-day
  // raw scans on page mount; a -7d scan measured >60s on the pool.
  useEffect(() => {
    if (!incident) return;
    let cancelled = false;
    const ageMs = incident.openedAtMs > 0 ? Date.now() - incident.openedAtMs : 0;
    const sinceHours = Math.min(48, Math.max(2, Math.ceil(ageMs / 3_600_000) + 1));
    const memberSvcs = new Set(incident.services.map((m) => m.service));
    const windowStart = incident.openedAtMs - CORRELATE_BEFORE_MS;
    const windowEnd = incident.lastFireMs + CORRELATE_AFTER_MS;
    const isOngoingIncident = incident.status !== 'resolved' && incident.status !== 'closed';

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
      .catch(() => { /* timeline is best-effort */ });

    if (serverInvestigations) {
      // Correlate via the CELL'S INDEX, not a dataset scan: the index
      // is one fast HTTP call with complete coverage, while the
      // -Nh raw scan could exceed the query budget on older incidents
      // and silently leave this section empty (observed live). The
      // svc comes from incidentKey ("svc:signal") / alertId
      // ("auto:health:svc"); the window is open-ended for ongoing
      // incidents — investigations often conclude well after the last
      // firing transition.
      const svcOf = (inv: { incidentKey: string; alertId: string }): string => {
        const key = inv.incidentKey.split(':')[0];
        if (key && key !== 'interactive') return key;
        const m = /^auto:[a-z_]+:([^:]+)/.exec(inv.alertId);
        return m?.[1] ?? '';
      };
      const statusToEventType: Record<string, string> = {
        concluded: 'investigated',
        failed: 'investigation_failed',
        queued: 'started',
        running: 'started',
        idle: 'linked',
        cancelled: 'linked',
      };
      listInvestigations({ limit: 100 })
        .then(async (all) => {
          if (cancelled) return;
          const correlated = all.filter((inv) => {
            const svc = svcOf(inv);
            if (!svc || !memberSvcs.has(svc)) return false;
            if (inv.createdAt < windowStart) return false;
            return isOngoingIncident || inv.createdAt <= windowEnd;
          }).slice(0, 8);
          const withConclusions = await Promise.all(correlated.map(async (inv) => {
            let conclusion = '';
            if (inv.status === 'concluded') {
              try {
                const st = await fetchInvestigationStatus(inv.id);
                const c = st.conclusion as { conclusion?: unknown } | null;
                if (c && typeof c.conclusion === 'string') conclusion = c.conclusion;
              } catch { /* conclusion is a bonus, the row still renders */ }
            }
            return {
              timeMs: inv.concludedAt ?? inv.startedAt ?? inv.createdAt,
              eventType: statusToEventType[inv.status] ?? 'started',
              investigationId: inv.id,
              svc: svcOf(inv),
              signalType: '',
              conclusion,
            };
          }));
          if (!cancelled) setInvestigations(withConclusions);
        })
        .catch(() => { /* investigations are best-effort */ });
    }

    readCachedAlertHistory()
      .then((rows) => {
        if (cancelled || !rows) return;
        const byMember = new Map<string, MemberEpisode>();
        for (const r of rows) {
          const svc = String(r.svc ?? '');
          const t = Number(r._time) * 1000;
          if (!memberSvcs.has(svc) || t < windowStart || t > windowEnd) continue;
          let ep = byMember.get(svc);
          if (!ep) { ep = { peakErrorRate: 0, signalTypes: new Set() }; byMember.set(svc, ep); }
          ep.peakErrorRate = Math.max(ep.peakErrorRate, Number(r.curr_error_rate ?? 0));
          const sig = String(r.signal_type ?? '');
          if (sig && sig !== 'none') ep.signalTypes.add(sig);
        }
        setEpisodes(byMember);
      })
      .catch(() => { /* episode stats are best-effort */ });

    return () => { cancelled = true; };
  }, [incident, serverInvestigations, writeNudge]);

  /** Interleaved warroom feed: incident events + investigation lifecycle. */
  const feed = useMemo(() => {
    const rows: Array<{ timeMs: number; author: string; line: string; link?: string }> = [
      ...events.map((ev) => ({ timeMs: ev.timeMs, author: ev.author, line: timelineLine(ev) })),
      ...investigations.map((iv) => ({
        timeMs: iv.timeMs,
        author: 'agent',
        line: iv.eventType === 'started'
          ? `Auto-investigation started on ${iv.svc}`
          : iv.eventType === 'investigated'
            ? `Auto-investigation concluded on ${iv.svc}${iv.conclusion ? ` — ${iv.conclusion.slice(0, 160)}` : ''}`
            : iv.eventType === 'investigation_failed'
              ? `Auto-investigation failed on ${iv.svc}`
              : `Investigation on ${iv.svc}`,
        link: `/investigate?investigation=${encodeURIComponent(iv.investigationId)}`,
      })),
    ];
    return rows.sort((a, b) => a.timeMs - b.timeMs);
  }, [events, investigations]);

  const concluded = useMemo(
    () => investigations.filter((iv) => iv.eventType === 'investigated' && iv.conclusion),
    [investigations],
  );

  /** Investigations explicitly linked to this incident by a human
   *  launch (investigation_linked events) — shown even when no
   *  lifecycle event correlates (e.g. interactive runs). */
  const linkedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const ev of events) {
      if (ev.eventType === 'investigation_linked' && ev.investigationId) ids.add(ev.investigationId);
    }
    return ids;
  }, [events]);

  /** Latest lifecycle event per investigation id → its card row; then
   *  linked-but-uncorrelated runs appended as bare rows. */
  const investigationCards = useMemo(() => {
    const byId = new Map<string, InvestigationRow>();
    for (const iv of [...investigations].sort((a, b) => a.timeMs - b.timeMs)) {
      byId.set(iv.investigationId, iv);
    }
    for (const id of linkedIds) {
      if (!byId.has(id)) {
        const linkEv = events.find((e) => e.eventType === 'investigation_linked' && e.investigationId === id);
        byId.set(id, {
          timeMs: linkEv?.timeMs ?? 0,
          eventType: 'linked',
          investigationId: id,
          svc: incident?.rootService ?? '',
          signalType: '',
          conclusion: '',
        });
      }
    }
    return Array.from(byId.values()).sort((a, b) => b.timeMs - a.timeMs);
  }, [investigations, linkedIds, events, incident?.rootService]);

  if (incident === undefined) {
    return <div className={s.page}><div className={s.empty}>Loading incident…</div></div>;
  }
  if (incident === null) {
    return (
      <div className={s.page}>
        {error && <StatusBanner kind="error">{error}</StatusBanner>}
        <div className={s.empty}>
          Incident not found — it may have aged out of the 7-day read model.
          {' '}<Link to="/alerts">Back to Alerts</Link>
        </div>
      </div>
    );
  }

  const st = STATUS_TAG[incident.status] ?? STATUS_TAG.open;
  const isOngoing = incident.status !== 'resolved' && incident.status !== 'closed';
  const durationMs = isOngoing
    // eslint-disable-next-line react-hooks/purity -- live "so far" duration
    ? Date.now() - incident.openedAtMs
    : Math.max(incident.lastFireMs - incident.openedAtMs, 60_000);
  const downstream = incident.services.filter((m) => m.service !== incident.rootService);

  return (
    <div className={s.page}>
      <div className={s.header}>
        <div>
          <div className={s.breadcrumb}><Link to="/alerts">Alerts</Link> / Incident</div>
          <h1 className={s.title}>{incident.title}</h1>
          <div className={s.tags}>
            <Tag color={st.color}>{st.label}</Tag>
            <Tag color={SEVERITY_TAG[incident.severity] ?? 'info'}>{incident.severity.toUpperCase()}</Tag>
            <span className={s.meta}>
              Opened {new Date(incident.openedAtMs).toLocaleString()}
              {' · '}{isOngoing ? `${fmtDurationMs(durationMs)} so far` : `lasted ${fmtDurationMs(durationMs)}`}
              {' · '}{incident.services.length} service{incident.services.length === 1 ? '' : 's'}
            </span>
          </div>
        </div>
        <div className={s.controls}>
          <Menu
            trigger={
              <Button variant="secondary" size="sm" trailingIcon={ChevronDown} disabled={pendingAction !== null}>
                {pendingAction === 'status' ? 'Saving…' : 'Set status'}
              </Button>
            }
          >
            {HUMAN_STATUSES.map((st2) => (
              <Menu.Item
                key={st2}
                label={STATUS_TAG[st2].label}
                onClick={() => act('status', { kind: 'status', status: st2 }, { status: st2 })}
              />
            ))}
          </Menu>
          <Menu
            trigger={
              <Button variant="secondary" size="sm" trailingIcon={ChevronDown} disabled={pendingAction !== null}>
                {pendingAction === 'severity' ? 'Saving…' : 'Set severity'}
              </Button>
            }
          >
            {HUMAN_SEVERITIES.map((sv) => (
              <Menu.Item
                key={sv}
                label={sv.toUpperCase()}
                onClick={() => act('severity', { kind: 'severity', severity: sv }, { severity: sv })}
              />
            ))}
          </Menu>
          {incident.status === 'closed' ? (
            <Button
              variant="secondary" size="sm"
              pending={pendingAction === 'reopen'}
              disabled={pendingAction !== null}
              onClick={() => act('reopen', { kind: 'reopen' }, { status: 'open' })}
            >
              Reopen
            </Button>
          ) : (
            <Button
              variant="secondary" size="sm"
              pending={pendingAction === 'close'}
              disabled={pendingAction !== null}
              onClick={() => act('close', { kind: 'close' }, { status: 'closed' })}
            >
              Close incident
            </Button>
          )}
          <InvestigateButton
            seed={{
              ...buildAlertSeed({
                service: incident.rootService || incident.services[0]?.service || '',
                signalType: episodes.get(incident.rootService)?.signalTypes.values().next().value ?? 'error_rate',
                errorRate: episodes.get(incident.rootService)?.peakErrorRate ?? 0,
                // eslint-disable-next-line react-hooks/purity -- live window from incident age (capped like the page queries)
                earliest: `-${Math.min(48, Math.max(2, Math.ceil((incident.openedAtMs > 0 ? Date.now() - incident.openedAtMs : 0) / 3_600_000) + 1))}h`,
              }),
              incidentId: incident.incidentId,
              knownSignals: [
                `Incident ${incident.incidentId}: ${incident.title}`,
                `Affected services (first-fired order): ${incident.services.map((m) => m.service).join(', ')}`,
                `Derived root (first to fire): ${incident.rootService}`,
              ],
            }}
            variant="primary"
            title="Start an AI investigation seeded with this incident's context"
          />
        </div>
      </div>

      {syncNote && <StatusBanner kind="info">{syncNote}</StatusBanner>}

      {/* What happened — deterministic narrative; the supervisor agent
          overwrites this with a root-caused version in Phase 6. */}
      <Card className={s.card}>
        <h2 className={s.sectionTitle}>Summary</h2>
        <div className={s.summaryBody}>
          <p>
            Alerts fired on{' '}
            <strong style={{ color: serviceColor(incident.rootService) }}>{incident.rootService}</strong>
            {' '}first{downstream.length > 0 && (
              <>
                , followed by{' '}
                {downstream.map((m, i) => (
                  <span key={m.service}>
                    {i > 0 && ', '}
                    <strong style={{ color: serviceColor(m.service) }}>{m.service}</strong>
                  </span>
                ))}
              </>
            )}.
            {' '}{isOngoing
              ? 'The incident is still ongoing.'
              : `All alerts cleared and the incident ${incident.status === 'closed' ? 'is closed' : 'resolved'} after ${fmtDurationMs(durationMs)}.`}
          </p>
          {concluded.length > 0 ? (
            <div>
              <p className={s.findingsLabel}>Auto-investigation findings:</p>
              <ul className={s.findings}>
                {concluded.map((iv) => (
                  <li key={iv.investigationId}>
                    <strong style={{ color: serviceColor(iv.svc) }}>{iv.svc}</strong>: {iv.conclusion}
                    {' '}<Link to={`/investigate?investigation=${encodeURIComponent(iv.investigationId)}`}>transcript →</Link>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className={s.muted}>
              {serverInvestigations
                ? 'No auto-investigation has concluded for this incident yet.'
                : 'Server-side investigations are off — enable them to get automated root-cause findings here.'}
            </p>
          )}
        </div>
      </Card>

      {/* The machines' work */}
      {serverInvestigations && (
        <Card className={s.card}>
          <h2 className={s.sectionTitle}>Investigations ({investigationCards.length})</h2>
          {investigationCards.length === 0 ? (
            <div className={s.empty}>
              No server-side investigations correlate with this incident window.
            </div>
          ) : (
            <table className={s.table}>
              <thead>
                <tr><th>Status</th><th>Service</th><th>When</th><th>Conclusion</th><th /></tr>
              </thead>
              <tbody>
                {investigationCards.map((iv) => (
                  <tr key={iv.investigationId}>
                    <td>
                      {iv.eventType === 'investigated' && <Tag color="success">Concluded</Tag>}
                      {iv.eventType === 'started' && <Tag color="info">Running…</Tag>}
                      {iv.eventType === 'investigation_failed' && <Tag color="warning">Failed</Tag>}
                      {iv.eventType === 'linked' && <Tag color="info">Linked</Tag>}
                    </td>
                    <td><span style={{ color: serviceColor(iv.svc) }}>{iv.svc}</span></td>
                    <td style={{ whiteSpace: 'nowrap' }}>{new Date(iv.timeMs).toLocaleString()}</td>
                    <td className={s.conclusionCell}>{iv.conclusion || '—'}</td>
                    <td>
                      <Link to={`/investigate?investigation=${encodeURIComponent(iv.investigationId)}`}>
                        Transcript →
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {/* Who's affected */}
      <Card className={s.card}>
        <h2 className={s.sectionTitle}>Services ({incident.services.length})</h2>
        <table className={s.table}>
          <thead>
            <tr><th>Service</th><th>Signals</th><th>Peak error rate</th><th>First fired</th><th>Last fired</th><th>Fires</th></tr>
          </thead>
          <tbody>
            {incident.services.map((m) => {
              const ep = episodes.get(m.service);
              return (
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
                  <td>{ep && ep.signalTypes.size > 0 ? Array.from(ep.signalTypes).join(', ') : '—'}</td>
                  <td>{ep && ep.peakErrorRate > 0 ? `${(ep.peakErrorRate * 100).toFixed(1)}%` : '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(m.firstSeenMs).toLocaleString()}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{new Date(m.lastFireMs).toLocaleString()}</td>
                  <td>{m.fireCount}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>

      {/* The warroom log + note composer */}
      <Card className={s.card}>
        <h2 className={s.sectionTitle}>Timeline</h2>
        <form
          className={s.noteComposer}
          onSubmit={(e) => {
            e.preventDefault();
            if (noteDraft.trim()) act('note', { kind: 'note', note: noteDraft });
          }}
        >
          <input
            className={s.noteInput}
            placeholder="Add a note to the warroom log — what you suspect, what you changed, what you ruled out…"
            value={noteDraft}
            onChange={(e) => setNoteDraft(e.target.value)}
            disabled={pendingAction !== null}
          />
          <Button
            type="submit"
            variant="secondary"
            size="sm"
            pending={pendingAction === 'note'}
            disabled={pendingAction !== null || !noteDraft.trim()}
          >
            Add note
          </Button>
        </form>
        {feed.length === 0 ? (
          <div className={s.empty}>No timeline events yet.</div>
        ) : (
          <ul className={s.timeline}>
            {feed.map((row, i) => (
              <li key={i} className={s.timelineRow}>
                <span className={s.timelineTime}>{new Date(row.timeMs).toLocaleString()}</span>
                <span className={s.timelineAuthor}>{row.author}</span>
                <span className={s.timelineText}>
                  {row.line}
                  {row.link && <>{' '}<Link to={row.link}>view →</Link></>}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
