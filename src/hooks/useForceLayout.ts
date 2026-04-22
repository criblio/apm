/**
 * Shared d3-force simulation driver for the System Architecture views.
 *
 * Both DependencyGraph (2D) and IsometricGraph (projected) consume the
 * same simulation so that switching views preserves the layout and so
 * dragging a node in one view reflects in the other when the user swaps
 * modes.
 *
 * Responsibilities:
 *  - Own the forceSimulation lifecycle (create on mount + param change,
 *    stop on unmount).
 *  - Expose refs to the live SimNode / SimLink arrays (d3 mutates them
 *    in place each tick).
 *  - Expose a `tick` counter that bumps each tick, so rendering React
 *    components can subscribe to it via their own useState and re-render.
 *  - Expose pinNode / releaseNode helpers for drag behavior.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  forceSimulation,
  forceManyBody,
  forceLink,
  forceCenter,
  forceCollide,
  type Simulation,
  type SimulationNodeDatum,
  type SimulationLinkDatum,
} from 'd3-force';

export interface SimNode extends SimulationNodeDatum {
  id: string;
  size: number;
}

export interface SimLink extends SimulationLinkDatum<SimNode> {
  /** Call count aggregated on this edge. */
  value: number;
  /** Error count on this edge. */
  errorCount: number;
  /** p95 latency (μs) of the child span on this edge. */
  p95DurUs: number;
  /** Edge kind — 'rpc' (parent→child span) or 'messaging' (kafka etc.). */
  kind: 'rpc' | 'messaging';
  /** Topic name for messaging edges, undefined for rpc. */
  topic?: string;
}

interface Options {
  nodes: SimNode[];
  links: SimLink[];
  width: number;
  height: number;
  nodeRadius: (n: SimNode) => number;
}

export interface UseForceLayoutResult {
  simNodesRef: React.MutableRefObject<SimNode[]>;
  simLinksRef: React.MutableRefObject<SimLink[]>;
  /** Bumped by 1 on each simulation tick — consumers re-render via it. */
  tick: number;
  /** Pin a node at (x, y) in world coordinates. Used while dragging. */
  pinNode: (id: string, x: number, y: number) => void;
  /** Clear a node's pinned position so physics can move it again. */
  releaseNode: (id: string) => void;
  /** Give the simulation a kick so pinned updates settle visibly. */
  reheat: (alpha?: number) => void;
}

export function useForceLayout({
  nodes,
  links,
  width,
  height,
  nodeRadius,
}: Options): UseForceLayoutResult {
  const simNodesRef = useRef<SimNode[]>([]);
  const simLinksRef = useRef<SimLink[]>([]);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const [tick, setTick] = useState(0);

  useEffect(() => {
    // Preserve positions from the previous simulation so data refreshes
    // don't randomize the layout. Only genuinely new nodes start at the
    // center; existing nodes keep their settled x/y.
    const prevById = new Map<string, SimNode>();
    for (const n of simNodesRef.current) prevById.set(n.id, n);

    const simNodes: SimNode[] = nodes.map((n) => {
      const prev = prevById.get(n.id);
      if (prev) {
        return { ...n, x: prev.x, y: prev.y, vx: 0, vy: 0 };
      }
      return { ...n };
    });
    const simLinks: SimLink[] = links.map((l) => ({ ...l }));

    const hadPrevious = prevById.size > 0;
    const existingNodeCount = simNodes.filter((n) => prevById.has(n.id)).length;
    const isStructuralChange = !hadPrevious || existingNodeCount < simNodes.length;

    simNodesRef.current = simNodes;
    simLinksRef.current = simLinks;

    if (simRef.current) {
      simRef.current.stop();
    }

    const sim = forceSimulation<SimNode>(simNodes)
      .force(
        'link',
        forceLink<SimNode, SimLink>(simLinks)
          .id((d) => d.id)
          .distance(200)
          .strength(0.4),
      )
      .force('charge', forceManyBody().strength(-1000).distanceMax(600))
      .force('center', forceCenter(width / 2, height / 2).strength(0.05))
      .force(
        'collision',
        forceCollide<SimNode>().radius((d) => nodeRadius(d) + 14).strength(1),
      )
      .alphaDecay(0.03)
      .on('tick', () => {
        setTick((t) => t + 1);
      });

    // When only data changed (same nodes, updated metrics), start nearly
    // cooled so the graph barely moves. Only do a full warm start when
    // the topology actually changed (new/removed nodes).
    if (hadPrevious && !isStructuralChange) {
      sim.alpha(0.05);
    }

    simRef.current = sim;
    return () => {
      sim.stop();
      simRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, links, width, height]);

  const pinNode = useCallback((id: string, x: number, y: number) => {
    const n = simNodesRef.current.find((node) => node.id === id);
    if (!n) return;
    n.fx = x;
    n.fy = y;
    // Keep the sim warm while dragging so collision with neighbors
    // pushes them out of the way in real time.
    if (simRef.current && simRef.current.alpha() < 0.2) {
      simRef.current.alpha(0.3).restart();
    }
  }, []);

  const releaseNode = useCallback((id: string) => {
    const n = simNodesRef.current.find((node) => node.id === id);
    if (!n) return;
    n.fx = null;
    n.fy = null;
  }, []);

  const reheat = useCallback((alpha: number = 0.3) => {
    simRef.current?.alpha(alpha).restart();
  }, []);

  return {
    simNodesRef,
    simLinksRef,
    tick,
    pinNode,
    releaseNode,
    reheat,
  };
}
