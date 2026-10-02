import { useMemo } from 'react';
import type { JaegerTrace } from '../api/types';
import { entityColor } from '@criblio/app-utils/viz';
import { formatDurationUs, traceTimeline } from '../utils/spans';
import s from './SpanTree.module.css';

interface Props {
  trace: JaegerTrace;
  selectedSpanId: string | null;
  onSelect: (spanId: string) => void;
}

const TICKS = 5;

export default function SpanTree({ trace, selectedSpanId, onSelect }: Props) {
  const timeline = useMemo(() => traceTimeline(trace), [trace]);
  const { duration: traceDuration, rows } = timeline;

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

      {rows.map(({ item: span, depth, offset, width, inWindow }) => {
        const proc = trace.processes[span.processID];
        const svc = proc?.serviceName ?? 'unknown';
        const color = entityColor(svc);
        // The timeline windows to the root span, so a clock-skewed child
        // stamped before the root is clipped: a clamped sliver when it
        // overlaps the window, a label-only row when it lies entirely
        // outside it (`inWindow: false`). Floor the width so a sub-pixel
        // span is still clickable.
        const leftPct = offset * 100;
        const widthPct = Math.max(width * 100, 0.2);
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
              {inWindow ? (
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
