import type { SessionStatus } from "../types";

interface SessionHeaderProps {
  sessionId: string;
  status: SessionStatus;
  connected: boolean;
  itemCount: number;
  relationCount: number;
  entityCount: number;
  decisionCount: number;
  actionCount: number;
}

export function SessionHeader({
  sessionId,
  status,
  connected,
  itemCount,
  relationCount,
  entityCount,
  decisionCount,
  actionCount,
}: SessionHeaderProps) {
  const dotClass =
    status === "recording"
      ? "session-header__dot--recording"
      : status === "completed"
        ? "session-header__dot--completed"
        : connected
          ? "session-header__dot--connected"
          : "";

  const statusLabel =
    status === "recording"
      ? "Recording"
      : status === "completed"
        ? "Session Complete"
        : status === "paused"
          ? "Paused"
          : "Ready";

  return (
    <div className="session-header">
      <h1 className="session-header__title">Voice Commands</h1>

      <div className="session-header__status">
        <span className={`session-header__dot ${dotClass}`} />
        <span>{statusLabel}</span>
      </div>

      <div className="session-header__spacer" />

      <div className="session-header__stats">
        <div className="session-header__stat">
          Items: <span className="session-header__stat-value">{itemCount}</span>
        </div>
        <div className="session-header__stat">
          Relations: <span className="session-header__stat-value">{relationCount}</span>
        </div>
        <div className="session-header__stat">
          Entities: <span className="session-header__stat-value">{entityCount}</span>
        </div>
        <div className="session-header__stat">
          Decisions: <span className="session-header__stat-value">{decisionCount}</span>
        </div>
        <div className="session-header__stat">
          Actions: <span className="session-header__stat-value">{actionCount}</span>
        </div>
        {sessionId && (
          <div className="session-header__stat" style={{ opacity: 0.5 }}>
            {sessionId.slice(0, 16)}
          </div>
        )}
      </div>
    </div>
  );
}
