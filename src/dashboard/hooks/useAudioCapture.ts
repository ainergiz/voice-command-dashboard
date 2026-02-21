import { useState, useRef, useCallback, useEffect } from "react";

interface UseAudioCaptureOptions {
  onAudioFrame: (pcmBase64: string) => void;
  onLevelChange?: (level: number) => void;
}

interface UseAudioCaptureResult {
  isCapturing: boolean;
  isDemoPlaying: boolean;
  start: () => Promise<void>;
  startDemo: () => Promise<void>;
  stop: () => void;
  error: string | null;
}

export function useAudioCapture({
  onAudioFrame,
  onLevelChange,
}: UseAudioCaptureOptions): UseAudioCaptureResult {
  const [isCapturing, setIsCapturing] = useState(false);
  const [isDemoPlaying, setIsDemoPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const streamRef = useRef<MediaStream | null>(null);
  const contextRef = useRef<AudioContext | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);
  const sourceNodeRef = useRef<AudioBufferSourceNode | null>(null);

  // Stable refs for callbacks
  const onAudioFrameRef = useRef(onAudioFrame);
  const onLevelChangeRef = useRef(onLevelChange);
  useEffect(() => {
    onAudioFrameRef.current = onAudioFrame;
    onLevelChangeRef.current = onLevelChange;
  }, [onAudioFrame, onLevelChange]);

  const setupWorklet = useCallback(async (ctx: AudioContext) => {
    await ctx.audioWorklet.addModule("/audio-processor.worklet.js");
    const workletNode = new AudioWorkletNode(ctx, "audio-processor");
    workletRef.current = workletNode;

    workletNode.port.onmessage = (event) => {
      if (event.data.type === "audio_frame") {
        const bytes = new Uint8Array(event.data.pcm);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        const base64 = btoa(binary);
        onAudioFrameRef.current(base64);

        if (onLevelChangeRef.current) {
          onLevelChangeRef.current(event.data.level);
        }
      }
    };

    return workletNode;
  }, []);

  const start = useCallback(async () => {
    try {
      setError(null);

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
        },
      });
      streamRef.current = stream;

      const ctx = new AudioContext({ sampleRate: 48000 });
      contextRef.current = ctx;

      const workletNode = await setupWorklet(ctx);
      const source = ctx.createMediaStreamSource(stream);
      source.connect(workletNode);

      setIsCapturing(true);
    } catch (err) {
      const message =
        err instanceof DOMException && err.name === "NotAllowedError"
          ? "Microphone access denied. Please allow microphone access."
          : `Failed to start audio capture: ${err instanceof Error ? err.message : String(err)}`;
      setError(message);
      setIsCapturing(false);
    }
  }, [setupWorklet]);

  const startDemo = useCallback(async () => {
    try {
      setError(null);

      const response = await fetch("/demo-meeting.wav");
      if (!response.ok) throw new Error("Failed to load demo audio");
      const arrayBuffer = await response.arrayBuffer();

      // Decode at 48kHz to match the worklet's expected input sample rate
      const ctx = new AudioContext({ sampleRate: 48000 });
      contextRef.current = ctx;

      const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

      const workletNode = await setupWorklet(ctx);

      const bufferSource = ctx.createBufferSource();
      bufferSource.buffer = audioBuffer;
      bufferSource.connect(workletNode);
      // Also play through speakers so the user hears the demo
      bufferSource.connect(ctx.destination);
      sourceNodeRef.current = bufferSource;

      bufferSource.onended = () => {
        setIsCapturing(false);
        setIsDemoPlaying(false);
      };

      bufferSource.start();
      setIsCapturing(true);
      setIsDemoPlaying(true);
    } catch (err) {
      const message = `Failed to play demo: ${err instanceof Error ? err.message : String(err)}`;
      setError(message);
      setIsCapturing(false);
      setIsDemoPlaying(false);
    }
  }, [setupWorklet]);

  const stop = useCallback(() => {
    if (sourceNodeRef.current) {
      try { sourceNodeRef.current.stop(); } catch { /* already stopped */ }
      sourceNodeRef.current = null;
    }
    if (workletRef.current) {
      workletRef.current.disconnect();
      workletRef.current = null;
    }
    if (contextRef.current) {
      contextRef.current.close();
      contextRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    setIsCapturing(false);
    setIsDemoPlaying(false);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (sourceNodeRef.current) {
        try { sourceNodeRef.current.stop(); } catch { /* ok */ }
      }
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((t) => t.stop());
      }
      if (contextRef.current) {
        contextRef.current.close();
      }
    };
  }, []);

  return { isCapturing, isDemoPlaying, start, startDemo, stop, error };
}
