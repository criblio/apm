import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { scaleTime } from 'd3-scale';
import { timeFormat } from 'd3-time-format';
import s from './AlertTimeline.module.css';

interface AlertEvent {
  time: number;
  eventType: string;
  service: string;
}

interface Props {
  events: AlertEvent[];
  onRangeSelect?: (start: number, end: number) => void;
  onRangeClear?: () => void;
  height?: number;
}

const M = { top: 4, right: 12, bottom: 22, left: 12 };
const fmtTick = timeFormat('%H:%M');
const fmtDay = timeFormat('%b %d');

export default function AlertTimeline({ events, onRangeSelect, onRangeClear, height = 80 }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(600);
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragEnd, setDragEnd] = useState<number | null>(null);
  const [selection, setSelection] = useState<[number, number] | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const ro = new ResizeObserver(() => {
      const r = containerRef.current?.getBoundingClientRect();
      if (r && r.width > 0) setWidth(r.width);
    });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  const innerW = width - M.left - M.right;
  const innerH = height - M.top - M.bottom;

  const xScale = useMemo(() => {
    if (events.length === 0) {
      const now = Date.now();
      return scaleTime().domain([now - 86400000, now]).range([0, innerW]);
    }
    const times = events.map((e) => e.time);
    const minT = Math.min(...times);
    const maxT = Math.max(...times);
    const pad = Math.max((maxT - minT) * 0.05, 60000);
    return scaleTime().domain([minT - pad, maxT + pad]).range([0, innerW]);
  }, [events, innerW]);

  const ticks = xScale.ticks(Math.max(3, Math.floor(innerW / 100)));

  const handleMouseDown = useCallback((e: React.MouseEvent<SVGRectElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - M.left;
    const t = xScale.invert(x).getTime();
    setDragStart(t);
    setDragEnd(t);
    setSelection(null);
    onRangeClear?.();
  }, [xScale, onRangeClear]);

  const handleMouseMove = useCallback((e: React.MouseEvent<SVGRectElement>) => {
    if (dragStart === null) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left - M.left;
    setDragEnd(xScale.invert(x).getTime());
  }, [dragStart, xScale]);

  const handleMouseUp = useCallback(() => {
    if (dragStart !== null && dragEnd !== null) {
      const s = Math.min(dragStart, dragEnd);
      const e = Math.max(dragStart, dragEnd);
      if (e - s > 30000) {
        setSelection([s, e]);
        onRangeSelect?.(s, e);
      }
    }
    setDragStart(null);
    setDragEnd(null);
  }, [dragStart, dragEnd, onRangeSelect]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    onRangeClear?.();
  }, [onRangeClear]);

  const selLeft = selection ? xScale(selection[0]) : dragStart !== null && dragEnd !== null ? xScale(Math.min(dragStart, dragEnd)) : null;
  const selWidth = selection ? xScale(selection[1]) - xScale(selection[0]) : dragStart !== null && dragEnd !== null ? Math.abs(xScale(dragEnd) - xScale(dragStart)) : null;

  return (
    <div className={s.wrap} ref={containerRef}>
      <div className={s.header}>
        <span className={s.title}>Alert Timeline</span>
        {selection && (
          <button className={s.clearBtn} onClick={clearSelection}>
            Clear selection
          </button>
        )}
      </div>
      <svg width={width} height={height}>
        <g transform={`translate(${M.left},${M.top})`}>
          {/* Axis */}
          <line x1={0} y1={innerH} x2={innerW} y2={innerH} stroke="var(--cds-color-border-subtle)" />
          {ticks.map((t) => {
            const x = xScale(t);
            return (
              <g key={t.getTime()}>
                <line x1={x} y1={0} x2={x} y2={innerH} stroke="var(--cds-color-border-subtle)" strokeDasharray="2,3" opacity={0.5} />
                <text x={x} y={innerH + 14} textAnchor="middle" fill="var(--cds-color-fg-muted)" fontSize={10}>
                  {fmtTick(t)}
                </text>
              </g>
            );
          })}

          {/* Selection highlight */}
          {selLeft !== null && selWidth !== null && selWidth > 0 && (
            <rect x={selLeft} y={0} width={selWidth} height={innerH} fill="var(--cds-color-accent)" opacity={0.12} rx={2} />
          )}

          {/* Event marks */}
          {events.map((ev, i) => {
            const x = xScale(ev.time);
            const isFiring = ev.eventType === 'firing';
            return (
              <g key={i}>
                <line x1={x} y1={4} x2={x} y2={innerH - 4} stroke={isFiring ? '#dc2626' : '#10b981'} strokeWidth={2} opacity={0.8} />
                <circle cx={x} cy={innerH / 2} r={4} fill={isFiring ? '#dc2626' : '#10b981'} />
              </g>
            );
          })}

          {/* Drag capture overlay */}
          <rect
            x={0} y={0} width={innerW} height={innerH}
            fill="transparent"
            cursor="crosshair"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          />
        </g>
      </svg>
      {events.length === 0 && (
        <div className={s.empty}>No alert events in this time range</div>
      )}
    </div>
  );
}
