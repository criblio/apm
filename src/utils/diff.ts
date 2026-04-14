/**
 * Structural diff between two Jaeger traces.
 *
 * Each span is reduced to a stable signature (service + operation name)
 * and the trees are walked simultaneously, marking each rendered row as:
 *   - 'both'   present in both traces at the same tree position
 *   - 'left'   present only in trace A
 *   - 'right'  present only in trace B
 *
 * This is what Jaeger's Compare view calls a "structural diff" — it
 * doesn't try to do exact span-id matching; it diffs the call shape.
 */
import type { JaegerTrace, JaegerSpan } from '../api/types';
import { buildTimeline, type SpanNode } from './spans';

export type DiffMark = 'both' | 'left' | 'right';

export interface DiffRow {
  mark: DiffMark;
  depth: number;
  service: string;
  operationName: string;
  /** μs durations from each side; null if absent on that side. */
  leftDurationUs: number | null;
  rightDurationUs: number | null;
  leftSpan: JaegerSpan | null;
  rightSpan: JaegerSpan | null;
}

interface IndexedNode {
  node: SpanNode;
  service: string;
  signature: string;
  children: IndexedNode[];
}

/** Build a service-tagged tree from a trace. */
function indexTrace(trace: JaegerTrace): IndexedNode[] {
  const timeline = buildTimeline(trace);
  // The timeline is already DFS-ordered with depths; rebuild a tree structure
  // by tracking parents via depth.
  const stack: IndexedNode[] = [];
  const roots: IndexedNode[] = [];
  for (const sn of timeline.nodes) {
    const proc = trace.processes[sn.span.processID];
    const service = proc?.serviceName ?? 'unknown';
    const signature = `${service}\u0000${sn.span.operationName}`;
    const node: IndexedNode = { node: sn, service, signature, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].node.depth >= sn.depth) {
      stack.pop();
    }
    if (stack.length === 0) {
      roots.push(node);
    } else {
      stack[stack.length - 1].children.push(node);
    }
    stack.push(node);
  }
  return roots;
}

/**
 * Compute the diff rows by walking both forests in parallel. Children with
 * matching signatures are paired greedily (first match wins). Unmatched
 * children become left-only or right-only rows with their full subtree.
 */
export function diffTraces(left: JaegerTrace, right: JaegerTrace): DiffRow[] {
  const leftRoots = indexTrace(left);
  const rightRoots = indexTrace(right);
  const rows: DiffRow[] = [];
  walk(leftRoots, rightRoots, 0, rows);
  return rows;
}

function walk(
  leftKids: IndexedNode[],
  rightKids: IndexedNode[],
  depth: number,
  out: DiffRow[],
) {
  // Greedy pair: for each left child, find the first unmatched right child
  // with the same signature. Anything left over is unilateral.
  const rightMatched = new Array(rightKids.length).fill(false);

  for (const l of leftKids) {
    let pairedIdx = -1;
    for (let i = 0; i < rightKids.length; i++) {
      if (rightMatched[i]) continue;
      if (rightKids[i].signature === l.signature) {
        pairedIdx = i;
        break;
      }
    }
    if (pairedIdx >= 0) {
      const r = rightKids[pairedIdx];
      rightMatched[pairedIdx] = true;
      out.push({
        mark: 'both',
        depth,
        service: l.service,
        operationName: l.node.span.operationName,
        leftDurationUs: l.node.span.duration,
        rightDurationUs: r.node.span.duration,
        leftSpan: l.node.span,
        rightSpan: r.node.span,
      });
      walk(l.children, r.children, depth + 1, out);
    } else {
      emitSubtree(l, depth, 'left', out);
    }
  }

  for (let i = 0; i < rightKids.length; i++) {
    if (rightMatched[i]) continue;
    emitSubtree(rightKids[i], depth, 'right', out);
  }
}

function emitSubtree(node: IndexedNode, depth: number, side: 'left' | 'right', out: DiffRow[]) {
  out.push({
    mark: side,
    depth,
    service: node.service,
    operationName: node.node.span.operationName,
    leftDurationUs: side === 'left' ? node.node.span.duration : null,
    rightDurationUs: side === 'right' ? node.node.span.duration : null,
    leftSpan: side === 'left' ? node.node.span : null,
    rightSpan: side === 'right' ? node.node.span : null,
  });
  for (const c of node.children) {
    emitSubtree(c, depth + 1, side, out);
  }
}
