// --- STT Provider Interface and Mistral Voxtral Realtime Implementation ---

import type { STTProviderConfig } from "../types/providers";

export type TranscriptCallback = (
  text: string,
  isFinal: boolean,
  confidence: number
) => void;

export type ErrorCallback = (error: Error) => void;

export interface STTProvider {
  connect(): Promise<void>;
  send(audio: ArrayBuffer): void;
  close(): void;
}

// --- Mistral Voxtral Realtime Implementation ---

const MAX_RECONNECT_ATTEMPTS = 3;
const RECONNECT_BASE_DELAY_MS = 500;
// Keep ~3 seconds of 16kHz S16LE audio (32000 bytes/sec)
const MAX_AUDIO_BUFFER_BYTES = 96_000;
// Sentence-ending punctuation pattern
const SENTENCE_END_RE = /[.!?]\s*$/;

export class MistralRealtimeSTT implements STTProvider {
  private ws: WebSocket | null = null;
  private apiKey: string;
  private model: string;
  private delayMs: number;
  private onTranscript: TranscriptCallback;
  private onError: ErrorCallback | null;

  // Reconnection state
  private reconnectAttempts = 0;
  private isIntentionalClose = false;
  private audioBuffer: ArrayBuffer[] = [];
  private audioBufferBytes = 0;
  private isReconnecting = false;
  private sessionReady = false;

  // Transcript accumulation
  private accumulatedText = "";
  private finalizedText = "";
  private audioChunksSent = 0;

  constructor(
    apiKey: string,
    onTranscript: TranscriptCallback,
    model?: string,
    delayMs?: number,
    onError?: ErrorCallback
  ) {
    this.apiKey = apiKey;
    this.model = model ?? "voxtral-mini-transcribe-realtime-2602";
    this.delayMs = delayMs ?? 480;
    this.onTranscript = onTranscript;
    this.onError = onError ?? null;
  }

