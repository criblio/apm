/**
 * Floating card rendered on edge hover in the System Architecture
 * graphs. Replaces the native SVG <title> tooltip which had a ~1s
 * OS-level delay and plain-text styling. Matches the visual design
 * of NodeTooltip — same card surface, header layout, and stats grid.
 *
 * Positioning: follows the cursor. The caller passes screen-pixel
 * coordinates (relative to the graph container) and the card offsets
 * itself to avoid going off the right edge.
 */
import { serviceColor, formatDurationUs } from '../utils/spans';
import { healthFromRate } from '../utils/health';
import s from './EdgeTooltip.module.css';

interface Props {
  parent: string;
  child: string;
  kind: 'rpc' | 'messaging';
  topic?: string;
  callCount: number;
  errorCount: number;
  p95DurUs: number;
  /** Cursor position, screen pixels relative to the graph container. */
  left: number;
  top: number;
  /** Container width so we can keep the card on-screen. */
  containerWidth: number;
  containerHeight: number;
}

/** Card dimensions used to compute off-screen avoidance. */
const CARD_WIDTH = 260;
const CARD_HEIGHT_EST = 180;
const CURSOR_GAP = 14;

export default function EdgeTooltip({
  parent,
  child,
  kind,
  topic,
  callCount,
  errorCount,
  p95DurUs,
  left,
  top,
  containerWidth,
  containerHeight,
}: Props) {
  const errorRate = callCount > 0 ? errorCount / callCount : 0;
  const health = healthFromRate(errorRate, callCount);

  // Place the card next to the cursor, flip left when it would run
  // off the right edge. Vertical centering on the cursor with a
  // small gap feels most natural for edge hovers.
  let x = left + CURSOR_GAP;
  if (x + CARD_WIDTH > containerWidth) x = left - CURSOR_GAP - CARD_WIDTH;
  if (x < 8) x = 8;
  let y = top - CARD_HEIGHT_EST / 2;
  if (y < 8) y = 8;
  if (y + CARD_HEIGHT_EST > containerHeight) {
    y = containerHeight - CARD_HEIGHT_EST - 8;
  }

  const parentColor = serviceColor(parent);
  const childColor = serviceColor(child);
  const kindLabel = kind === 'messaging' ? 'messaging' : 'rpc';

  return (
    <div className={s.card} style={{ left: x, top: y }}>
      <div className={s.header}>
        <span className={s.kindBadge} data-kind={kind}>
          {kindLabel}
        </span>
        <span className={s.healthDot} style={{ background: health.color }} />
        <span className={s.healthText}>{health.label}</span>
      </div>

      <div className={s.endpoints}>
        <div className={s.endpoint}>
          <span className={s.endpointDot} style={{ background: parentColor }} />
          <span className={s.endpointName} title={parent}>
            {parent}
          </span>
        </div>
        <div className={s.arrow} aria-hidden="true">
          →
        </div>
        <div className={s.endpoint}>
          <span className={s.endpointDot} style={{ background: childColor }} />
          <span className={s.endpointName} title={child}>
            {child}
          </span>
        </div>
      </div>

      {topic && (
        <div className={s.topicRow}>
          <span className={s.topicLabel}>Topic</span>
          <span className={s.topicValue} title={topic}>
            {topic}
          </span>
        </div>
      )}

      <div className={s.stats}>
        <span className={s.statLabel}>Calls</span>
        <span className={s.statValue}>{callCount.toLocaleString()}</span>

        <span className={s.statLabel}>Errors</span>
        <span
          className={`${s.statValue} ${errorCount > 0 ? s.statValueErr : ''}`}
        >
          {errorCount === 0
            ? '0'
            : `${errorCount.toLocaleString()} · ${(errorRate * 100).toFixed(2)}%`}
        </span>

        <span className={s.statLabel}>p95</span>
        <span className={s.statValue}>{formatDurationUs(p95DurUs)}</span>
      </div>

      <div className={s.investigateHint}>
        Click edge to investigate with Copilot →
      </div>
    </div>
  );
}
