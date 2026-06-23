import { Link } from 'react-router-dom';
import { Tag, type TagColor } from '@capra/core';
import { serviceColor } from '../utils/spans';
import InvestigateButton from './InvestigateButton';
import type { InvestigationSeed } from '../api/agentContext';
import type { DetectedIssue } from '../api/types';
import s from './DetectedIssuesPanel.module.css';

/** Map alert status → Capra Tag color. Used for the firing /
 *  pending / resolving tags on the issue row. */
const STATUS_TAG_COLOR: Record<string, TagColor> = {
  firing: 'danger',
  pending: 'warning',
  resolving: 'info',
  ok: 'success',
};

/** Map signal type → Capra Tag color so the per-issue type tag
 *  ("Error Rate", "Traffic Drop", "Latency Anomaly", "Service Silent")
 *  picks up Capra's palette instead of bespoke rgba(...) backgrounds. */
const SIGNAL_TAG_COLOR: Record<DetectedIssue['signalType'], TagColor> = {
  error_rate_critical: 'danger',
  error_rate_warn: 'warning',
  traffic_drop: 'purple',
  latency_anomaly: 'cyan',
  silent: 'danger',
};

interface Props {
  issues: DetectedIssue[];
  loading: boolean;
  lookback: string;
}

const SIGNAL_STYLE: Record<
  DetectedIssue['signalType'],
  { label: string; bg: string; fg: string }
> = {
  error_rate_critical: {
    label: 'Error Rate',
    bg: 'rgba(220, 38, 38, 0.12)',
    fg: '#dc2626',
  },
  error_rate_warn: {
    label: 'Error Rate',
    bg: 'rgba(245, 158, 11, 0.12)',
    fg: '#f59e0b',
  },
  traffic_drop: {
    label: 'Traffic Drop',
    bg: 'rgba(168, 85, 247, 0.12)',
    fg: '#a855f7',
  },
  latency_anomaly: {
    label: 'Latency Anomaly',
    bg: 'rgba(6, 182, 212, 0.12)',
    fg: '#06b6d4',
  },
  silent: {
    label: 'Service Silent',
    bg: 'rgba(220, 38, 38, 0.12)',
    fg: '#dc2626',
  },
};

const SEVERITY_COLOR: Record<DetectedIssue['severity'], string> = {
  critical: '#dc2626',
  warn: '#f59e0b',
};

function buildIssueSeed(issue: DetectedIssue, lookback: string): InvestigationSeed {
  const signals = [issue.detail];
  if (issue.rootCauseHint) signals.push(`Root-cause hint: ${issue.rootCauseHint}`);

  const typeLabel = SIGNAL_STYLE[issue.signalType].label.toLowerCase();
  return {
    question: `The ${issue.service} service has a ${typeLabel} issue: ${issue.detail}. Investigate the root cause.`,
    service: issue.service,
    operation: issue.operation,
    knownSignals: signals,
    earliest: lookback,
    latest: 'now',
  };
}

export default function DetectedIssuesPanel({ issues, loading, lookback }: Props) {
  if (loading) {
    return (
      <div className={s.wrap}>
        <div className={s.header}>
          <span className={s.title}>Detected Issues</span>
        </div>
        <div className={s.skeleton}>
          {[85, 70, 60].map((w, i) => (
            <div key={i} className={s.skeletonBar} style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
    );
  }

  if (issues.length === 0) {
    return (
      <div className={s.wrap}>
        <div className={s.allClear}>
          <svg
            className={s.checkIcon}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
            <polyline points="22 4 12 14.01 9 11.01" />
          </svg>
          All services healthy
        </div>
      </div>
    );
  }

  return (
    <div className={s.wrap}>
      <div className={s.header}>
        <span className={s.title}>
          Detected Issues
          <span className={s.countBadge}>{issues.length}</span>
        </span>
        <span className={s.subtitle}>
          Services with anomalous health signals in the current window
        </span>
      </div>
      <ul className={s.list}>
        {issues.map((issue, i) => {
          const style = SIGNAL_STYLE[issue.signalType];
          const drillTo = `/service/${encodeURIComponent(issue.service)}?range=${encodeURIComponent(lookback)}`;
          return (
            <li key={`${issue.service}-${issue.signalType}-${issue.operation ?? ''}-${i}`}>
              <Link to={drillTo} className={s.row}>
                <span
                  className={`${s.severityDot} ${issue.alertStatus === 'firing' ? s.severityDotFiring : ''}`}
                  style={{ background: SEVERITY_COLOR[issue.severity] }}
                  title={issue.alertStatus ?? issue.severity}
                />
                <div className={s.mainCol}>
                  {issue.alertStatus && issue.alertStatus !== 'ok' && (
                    <Tag color={STATUS_TAG_COLOR[issue.alertStatus] ?? 'default'}>
                      {issue.alertStatus}
                    </Tag>
                  )}
                  {issue.isPersistent && (
                    <Tag color="info" aria-label="Elevated in both current and previous window">
                      persistent
                    </Tag>
                  )}
                  <span
                    className={s.svcName}
                    style={{ color: serviceColor(issue.service) }}
                  >
                    {issue.service}
                  </span>
                  <Tag color={SIGNAL_TAG_COLOR[issue.signalType] ?? 'default'}>
                    {style.label}
                  </Tag>
                  <span className={s.detail}>{issue.detail}</span>
                  {issue.rootCauseHint && (
                    <span className={s.hintChip} title={issue.rootCauseHint}>
                      → {issue.rootCauseHint}
                    </span>
                  )}
                </div>
                <div className={s.actions}>
                  <InvestigateButton
                    seed={buildIssueSeed(issue, lookback)}
                    title={`Investigate ${issue.service}`}
                  />
                </div>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
