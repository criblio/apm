/**
 * Pan + zoom for SVG scenes.
 *
 * Tracks a 2D affine transform {tx, ty, scale} that the caller applies
 * to a <g> wrapper inside the SVG. Exposes wheel / pointer handlers
 * for zoom and pan, plus screenToWorld / worldToScreen helpers for
 * mapping pointer coordinates through the transform.
 *
 * Notes on event wiring:
 * - The wheel handler is attached via a native addEventListener inside
 *   a useEffect so we can pass {passive: false} and call
 *   preventDefault(). React's synthetic wheel events are passive by
 *   default since React 17.
 * - Pointer pan handlers return from React onPointer* props so they
 *   naturally coexist with individual node drag handlers (which call
 *   stopPropagation on their own pointerdown to prevent the pan from
 *   starting when the user grabs a node).
 * - The caller should track whether the last pointer interaction
 *   moved enough to count as a pan — a zero-distance pointerup on
 *   the background is a "click" that should still unpin tooltips.
 *   `consumeLastPan()` reports that state to the caller.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';

export interface PanZoomTransform {
  tx: number;
  ty: number;
  scale: number;
}

export interface UsePanZoomResult {
  transform: PanZoomTransform;
  svgRef: React.RefObject<SVGSVGElement | null>;
  onBackgroundPointerDown: (e: ReactPointerEvent<SVGElement>) => void;
  onBackgroundPointerMove: (e: ReactPointerEvent<SVGElement>) => void;
  onBackgroundPointerUp: (e: ReactPointerEvent<SVGElement>) => void;
  /** Screen pixel (relative to SVG top-left) → pre-transform coords. */
  screenToWorld: (sx: number, sy: number) => { x: number; y: number };
  /** Pre-transform coords → screen pixel (relative to SVG top-left). */
  worldToScreen: (wx: number, wy: number) => { x: number; y: number };
  zoomBy: (factor: number, centerX?: number, centerY?: number) => void;
  reset: () => void;
  /** Fit the viewport to a bounding box in world coordinates, with padding. */
  fitToBounds: (bounds: { minX: number; minY: number; maxX: number; maxY: number }, padding?: number) => void;
  /** Returns true if the most recent pointer interaction was a pan (not a click). */
  consumeLastPan: () => boolean;
}

const MIN_SCALE = 0.2;
const MAX_SCALE = 5;
const PAN_THRESHOLD = 4;

export function usePanZoom(width: number, height: number): UsePanZoomResult {
  const svgRef = useRef<SVGSVGElement>(null);
  const [transform, setTransform] = useState<PanZoomTransform>({
    tx: 0,
    ty: 0,
    scale: 1,
  });
  // Live copy of the transform for event handlers that need the
  // pre-update value without triggering re-renders. The lint rule flags
  // ref assignment during render; in this case we specifically want the
  // handlers to see the most recent committed transform.
  const transformRef = useRef(transform);
  // eslint-disable-next-line react-hooks/refs
  transformRef.current = transform;

  const panRef = useRef<{
    startX: number;
    startY: number;
    startTx: number;
    startTy: number;
    moved: boolean;
  } | null>(null);
  const lastWasPanRef = useRef(false);

  // Wheel handler — attached natively so we can preventDefault.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      // Normalize wheel delta across devices (line vs pixel).
      const deltaY = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
      const factor = Math.exp(-deltaY * 0.0015);
      const t = transformRef.current;
      const nextScale = Math.max(
        MIN_SCALE,
        Math.min(MAX_SCALE, t.scale * factor),
      );
      const realFactor = nextScale / t.scale;
      // Keep the point under the cursor fixed while scaling.
      const nextTx = mx - (mx - t.tx) * realFactor;
      const nextTy = my - (my - t.ty) * realFactor;
      setTransform({ tx: nextTx, ty: nextTy, scale: nextScale });
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      svg.removeEventListener('wheel', onWheel);
    };
  }, []);

  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent<SVGElement>) => {
      // Left button only
      if (e.button !== 0) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      panRef.current = {
        startX: e.clientX - rect.left,
        startY: e.clientY - rect.top,
        startTx: transformRef.current.tx,
        startTy: transformRef.current.ty,
        moved: false,
      };
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* no-op */
      }
    },
    [],
  );

  const onBackgroundPointerMove = useCallback(
    (e: ReactPointerEvent<SVGElement>) => {
      const pan = panRef.current;
      if (!pan) return;
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const dx = x - pan.startX;
      const dy = y - pan.startY;
      if (!pan.moved && Math.hypot(dx, dy) > PAN_THRESHOLD) {
        pan.moved = true;
      }
      if (pan.moved) {
        setTransform((t) => ({
          ...t,
          tx: pan.startTx + dx,
          ty: pan.startTy + dy,
        }));
      }
    },
    [],
  );

  const onBackgroundPointerUp = useCallback(
    (e: ReactPointerEvent<SVGElement>) => {
      const pan = panRef.current;
      if (!pan) return;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* no-op */
      }
      lastWasPanRef.current = pan.moved;
      panRef.current = null;
    },
    [],
  );

  const screenToWorld = useCallback((sx: number, sy: number) => {
    const t = transformRef.current;
    return { x: (sx - t.tx) / t.scale, y: (sy - t.ty) / t.scale };
  }, []);

  const worldToScreen = useCallback((wx: number, wy: number) => {
    const t = transformRef.current;
    return { x: wx * t.scale + t.tx, y: wy * t.scale + t.ty };
  }, []);

  const zoomBy = useCallback(
    (factor: number, centerX?: number, centerY?: number) => {
      const t = transformRef.current;
      const cx = centerX ?? width / 2;
      const cy = centerY ?? height / 2;
      const nextScale = Math.max(
        MIN_SCALE,
        Math.min(MAX_SCALE, t.scale * factor),
      );
      const realFactor = nextScale / t.scale;
      const nextTx = cx - (cx - t.tx) * realFactor;
      const nextTy = cy - (cy - t.ty) * realFactor;
      setTransform({ tx: nextTx, ty: nextTy, scale: nextScale });
    },
    [width, height],
  );

  const reset = useCallback(() => {
    setTransform({ tx: 0, ty: 0, scale: 1 });
  }, []);

  const fitToBounds = useCallback(
    (bounds: { minX: number; minY: number; maxX: number; maxY: number }, padding = 60) => {
      const bw = bounds.maxX - bounds.minX + padding * 2;
      const bh = bounds.maxY - bounds.minY + padding * 2;
      if (bw <= 0 || bh <= 0) return;
      const scale = Math.min(width / bw, height / bh, 0.85);
      const cx = (bounds.minX + bounds.maxX) / 2;
      const cy = (bounds.minY + bounds.maxY) / 2;
      setTransform({
        tx: width / 2 - cx * scale,
        ty: height / 2 - cy * scale,
        scale,
      });
    },
    [width, height],
  );

  const consumeLastPan = useCallback(() => {
    const v = lastWasPanRef.current;
    lastWasPanRef.current = false;
    return v;
  }, []);

  return {
    transform,
    svgRef,
    onBackgroundPointerDown,
    onBackgroundPointerMove,
    onBackgroundPointerUp,
    screenToWorld,
    worldToScreen,
    zoomBy,
    reset,
    fitToBounds,
    consumeLastPan,
  };
}