  async connect(): Promise<void> {
    // Mistral realtime endpoint: model passed as query param
    const url = `https://api.mistral.ai/v1/audio/transcriptions/realtime?model=${encodeURIComponent(this.model)}`;

    // Cloudflare Workers WebSocket via fetch with Upgrade header
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        Upgrade: "websocket",
      },
    });

    this.ws = resp.webSocket;
    if (!this.ws) {
      const body = await resp.text().catch(() => "(no body)");
      throw new Error(
        `Failed to establish Mistral WebSocket (status ${resp.status}): ${body}`
      );
    }
    this.ws.accept();

    // Reset state on successful connection
    this.reconnectAttempts = 0;
    this.sessionReady = false;
    this.accumulatedText = "";
    this.finalizedText = "";
    this.audioChunksSent = 0;

    this.ws.addEventListener("message", (event) => {
      this.handleMessage(event.data);
    });

    this.ws.addEventListener("close", () => {
      this.cleanup();
      if (!this.isIntentionalClose) {
        this.reconnect();
      }
    });

    this.ws.addEventListener("error", (err) => {
      console.error("Mistral WebSocket error:", err);
      this.onError?.(new Error("Mistral WebSocket error"));
    });

    // Session config is sent after receiving session.created in handleMessage
    // No keepalive ping — Mistral doesn't support it
  }

  send(audio: ArrayBuffer): void {
    // Buffer audio if not ready (reconnecting or session not yet created)
    if (this.isReconnecting || !this.sessionReady) {
      this.audioBuffer.push(audio);
      this.audioBufferBytes += audio.byteLength;
      while (this.audioBufferBytes > MAX_AUDIO_BUFFER_BYTES && this.audioBuffer.length > 0) {
        const evicted = this.audioBuffer.shift()!;
        this.audioBufferBytes -= evicted.byteLength;
      }
      return;
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      const base64 = arrayBufferToBase64(audio);
      this.ws.send(
        JSON.stringify({
          type: "input_audio.append",
          audio: base64,
        })
      );
      this.audioChunksSent++;
      if (this.audioChunksSent <= 3 || this.audioChunksSent % 100 === 0) {
        console.log(`Mistral: audio chunk #${this.audioChunksSent}`);
      }
    }
  }

  close(): void {
    this.isIntentionalClose = true;
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: "input_audio.end" }));
    }
    // Flush any remaining accumulated text as final
    if (this.accumulatedText.trim()) {
      this.onTranscript(this.accumulatedText.trim(), true, 1.0);
      this.accumulatedText = "";
    }
    this.cleanup();
  }

  private async reconnect(): Promise<void> {
    if (this.isIntentionalClose || this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
        console.error(`Mistral: max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
        this.onError?.(new Error("Mistral: max reconnect attempts reached"));
      }
      return;
    }

    this.isReconnecting = true;
    this.reconnectAttempts++;
    const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempts - 1);

    console.log(`Mistral: reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS})`);
    await new Promise((r) => setTimeout(r, delay));

    try {
      await this.connect();
      // Flush buffered audio
      const buffered = this.audioBuffer;
      this.audioBuffer = [];
      this.audioBufferBytes = 0;
      for (const buf of buffered) {
        this.send(buf);
      }
    } catch (err) {
      console.error("Mistral: reconnection failed:", err);
      this.onError?.(err instanceof Error ? err : new Error(String(err)));
      this.reconnect();
    } finally {
      this.isReconnecting = false;
    }
  }

  private handleMessage(data: string | ArrayBuffer): void {
    if (typeof data !== "string") return;

    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data);
    } catch {
      console.error("Failed to parse Mistral message");
      return;
    }

    const type = parsed.type as string;

    switch (type) {
      case "transcription.text.delta": {
        const text = parsed.text as string;
        this.accumulatedText += text;

        // Check for sentence boundary — emit only final, no interim for this text
        if (SENTENCE_END_RE.test(this.accumulatedText)) {
          const sentence = this.accumulatedText.trim();
          console.log("Mistral: sentence finalized:", sentence);
          this.onTranscript(sentence, true, 1.0);
          this.finalizedText += (this.finalizedText ? " " : "") + sentence;
          this.accumulatedText = "";
        } else if (this.accumulatedText.trim()) {
          // Broadcast interim only when NOT at a sentence boundary
          this.onTranscript(this.accumulatedText.trim(), false, 0.8);
        }
        break;
      }

      case "transcription.done":
        // Stream ended — flush remaining text
        if (this.accumulatedText.trim()) {
          console.log("Mistral: transcription.done, flushing:", this.accumulatedText.trim());
          this.onTranscript(this.accumulatedText.trim(), true, 1.0);
          this.accumulatedText = "";
        }
        break;

      case "error": {
        const errMsg = (parsed.error as any)?.message ?? JSON.stringify(parsed);
        console.error("Mistral STT error:", errMsg);
        this.onError?.(new Error(`Mistral STT: ${errMsg}`));
        break;
      }

      case "session.created":
        console.log("Mistral session created");
        this.ws?.send(
          JSON.stringify({
            type: "session.update",
            session: {
              audio_format: {
                encoding: "pcm_s16le",
                sample_rate: 16000,
              },
              target_streaming_delay_ms: this.delayMs,
            },
          })
        );
        this.sessionReady = true;
        // Flush buffered audio
        if (this.audioBuffer.length > 0) {
          console.log(`Mistral: flushing ${this.audioBuffer.length} buffered audio chunks`);
          const buffered = this.audioBuffer;
          this.audioBuffer = [];
          this.audioBufferBytes = 0;
          for (const buf of buffered) {
            this.send(buf);
          }
        }
        break;

      case "session.updated":
        console.log("Mistral session updated OK");
        break;

      default:
        // Silently ignore unknown events (turn.started, turn.done, etc.)
        break;
    }
  }

  private cleanup(): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

// --- Factory ---

export function createSTTProvider(
  config: STTProviderConfig,
  onTranscript: TranscriptCallback,
  onError?: ErrorCallback
): STTProvider {
  switch (config.provider) {
    case "mistral":
      return new MistralRealtimeSTT(
        config.apiKey,
        onTranscript,
        config.model,
        config.delayMs,
        onError
      );

    default:
      throw new Error(`Unknown STT provider: ${config.provider}`);
  }
}
