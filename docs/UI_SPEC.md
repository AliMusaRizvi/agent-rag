# UI Specification — Enterprise Knowledge Agent Frontend

This is the complete brief to paste into Loveable or Google AI Studio (or
hand to any React/TypeScript builder) to generate the demo frontend. The
backend (this repo) is complete and API-first — this document describes
what to build *on top of it*, not how the backend works.

**Reminder of the design intent (from the main design doc, §12):** this UI's
only job is to make the agent's reasoning *visible* in under a minute —
citations, the reasoning loops, and the human-approval moment. It is not a
product. Do not build auth, multi-user accounts, settings pages, or a
dashboard. One clean screen, done well, beats five half-built ones.

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

## 4. API contract (exact shape to build against)

```
POST /chat
  body:    { "message": string, "thread_id"?: string }
  returns: {
    "thread_id": string,
    "response"?: string,            // present when a final answer is ready
    "requires_approval": boolean,   // true = render the approval card instead
    "pending_tool_args"?: {         // present when requires_approval is true
      "title": string,
      "body": string,
      "labels": string[]
    }
  }

POST /approve-tool
  body:    { "thread_id": string, "approved": boolean }
  returns: {
    "thread_id": string,
    "response"?: string             // e.g. "Created issue: <url>"
  }

GET /health
  returns: { "status": "ok" }
```

**Session handling:** generate a `thread_id` (UUID) client-side on first
load if the backend didn't already assign one, persist it in memory for
the session (no need for localStorage — see note below), and send it on
every subsequent `/chat` call so the backend's Postgres checkpointer keeps
the right conversation state.

**Citations parsing:** the plain-text `response` field currently embeds a
"Sources:" section as markdown-ish text (see backend `finalize_node`).
Render the answer body and the sources list by splitting on that marker
client-side, OR — better, and worth doing if you have time — ask whoever
maintains the backend to return `citations` as a separate structured array
in the API response instead of embedding it in the string. Flag this as a
"nice to have" backend change; don't block the frontend build on it.

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

## 6. Explicitly out of scope for this build

Do not implement: user authentication, multiple saved conversations,
a settings/preferences panel, file upload, voice input, or a document
viewer/browser for the underlying Handbook pages. If asked to add any of
these "to make it look more complete," the answer is no — a portfolio
demo that clearly does one thing well outperforms one that half-does five
things (see design doc §12 for the reasoning).

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
