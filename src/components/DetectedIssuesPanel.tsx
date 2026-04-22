import { Link } from 'react-router-dom';
import { serviceColor } from '../utils/spans';
import InvestigateButton from './InvestigateButton';
import type { InvestigationSeed } from '../api/agentContext';
import type { DetectedIssue } from '../api/types';
import s from './DetectedIssuesPanel.module.css';

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
                  className={s.severityDot}
                  style={{ background: SEVERITY_COLOR[issue.severity] }}
                  title={issue.severity}
                />
                <div className={s.mainCol}>
                  <span
                    className={s.svcName}
                    style={{ color: serviceColor(issue.service) }}
                  >
                    {issue.service}
                  </span>
                  <span
                    className={s.signalBadge}
                    style={{ background: style.bg, color: style.fg }}
                  >
                    {style.label}
                  </span>
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
