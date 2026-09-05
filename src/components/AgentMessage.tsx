import { useState, useEffect, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import { ShieldAlert, ThumbsUp, ThumbsDown, Copy, Check } from 'lucide-react';
import { ChatMessage } from '../types';
import { cn } from '../lib/utils';
import { ReasoningVisualization } from './ReasoningVisualization';
import { SourceList } from './SourceList';

export function AgentMessage({ message, onStreamComplete, onFeedback }: { message: ChatMessage, onStreamComplete?: (id: string) => void, onFeedback?: (id: string, rating: 'up' | 'down' | null) => void }) {
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(message.feedback || null);
  // Only used for the typewriter-reveal case; an already-streamed message
  // renders message.content directly (see displayedContent below), so this
  // effect never needs to setState just to mirror a prop it could render
  // straight from.
  const [animatedContent, setAnimatedContent] = useState('');
  const [isCopied, setIsCopied] = useState(false);
  const onStreamCompleteRef = useRef(onStreamComplete);
  useEffect(() => {
    onStreamCompleteRef.current = onStreamComplete;
  }, [onStreamComplete]);

  useEffect(() => {
    if (message.streamed || !message.content) return;

    const speed = 15;
    const chunk = 3;
    let i = 0; // the interval's own first tick paints the first frame — no synchronous setState here

    const interval = setInterval(() => {
      i += chunk;
      if (i >= message.content.length) {
        setAnimatedContent(message.content);
        clearInterval(interval);
        onStreamCompleteRef.current?.(message.id);
      } else {
        setAnimatedContent(message.content.slice(0, i));
      }
    }, speed);

    return () => clearInterval(interval);
  }, [message.content, message.streamed, message.id]);

  const displayedContent = message.streamed ? message.content : animatedContent;

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
  };

  const handleFeedback = (rating: 'up' | 'down') => {
    const next = feedback === rating ? null : rating;
    setFeedback(next);
    onFeedback?.(message.id, next);
  };

  return (
    <div className="flex w-full animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="w-full text-textMain py-2">
        {/* Unverified Badge */}
        {message.unverified && (
          <div className="flex items-center gap-1.5 text-warning text-xs font-medium mb-3">
            <ShieldAlert size={14} />
            Unverified — treat with caution
          </div>
        )}

        {/* Message Body */}
        <div className="prose prose-invert prose-p:text-textMain max-w-none text-base leading-relaxed">
          <ReactMarkdown>{displayedContent}</ReactMarkdown>
        </div>

        {message.citations && message.citations.length > 0 && displayedContent.length >= message.content.length && (
          <SourceList sources={message.citations} />
        )}

        {/* Bottom Actions Row: Reasoning Trace Toggle & Feedback */}
        {displayedContent.length >= message.content.length && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
            {message.reasoning ? (
              <div className="flex-1 min-w-0">
                <ReasoningVisualization reasoning={message.reasoning} graphTrace={message.graphTrace} unverified={message.unverified} />
              </div>
            ) : <div className="flex-1 min-w-0" />}

            {/* Feedback Buttons */}
            <div className="flex items-center gap-1">
              <button 
                onClick={handleCopy}
                className="p-1.5 rounded-md transition-colors text-textMuted hover:text-textMain hover:bg-surfaceHover"
                title="Copy to clipboard"
              >
                {isCopied ? <Check size={14} className="text-green-500" /> : <Copy size={14} />}
              </button>
              <button
                onClick={() => handleFeedback('up')}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  feedback === 'up' ? "bg-primary/20 text-primary" : "text-textMuted hover:text-textMain hover:bg-surfaceHover"
                )}
                title="Good response"
              >
                <ThumbsUp size={14} />
              </button>
              <button
                onClick={() => handleFeedback('down')}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  feedback === 'down' ? "bg-red-500/20 text-red-500" : "text-textMuted hover:text-textMain hover:bg-surfaceHover"
                )}
                title="Poor response"
              >
                <ThumbsDown size={14} />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
