import { useState, useCallback } from "react";
import type { ClarificationQuestion } from "../types";

interface ClarificationPanelProps {
  clarifications: ClarificationQuestion[];
  streamingClarification: { id: string; text: string } | null;
  onAnswer: (id: string, answer: string) => void;
}

const MAX_VISIBLE = 3;

export function ClarificationPanel({
  clarifications,
  streamingClarification,
  onAnswer,
}: ClarificationPanelProps) {
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const [exiting, setExiting] = useState<Set<string>>(new Set());

  const dismiss = useCallback((id: string) => {
    setExiting((prev) => new Set(prev).add(id));
    setTimeout(() => {
      setExiting((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      setDismissed((prev) => new Set(prev).add(id));
    }, 250);
  }, []);

  const handleAnswer = useCallback(
    (id: string, answer: string) => {
      setExiting((prev) => new Set(prev).add(id));
      setTimeout(() => {
        setExiting((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        onAnswer(id, answer);
      }, 250);
    },
    [onAnswer]
  );

  const unanswered = clarifications.filter(
    (c) => !c.answer && !dismissed.has(c.id)
  );

  const items: Array<
    | { type: "streaming"; id: string; text: string }
    | { type: "question"; clr: ClarificationQuestion }
  > = [];

  if (streamingClarification && !dismissed.has(streamingClarification.id)) {
    items.push({ type: "streaming", ...streamingClarification });
  }
  for (const clr of unanswered) {
    items.push({ type: "question", clr });
  }

  if (items.length === 0) return null;

  const visible = items.slice(0, MAX_VISIBLE);
  const overflowCount = items.length - MAX_VISIBLE;

  return (
    <div className="toast-stack">
      {visible.map((item, index) => {
        const id = item.type === "streaming" ? item.id : item.clr.id;
        const isExiting = exiting.has(id);
        return (
          <div
            key={id}
            className={`toast${isExiting ? " toast--exit" : ""}`}
            style={{ "--toast-index": index } as React.CSSProperties}
          >
            <button
              className="toast__dismiss"
              onClick={() => dismiss(id)}
              aria-label="Dismiss"
            >
              &times;
            </button>
            {item.type === "streaming" ? (
              <div className="clarification__question clarification__streaming">
                {item.text}
              </div>
            ) : (
              <ClarificationToast
                clarification={item.clr}
                onAnswer={handleAnswer}
              />
            )}
          </div>
        );
      })}
      {overflowCount > 0 && (
        <div className="toast-stack__overflow">+{overflowCount} more</div>
      )}
    </div>
  );
}

function ClarificationToast({
  clarification,
  onAnswer,
}: {
  clarification: ClarificationQuestion;
  onAnswer: (id: string, answer: string) => void;
}) {
  const [input, setInput] = useState("");

  const handleSubmit = () => {
    if (!input.trim()) return;
    onAnswer(clarification.id, input.trim());
    setInput("");
  };

  return (
    <>
      <div className="clarification__question">{clarification.question}</div>
      <div className="clarification__input-row">
        <input
          className="clarification__input"
          type="text"
          placeholder="Type your answer..."
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSubmit();
          }}
        />
        <button className="clarification__submit" onClick={handleSubmit}>
          Answer
        </button>
      </div>
    </>
  );
}
