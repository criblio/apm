/**
 * Small floating zoom control overlay for pan+zoom canvases.
 * Positioned in the bottom-right corner of its parent (which must be
 * position: relative). Buttons for zoom-in / zoom-out / reset and a
 * tiny scale readout so users know what zoom level they're at.
 */
import s from './ZoomControls.module.css';

interface Props {
  scale: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onReset: () => void;
}

export default function ZoomControls({ scale, onZoomIn, onZoomOut, onReset }: Props) {
  return (
    <div className={s.wrap} onClick={(e) => e.stopPropagation()}>
      <button
        type="button"
        className={s.btn}
        onClick={onZoomIn}
        title="Zoom in (or use mouse wheel)"
        aria-label="Zoom in"
      >
        +
      </button>
      <div className={s.scaleLabel}>{Math.round(scale * 100)}%</div>
      <button
        type="button"
        className={s.btn}
        onClick={onZoomOut}
        title="Zoom out (or use mouse wheel)"
        aria-label="Zoom out"
      >
        −
      </button>
      <button
        type="button"
        className={s.btn}
        onClick={onReset}
        title="Reset view"
        aria-label="Reset zoom and pan"
        style={{ fontSize: 12 }}
      >
        ⟲
      </button>
    </div>
  );
}
