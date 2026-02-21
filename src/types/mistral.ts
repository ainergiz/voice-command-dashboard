// --- Mistral Voxtral Realtime Event Types ---

// Client → Mistral events

export interface MistralSessionUpdate {
  type: "session.update";
  session: {
    audio_format?: {
      encoding: "pcm_s16le";
      sample_rate: number;
    };
    target_streaming_delay_ms?: number;
  };
}

export interface MistralAudioAppend {
  type: "input_audio.append";
  audio: string; // base64 PCM S16LE
}

export interface MistralAudioEnd {
  type: "input_audio.end";
}

export type MistralClientEvent =
  | MistralSessionUpdate
  | MistralAudioAppend
  | MistralAudioEnd;

// Mistral → Client events

export interface MistralSessionCreated {
  type: "session.created";
  session_id: string;
}

export interface MistralTranscriptionDelta {
  type: "transcription.text.delta";
  text: string;
}

export interface MistralTranscriptionDone {
  type: "transcription.done";
  text: string;
}

export interface MistralSessionUpdated {
  type: "session.updated";
  session: Record<string, unknown>;
}

export interface MistralError {
  type: "error";
  error: {
    type: string;
    message: string;
    code?: string;
  };
}

export interface MistralTurnStarted {
  type: "turn.started";
}

export interface MistralTurnDone {
  type: "turn.done";
}

export type MistralServerEvent =
  | MistralSessionCreated
  | MistralSessionUpdated
  | MistralTranscriptionDelta
  | MistralTranscriptionDone
  | MistralError
  | MistralTurnStarted
  | MistralTurnDone;
