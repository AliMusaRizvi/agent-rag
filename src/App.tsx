import React, { useState, useEffect, useRef, useCallback } from 'react';
import { v4 as uuidv4 } from 'uuid';
import toast from 'react-hot-toast';
import { ChatMessage, ChatThread } from './types';
import { EmptyState } from './components/EmptyState';
import { InputBar } from './components/InputBar';
import { AgentMessage } from './components/AgentMessage';
import { UserMessage } from './components/UserMessage';
import { ApprovalCard } from './components/ApprovalCard';
import { Sidebar } from './components/Sidebar';
import { ConfidenceChart } from './components/ConfidenceChart';
import { exportToMarkdown, cn } from './lib/utils';
import { CheckCircle2, ExternalLink, RotateCcw, Menu, Download, ChevronDown, Search, X, Database, Trash2, Settings, FileText, Sun, Moon, Sliders } from 'lucide-react';

export default function App() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [threadId, setThreadId] = useState<string>('');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [selectedModel, setSelectedModel] = useState('Groq');
  const [isModelDropdownOpen, setIsModelDropdownOpen] = useState(false);
  const [scrollProgress, setScrollProgress] = useState(0);
  const [isChatSearchOpen, setIsChatSearchOpen] = useState(false);
  const [chatSearchQuery, setChatSearchQuery] = useState('');
  const [isContextPanelOpen, setIsContextPanelOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [agentPersona, setAgentPersona] = useState(() => localStorage.getItem('agentPersona') || 'concise');
  const [systemPrompt, setSystemPrompt] = useState(() => localStorage.getItem('systemPrompt') || '');
  const [isDarkMode, setIsDarkMode] = useState(() => localStorage.getItem('isDarkMode') !== 'false');

  useEffect(() => {
    localStorage.setItem('agentPersona', agentPersona);
  }, [agentPersona]);

  useEffect(() => {
    localStorage.setItem('systemPrompt', systemPrompt);
  }, [systemPrompt]);

  useEffect(() => {
    localStorage.setItem('isDarkMode', String(isDarkMode));
  }, [isDarkMode]);
  const [contextData, setContextData] = useState<{sources: {title: string, url: string, snippet?: string, score?: number}[], cacheHits: number}>({sources: [], cacheHits: 0});

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  const [threads, setThreads] = useState<ChatThread[]>(() => {
    const saved = localStorage.getItem('chat_threads');
    return saved ? JSON.parse(saved) : [];
  });
  
  const endOfMessagesRef = useRef<HTMLDivElement>(null);

  const handleReset = useCallback(() => {
    setMessages([]);
    setThreadId(uuidv4());
  }, []);

  useEffect(() => {
    if (threads.length > 0) {
      const latest = threads[0];
      setThreadId(latest.id);
      setMessages(latest.messages.map(m => ({ ...m, streamed: true })));
      setSelectedModel(latest.model || 'Primary');
    } else {
      handleReset();
    }
  }, []); // eslint-disable-next-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (messages.length === 0 || !threadId) return;
    
    setThreads(prev => {
      const existingIdx = prev.findIndex(t => t.id === threadId);
      const firstUserMessage = messages.find(m => m.role === 'user')?.content || 'New Conversation';
      const title = firstUserMessage.length > 30 ? firstUserMessage.slice(0, 30) + '...' : firstUserMessage;
      
      const updatedThread: ChatThread = {
        id: threadId,
        title,
        date: existingIdx >= 0 ? prev[existingIdx].date : new Date().toISOString(),
        messages,
        model: selectedModel
      };

      let newThreads = [...prev];
      if (existingIdx >= 0) {
        newThreads[existingIdx] = updatedThread;
      } else {
        newThreads = [updatedThread, ...newThreads];
      }
      
      localStorage.setItem('chat_threads', JSON.stringify(newThreads));
      return newThreads;
    });
  }, [messages, threadId, selectedModel]);

  useEffect(() => {
    if (endOfMessagesRef.current && !chatSearchQuery) {
      endOfMessagesRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages, isLoading, chatSearchQuery]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
        e.preventDefault();
        document.getElementById('chat-input')?.focus();
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        handleReset();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleReset]);

  const handleScroll = (e: React.UIEvent<HTMLElement>) => {
    const { scrollTop, scrollHeight, clientHeight } = e.currentTarget;
    if (scrollHeight > clientHeight) {
      setScrollProgress((scrollTop / (scrollHeight - clientHeight)) * 100);
    } else {
      setScrollProgress(0);
    }
  };

  const handleSendMessage = async (text: string) => {
    if (!text.trim() || isLoading) return;
    
    const newUserMsg: ChatMessage = {
      id: uuidv4(),
      role: 'user',
      content: text,
      streamed: true
    };
    
    setMessages(prev => [...prev, newUserMsg]);
    setIsLoading(true);
    setChatSearchQuery('');
    setIsChatSearchOpen(false);

    try {
      const res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, thread_id: threadId, model: selectedModel, persona: agentPersona, systemPrompt: systemPrompt, history: messages.map(m => ({ role: m.role, content: m.content })) })
      });
      
      const data = await res.json();
      
      // The backend response parsing
      let parsedContent = data.response || '';
      let citations: {title: string, url: string, snippet?: string, score?: number}[] = data.sources || [];
      
      // Deduplicate citations by combining title and url to ensure unique sources
      const uniqueCitations = new Map<string, {title: string, url: string, snippet?: string, score?: number}>();
      citations.forEach(c => uniqueCitations.set(`${c.title}-${c.url}`, c));
      citations = Array.from(uniqueCitations.values());
      
      if (citations.length > 0) {
        setContextData(prev => {
          const allSources = [...prev.sources, ...citations];
          const uniqueSources = new Map<string, {title: string, url: string, snippet?: string, score?: number}>();
          allSources.forEach(s => uniqueSources.set(`${s.title}-${s.url}`, s));
          return {
            sources: Array.from(uniqueSources.values()),
            cacheHits: prev.cacheHits + 1
          };
        });
      }

      let unverified = false;
      
      const sourcesMatch = parsedContent.match(/Sources:\n([\s\S]*)/);
      if (sourcesMatch && citations.length === 0) {
        parsedContent = parsedContent.replace(sourcesMatch[0], '').trim();
        const sourcesText = sourcesMatch[1];
        const sourceLines = sourcesText.split('\n').filter((l: string) => l.trim() !== '');
        
        citations = sourceLines.map((line: string, i: number) => {
          return { title: line.replace(/^- /, ''), url: '#' };
        });
      }

      if (parsedContent.includes('could not be fully verified')) {
        unverified = true;
      }

      const newAgentMsg: ChatMessage = {
        id: uuidv4(),
        role: 'agent',
        content: parsedContent,
        requires_approval: data.requires_approval,
        pending_tool_args: data.pending_tool_args,
        citations: citations.length > 0 ? citations : undefined,
        unverified,
        isApprovalCard: data.requires_approval,
        actionStatus: data.requires_approval ? 'pending' : undefined,
        reasoning: data.reasoning || { attempts: 1, verdict: unverified ? 'Low confidence' : 'Verified by LangGraph checks' },
        streamed: false
      };
      
      setMessages(prev => [...prev, newAgentMsg]);
      
    } catch (error) {
      console.error('Failed to send message:', error);
      toast.error('Failed to connect to the backend server. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleApproveAction = async (messageId: string, approved: boolean) => {
    setIsLoading(true);
    
    setMessages(prev => prev.map(m => 
      m.id === messageId ? { ...m, actionStatus: approved ? 'approved' : 'rejected' } : m
    ));

    try {
      const res = await fetch('/approve-tool', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thread_id: threadId, approved })
      });
      
      const data = await res.json();
      
      setMessages(prev => prev.map(m => 
        m.id === messageId ? { 
          ...m, 
          actionResult: data.response || (approved ? 'Action executed successfully.' : 'Action cancelled.') 
        } : m
      ));
      
    } catch (error) {
      console.error('Failed to approve action:', error);
      toast.error('Failed to process approval.');
      setMessages(prev => prev.map(m => 
        m.id === messageId ? { ...m, actionStatus: 'pending' } : m
      ));
    } finally {
      setIsLoading(false);
    }
  };

  const handleSelectThread = (id: string) => {
    const thread = threads.find(t => t.id === id);
    if (thread) {
      setThreadId(thread.id);
      setMessages(thread.messages.map(m => ({ ...m, streamed: true })));
      setSelectedModel(thread.model || 'Grok');
      setChatSearchQuery('');
      setIsChatSearchOpen(false);
    }
  };

  const handleDeleteThread = (id: string) => {
    const newThreads = threads.filter(t => t.id !== id);
    setThreads(newThreads);
    localStorage.setItem('chat_threads', JSON.stringify(newThreads));
    if (id === threadId) {
      if (newThreads.length > 0) {
        handleSelectThread(newThreads[0].id);
      } else {
        handleReset();
      }
    }
  };

  const handleStreamComplete = (msgId: string) => {
    setMessages(prev => prev.map(m => m.id === msgId ? { ...m, streamed: true } : m));
  };

  const displayedMessages = messages.filter(m => 
    !chatSearchQuery || 
    m.content.toLowerCase().includes(chatSearchQuery.toLowerCase()) || 
    (m.pending_tool_args && JSON.stringify(m.pending_tool_args).toLowerCase().includes(chatSearchQuery.toLowerCase()))
  );

  const clearKVContext = async () => {
    try {
      await fetch('/api/clear-cache', { method: 'POST' });
      setContextData({sources: [], cacheHits: 0});
      toast.success('Context cache cleared successfully');
    } catch (e) {
      toast.error('Failed to clear backend cache');
    }
  };

  return (
    <div className="flex h-screen bg-background relative overflow-hidden">
      <Sidebar 
        isOpen={isSidebarOpen} 
        onClose={() => setIsSidebarOpen(false)} 
        threads={threads} 
        currentThreadId={threadId} 
        onSelectThread={handleSelectThread} 
        onDeleteThread={handleDeleteThread}
        onOpenSettings={() => setIsSettingsOpen(true)} 
        onNewChat={handleReset} 
      />


      <div className="flex flex-col flex-1 min-w-0 h-screen relative z-10">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] rounded-full bg-primary/5 blur-[120px] pointer-events-none" />
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] rounded-full bg-warning/5 blur-[120px] pointer-events-none" />
      
      <header className="flex-none pt-6 pb-4 px-4 md:px-6 flex items-start justify-between relative z-20">
        <div className="flex gap-4">
          <button onClick={() => setIsSidebarOpen(true)} className="md:hidden mt-1 p-1.5 text-textMuted hover:text-textMain hover:bg-surfaceHover rounded-md transition-colors">
            <Menu size={20} />
          </button>
          
          <div className="flex flex-col gap-2">
            <h1 className="font-semibold text-textMain tracking-tight text-lg">Enterprise Knowledge Agent</h1>
            
            <div className="flex flex-wrap items-center gap-2">
              <div className="relative ml-2">
                <button 
                  onClick={() => setIsModelDropdownOpen(!isModelDropdownOpen)}
                  className="flex items-center gap-1.5 px-2 py-0.5 border border-border/80 hover:bg-surfaceHover rounded text-[10px] uppercase tracking-wider font-semibold text-textMuted hover:text-textMain transition-colors bg-surface/30"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse"></span>
                  {selectedModel}
                  <span className="ml-1 px-1.5 py-0.5 rounded-full bg-primary/20 text-primary text-[8px] font-bold">BETA</span>
                  <ChevronDown size={10} className={cn("transition-transform", isModelDropdownOpen && "rotate-180")} />
                </button>
                
                {isModelDropdownOpen && (
                  <div className="absolute top-full left-0 mt-2 w-48 bg-surface border border-border rounded-lg shadow-lg overflow-hidden z-50 py-1">
                    <button
                      onClick={() => {
                        setSelectedModel('Groq');
                        setIsModelDropdownOpen(false);
                      }}
                      className={cn(
                        "w-full text-left px-4 py-2 text-xs transition-colors font-medium flex items-center justify-between",
                        selectedModel === 'Groq' ? "bg-primary/10 text-primary" : "text-textMain hover:bg-surfaceHover"
                      )}
                    >
                      <span>Groq</span>
                      {selectedModel === 'Groq' && <span className="w-1.5 h-1.5 rounded-full bg-primary"></span>}
                    </button>
                    {['Gemini', 'OpenAI', 'Anthropic'].map(model => (
                      <button
                        key={model}
                        disabled
                        className="w-full text-left px-4 py-2 text-xs transition-colors font-medium text-textMuted opacity-50 flex items-center justify-between cursor-not-allowed"
                      >
                        <span>{model}</span>
                        <span className="text-[9px] bg-surfaceHover px-1.5 py-0.5 rounded">Coming Soon</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
        
        <div className="flex items-center gap-1 sm:gap-2 relative">
          <button 
            onClick={() => setIsDarkMode(!isDarkMode)}
            className="text-textMuted hover:text-textMain text-sm flex items-center gap-1.5 transition-colors px-2.5 py-1.5 rounded-md hover:bg-surfaceHover"
            title="Toggle Theme"
          >
            {isDarkMode ? <Sun size={16} /> : <Moon size={16} />}
          </button>
          
          <button 
            onClick={() => {
              setIsChatSearchOpen(!isChatSearchOpen);
              if (!isChatSearchOpen) setChatSearchQuery('');
            }}
            className={cn(
              "text-textMuted hover:text-textMain text-sm flex items-center gap-1.5 transition-colors px-2.5 py-1.5 rounded-md hover:bg-surfaceHover",
              isChatSearchOpen && "bg-surfaceHover text-textMain"
            )}
            title="Find in Chat"
          >
            <Search size={16} />
            <span className="hidden sm:inline">Find</span>
          </button>
          
          <button 
            onClick={() => setIsContextPanelOpen(true)}
            className="text-textMuted hover:text-textMain text-sm flex items-center gap-1.5 transition-colors px-2.5 py-1.5 rounded-md hover:bg-surfaceHover"
            title="Context Management"
          >
            <Database size={16} />
            <span className="hidden sm:inline">Context</span>
          </button>
          
          <button 
            onClick={() => exportToMarkdown(messages, selectedModel)}
            className="text-textMuted hover:text-textMain text-sm flex items-center gap-1.5 transition-colors px-2.5 py-1.5 rounded-md hover:bg-surfaceHover"
            title="Download Chat History"
          >
            <Download size={16} />
            <span className="hidden sm:inline">Export</span>
          </button>
          <button 
            onClick={handleReset}
            className="text-textMuted hover:text-textMain text-sm flex items-center gap-1.5 transition-colors px-2.5 py-1.5 rounded-md hover:bg-surfaceHover"
            title="Reset conversation (Ctrl+N)"
          >
            <RotateCcw size={16} />
            <span className="hidden sm:inline">Reset</span>
          </button>

          {isChatSearchOpen && (
            <div className="absolute top-full right-0 mt-2 w-64 bg-surface border border-border rounded-xl shadow-lg p-2 z-50 animate-in slide-in-from-top-2 fade-in">
              <div className="relative flex items-center">
                <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 text-textMuted" size={14} />
                <input
                  autoFocus
                  type="text"
                  placeholder="Find in current chat..."
                  value={chatSearchQuery}
                  onChange={(e) => setChatSearchQuery(e.target.value)}
                  className="w-full bg-background border border-border/60 rounded-lg pl-8 pr-8 py-1.5 text-sm text-textMain placeholder-textMuted focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all"
                />
                <button 
                  onClick={() => {
                    setIsChatSearchOpen(false);
                    setChatSearchQuery('');
                  }}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-textMuted hover:text-textMain"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}
        </div>
      </header>

      <div className="w-full h-0.5 bg-background absolute top-14 left-0 z-10">
        <div 
          className="h-full bg-primary transition-all duration-150 ease-out shadow-[0_0_8px_rgba(59,130,246,0.6)]"
          style={{ width: `${scrollProgress}%` }}
        />
      </div>

      <main className="flex-1 overflow-y-auto px-4 py-8 custom-scrollbar" onScroll={handleScroll}>
        <div className="max-w-[720px] mx-auto w-full flex flex-col gap-6 pb-4">
          {displayedMessages.length === 0 && chatSearchQuery ? (
            <div className="text-center text-textMuted py-8">No results found for "{chatSearchQuery}"</div>
          ) : displayedMessages.length === 0 ? (
            <EmptyState onSelectQuestion={handleSendMessage} />
          ) : (
            displayedMessages.map((msg) => {
              if (msg.role === 'user') {
                return <UserMessage key={msg.id} content={msg.content} />;
              }
              if (msg.isApprovalCard) {
                return (
                  <ApprovalCard 
                    key={msg.id} 
                    message={msg} 
                    onApprove={(approved) => handleApproveAction(msg.id, approved)}
                    disabled={isLoading}
                  />
                );
              }
              return <AgentMessage key={msg.id} message={msg} onStreamComplete={handleStreamComplete} />;
            })
          )}
          {isLoading && !messages[messages.length - 1]?.isApprovalCard && !chatSearchQuery && (
            <div className="flex items-center gap-3 text-textMuted mt-4 mb-2 animate-in fade-in slide-in-from-bottom-2 duration-500">
              <div className="flex gap-1.5 items-center bg-surfaceHover/50 px-3 py-1.5 rounded-full border border-border/50">
                <span className="w-2 h-2 bg-primary/70 rounded-full animate-wave" style={{ animationDelay: '0ms' }}></span>
                <span className="w-2 h-2 bg-primary/70 rounded-full animate-wave" style={{ animationDelay: '150ms' }}></span>
                <span className="w-2 h-2 bg-primary/70 rounded-full animate-wave" style={{ animationDelay: '300ms' }}></span>
              </div>
              <span className="text-sm font-medium animate-smooth-pulse text-primary/80 bg-clip-text text-transparent bg-gradient-to-r from-primary to-primaryHover">Agent is thinking...</span>
            </div>
          )}
          <div ref={endOfMessagesRef} />
        </div>
      </main>

      <InputBar onSend={handleSendMessage} disabled={isLoading} />
    </div>

    {/* Context Management Panel */}
    <div 
      className={cn(
        "fixed inset-y-0 right-0 w-full sm:w-80 bg-surface border-l border-border/60 z-50 transform transition-transform duration-300 ease-in-out flex flex-col shadow-2xl",
        isContextPanelOpen ? "translate-x-0" : "translate-x-full"
      )}
    >
      <div className="p-4 border-b border-border/60 flex items-center justify-between">
        <h2 className="font-medium text-textMain flex items-center gap-2">
          <Database size={18} className="text-primary" />
          Context Management
        </h2>
        <button onClick={() => setIsContextPanelOpen(false)} className="p-1.5 text-textMuted hover:text-textMain hover:bg-surfaceHover rounded-md transition-colors">
          <X size={18} />
        </button>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-6">
        <div>
          <h3 className="text-xs font-semibold text-textMuted uppercase tracking-wider mb-3">KV Cache Status</h3>
          <div className="bg-background rounded-lg p-3 border border-border/50 flex items-center justify-between mb-4">
            <span className="text-sm">Cache Hits</span>
            <span className="font-medium text-primary">{contextData.cacheHits}</span>
          </div>
          {contextData.sources.length > 0 && (
            <ConfidenceChart data={contextData.sources as any} />
          )}
        </div>

        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-xs font-semibold text-textMuted uppercase tracking-wider">Cached Sources</h3>
            {contextData.sources.length > 0 && (
              <button 
                onClick={clearKVContext}
                className="text-xs text-red-400 hover:text-red-500 flex items-center gap-1 transition-colors"
              >
                <Trash2 size={12} />
                Clear
              </button>
            )}
          </div>
          
          {contextData.sources.length === 0 ? (
            <div className="text-sm text-textMuted text-center py-6 border border-dashed border-border rounded-lg">
              No sources in current context
            </div>
          ) : (
            <div className="space-y-2">
              {contextData.sources.map((src, i) => (
                <details key={i} className="group text-sm bg-background rounded-lg border border-border/50 overflow-hidden">
                  <summary className="p-2.5 flex items-start gap-2 cursor-pointer hover:bg-surfaceHover transition-colors list-none">
                    <FileText size={14} className="mt-0.5 text-primary flex-shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="break-all text-textMain font-medium" title={src.title}>
                        {src.title}
                      </div>
                      {!src.snippet && (
                        <div className="text-xs text-textMuted mt-1">
                          No preview available
                        </div>
                      )}
                    </div>
                  </summary>
                  {src.snippet && (
                    <div className="px-2.5 pb-3 pt-1 border-t border-border/50">
                      <div className="text-xs text-textMuted whitespace-pre-wrap font-mono bg-surfaceHover p-2 rounded-md border border-border/30">
                        {src.snippet}
                      </div>
                      <a href={src.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs text-primary hover:text-primaryHover mt-2 transition-colors">
                        View source <ExternalLink size={12} />
                      </a>
                    </div>
                  )}
                </details>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
    
    {isContextPanelOpen && (
      <div 
        className="fixed inset-0 bg-background/50 backdrop-blur-sm z-40" 
        onClick={() => setIsContextPanelOpen(false)} 
      />
    )}

    {/* Settings Modal */}
    {isSettingsOpen && (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm p-4">
        <div className="bg-surface border border-border/60 rounded-2xl shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200">
          <div className="flex items-center justify-between p-4 border-b border-border/60">
            <h2 className="font-semibold text-textMain flex items-center gap-2">
              <Sliders size={18} className="text-primary" />
              Settings
            </h2>
            <button 
              onClick={() => setIsSettingsOpen(false)} 
              className="p-1.5 text-textMuted hover:text-textMain hover:bg-surfaceHover rounded-md transition-colors"
            >
              <X size={18} />
            </button>
          </div>
          <div className="p-6 space-y-6">
            <div>
              <label className="block text-sm font-medium text-textMain mb-2">Custom System Prompt</label>
              <textarea 
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                placeholder="E.g., You are a senior engineer. Always provide code examples..."
                className="w-full bg-background border border-border/60 rounded-lg p-3 text-sm text-textMain placeholder-textMuted focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary transition-all custom-scrollbar min-h-[80px]"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-textMain mb-2">Agent Persona (Preset)</label>
              <p className="text-xs text-textMuted mb-4">Or choose a preset persona (overridden by custom prompt if set).</p>
              
              <div className="flex items-center justify-between p-3 rounded-lg border border-border/50">
                <div className="flex flex-col">
                  <span className="text-sm font-medium text-textMain">Dark Mode</span>
                  <span className="text-xs text-textMuted">Toggle application theme</span>
                </div>
                <button 
                  onClick={() => setIsDarkMode(!isDarkMode)}
                  className="p-2 rounded-lg bg-surfaceHover text-textMain hover:bg-border/50 transition-colors"
                >
                  {isDarkMode ? <Moon size={16} /> : <Sun size={16} />}
                </button>
              </div>
            </div>
            
            <div>
              <label className="block text-sm font-medium text-textMain mb-2">Agent Persona (Preset)</label>
              <p className="text-xs text-textMuted mb-4">Or choose a preset persona (overridden by custom prompt if set).</p>
              
              <div className="space-y-2">
                {[
                  { id: 'concise', label: 'Concise & Direct', desc: 'Brief, to the point answers.' },
                  { id: 'formal', label: 'Formal & Professional', desc: 'Thorough, corporate tone.' },
                  { id: 'creative', label: 'Creative & Engaging', desc: 'Conversational and descriptive.' }
                ].map((persona) => (
                  <label key={persona.id} className="flex items-start gap-3 p-3 rounded-lg border border-border/50 hover:bg-surfaceHover cursor-pointer transition-colors">
                    <input 
                      type="radio" 
                      name="persona" 
                      value={persona.id} 
                      checked={agentPersona === persona.id}
                      onChange={(e) => setAgentPersona(e.target.value)}
                      className="mt-1 text-primary focus:ring-primary h-4 w-4 border-border/60 bg-background"
                    />
                    <div className="flex flex-col">
                      <span className="text-sm font-medium text-textMain">{persona.label}</span>
                      <span className="text-xs text-textMuted">{persona.desc}</span>
                    </div>
                  </label>
                ))}
              </div>
            </div>
          </div>
          <div className="p-4 border-t border-border/60 flex justify-end">
            <button 
              onClick={() => setIsSettingsOpen(false)}
              className="px-4 py-2 bg-primary hover:bg-primaryHover text-white text-sm font-medium rounded-lg transition-colors"
            >
              Done
            </button>
          </div>
        </div>
      </div>
    )}
    
    </div>
  );
}
