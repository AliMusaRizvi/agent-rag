# UI Specification — Enterprise Knowledge Agent Frontend

This was the original brief for a thin demo frontend. **What actually
shipped in `src/` goes further than this spec asked for** — a sidebar with
persisted conversation history, a settings panel, file upload, and a model
picker, in addition to everything below. That was a deliberate call, made
after the UI was built: the extra surface is real, working, and useful for
a portfolio reviewer poking around rather than following a script, so it
stayed rather than getting cut back to match this document. The reasoning
in this file about the four core interaction states, the citation strip,
and the approval card is still exactly what's implemented — read it as
"what the UI must get right," not "the only screen that's allowed to
exist."

**Reminder of the design intent (from the main design doc, §12):** the
agent's reasoning must be *visible* in under a minute — citations, the
reasoning loops, and the human-approval moment. That's still the bar every
addition gets held to.

---

## 1. Product framing (give this to the AI builder verbatim)

> Build a single-page chat interface for an AI knowledge agent called
> "Enterprise Knowledge Agent." It answers questions from an internal
> company handbook, always cites its sources, and can take real actions
> (like filing a support ticket) — but only after the user explicitly
> approves the action. The tone is professional, calm, and trustworthy —
> think an internal enterprise tool (Linear, Notion AI, Intercom's help
> panel), not a flashy consumer chatbot. Dark-mode-first, clean typography,
> generous whitespace, minimal chrome.

---

## 2. Screens / layout

**Single screen, three zones:**

1. **Header bar** (fixed top): product name + a small "Powered by LangGraph
   · Gemini · Qdrant" badge row — this is a portfolio piece, the stack
   deserves to be visible, but keep it small and unobtrusive (not a hero
   banner).
2. **Main chat column** (center, max-width ~720px, centered): message
   history, newest at bottom, auto-scrolls. Standard chat bubble pattern —
   user messages right-aligned/filled, agent messages left-aligned/subtle
   background.
3. **Input bar** (fixed bottom): text input + send button. Disabled while
   a response is in flight, with a subtle loading indicator (not a full
   spinner overlay — the point is responsiveness).

No sidebar, no conversation history list, no settings icon. If you want one
optional extra, a "Reset conversation" text link near the header is enough.

---

## 3. Core interaction states (this is the part that matters most)

The agent message rendering needs to handle **four distinct states**, and
making each visually distinct is the actual point of this UI:

### 3.1 Plain answer with citations
- Render the answer text normally.
- Below it, a **"Sources" strip**: small pill/chip per citation, each
  showing the source page title, clickable and opens `source_url` in a new
  tab. This is the single most important visual element in the whole app —
  it's what proves the answer is grounded, not just plausible-sounding.

### 3.2 Low-confidence / unverified answer
- If the backend response includes the "could not be fully verified"
  note (see backend `finalize_node`), render the answer with a distinct
  visual treatment — a subtle amber left-border or badge reading
  "Unverified — treat with caution," not a scary red error. This
  communicates the hallucination-check loop's result honestly instead of
  hiding it.

### 3.3 Human-in-the-loop approval card
- When `/chat` returns `requires_approval: true`, do NOT render it as a
  normal message. Render a distinct **approval card**:
  - A clear label: "This action needs your approval"
  - The proposed action rendered as structured fields, not raw JSON —
    e.g. for a GitHub issue: **Title**, **Body** (scrollable if long),
    **Labels** as chips.
  - Two buttons: **Approve** (primary, calls `/approve-tool` with
    `approved: true`) and **Reject** (secondary, calls it with
    `approved: false`).
  - After the decision, replace the card with a small confirmation line
    ("✓ Issue created — [view on GitHub]" linking to the returned URL, or
    "Action cancelled").
  - This card is the single most important screen in a demo video — it's
    the visual proof of "human-in-the-loop," not a documentation claim.

