"use client";

import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { matchSavedQuestion, maxQuestionLength, normalizeQuestion, type AskAnswer, type AskEvent, type SavedQuestion } from "../lib/ask";

const icons = {
  new: <path d="M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M16 3h5v5m0-5-9 9" />,
  search: <><circle cx="10.8" cy="10.8" r="6.6" /><path d="m16 16 5 5" /></>,
  send: <path d="M12 19V5m-6 6 6-6 6 6" />,
  copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  chevron: <path d="m6 9 6 6 6-6" />,
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></>,
};
const mobileViewport = "(max-width: 800px)";

function Icon({ name }: { name: keyof typeof icons }) {
  return <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{icons[name]}</svg>;
}

type Step = Extract<AskEvent, { type: "step" }>;
type Source = Extract<AskEvent, { type: "answer" }>["source"];
type Exchange = {
  question: string;
  team?: string;
  savedId?: string;
  pending?: boolean;
  answer?: AskAnswer;
  source?: Source;
  error?: string;
  steps: Step[];
};

const stepLabels: Record<Step["action"], string> = {
  search: "Searched meeting transcripts",
  read: "Read transcript context",
  numbers: "Checked numbers in the transcript",
  final: "Verified citations",
};

function StepList({ steps }: { steps: Step[] }) {
  return (
    <ol className="step-list">
      {steps.map(({ step, action, turns }) => (
        <li key={step}>{stepLabels[action]}{action !== "final" && turns > 0 ? ` · ${turns} ${turns === 1 ? "turn" : "turns"}` : ""}</li>
      ))}
    </ol>
  );
}

