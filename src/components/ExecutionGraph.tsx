import { useState } from 'react';
import {
  Route, Search, ListFilter, ScaleIcon, RefreshCw, Sparkles, BadgeCheck,
  ShieldCheck, ShieldAlert, MessageCircle, Ban, FileEdit, Send, ChevronDown,
} from 'lucide-react';
import { GraphTrace, GraphTraceStep } from '../types';
import { cn } from '../lib/utils';

interface ExecutionGraphProps {
  graphTrace: GraphTrace;
}

const NODE_META: Record<string, { label: string; icon: typeof Route }> = {
  router: { label: 'Route', icon: Route },
  retrieve: { label: 'Retrieve', icon: Search },
  rerank: { label: 'Rerank', icon: ListFilter },
  grade: { label: 'Grade context', icon: ScaleIcon },
  rewriteQuery: { label: 'Rewrite query', icon: RefreshCw },
  generate: { label: 'Generate', icon: Sparkles },
  verifyCitations: { label: 'Verify citations', icon: BadgeCheck },
  checkGroundedness: { label: 'Check groundedness', icon: ShieldCheck },
  incrementRegenerate: { label: 'Regenerate', icon: RefreshCw },
  markUnverified: { label: 'Mark unverified', icon: ShieldAlert },
  refusal: { label: 'Refuse', icon: ShieldAlert },
  blocked: { label: 'Blocked', icon: Ban },
  chatReply: { label: 'Reply', icon: MessageCircle },
  prepareTool: { label: 'Prepare action', icon: FileEdit },
  executeTool: { label: 'Execute action', icon: Send },
};

// Real, node-specific detail worth surfacing at a glance — pulled straight
// from what that node actually wrote to state, not a generic re-statement
// of the node name.
function stepHeadline(step: GraphTraceStep): string | null {
  const d = step.detail as Record<string, any>;
  switch (step.node) {
    case 'router':
      return `→ ${d.route}${d.modelUsed ? ` · ${d.modelUsed}` : ''}`;
    case 'retrieve':
      return `${d.candidates} candidates`;
    case 'rerank':
      return d.topScore != null ? `top score ${(d.topScore * 100).toFixed(0)}%` : `kept ${d.kept}`;
    case 'grade':
      return d.sufficient ? 'sufficient' : 'insufficient';
    case 'rewriteQuery':
      return d.rewritten ? `"${d.rewritten}"` : null;
    case 'generate':
      return d.modelUsed || null;
    case 'verifyCitations':
      return d.dropped > 0 ? `${d.kept} kept, ${d.dropped} dropped` : `${d.kept} verified`;
    case 'checkGroundedness':
      return d.grounded ? 'grounded' : 'not grounded';
    case 'executeTool':
      return d.approved ? (d.result?.success ? 'created' : 'failed') : 'denied';
    default:
      return null;
  }
}

function StepDetail({ step }: { step: GraphTraceStep }) {
  const entries = Object.entries(step.detail).filter(([, v]) => v !== null && v !== undefined && v !== '');
  if (entries.length === 0) return <p className="text-textMuted">No additional detail recorded for this step.</p>;
  return (
    <dl className="space-y-1">
      {entries.map(([key, value]) => (
        <div key={key} className="flex gap-2">
          <dt className="text-textMuted shrink-0">{key}:</dt>
          <dd className="text-textMain break-words">{typeof value === 'object' ? JSON.stringify(value) : String(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

// A real, ordered rendering of the actual LangGraph run — not a static
// diagram of the graph's possible shape. When a loop fires (a rewrite or a
// regenerate pass), the node it looped through for real appears twice in
// sequence with a step-number badge, which is more honest than collapsing
// it into a single box with a "×2" annotation would be: a reviewer can
// literally count the repeated nodes and see the loop actually ran.
export function ExecutionGraph({ graphTrace }: ExecutionGraphProps) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);

  if (!graphTrace?.steps?.length) return null;

  return (
    <div className="w-full">
      <div className="flex items-center gap-1.5 overflow-x-auto pb-2 custom-scrollbar">
        {graphTrace.steps.map((step, idx) => {
          const meta = NODE_META[step.node] || { label: step.node, icon: Route };
          const Icon = meta.icon;
          const headline = stepHeadline(step);
          const isLoopRepeat = graphTrace.steps.findIndex((s) => s.node === step.node) !== idx;
          const isOpen = openIndex === idx;
          return (
            <div key={idx} className="flex items-center gap-1.5 shrink-0">
              {idx > 0 && <div className="w-4 h-px bg-border shrink-0" aria-hidden="true" />}
              <button
                onClick={() => setOpenIndex(isOpen ? null : idx)}
                className={cn(
                  'flex flex-col items-start gap-0.5 px-2.5 py-1.5 rounded-lg border text-left transition-colors shrink-0',
                  isOpen ? 'bg-primary/10 border-primary/40' : 'bg-surface border-border/60 hover:border-border hover:bg-surfaceHover',
                )}
              >
                <span className="flex items-center gap-1.5 text-xs font-medium text-textMain whitespace-nowrap">
                  <Icon size={12} className={isOpen ? 'text-primary' : 'text-textMuted'} />
                  {meta.label}
                  {isLoopRepeat && (
                    <span className="text-[9px] font-bold text-warning bg-warningBg px-1 rounded">
                      #{graphTrace.steps.slice(0, idx + 1).filter((s) => s.node === step.node).length}
                    </span>
                  )}
                </span>
                {headline && <span className="text-[10px] text-textMuted whitespace-nowrap max-w-[160px] truncate">{headline}</span>}
              </button>
            </div>
          );
        })}
      </div>

      {openIndex !== null && (
        <div className="mt-2 p-3 rounded-lg bg-surface/50 border border-border/50 text-xs animate-in fade-in slide-in-from-top-1 duration-150">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-textMain">
              {(NODE_META[graphTrace.steps[openIndex].node] || { label: graphTrace.steps[openIndex].node }).label}
            </span>
            <button onClick={() => setOpenIndex(null)} className="text-textMuted hover:text-textMain">
              <ChevronDown size={14} className="rotate-180" />
            </button>
          </div>
          <StepDetail step={graphTrace.steps[openIndex]} />
        </div>
      )}
    </div>
  );
}
