import { useMemo } from 'react';
import type { JaegerTrace } from '../api/types';
import { buildTimeline, formatDurationUs, serviceColor } from '../utils/spans';
import s from './SpanTree.module.css';

interface Props {
  trace: JaegerTrace;
  selectedSpanId: string | null;
  onSelect: (spanId: string) => void;
}

const TICKS = 5;

export default function SpanTree({ trace, selectedSpanId, onSelect }: Props) {
  const timeline = useMemo(() => buildTimeline(trace), [trace]);
  const { traceStart, traceDuration, nodes } = timeline;

  return (
    <div className={s.tree}>
      <div className={s.timeAxis}>
        <div className={s.timeAxisLabel}>Service / Operation</div>
        <div className={s.timeAxisTrack}>
          {Array.from({ length: TICKS + 1 }, (_, i) => {
            const pct = (i / TICKS) * 100;
            const us = (traceDuration * i) / TICKS;
            return (
              <div
                key={i}
                className={s.timeAxisTick}
                style={{ left: `${pct}%`, transform: i === TICKS ? 'translateX(-100%)' : 'none' }}
              >
                {formatDurationUs(us)}
              </div>
            );
          })}
        </div>
      </div>

      {nodes.map(({ span, depth }) => {
        const proc = trace.processes[span.processID];
        const svc = proc?.serviceName ?? 'unknown';
        const color = serviceColor(svc);
        // Clip the span's extent to the chart's [traceStart, traceEnd]
        // window. buildTimeline anchors that window to the root span
        // when one exists, so clock-skewed children whose start lands
        // before the root can render as either a clamped sliver (if
        // they overlap the window) or a label-only row with no bar
        // (if they are entirely outside it). Either is preferable to
        // the old behavior, where negative leftPct pushed the bar off
        // the visible area and made the row look half-broken.
        const traceEnd = traceStart + traceDuration;
        const spanEnd = span.startTime + span.duration;
        const visStart = Math.max(span.startTime, traceStart);
        const visEnd = Math.min(spanEnd, traceEnd);
        const hasVisibleBar = visEnd > visStart;
        const leftPct = ((visStart - traceStart) / traceDuration) * 100;
        const widthPct = Math.max(
          ((visEnd - visStart) / traceDuration) * 100,
          0.2,
        );
        const isError = span.tags.some((t) => t.key === 'error' && t.value === true);
        const isSelected = span.spanID === selectedSpanId;
        const outOfWindowTitle =
          'This span is timestamped outside the trace window — likely ' +
          'clock skew in the emitting service. Select the row to see ' +
          'the raw timings in the detail pane.';

        return (
          <div
            key={span.spanID}
            className={`${s.row} ${isError ? s.error : ''} ${isSelected ? s.rowSelected : ''}`}
            onClick={() => onSelect(span.spanID)}
          >
            <div className={s.label} style={{ paddingLeft: `${12 + depth * 18}px` }}>
              <span className={s.serviceDot} style={{ background: color }} />
              <span className={s.serviceName}>{svc}</span>
              <span className={s.opName}>{span.operationName}</span>
            </div>
            <div className={s.bar}>
              {hasVisibleBar ? (
                <div
                  className={s.barFill}
                  style={{
                    left: `${leftPct}%`,
                    width: `${widthPct}%`,
                    background: color,
                  }}
                  title={formatDurationUs(span.duration)}
                >
                  {widthPct > 8 ? formatDurationUs(span.duration) : ''}
                </div>
              ) : (
                <div className={s.outOfWindow} title={outOfWindowTitle}>
                  ⚠ {formatDurationUs(span.duration)} outside trace window
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
