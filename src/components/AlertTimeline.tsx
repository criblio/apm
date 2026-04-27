import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { scaleTime } from 'd3-scale';
import { timeFormat } from 'd3-time-format';
import { serviceColor } from '../utils/spans';
import s from './AlertTimeline.module.css';

export interface AlertInterval {
  service: string;
  startTime: number;
  endTime: number | null;
}

interface Props {
  intervals: AlertInterval[];
  onRangeSelect?: (start: number, end: number) => void;
  onRangeClear?: () => void;
  height?: number;
}

const M = { top: 4, right: 12, bottom: 22, left: 12 };
const BAR_H = 14;
const BAR_GAP = 3;
const fmtTick = timeFormat('%H:%M');

export default function AlertTimeline({ intervals, onRangeSelect, onRangeClear, height: propHeight }: Props) {
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

  // Stack intervals by service — each service gets its own row
  const services = useMemo(() => {
    const set = new Set<string>();
    for (const iv of intervals) set.add(iv.service);
    return Array.from(set).sort();
  }, [intervals]);

  const innerW = width - M.left - M.right;
  const height = propHeight ?? Math.max(60, M.top + M.bottom + services.length * (BAR_H + BAR_GAP));
  const innerH = height - M.top - M.bottom;

  const now = Date.now();
  const xScale = useMemo(() => {
    if (intervals.length === 0) {
      return scaleTime().domain([now - 86400000, now]).range([0, innerW]);
    }
    const starts = intervals.map((iv) => iv.startTime);
    const ends = intervals.map((iv) => iv.endTime ?? now);
    const minT = Math.min(...starts);
    const maxT = Math.max(...ends);
    const pad = Math.max((maxT - minT) * 0.03, 60000);
    return scaleTime().domain([minT - pad, maxT + pad]).range([0, innerW]);
  }, [intervals, innerW, now]);

  const ticks = xScale.ticks(Math.max(3, Math.floor(innerW / 120)));

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
          <button className={s.clearBtn} onClick={clearSelection}>Clear selection</button>
        )}
      </div>
      <svg width={width} height={height}>
        <g transform={`translate(${M.left},${M.top})`}>
          {/* Grid */}
          <line x1={0} y1={innerH} x2={innerW} y2={innerH} stroke="var(--cds-color-border-subtle)" />
          {ticks.map((t) => (
            <g key={t.getTime()}>
              <line x1={xScale(t)} y1={0} x2={xScale(t)} y2={innerH} stroke="var(--cds-color-border-subtle)" strokeDasharray="2,3" opacity={0.4} />
              <text x={xScale(t)} y={innerH + 14} textAnchor="middle" fill="var(--cds-color-fg-muted)" fontSize={10}>{fmtTick(t)}</text>
            </g>
          ))}

          {/* Selection highlight */}
          {selLeft !== null && selWidth !== null && selWidth > 0 && (
            <rect x={selLeft} y={0} width={selWidth} height={innerH} fill="var(--cds-color-accent)" opacity={0.1} rx={2} />
          )}

          {/* Service bars */}
          {services.map((svc, svcIdx) => {
            const y = svcIdx * (BAR_H + BAR_GAP);
            const color = serviceColor(svc);
            const svcIntervals = intervals.filter((iv) => iv.service === svc);
            return (
              <g key={svc}>
                {/* Service label */}
                <text x={2} y={y + BAR_H - 3} fill="var(--cds-color-fg-muted)" fontSize={9} opacity={0.7}>{svc}</text>
                {svcIntervals.map((iv, j) => {
                  const x1 = Math.max(0, xScale(iv.startTime));
                  const x2 = Math.min(innerW, xScale(iv.endTime ?? now));
                  const barW = Math.max(2, x2 - x1);
                  return (
                    <rect key={j} x={x1} y={y} width={barW} height={BAR_H} fill={color} opacity={0.7} rx={2} />
                  );
                })}
              </g>
            );
          })}

          {/* Drag overlay */}
          <rect
            x={0} y={0} width={innerW} height={innerH}
            fill="transparent" cursor="crosshair"
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={handleMouseUp}
          />
        </g>
      </svg>
      {intervals.length === 0 && (
        <div className={s.empty}>No alert incidents in this time range</div>
      )}
    </div>
  );
}
