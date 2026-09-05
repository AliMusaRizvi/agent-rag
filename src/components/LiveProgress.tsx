import { useEffect, useState } from 'react';
import { Check, Loader2 } from 'lucide-react';
import { nodeMeta, nodeHeadline } from '../lib/graphNodes';
import { cn } from '../lib/utils';

export interface LiveStep {
  node: string;
  detail: Record<string, unknown> | null;
}

// Shows the agent's real progress while a turn runs. Every row here comes
// from an actual LangGraph node that finished executing on the server and
// streamed an event — nothing is a scripted or time-based estimate, so if
// the pipeline loops back to re-search, that genuinely shows up as a
// repeated step rather than a progress bar quietly moving forward.
export function LiveProgress({ steps }: { steps: LiveStep[] }) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const started = Date.now();
    const id = setInterval(() => setElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="animate-in fade-in slide-in-from-bottom-2 duration-300 rounded-2xl border border-border/60 bg-surface/40 p-4">
      <div className="mb-3 flex items-center justify-between">
        <span className="flex items-center gap-2 text-sm font-medium text-textMain">
          <Loader2 size={14} className="animate-spin text-primary" />
          Working on it
        </span>
        <span className="tabular-nums text-xs text-textMuted">{elapsed}s</span>
      </div>

      <ol className="flex flex-col gap-2">
        {steps.map((step, i) => {
          const meta = nodeMeta(step.node);
          const Icon = meta.icon;
          const headline = nodeHeadline(step.node, step.detail);
          const isCurrent = i === steps.length - 1;
          return (
            <li
              key={`${step.node}-${i}`}
              className="flex items-start gap-2.5 text-xs animate-in fade-in slide-in-from-left-1 duration-200"
            >
              <span
                className={cn(
                  'mt-px flex h-4 w-4 flex-none items-center justify-center rounded-full',
                  isCurrent ? 'bg-primary/15 text-primary' : 'bg-green-500/15 text-green-500',
                )}
              >
                {isCurrent ? <Icon size={10} /> : <Check size={10} strokeWidth={3} />}
              </span>
              <span className="min-w-0">
                <span className={cn('font-medium', isCurrent ? 'text-textMain' : 'text-textMuted')}>
                  {meta.label}
                </span>
                {headline && <span className="ml-1.5 text-textMuted/80">{headline}</span>}
              </span>
            </li>
          );
        })}

        {steps.length === 0 && (
          <li className="text-xs text-textMuted">Starting…</li>
        )}
      </ol>
    </div>
  );
}
