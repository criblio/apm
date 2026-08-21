/**
 * APM-typed wrapper over the shared d3-force simulation driver
 * (@criblio/app-utils/graph, extracted from this app). The generic hook
 * owns the physics/lifecycle; this file pins the APM datum types so
 * DependencyGraph and IsometricGraph keep their existing contracts.
 */
import {
  useForceLayout as useForceLayoutGeneric,
  type ForceNode,
  type UseForceLayoutResult as GenericResult,
} from '@criblio/app-utils/graph';
import type { SimulationLinkDatum } from 'd3-force';

export interface SimNode extends ForceNode {
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

export type UseForceLayoutResult = GenericResult<SimNode, SimLink>;

export function useForceLayout(options: Options): UseForceLayoutResult {
  return useForceLayoutGeneric<SimNode, SimLink>(options);
}