### 3.4 Reasoning trace (optional but strongly recommended)
- A small collapsible "Show reasoning" toggle under each answer that
  expands to show: number of retrieval attempts (if the rewrite loop
  fired), and the hallucination-check verdict. Keep this collapsed by
  default — it's for reviewers who want to see the agentic loops actually
  ran, not for every-day use. If the backend doesn't yet expose this via
  the API, stub it with placeholder state and note it as a "wire up to
  `/chat` response metadata" TODO — don't block the rest of the UI on it.

---

## 4. API contract (as actually implemented — see `src/server/routes/`)

```
POST /chat
  body:    { "message": string, "thread_id"?: string, "model"?: string,
             "persona"?: "concise"|"formal"|"creative", "systemPrompt"?: string }
  returns: {
    "thread_id": string,
    "response": string,
    "requires_approval": boolean,
    "pending_tool_args"?: { "action", "repo", "title", "body", "labels" },
    "sources"?: { "title", "url", "snippet", "score" }[],   // structured, server-verified citations
    "unverified"?: boolean,
    "reasoning"?: { "attempts": number, "verdict": string, "trace": string }
  }

POST /approve-tool
  body:    { "thread_id": string, "approved": boolean }
  returns: { "thread_id": string, "response": string, "toolResult"?: object }

POST /api/upload           (multipart "file"; PDF/DOCX/TXT, 10MB cap)
GET  /api/models           → { "models": { "id", "label", "available" }[] }
POST /api/clear-cache
GET  /health   |   GET /ready
```

**Session handling:** the server sets a first-party, httpOnly session
cookie automatically (`credentials: 'include'` on fetch calls, or same-
origin, handles this with no client code needed) — it's what scopes rate
limits and private uploads to your browser session, and what
`/approve-tool` checks before letting you approve or reject a pending
action. `thread_id` is separate and conversation-scoped: generate one
client-side (or let the server assign one on the first `/chat` call) and
send it on every subsequent call so the Postgres checkpointer resumes the
right conversation — the server owns message history from there; **do not**
resend prior messages in the request body.

**Citations:** `sources` arrives as a structured array — every entry was
checked server-side against what was actually retrieved before being
returned, so there's nothing to parse out of the answer text. `unverified`
is `true` when the groundedness check failed even after a retry, or when
the system refused for lack of grounded context — render it as a visible
but calm badge (§3.2), not a hidden field.

---

## 5. Visual/design direction

- **Palette:** dark neutral background (near-black, not pure black),
  one accent color used sparingly (for the send button, links, and the
  approval card's Approve button only — not scattered everywhere).
- **Typography:** a clean sans-serif for UI chrome, and — importantly —
  render agent answers as actual markdown (headings, bold, lists) since
  handbook content often includes structure worth preserving, not just
  plain paragraphs.
- **Motion:** minimal. A subtle fade-in for new messages is enough;
  avoid bouncy/playful animation — this is meant to read as a serious
  internal tool.
- **Empty state:** when the conversation is empty, show 3-4 clickable
  example questions pulled from the eval gold set (e.g. "What is GitLab's
  remote work policy?") — this does double duty as a demo aid and as
  proof the eval questions and the live demo are the same corpus.

---

## 6. Out of scope

Multiple saved conversations, a settings panel, and file upload shipped
after all (§0) — they're real, backend-supported features (per-session
thread history, persona/system-prompt controls, PDF/DOCX/TXT upload scoped
privately to your session), not scope creep for its own sake. Still out of
scope, deliberately: multi-user accounts/login (there is no per-user
identity system, only an anonymous per-session cookie — see the README's
security posture section), voice input, and a document viewer/browser for
the underlying Handbook pages beyond the citation links.

---

## 7. Suggested component breakdown (for the AI builder to scaffold)

```
<App>
  <Header />
  <ChatWindow>
    <MessageList>
      <UserMessage />
      <AgentMessage variant="answer" | "unverified" />
      <ApprovalCard />
    </MessageList>
    <EmptyState />          // shown only when MessageList is empty
  </ChatWindow>
  <InputBar />
</App>
```

Keep state management simple — React `useState`/`useReducer` for the
message list and pending-approval state is sufficient at this scale; no
need for Redux/Zustand for a single-screen app.
