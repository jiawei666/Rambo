import type { VoiceAudioChunk } from '../shared/contracts';

export const LIVE_PLAYBACK_GAIN = 2;
const LIVE_PCM_START_DELAY_SECONDS = 0.06;

interface LivePcmPlaybackGraph {
  gain: GainNode;
  limiter: DynamicsCompressorNode;
}

function createLivePlaybackOutput(
  context: AudioContext,
  destination: AudioNode = context.destination
): LivePcmPlaybackGraph {
  const gain = context.createGain();
  gain.gain.value = LIVE_PLAYBACK_GAIN;

  const limiter = context.createDynamicsCompressor();
  limiter.threshold.value = -6;
  limiter.knee.value = 0;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;

  gain.connect(limiter);
  limiter.connect(destination);
  return { gain, limiter };
}

export function decodeBase64Pcm16le(
  data: string,
  numChannels: number
): Float32Array<ArrayBuffer>[] {
  if (!Number.isInteger(numChannels) || numChannels < 1 || numChannels > 2) {
    throw new Error(`Unsupported PCM channel count: ${numChannels}`);
  }
  const binary = globalThis.atob(data);
  const frameCount = Math.floor(binary.length / (2 * numChannels));
  const channels = Array.from(
    { length: numChannels },
    () => new Float32Array(new ArrayBuffer(frameCount * Float32Array.BYTES_PER_ELEMENT))
  );
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const offset = (frame * numChannels + channel) * 2;
      const sample = binary.charCodeAt(offset) | (binary.charCodeAt(offset + 1) << 8);
      channels[channel][frame] = (sample >= 0x8000 ? sample - 0x10000 : sample) / 0x8000;
    }
  }
  return channels;
}

/**
 * Schedules App Server PCM chunks back-to-back on the Web Audio clock. Starting
 * slightly ahead of the first chunk avoids turning normal IPC jitter into
 * audible gaps without adding a large conversational delay.
 */
export class LivePcmPlayback {
  private readonly output: LivePcmPlaybackGraph;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly context: AudioContext;
  private nextStartTime = 0;
  private closed = false;

  constructor(
    context: AudioContext,
    destination: AudioNode = context.destination
  ) {
    this.context = context;
    this.output = createLivePlaybackOutput(context, destination);
  }

  enqueue(chunk: VoiceAudioChunk): boolean {
    if (this.closed || !chunk.data) return false;
    if (!Number.isFinite(chunk.sampleRate) || chunk.sampleRate < 8_000 || chunk.sampleRate > 96_000) {
      return false;
    }

    let channels: Float32Array<ArrayBuffer>[];
    try {
      channels = decodeBase64Pcm16le(chunk.data, chunk.numChannels);
    } catch {
      return false;
    }
    const frameCount = channels[0]?.length ?? 0;
    if (!frameCount) return false;

    const buffer = this.context.createBuffer(chunk.numChannels, frameCount, chunk.sampleRate);
    for (let channel = 0; channel < channels.length; channel++) {
      buffer.copyToChannel(channels[channel], channel);
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.output.gain);
    source.onended = () => this.sources.delete(source);
    this.sources.add(source);

    const now = this.context.currentTime;
    const startAt = Math.max(
      now + LIVE_PCM_START_DELAY_SECONDS,
      this.nextStartTime
    );
    source.start(startAt);
    this.nextStartTime = startAt + buffer.duration;
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const source of this.sources) {
      try { source.stop(); } catch { /* already stopped */ }
      try { source.disconnect(); } catch { /* already disconnected */ }
    }
    this.sources.clear();
    try { this.output.gain.disconnect(); } catch { /* already disconnected */ }
    try { this.output.limiter.disconnect(); } catch { /* already disconnected */ }
  }
}
