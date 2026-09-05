import {
  Route, Search, ListFilter, Scale, RefreshCw, Sparkles, BadgeCheck,
  ShieldCheck, ShieldAlert, MessageCircle, Ban, FileEdit, Send,
} from 'lucide-react';

// Shared presentation layer for LangGraph node names. Used by both the
// live progress panel (while a turn is running) and the execution-path
// panel (after it finishes), so a node can't end up labelled one way
// mid-flight and a different way in the trace.
export const NODE_META: Record<string, { label: string; icon: typeof Route }> = {
  router: { label: 'Understanding the question', icon: Route },
  retrieve: { label: 'Searching the handbook', icon: Search },
  rerank: { label: 'Ranking the best matches', icon: ListFilter },
  grade: { label: 'Checking if that answers it', icon: Scale },
  rewriteQuery: { label: 'Rephrasing the search', icon: RefreshCw },
  generate: { label: 'Writing the answer', icon: Sparkles },
  verifyCitations: { label: 'Verifying citations', icon: BadgeCheck },
  checkGroundedness: { label: 'Fact-checking against sources', icon: ShieldCheck },
  incrementRegenerate: { label: 'Trying again', icon: RefreshCw },
  markUnverified: { label: 'Flagging as unverified', icon: ShieldAlert },
  refusal: { label: 'No confident answer found', icon: ShieldAlert },
  blocked: { label: 'Blocked', icon: Ban },
  chatReply: { label: 'Replying', icon: MessageCircle },
  prepareTool: { label: 'Preparing the action', icon: FileEdit },
  executeTool: { label: 'Running the action', icon: Send },
};

export function nodeMeta(node: string) {
  return NODE_META[node] || { label: node, icon: Route };
}

// A one-line summary of what a node actually did, pulled from the detail it
// recorded — never a generic restatement of the node's own name.
export function nodeHeadline(node: string, detail: Record<string, any> | null | undefined): string | null {
  const d = detail || {};
  switch (node) {
    case 'router':
      return d.route ? `route: ${d.route}${d.modelUsed ? ` · ${d.modelUsed}` : ''}` : null;
    case 'retrieve':
      return d.candidates != null ? `${d.candidates} candidates` : null;
    case 'rerank':
      return d.topScore != null ? `top match ${Math.round(d.topScore * 100)}%` : (d.kept != null ? `kept ${d.kept}` : null);
    case 'grade':
      return d.sufficient == null ? null : (d.sufficient ? 'enough context' : 'not enough context');
    case 'rewriteQuery':
      return d.rewritten ? `"${d.rewritten}"` : null;
    case 'generate':
      return d.modelUsed || null;
    case 'verifyCitations':
      return d.dropped > 0 ? `${d.kept} kept, ${d.dropped} dropped` : (d.kept != null ? `${d.kept} verified` : null);
    case 'checkGroundedness':
      return d.grounded == null ? null : (d.grounded ? 'grounded' : 'unsupported claims found');
    case 'executeTool':
      return d.approved ? (d.result?.success ? 'created' : 'failed') : 'denied';
    default:
      return null;
  }
}
