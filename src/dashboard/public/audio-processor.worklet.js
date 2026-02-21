// AudioWorklet processor: receives 48kHz Float32 from MediaStream,
// downsamples to 16kHz, converts to S16LE, chunks to 480ms frames.

const TARGET_SAMPLE_RATE = 16000;
const FRAME_DURATION_MS = 480;
const FRAME_SAMPLES = (TARGET_SAMPLE_RATE * FRAME_DURATION_MS) / 1000; // 7680 samples

class AudioProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(0);
    this.inputSampleRate = sampleRate;
  }

  process(inputs, _outputs, _parameters) {
    const input = inputs[0]?.[0];
    if (!input || input.length === 0) return true;

    // Accumulate input samples
    const newBuffer = new Float32Array(this.buffer.length + input.length);
    newBuffer.set(this.buffer);
    newBuffer.set(input, this.buffer.length);
    this.buffer = newBuffer;

    // Calculate how many input samples we need for one output frame
    const ratio = this.inputSampleRate / TARGET_SAMPLE_RATE;
    const inputSamplesPerFrame = Math.ceil(FRAME_SAMPLES * ratio);

    // Process complete frames
    while (this.buffer.length >= inputSamplesPerFrame) {
      // Downsample
      const downsampled = new Float32Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        const srcIndex = Math.round(i * ratio);
        downsampled[i] = this.buffer[Math.min(srcIndex, this.buffer.length - 1)];
      }

      // Convert to S16LE
      const pcm = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i++) {
        const s = Math.max(-1, Math.min(1, downsampled[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      // Calculate RMS level for the audio meter
      let sum = 0;
      for (let i = 0; i < downsampled.length; i++) {
        sum += downsampled[i] * downsampled[i];
      }
      const rms = Math.sqrt(sum / downsampled.length);

      // Send PCM frame to main thread
      this.port.postMessage(
        { type: "audio_frame", pcm: pcm.buffer, level: rms },
        [pcm.buffer]
      );

      // Advance buffer
      this.buffer = this.buffer.slice(inputSamplesPerFrame);
    }

    return true;
  }
}

registerProcessor("audio-processor", AudioProcessor);
