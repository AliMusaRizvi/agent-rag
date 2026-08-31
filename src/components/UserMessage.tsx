
export function UserMessage({ content }: { content: string }) {
  return (
    <div className="flex justify-end w-full animate-in fade-in slide-in-from-bottom-2 duration-300">
      <div className="max-w-[85%] bg-surfaceHover border border-border/40 px-5 py-3.5 rounded-[20px] rounded-tr-[4px] text-textMain leading-relaxed text-sm md:text-base shadow-sm">
        {content}
      </div>
    </div>
  );
}
