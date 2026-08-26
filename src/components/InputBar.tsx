import React, { useState, useEffect, useRef } from 'react';
import { ArrowUp, Paperclip, X, FileText, Image as ImageIcon } from 'lucide-react';
import { cn } from '../lib/utils';
import toast from 'react-hot-toast';

interface InputBarProps {
  onSend: (text: string) => void;
  disabled: boolean;
}

export function InputBar({ onSend, disabled }: InputBarProps) {
  const [input, setInput] = useState(() => sessionStorage.getItem('chat_draft') || '');
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    sessionStorage.setItem('chat_draft', input);
  }, [input]);

  const handleUpload = async (file: File) => {
    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData
      });
      if (res.ok) {
        toast.success(`${file.name} uploaded and indexed successfully!`);
        setSelectedFile(null);
      } else {
        toast.error('Failed to upload file.');
        setSelectedFile(null);
      }
    } catch (e) {
      toast.error('Upload error.');
      setSelectedFile(null);
    } finally {
      setIsUploading(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (selectedFile) {
      handleUpload(selectedFile);
    }
    if (input.trim() && !disabled) {
      onSend(input);
      setInput('');
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit(e);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  
  const handleDragLeave = () => {
    setIsDragging(false);
  };
  
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFileSelection(e.dataTransfer.files[0]);
    }
  };

  const handleFileSelection = (file: File) => {
    const validTypes = ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain', 'image/png', 'image/jpeg', 'image/webp'];
    if (validTypes.includes(file.type) || file.name.endsWith('.pdf') || file.name.endsWith('.docx') || file.name.endsWith('.txt')) {
      setSelectedFile(file);
    } else {
      toast.error('Unsupported file type. Please upload PDF, Word, TXT, or Image files.');
    }
  };

  return (
    <div className="flex-none bg-background/80 backdrop-blur-md border-t border-border p-4 w-full relative z-10">
      <div className="max-w-[720px] mx-auto relative">
        <div 
          className={cn(
            "relative flex flex-col w-full bg-surface border rounded-[24px] transition-all shadow-sm",
            isDragging ? "border-primary bg-primary/5" : "border-border/60 hover:border-border",
            selectedFile ? "pt-2" : ""
          )}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragging && (
            <div className="absolute inset-0 rounded-[24px] border-2 border-primary border-dashed bg-background/50 backdrop-blur-sm z-20 flex items-center justify-center pointer-events-none">
              <span className="text-primary font-medium flex items-center gap-2">
                <Paperclip size={18} /> Drop file here
              </span>
            </div>
          )}
          
          {selectedFile && (
            <div className="px-4 pb-2 pt-1 flex items-center gap-2">
              <div className="flex items-center gap-2 bg-background border border-border px-3 py-1.5 rounded-lg text-sm max-w-full">
                {selectedFile.type.includes('image') ? <ImageIcon size={14} className="text-primary" /> : <FileText size={14} className="text-primary" />}
                <span className="truncate text-textMain">{selectedFile.name}</span>
                <span className="text-textMuted text-xs ml-1">({(selectedFile.size / 1024).toFixed(0)} KB)</span>
                <button 
                  onClick={() => setSelectedFile(null)} 
                  className="ml-2 text-textMuted hover:text-red-400 p-0.5 rounded-full hover:bg-surfaceHover transition-colors"
                  type="button"
                >
                  <X size={14} />
                </button>
              </div>
            </div>
          )}

          <form onSubmit={handleSubmit} className="relative flex items-end w-full">
            <input 
              type="file" 
              ref={fileInputRef} 
              className="hidden" 
              onChange={(e) => e.target.files && handleFileSelection(e.target.files[0])} 
            />
            
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="absolute left-4 bottom-3 p-1.5 text-textMuted hover:text-textMain hover:bg-surfaceHover rounded-full transition-colors"
              title="Attach File"
            >
              <Paperclip size={18} />
            </button>

            <textarea
              id="chat-input"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={isUploading ? "Uploading..." : "Ask about the handbook or upload a document..."}
              className={cn(
                "w-full bg-transparent px-12 py-4 pr-14",
                "text-textMain placeholder-textMuted focus:outline-none transition-all",
                "resize-none min-h-[56px] max-h-32 custom-scrollbar"
              )}
              rows={1}
              disabled={disabled || isUploading}
              style={{ height: 'auto', boxSizing: 'border-box' }}
            />
            <button
              type="submit"
              disabled={(!input.trim() && !selectedFile) || disabled || isUploading}
              className={cn(
                "absolute right-2 bottom-2 p-2.5 rounded-full text-white bg-primary hover:bg-primaryHover transition-all flex items-center justify-center",
                "disabled:opacity-40 disabled:bg-surfaceHover disabled:text-textMuted disabled:cursor-not-allowed",
                (!disabled && !isUploading && (input.trim() || selectedFile)) && "shadow-md shadow-primary/20 hover:shadow-lg hover:shadow-primary/30 hover:-translate-y-0.5"
              )}
            >
              {(disabled || isUploading) && (!input.trim() && !selectedFile) ? (
                <div className="w-5 h-5 border-2 border-white/20 border-t-white rounded-full animate-spin" />
              ) : (
                <ArrowUp size={20} strokeWidth={2.5} />
              )}
            </button>
          </form>
        </div>
        <div className="text-center mt-3">
          <span className="text-[11px] text-textMuted tracking-wide">
            Answers are grounded in internal sources. Actions require your approval.
          </span>
        </div>
      </div>
    </div>
  );
}
