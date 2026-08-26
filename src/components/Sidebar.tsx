import React, { useState } from 'react';
import { MessageSquare, X, Trash2, Search, Sliders } from 'lucide-react';
import { ChatThread } from '../types';
import { cn } from '../lib/utils';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  threads: ChatThread[];
  currentThreadId: string;
  onSelectThread: (threadId: string) => void;
  onDeleteThread: (threadId: string) => void;
  onNewChat: () => void;
  onOpenSettings?: () => void;
}

export function Sidebar({ isOpen, onClose, threads, currentThreadId, onSelectThread, onDeleteThread, onNewChat, onOpenSettings }: SidebarProps) {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredThreads = threads.filter(t => 
    t.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
    t.messages.some(m => m.content.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <>
      {/* Backdrop */}
      <div 
        className={cn(
          "fixed inset-0 bg-background/80 backdrop-blur-sm z-40 transition-opacity duration-300 md:hidden",
          isOpen ? "opacity-100 pointer-events-auto" : "opacity-0 pointer-events-none"
        )} 
        onClick={onClose} 
      />
      {/* Sidebar */}
      <div 
        className={cn(
          "fixed md:static inset-y-0 left-0 w-[85vw] sm:w-72 bg-surface border-r border-border/60 z-50 transform transition-transform duration-300 ease-in-out flex flex-col shadow-2xl md:shadow-none flex-shrink-0 md:translate-x-0",
          isOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="p-4 border-b border-border/60 flex items-center justify-between">
          <h2 className="font-medium text-textMain">Chat History</h2>
          <button onClick={onClose} className="md:hidden p-1.5 text-textMuted hover:text-textMain hover:bg-surfaceHover rounded-md transition-colors">
            <X size={18} />
          </button>
        </div>
        
        <div className="p-4 border-b border-border/60 space-y-3">
          <button
            onClick={() => { onNewChat(); onClose(); }}
            className="w-full flex items-center justify-center gap-2 py-2.5 px-4 bg-primary text-white rounded-xl hover:bg-primaryHover transition-colors font-medium text-sm shadow-sm"
          >
            + New Chat
          </button>
          
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-textMuted" size={16} />
            <input
              type="text"
              placeholder="Search history..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-background border border-border/60 rounded-lg pl-9 pr-3 py-2 text-sm text-textMain placeholder-textMuted focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto custom-scrollbar p-3 space-y-2">
          {filteredThreads.length === 0 ? (
            <div className="text-center py-8 text-sm text-textMuted">
              {searchQuery ? 'No matching conversations' : 'No past conversations'}
            </div>
          ) : (
            filteredThreads.map(thread => (
              <div key={thread.id} className={cn(
                "group flex items-center justify-between p-3 rounded-xl cursor-pointer transition-all border",
                thread.id === currentThreadId 
                  ? "bg-surfaceHover border-border/60 text-textMain shadow-sm" 
                  : "bg-transparent border-transparent text-textMuted hover:bg-surfaceHover/50 hover:text-textMain"
              )}>
                <div 
                  className="flex-1 min-w-0 pr-2"
                  onClick={() => { onSelectThread(thread.id); onClose(); }}
                >
                  <div className="flex items-center gap-2 mb-1">
                    <MessageSquare size={14} className={thread.id === currentThreadId ? "text-primary" : ""} />
                    <span className="text-sm font-medium truncate">{thread.title || 'New Conversation'}</span>
                  </div>
                  <div className="text-xs opacity-60">
                    {new Date(thread.date).toLocaleDateString()} &middot; {thread.model}
                  </div>
                </div>
                <button 
                  onClick={(e) => { e.stopPropagation(); onDeleteThread(thread.id); }}
                  className="p-1.5 opacity-0 group-hover:opacity-100 text-textMuted hover:text-red-400 hover:bg-background rounded-md transition-all"
                >
                  <Trash2 size={14} />
                </button>
              </div>
            ))
          )}
        </div>

        <div className="p-4 border-t border-border/60 flex flex-col gap-3">
          <button 
            onClick={() => {
              if (onOpenSettings) onOpenSettings();
              onClose();
            }}
            className="flex items-center gap-2 text-sm text-textMuted hover:text-textMain transition-colors w-full text-left p-2 rounded-md hover:bg-surfaceHover"
          >
            <Sliders size={16} />
            Settings
          </button>
        </div>
      </div>
    </>
  );
}
