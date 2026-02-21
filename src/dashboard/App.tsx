import { useState, useCallback } from "react";
import { useSessionAgent } from "./hooks/useSessionAgent";
import { useAudioCapture } from "./hooks/useAudioCapture";
import { SessionHeader } from "./components/SessionHeader";
import { LiveTranscript } from "./components/LiveTranscript";
import { MicControls } from "./components/MicControls";
import { TaskBoard } from "./components/TaskBoard";
import { ClarificationPanel } from "./components/ClarificationPanel";
import { ItemDrawer } from "./components/ItemDrawer";
import type { MeetingItem } from "./types";

function getSessionId(): string {
  const params = new URLSearchParams(window.location.search);
  return params.get("session") || `session-${Date.now()}`;
}

export function App() {
  const [sessionId] = useState(getSessionId);
  const [audioLevel, setAudioLevel] = useState(0);
  const [selectedItem, setSelectedItem] = useState<MeetingItem | null>(null);

  const {
    state,
    connected,
    streamingClarification,
    processingStage,
    sendAudioChunk,
    startSession,
    stopSession,
    answerClarification,
  } = useSessionAgent({ sessionId });

  const {
    isCapturing,
    isDemoPlaying,
    start: startCapture,
    startDemo: startDemoCapture,
    stop: stopCapture,
    error: audioError,
  } = useAudioCapture({
    onAudioFrame: sendAudioChunk,
    onLevelChange: setAudioLevel,
  });

  const handleStart = useCallback(async () => {
    await startCapture();
    startSession();
  }, [startCapture, startSession]);

  const handleStartDemo = useCallback(async () => {
    await startDemoCapture();
    startSession();
  }, [startDemoCapture, startSession]);

  const handleStop = useCallback(() => {
    stopCapture();
    stopSession();
  }, [stopCapture, stopSession]);

  const decisionCount = state.items.filter((item) => item.itemType === "decision").length;
  const actionCount = state.items.filter(
    (item) => item.itemType === "action_item" || item.itemType === "commitment"
  ).length;

  // Keep selected item synced with latest state
  const liveSelectedItem = selectedItem
    ? state.items.find((i) => i.id === selectedItem.id) ?? selectedItem
    : null;

  return (
    <div className="app">
      <div className="app__header">
        <SessionHeader
          sessionId={state.sessionId}
          status={state.status}
          connected={connected}
          itemCount={state.items.length}
          relationCount={state.relations.length}
          entityCount={state.entities.length}
          decisionCount={decisionCount}
          actionCount={actionCount}
        />
      </div>

      <div className="app__body">
        <div className="app__left">
          <div className="panel" style={{ flex: 1 }}>
            <div className="panel__header">Live Transcript</div>
            <div className="panel__body panel__body--no-pad" style={{ flex: 1, position: "relative" }}>
              <LiveTranscript entries={state.recentTranscript} />
            </div>
          </div>
          <MicControls
            status={state.status}
            isCapturing={isCapturing}
            isDemoPlaying={isDemoPlaying}
            audioLevel={audioLevel}
            processingStage={processingStage}
            error={audioError}
            onStart={handleStart}
            onStartDemo={handleStartDemo}
            onStop={handleStop}
          />
        </div>

        <div className="app__right">
          <div className="panel" style={{ flex: 1 }}>
            <div className="panel__header">Meeting Intelligence ({state.items.length})</div>
            <div className="panel__body">
              <TaskBoard
                items={state.items}
                relations={state.relations}
                entities={state.entities}
                onSelectItem={setSelectedItem}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Item detail drawer */}
      {liveSelectedItem && (
        <ItemDrawer
          item={liveSelectedItem}
          relations={state.relations}
          items={state.items}
          entities={state.entities}
          onClose={() => setSelectedItem(null)}
        />
      )}

      {/* Floating toast clarifications */}
      <ClarificationPanel
        clarifications={state.clarifications}
        streamingClarification={streamingClarification}
        onAnswer={answerClarification}
      />
    </div>
  );
}
