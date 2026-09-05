import { useState } from 'react';
import { ExternalLink, ChevronDown } from 'lucide-react';
import { Citation } from '../types';
import { cn } from '../lib/utils';

// Sources used to render as a row of tiny pills — a title and a bare
// percentage, with the snippet hidden in a title attribute nobody hovers.
// For a system whose whole claim is "every answer is traceable to a real
// document", that undersold the most important evidence on screen.
//
// Cited sources now get numbered cards with a readable excerpt and a
// visible relevance bar. Sources that were retrieved and considered but
// NOT cited stay available behind a disclosure rather than being hidden
// (what the model saw and chose not to use is real transparency) or given
// equal weight to what actually backs the answer.
function relevanceLabel(score: number) {
  if (score >= 0.75) return { text: 'strong match', tone: 'text-green-500' };
  if (score >= 0.45) return { text: 'partial match', tone: 'text-amber-500' };
  return { text: 'weak match', tone: 'text-textMuted' };
}

function SourceCard({ source, index, dimmed }: { source: Citation; index?: number; dimmed?: boolean }) {
  const score = typeof source.score === 'number' ? Math.max(0, Math.min(1, source.score)) : null;
  const rel = score != null ? relevanceLabel(score) : null;

  return (
    <a
      href={source.url}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(
        'group block rounded-xl border p-3 transition-colors',
        dimmed
          ? 'border-border/40 bg-transparent hover:bg-surfaceHover/50'
          : 'border-border/70 bg-surface/40 hover:bg-surfaceHover hover:border-border',
      )}
    >
      <div className="flex items-start gap-2.5">
        {index != null && (
          <span className="mt-0.5 flex h-5 w-5 flex-none items-center justify-center rounded-md bg-primary/10 text-[11px] font-semibold tabular-nums text-primary">
            {index}
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-2">
            <span className={cn('text-sm font-medium leading-snug', dimmed ? 'text-textMuted' : 'text-textMain')}>
              {source.title}
            </span>
            <ExternalLink size={13} className="mt-0.5 flex-none text-textMuted opacity-0 transition-opacity group-hover:opacity-100" />
          </div>

          {source.snippet && (
            <p className="mt-1.5 line-clamp-2 text-xs leading-relaxed text-textMuted">
              {source.snippet.replace(/\s+/g, ' ').trim()}
            </p>
          )}

          {score != null && rel && (
            <div className="mt-2 flex items-center gap-2">
              <div className="h-1 w-16 overflow-hidden rounded-full bg-border/60">
                <div
                  className={cn('h-full rounded-full', score >= 0.75 ? 'bg-green-500' : score >= 0.45 ? 'bg-amber-500' : 'bg-textMuted')}
                  style={{ width: `${Math.round(score * 100)}%` }}
                />
              </div>
              <span className={cn('text-[10px]', rel.tone)}>{rel.text}</span>
            </div>
          )}
        </div>
      </div>
    </a>
  );
}

export function SourceList({ sources }: { sources: Citation[] }) {
  const [showOthers, setShowOthers] = useState(false);
  if (!sources.length) return null;

  // `cited` is set by the server per source. Older saved threads predate
  // that field entirely — treating undefined as "cited" keeps them
  // rendering as they always did instead of collapsing them all away.
  const cited = sources.filter((s) => s.cited !== false);
  const others = sources.filter((s) => s.cited === false);

  return (
    <div className="mt-5">
      <div className="mb-2.5 flex items-baseline gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-textMuted">
          {cited.length > 0 ? `${cited.length} source${cited.length === 1 ? '' : 's'} cited` : 'Sources considered'}
        </span>
      </div>

      <div className="flex flex-col gap-2">
        {cited.map((s, i) => (
          <SourceCard key={s.chunkId ?? `cited-${i}`} source={s} index={i + 1} />
        ))}
      </div>

      {others.length > 0 && (
        <div className="mt-2">
          <button
            onClick={() => setShowOthers(!showOthers)}
            className="flex items-center gap-1.5 rounded-md px-1 py-1 text-[11px] text-textMuted transition-colors hover:text-textMain"
          >
            <ChevronDown size={12} className={cn('transition-transform duration-200', showOthers && 'rotate-180')} />
            {showOthers ? 'Hide' : `${others.length} more considered but not cited`}
          </button>
          {showOthers && (
            <div className="mt-2 flex flex-col gap-2 animate-in fade-in slide-in-from-top-1 duration-200">
              {others.map((s, i) => (
                <SourceCard key={s.chunkId ?? `other-${i}`} source={s} dimmed />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
