import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { GraphTrace, GraphTraceStep } from '../types';
import { cn } from '../lib/utils';
import { nodeMeta, nodeHeadline } from '../lib/graphNodes';

interface ExecutionGraphProps {
  graphTrace: GraphTrace;
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
          const meta = nodeMeta(step.node);
          const Icon = meta.icon;
          const headline = nodeHeadline(step.node, step.detail as Record<string, unknown>);
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
              {nodeMeta(graphTrace.steps[openIndex].node).label}
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
