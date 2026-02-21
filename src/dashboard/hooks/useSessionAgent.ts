import { useState, useEffect, useRef, useCallback } from "react";
import type {
  DashboardMessage,
  SessionState,
  TranscriptEntry,
} from "../types";
import { INITIAL_SESSION_STATE } from "../types";

const MAX_RECONNECT_DELAY = 30_000;
const BASE_RECONNECT_DELAY = 1_000;
const MAX_TRANSCRIPT_ENTRIES = 80;

export interface UseSessionAgentResult {
  state: SessionState;
  connected: boolean;
  streamingClarification: { id: string; text: string } | null;
  processingStage: string | null;
  sendAudioChunk: (base64: string) => void;
  startSession: () => void;
  stopSession: () => void;
  answerClarification: (id: string, answer: string) => void;
  requestAnalysis: () => void;
  undoLastDeepRun: () => void;
}

function dedupeTranscript(entries: TranscriptEntry[]): TranscriptEntry[] {
  const byId = new Map<string, TranscriptEntry>();
  for (const entry of entries) {
    const key = entry.id || `${entry.timestamp}|${entry.isFinal ? "1" : "0"}|${entry.text}`;
    byId.set(key, entry);
  }
  const deduped = [...byId.values()];
  if (deduped.length > MAX_TRANSCRIPT_ENTRIES) {
    deduped.splice(0, deduped.length - MAX_TRANSCRIPT_ENTRIES);
  }
  return deduped;
}

export function useSessionAgent({ sessionId }: { sessionId: string }): UseSessionAgentResult {
  const [state, setState] = useState<SessionState>(INITIAL_SESSION_STATE);
  const [connected, setConnected] = useState(false);
  const [streamingClarification, setStreamingClarification] = useState<{ id: string; text: string } | null>(null);
  const [processingStage, setProcessingStage] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const send = useCallback((message: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }, []);

  const sendAudioChunk = useCallback(
    (base64: string) => send({ type: "audio_chunk", data: base64 }),
    [send]
  );

  const startSession = useCallback(
    () => send({ type: "start_session" }),
    [send]
  );

  const stopSession = useCallback(
    () => send({ type: "stop_session" }),
    [send]
  );

  const answerClarification = useCallback(
    (id: string, answer: string) => send({ type: "answer_clarification", id, answer }),
    [send]
  );

  const requestAnalysis = useCallback(
    () => send({ type: "request_analysis" }),
    [send]
  );

  const undoLastDeepRun = useCallback(
    () => send({ type: "undo_last_deep_run" }),
    [send]
  );

  const handleMessage = useCallback((msg: DashboardMessage) => {
    switch (msg.type) {
      case "welcome":
        setState({
          ...msg.state,
          recentTranscript: dedupeTranscript(msg.state.recentTranscript),
        });
        break;

      case "transcript_interim":
        setState((prev) => {
          const entries = [...prev.recentTranscript];
          const lastIdx = entries.length - 1;
          const interimEntry: TranscriptEntry = {
            id: `interim-${msg.timestamp}`,
            text: msg.text,
            timestamp: msg.timestamp,
            isFinal: false,
          };
          if (lastIdx >= 0 && !entries[lastIdx].isFinal) {
            entries[lastIdx] = interimEntry;
          } else {
            entries.push(interimEntry);
          }
          return { ...prev, recentTranscript: dedupeTranscript(entries) };
        });
        break;

      case "transcript_final":
        setState((prev) => {
          const entries = [...prev.recentTranscript];
          const finalEntry: TranscriptEntry = {
            id: msg.id,
            text: msg.text,
            timestamp: msg.timestamp,
            isFinal: true,
          };
          const lastIdx = entries.length - 1;
          if (lastIdx >= 0 && !entries[lastIdx].isFinal) {
            entries[lastIdx] = finalEntry;
          } else {
            const alreadyExists = entries.some((entry) => entry.id === msg.id);
            if (!alreadyExists) entries.push(finalEntry);
          }
          return { ...prev, recentTranscript: dedupeTranscript(entries) };
        });
        break;

      case "insights_update":
        setState((prev) => ({
          ...prev,
          items: msg.items,
          relations: msg.relations,
          entities: msg.entities,
          topics: msg.topics,
        }));
        break;

      case "clarification_chunk":
        if (msg.done) {
          setStreamingClarification(null);
          setState((prev) => {
            const existing = prev.clarifications.find((c) => c.id === msg.id);
            if (existing) return prev;
            return {
              ...prev,
              clarifications: [
                ...prev.clarifications,
                {
                  id: msg.id,
                  question: msg.text,
                  context: "",
                  answer: null,
                  relatedItemIds: [],
                },
              ],
            };
          });
        } else {
          setStreamingClarification({ id: msg.id, text: msg.text });
        }
        break;

      case "session_status":
        setState((prev) => ({ ...prev, status: msg.status }));
        break;

      case "processing":
        setProcessingStage(msg.stage);
        break;

      case "error":
        console.error("Session error:", msg.message);
        break;
    }
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let isDisposed = false;

    function clearReconnectTimer() {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    }

    function connect() {
      if (isDisposed) return;
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const url = `${protocol}//${window.location.host}/agents/session-agent/${sessionId}`;

      const ws = new WebSocket(url);
      const previous = wsRef.current;
      wsRef.current = ws;
      if (previous && previous !== ws && previous.readyState !== WebSocket.CLOSED) {
        previous.close();
      }

      ws.addEventListener("open", () => {
        if (isDisposed || wsRef.current !== ws) {
          ws.close();
          return;
        }
        clearReconnectTimer();
        setConnected(true);
        reconnectAttemptRef.current = 0;
      });

      ws.addEventListener("message", (event) => {
        if (isDisposed || wsRef.current !== ws) return;
        try {
          const msg: DashboardMessage = JSON.parse(event.data);
          handleMessage(msg);
        } catch {
          // Ignore malformed messages.
        }
      });

      ws.addEventListener("close", () => {
        if (wsRef.current === ws) {
          wsRef.current = null;
        }
        if (isDisposed) return;
        setConnected(false);
        scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        if (isDisposed || wsRef.current !== ws) return;
        ws.close();
      });
    }

    function scheduleReconnect() {
      if (isDisposed || reconnectTimerRef.current) return;
      const attempt = reconnectAttemptRef.current;
      const delay = Math.min(BASE_RECONNECT_DELAY * 2 ** attempt, MAX_RECONNECT_DELAY);
      reconnectAttemptRef.current = attempt + 1;
      reconnectTimerRef.current = setTimeout(() => {
        reconnectTimerRef.current = null;
        connect();
      }, delay);
    }

    connect();

    return () => {
      isDisposed = true;
      clearReconnectTimer();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) ws.close();
    };
  }, [sessionId, handleMessage]);

  return {
    state,
    connected,
    streamingClarification,
    processingStage,
    sendAudioChunk,
    startSession,
    stopSession,
    answerClarification,
    requestAnalysis,
    undoLastDeepRun,
  };
}
