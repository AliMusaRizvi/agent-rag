import { Quote, ShieldCheck, GitBranch } from 'lucide-react';

interface EmptyStateProps {
  onSelectQuestion: (question: string) => void;
}

// Each example demonstrates a different behavior rather than just filling
// the grid — a plain lookup, a synthesis across pages, a process question
// that *looks* like an action request but isn't, and a genuine action
// request that does trigger the human-approval gate. Clicking through all
// four shows the routing logic working without anyone explaining it.
const EXAMPLES = [
  { text: "What are GitLab's core values?", hint: 'Straight lookup, cited' },
  { text: "What is GitLab's approach to remote work?", hint: 'Synthesized across pages' },
  { text: 'How do I file a hardware replacement ticket?', hint: 'Explains the process — does not act' },
  { text: 'File a bug: the onboarding docs link is broken.', hint: 'A real action — asks you first' },
];

const TRAITS = [
  { icon: Quote, label: 'Every claim cited to a real page' },
  { icon: ShieldCheck, label: 'Says "I don\'t know" over guessing' },
  { icon: GitBranch, label: 'Shows the reasoning it actually used' },
];

export function EmptyState({ onSelectQuestion }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-4 py-10 text-center animate-in fade-in duration-700">
      <div className="mb-5 flex h-12 w-12 items-center justify-center rounded-2xl bg-primary/10">
        {/* The same three-connected-nodes mark as the favicon — the graph
            this agent actually runs on. */}
        <svg viewBox="0 0 32 32" className="h-6 w-6" aria-hidden="true">
          <line x1="16" y1="9" x2="9" y2="21" className="stroke-primary" strokeWidth="1.8" />
          <line x1="16" y1="9" x2="23" y2="21" className="stroke-primary" strokeWidth="1.8" />
          <line x1="9" y1="21" x2="23" y2="21" className="stroke-primary" strokeWidth="1.8" />
          <circle cx="16" cy="9" r="3.4" className="fill-primary" />
          <circle cx="9" cy="21" r="3.4" className="fill-primary" />
          <circle cx="23" cy="21" r="3.4" className="fill-primary" />
        </svg>
      </div>

      <h2 className="mb-2 text-2xl font-semibold tracking-tight text-textMain">Ask the handbook anything</h2>
      <p className="mb-6 max-w-md text-sm leading-relaxed text-textMuted">
        Answers come from GitLab's real public employee handbook — with the exact
        pages they came from, every time.
      </p>

      <div className="mb-8 flex flex-wrap items-center justify-center gap-x-5 gap-y-2">
        {TRAITS.map((t) => (
          <span key={t.label} className="flex items-center gap-1.5 text-xs text-textMuted">
            <t.icon size={13} className="text-primary/70" />
            {t.label}
          </span>
        ))}
      </div>

      <div className="grid w-full max-w-2xl grid-cols-1 gap-2.5 sm:grid-cols-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex.text}
            onClick={() => onSelectQuestion(ex.text)}
            className="group rounded-xl border border-border bg-surface/50 p-3.5 text-left transition-all hover:border-primary/40 hover:bg-surfaceHover"
          >
            <span className="block text-sm leading-snug text-textMain">{ex.text}</span>
            <span className="mt-1.5 block text-[11px] text-textMuted transition-colors group-hover:text-primary/80">
              {ex.hint}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
