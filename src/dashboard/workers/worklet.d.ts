// Type declarations for AudioWorklet global scope.
// These are not standard DOM types — they exist only in the AudioWorklet context.

declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new () => AudioWorkletProcessor
): void;

declare const sampleRate: number;
declare const currentTime: number;
declare const currentFrame: number;
