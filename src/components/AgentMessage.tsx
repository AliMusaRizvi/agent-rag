import React, { useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import { ChevronDown, ExternalLink, ShieldAlert, Sparkles, ThumbsUp, ThumbsDown, Copy, Check } from 'lucide-react';
import { ChatMessage } from '../types';
import { cn } from '../lib/utils';
import { ReasoningVisualization } from './ReasoningVisualization';

export function AgentMessage({ message, onStreamComplete }: { message: ChatMessage, onStreamComplete?: (id: string) => void }) {
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(message.feedback || null);
  const [displayedContent, setDisplayedContent] = useState(message.streamed ? message.content : '');
  const [isCopied, setIsCopied] = useState(false);

  useEffect(() => {
    if (message.streamed || !message.content) {
      setDisplayedContent(message.content);
      return;
    }

    let i = 0;
    const speed = 15;
    const chunk = 3;
    
    const interval = setInterval(() => {
      setDisplayedContent(message.content.slice(0, i));
      i += chunk;
      if (i >= message.content.length) {
        setDisplayedContent(message.content);
        clearInterval(interval);
        if (onStreamComplete) onStreamComplete(message.id);
      }
    }, speed);

    return () => clearInterval(interval);
  }, [message.content, message.streamed, message.id]);

  const handleCopy = () => {
    navigator.clipboard.writeText(message.content);
    setIsCopied(true);
    setTimeout(() => setIsCopied(false), 2000);
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

        {/* Citations Strip */}
        {message.citations && message.citations.length > 0 && displayedContent.length >= message.content.length && (
          <div className="mt-6">
            <div className="text-[10px] uppercase tracking-wider text-textMuted mb-3 font-semibold">Sources</div>
            <div className="flex flex-wrap gap-2">
              {message.citations.map((cit, idx) => (
                <a
                  key={idx}
                  href={cit.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-border/80 hover:bg-surfaceHover transition-colors text-xs text-textMain group"
                >
                  {cit.title}
                  <ExternalLink size={12} className="text-textMuted group-hover:text-textMain" />
                </a>
              ))}
            </div>
          </div>
        )}

        {/* Bottom Actions Row: Reasoning Trace Toggle & Feedback */}
        {displayedContent.length >= message.content.length && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-4">
            {message.reasoning ? (
              <div className="flex-1 min-w-0">
                <ReasoningVisualization reasoning={message.reasoning} unverified={message.unverified} />
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
                onClick={() => setFeedback(feedback === 'up' ? null : 'up')}
                className={cn(
                  "p-1.5 rounded-md transition-colors",
                  feedback === 'up' ? "bg-primary/20 text-primary" : "text-textMuted hover:text-textMain hover:bg-surfaceHover"
                )}
                title="Good response"
              >
                <ThumbsUp size={14} />
              </button>
              <button 
                onClick={() => setFeedback(feedback === 'down' ? null : 'down')}
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