function CitationCards({ citations }: Pick<AskAnswer, "citations">) {
  return (
    <section className="citation-section" aria-label="Citations">
      <h3>Citations</h3>
      <ul>
        {citations.map(({ meeting_id, quote, context }) => {
          const excerpt = <><span className="citation-id">{meeting_id}</span><q>{quote}</q></>;
          return (
            <li key={JSON.stringify([meeting_id, quote])}>
              {context ? (
                <details className="citation-card">
                  <summary>{excerpt}<Icon name="chevron" /></summary>
                  <div className="citation-context">
                    {context.before && <p className="neighbor-turn">{context.before}</p>}
                    <p className="turn-label">Speaker {context.speaker} · {Math.floor(context.startSeconds / 60)}:{String(context.startSeconds % 60).padStart(2, "0")} · {context.turnId}</p>
                    <p>{context.prefix}<mark>{context.highlight}</mark>{context.suffix}</p>
                    {context.after && <p className="neighbor-turn">{context.after}</p>}
                  </div>
                </details>
              ) : <div className="citation-card quote-only">{excerpt}</div>}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function QuestionBrowser({
  questions, matches, filter, setFilter, selected, select, close,
}: {
  questions: SavedQuestion[];
  matches: SavedQuestion[];
  filter: string;
  setFilter: (value: string) => void;
  selected?: string;
  select: (question: SavedQuestion) => void;
  close?: () => void;
}) {
  return (
    <>
      <div className="sidebar-top">
        <h2>Saved answers</h2>
        {close && <button type="button" className="icon-button" onClick={close} aria-label="Close saved answers"><Icon name="close" /></button>}
      </div>
      <label className="question-search">
        <Icon name="search" />
        <input type="search" aria-label="Search saved questions" placeholder="Search saved questions" value={filter} onChange={(event) => setFilter(event.target.value)} />
      </label>
      <p className="question-count" aria-live="polite">{filter.trim() ? `${matches.length} of ${questions.length} questions` : `${questions.length} questions`}</p>
      <ul className="question-list">
        {matches.map((entry) => (
          <li key={entry.id}>
            <button type="button" aria-current={selected === entry.id ? "true" : undefined} onClick={() => select(entry)}>
              <span className="question-meta">{entry.id} · {entry.team}</span>
              <span className="question-label">{entry.question}</span>
            </button>
          </li>
        ))}
        {matches.length === 0 && <li className="no-results">No saved questions match your search.</li>}
      </ul>
    </>
  );
}

async function readAskStream(response: Response, receive: (event: AskEvent) => void) {
  if (!response.ok) {
    receive(await response.json() as AskEvent);
    return;
  }
  const reader = response.body?.pipeThrough(new TextDecoderStream()).getReader();
  if (!reader) throw new Error("Missing answer stream");
  let buffer = "";
  let finished = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += value;
      const frames = buffer.split("\n\n");
      buffer = frames.pop() ?? "";
      for (const frame of frames) {
        if (!frame.startsWith("data: ")) continue;
        const event = JSON.parse(frame.slice(6)) as AskEvent;
        receive(event);
        if (event.type === "answer" || event.type === "error") finished = true;
      }
    }
    if (!finished) throw new Error("Incomplete answer stream");
  } finally {
    reader.releaseLock();
  }
}

export function AskWorkspace({ questions, teams, liveNotice }: { questions: SavedQuestion[]; teams: string[]; liveNotice?: string }) {
  const [draft, setDraft] = useState("");
  const [team, setTeam] = useState("");
  const [filter, setFilter] = useState("");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [exchange, setExchange] = useState<Exchange>();
  const [copyStatus, setCopyStatus] = useState("");
  const input = useRef<HTMLTextAreaElement>(null);
  const drawer = useRef<HTMLDialogElement>(null);
  const desktopSidebar = useRef<HTMLElement>(null);
  const result = useRef<HTMLElement>(null);
  const scrollArea = useRef<HTMLDivElement>(null);
  const active = useRef<AbortController | null>(null);
  const search = normalizeQuestion(filter);
  const matches = questions.filter(({ id, team, question }) => normalizeQuestion(`${id} ${team} ${question}`).includes(search));

  useEffect(() => {
    const viewport = window.matchMedia(mobileViewport);
    const closeMobileDrawer = () => {
      if (!viewport.matches) drawer.current?.close();
    };
    viewport.addEventListener("change", closeMobileDrawer);
    return () => viewport.removeEventListener("change", closeMobileDrawer);
  }, []);

  function showBrowser() {
    if (window.matchMedia(mobileViewport).matches) {
      drawer.current?.showModal();
      return;
    }
    setSidebarOpen(true);
    requestAnimationFrame(() => desktopSidebar.current?.querySelector("input")?.focus());
  }

  function newQuestion() {
    active.current?.abort();
    active.current = null;
    setExchange(undefined);
    setDraft("");
    setTeam("");
    setCopyStatus("");
    input.current?.focus();
  }

  function showSaved(entry: SavedQuestion) {
    active.current?.abort();
    active.current = null;
    setDraft("");
    setCopyStatus("");
    setExchange({ question: entry.question, team: entry.team, savedId: entry.id, answer: entry.answer, source: "saved", steps: [] });
    scrollArea.current?.scrollTo(0, 0);
    drawer.current?.close();
    requestAnimationFrame(() => result.current?.focus());
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const question = draft.trim();
    if (!question || active.current) return;
    const saved = matchSavedQuestion(questions, question, team || undefined);
    if (saved) return showSaved(saved);

    const controller = new AbortController();
    active.current = controller;
    setCopyStatus("");
    setExchange({ question, team: team || undefined, pending: true, steps: [] });
    scrollArea.current?.scrollTo(0, 0);
    try {
      const response = await fetch("/api/ask", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question, team: team || undefined }), signal: controller.signal,
      });
      await readAskStream(response, (event) => {
        if (controller.signal.aborted) return;
        if (event.type === "answer") setDraft((current) => current.trim() === question ? "" : current);
        setExchange((current) => {
          if (!current) return current;
          switch (event.type) {
            case "step": return { ...current, steps: [...current.steps, event] };
            case "answer": return { ...current, pending: false, answer: event.answer, source: event.source };
            case "error": return { ...current, pending: false, error: event.message };
          }
        });
      });
    } catch {
      if (!controller.signal.aborted) {
        setExchange((current) => current && {
          ...current, pending: false, error: "The connection to Catalist AI was interrupted. Try again or browse saved answers.",
        });
      }
    } finally {
      if (active.current === controller) active.current = null;
    }
  }

  async function copyAnswer() {
    if (!exchange?.answer) return;
    try {
      await navigator.clipboard.writeText(exchange.answer.text);
      setCopyStatus("Copied");
    } catch {
      setCopyStatus("Copy unavailable");
    }
  }

  const browserProps = { questions, matches, filter, setFilter, selected: exchange?.savedId, select: showSaved };
  let message: ReactNode;
  if (exchange?.error) message = <p className="answer-error" role="alert">{exchange.error}</p>;
  else if (exchange?.pending) message = <p className="pending" role="status">Checking the meeting transcripts…</p>;
  else if (exchange?.answer) message = <p className="answer-text">{exchange.answer.text}</p>;

  return (
    <div className="catalist-app">
      <header className="masthead">
        <div className="masthead-start">
          <a className="brand-logo" href="/" aria-label="Catalist AI home">
            <span className="brand-wordmark" aria-hidden="true">CATA<br />LIST</span>
          </a>
          <button type="button" className="icon-button sidebar-toggle" aria-controls="desktop-saved-answers"
            aria-expanded={sidebarOpen} aria-label={sidebarOpen ? "Collapse saved answers sidebar" : "Expand saved answers sidebar"}
            title={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"} onClick={() => setSidebarOpen((open) => !open)}>
            <Icon name="sidebar" />
          </button>
        </div>
        <nav className="masthead-nav" aria-label="Workspace">
          <button type="button" onClick={() => {
            if (exchange?.source === "saved") newQuestion();
            else input.current?.focus();
          }}>Ask</button>
          <button type="button" onClick={showBrowser}>Saved answers</button>
        </nav>
        <button type="button" className="yellow-button" onClick={newQuestion}><Icon name="new" />New question</button>
      </header>
      <div className="workspace">
        <aside id="desktop-saved-answers" className="sidebar desktop-sidebar" aria-label="Saved answers" hidden={!sidebarOpen} ref={desktopSidebar}>
          <QuestionBrowser {...browserProps} />
        </aside>
        <dialog className="mobile-drawer" ref={drawer} aria-label="Saved answers" onClick={(event) => {
          if (event.target === event.currentTarget) event.currentTarget.close();
        }}>
          <div className="sidebar"><QuestionBrowser {...browserProps} close={() => drawer.current?.close()} /></div>
        </dialog>
        <main className="ask-main">
          <div className="chat-scroll" ref={scrollArea}>
            {exchange ? (
              <section className="messages" ref={result} key={exchange.savedId ?? exchange.question} tabIndex={-1} aria-label="Current question and answer">
                <p className="user-bubble">{exchange.question}</p>
                <div className="assistant-message">
                  <span className="assistant-avatar" aria-hidden="true">C</span>
                  <div className="assistant-body">
                    <h2>Catalist AI</h2>
                    {exchange.source && <p className="answer-source">
                      {exchange.source === "saved" ? "Saved answer" : exchange.source === "cached" ? "Cached answer" : "Live answer"}
                      {exchange.team && ` · ${exchange.team}`}
                    </p>}
                    <div aria-live="polite">
                      {message}
                      {exchange.pending && <StepList steps={exchange.steps} />}
                    </div>
                    {exchange.answer && (
                      <>
                        <div className="copy-row">
                          <button type="button" onClick={copyAnswer}><Icon name="copy" /> Copy answer</button>
                          <span role="status">{copyStatus}</span>
                        </div>
                        <CitationCards citations={exchange.answer.citations} />
                      </>
                    )}
                    {!exchange.pending && exchange.steps.length > 0 && (
                      <details className="answer-steps"><summary>Search steps</summary><StepList steps={exchange.steps} /></details>
                    )}
                  </div>
                </div>
              </section>
            ) : (
              <section className="empty-chat">
                <div>
                  <div className="empty-logo" aria-hidden="true">C</div>
                  <h1>What can I help with?</h1>
                  <p>Ask about a design meeting or explore the 25 saved answers.</p>
                  <button type="button" className="mobile-browse" onClick={showBrowser}>Browse saved answers <span aria-hidden="true">↗</span></button>
                </div>
              </section>
            )}
          </div>
          <div className="composer-dock">
            <form className="composer" onSubmit={submit}>
              <textarea ref={input} rows={1} maxLength={maxQuestionLength} placeholder="Ask Catalist AI about a meeting" aria-label="Ask Catalist AI"
                value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }} />
              <div className="composer-bottom">
                <label className="team-picker">Team
                  <select value={team} onChange={(event) => setTeam(event.target.value)} aria-label="Team">
                    <option value="">Auto-detect</option>
                    {teams.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                </label>
                <button type="submit" className="send-button" aria-label="Ask question" disabled={!draft.trim() || exchange?.pending}><Icon name="send" /></button>
              </div>
            </form>
            {liveNotice && <p className="composer-note">{liveNotice}</p>}
          </div>
        </main>
      </div>
    </div>
  );
}
