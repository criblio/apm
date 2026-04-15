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
        const offsetUs = span.startTime - traceStart;
        const leftPct = (offsetUs / traceDuration) * 100;
        const widthPct = Math.max((span.duration / traceDuration) * 100, 0.2);
        const isError = span.tags.some((t) => t.key === 'error' && t.value === true);
        const isSelected = span.spanID === selectedSpanId;

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
            </div>
          </div>
        );
      })}
    </div>
  );
}
