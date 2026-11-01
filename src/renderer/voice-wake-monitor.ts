const WAKE_SAMPLE_RATE = 16_000;
const WAKE_BATCH_SAMPLES = 1_600;

const WAKE_WORKLET_SOURCE = `
class RamboWakeCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(${WAKE_BATCH_SAMPLES});
    this.offset = 0;
    this.sum = 0;
    this.count = 0;
    this.accumulated = 0;
    this.sampleRatio = sampleRate / ${WAKE_SAMPLE_RATE};
  }

  process(inputs) {
    const channels = inputs[0];
    if (!channels || !channels.length || !channels[0]) return true;
    const frames = channels[0].length;
    for (let frame = 0; frame < frames; frame += 1) {
      let value = 0;
      for (let channel = 0; channel < channels.length; channel += 1) {
        value += channels[channel][frame] || 0;
      }
      this.sum += value / channels.length;
      this.count += 1;
      this.accumulated += 1;
      if (this.accumulated < this.sampleRatio) continue;
      this.accumulated -= this.sampleRatio;
      this.samples[this.offset] = this.sum / this.count;
      this.offset += 1;
      this.sum = 0;
      this.count = 0;
      if (this.offset === this.samples.length) {
        const completed = this.samples;
        this.samples = new Float32Array(${WAKE_BATCH_SAMPLES});
        this.offset = 0;
        this.port.postMessage(completed, [completed.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('rambo-wake-capture', RamboWakeCaptureProcessor);
`;

/**
 * Captures only the PCM needed by the local keyword spotter. It never stores
 * wake audio or sends it to a speech service.
 */
export class VoiceWakeMonitor {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private sink: GainNode | null = null;
  private closed = false;

  async start(): Promise<void> {
    await window.rambo.startVoiceWake();
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: WAKE_SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });
      if (this.closed) throw new Error('本机唤醒已取消');
      const context = new AudioContext({ latencyHint: 'interactive', sampleRate: WAKE_SAMPLE_RATE });
      this.context = context;
      const moduleUrl = URL.createObjectURL(new Blob(
        [WAKE_WORKLET_SOURCE],
        { type: 'text/javascript' }
      ));
      try {
        await context.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
      const source = context.createMediaStreamSource(this.stream);
      const worklet = new AudioWorkletNode(context, 'rambo-wake-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1
      });
      // A silent destination keeps the worklet in the graph without playing mic audio.
      const sink = context.createGain();
      sink.gain.value = 0;
      source.connect(worklet);
      worklet.connect(sink);
      sink.connect(context.destination);
      worklet.port.onmessage = event => {
        if (this.closed || !(event.data instanceof Float32Array)) return;
        window.rambo.sendVoiceWakeAudio(event.data);
      };
      this.source = source;
      this.worklet = worklet;
      this.sink = sink;
      await context.resume();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.source?.disconnect();
    this.sink?.disconnect();
    this.worklet = null;
    this.source = null;
    this.sink = null;
    for (const track of this.stream?.getTracks() ?? []) {
      try { track.stop(); } catch { /* already stopped */ }
    }
    this.stream = null;
    const context = this.context;
    this.context = null;
    if (context && context.state !== 'closed') await context.close().catch(() => {});
    await window.rambo.stopVoiceWake().catch(() => {});
  }
}
