import { useEffect, useRef, useState, useCallback } from "react";
import type { TranscriptEntry } from "../types";

interface LiveTranscriptProps {
  entries: TranscriptEntry[];
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function LiveTranscript({ entries }: LiveTranscriptProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const prevEntryCountRef = useRef(entries.length);

  const handleScroll = useCallback(() => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    setIsAutoScroll(atBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
      setIsAutoScroll(true);
    }
  }, []);

  useEffect(() => {
    if (isAutoScroll && entries.length !== prevEntryCountRef.current) {
      const el = containerRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
    prevEntryCountRef.current = entries.length;
  }, [entries, isAutoScroll]);

  return (
    <div className="transcript" style={{ position: "relative" }}>
      <div className="transcript__list" ref={containerRef} onScroll={handleScroll}>
        {entries.length === 0 && (
          <div className="transcript__empty">
            Click "Start Recording" and speak to see your transcript here...
          </div>
        )}
        {entries.map((entry, i) => (
          <div
            key={entry.id || `${entry.timestamp}-${i}`}
            className={`transcript__entry ${
              entry.isFinal ? "transcript__entry--final" : "transcript__entry--interim"
            }`}
          >
            <span className="transcript__time">{formatTime(entry.timestamp)}</span>
            {entry.text}
          </div>
        ))}
      </div>
      {!isAutoScroll && (
        <button className="transcript__scroll-btn" onClick={scrollToBottom}>
          Scroll to bottom
        </button>
      )}
    </div>
  );
}
