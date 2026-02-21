import { AudioLevelMeter } from "./AudioLevelMeter";
import type { SessionStatus } from "../types";

interface MicControlsProps {
  status: SessionStatus;
  isCapturing: boolean;
  isDemoPlaying: boolean;
  audioLevel: number;
  processingStage: string | null;
  error: string | null;
  onStart: () => void;
  onStartDemo: () => void;
  onStop: () => void;
}

export function MicControls({
  status,
  isCapturing,
  isDemoPlaying,
  audioLevel,
  processingStage,
  error,
  onStart,
  onStartDemo,
  onStop,
}: MicControlsProps) {
  const isRecording = status === "recording";

  return (
    <div className="mic-controls">
      {isRecording ? (
        <button className="mic-controls__btn mic-controls__btn--stop" onClick={onStop}>
          {isDemoPlaying ? "Stop Demo" : "Stop Recording"}
        </button>
      ) : (
        <div className="mic-controls__actions">
          <button className="mic-controls__btn mic-controls__btn--start" onClick={onStart}>
            Start Recording
          </button>
          <button className="mic-controls__btn mic-controls__btn--demo" onClick={onStartDemo}>
            Play Demo
          </button>
        </div>
      )}

      <div className="mic-controls__level">
        {isCapturing && <AudioLevelMeter level={audioLevel} />}
      </div>

      {processingStage && (
        <span className="mic-controls__processing">
          {processingStage === "extracting" ? "Extracting meeting insights..." : "Consolidating meeting context..."}
        </span>
      )}

      {error && <span className="mic-controls__error">{error}</span>}
    </div>
  );
}
