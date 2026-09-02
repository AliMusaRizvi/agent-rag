import { X, Compass, MessageCircleQuestion, Paperclip, ShieldCheck, Sparkles, Sliders } from 'lucide-react';

interface GuideModalProps {
  onClose: () => void;
  onTryQuestion: (question: string) => void;
}

const TRY_QUESTIONS = [
  "What is GitLab's remote work policy?",
  "What are GitLab's core values?",
  'How do I file a hardware replacement ticket?',
];

// A client-facing "how to use this" guide — separate from developer docs.
// Shown automatically on a visitor's very first load (see App.tsx), and
// reopenable any time from the header. Written for someone evaluating this
// as a demo, not someone reading the source code.
export function GuideModal({ onClose, onTryQuestion }: GuideModalProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
      <div className="bg-surface border border-border/60 rounded-2xl shadow-2xl w-full max-w-lg overflow-hidden animate-in zoom-in-95 duration-200 max-h-[85vh] flex flex-col">
        <div className="flex items-center justify-between p-4 border-b border-border/60 flex-none">
          <h2 className="font-semibold text-textMain flex items-center gap-2">
            <Compass size={18} className="text-primary" />
            Getting started
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 text-textMuted hover:text-textMain hover:bg-surfaceHover rounded-md transition-colors"
          >
            <X size={18} />
          </button>
        </div>

        <div className="p-6 space-y-6 overflow-y-auto custom-scrollbar">
          <p className="text-sm text-textMain leading-relaxed">
            This is the <strong>Enterprise Knowledge Agent</strong> — it answers questions using
            GitLab's real, public employee handbook as its knowledge base. Every answer links back
            to the source it came from, and if it isn't confident it found the right information,
            it will say so instead of guessing.
          </p>

          <div>
            <h3 className="text-xs font-semibold text-textMuted uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <MessageCircleQuestion size={13} /> Try asking
            </h3>
            <div className="space-y-2">
              {TRY_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => { onTryQuestion(q); onClose(); }}
                  className="w-full text-left px-3.5 py-2.5 rounded-lg bg-background border border-border hover:border-primary/50 hover:bg-surfaceHover transition-colors text-sm text-textMain"
                >
                  {q}
                </button>
              ))}
            </div>
            <p className="text-xs text-textMuted mt-2">
              Follow-up questions work naturally too — e.g. ask about remote work, then just ask
              "what about contractors?" and it'll understand what you mean.
            </p>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-textMuted uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Sparkles size={13} /> What it can do
            </h3>
            <ul className="space-y-2 text-sm text-textMain">
              <li className="flex gap-2">
                <span className="text-primary">&bull;</span>
                <span>Answer questions from the handbook, with clickable sources under every answer.</span>
              </li>
              <li className="flex gap-2">
                <Paperclip size={14} className="text-primary flex-shrink-0 mt-0.5" />
                <span>Answer questions about your own document — attach a PDF, Word file, or text file with the paperclip icon, and it's only visible to you.</span>
              </li>
              <li className="flex gap-2">
                <ShieldCheck size={14} className="text-primary flex-shrink-0 mt-0.5" />
                <span>File a real GitHub issue if you explicitly ask it to ("File a bug: ...") — it always shows you exactly what it's about to create and waits for your approval first.</span>
              </li>
            </ul>
          </div>

          <div>
            <h3 className="text-xs font-semibold text-textMuted uppercase tracking-wider mb-3 flex items-center gap-1.5">
              <Sliders size={13} /> Worth knowing
            </h3>
            <ul className="space-y-2 text-sm text-textMuted">
              <li>Specific questions get better answers than vague ones — if it can't find a confident match, it'll tell you rather than make something up.</li>
              <li>Click "View reasoning process" under any answer to see exactly what it retrieved and how it double-checked itself before answering.</li>
              <li>Open Settings (the sliders icon) to change its tone, or give it a custom system prompt.</li>
            </ul>
          </div>
        </div>

        <div className="p-4 border-t border-border/60 flex justify-end flex-none">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-primary hover:bg-primaryHover text-white text-sm font-medium rounded-lg transition-colors"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
