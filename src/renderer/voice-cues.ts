export type VoiceCue = 'wake' | 'connected' | 'ended';

interface VoiceCueNote {
  frequency: number;
  start: number;
  duration: number;
  volume: number;
  harmonicVolume: number;
}

const CUE_ASSETS: Record<VoiceCue, { file: string; revision: string }> = {
  wake: {
    file: 'wake.mp3',
    revision: 'f21ee21d214e03d6c167295216e5805c328ca8f457412a131d4b6a52ecc4fbdd'
  },
  connected: {
    file: 'connected.mp3',
    revision: '2969330ad97291b5d4552b7a3815bd2758cfa19aed4132611421e337ddef68f8'
  },
  ended: {
    file: 'ended.mp3',
    revision: '315595d577a5050640c3616d504bce74e35c11410c42b0d7191d8ef7d68366f7'
  }
};

// These cues are only a local fallback if the bundled media cannot be loaded.
const FALLBACK_CUES: Record<VoiceCue, VoiceCueNote[]> = {
  wake: [
    { frequency: 987.77, start: 0, duration: 0.12, volume: 0.58, harmonicVolume: 0.18 },
    { frequency: 1318.51, start: 0.13, duration: 0.2, volume: 0.64, harmonicVolume: 0.2 }
  ],
  connected: [
    { frequency: 659.25, start: 0, duration: 0.15, volume: 0.58, harmonicVolume: 0.18 },
    { frequency: 830.61, start: 0.16, duration: 0.15, volume: 0.64, harmonicVolume: 0.2 },
    { frequency: 987.77, start: 0.32, duration: 0.17, volume: 0.68, harmonicVolume: 0.22 },
    { frequency: 1318.51, start: 0.51, duration: 0.34, volume: 0.72, harmonicVolume: 0.24 }
  ],
  ended: [
    { frequency: 987.77, start: 0, duration: 0.15, volume: 0.62, harmonicVolume: 0.2 },
    { frequency: 830.61, start: 0.16, duration: 0.17, volume: 0.66, harmonicVolume: 0.22 },
    { frequency: 659.25, start: 0.34, duration: 0.34, volume: 0.7, harmonicVolume: 0.24 }
  ]
};

const CUE_TAIL_MS = 40;
const AUDIO_END_TIMEOUT_MS = 2_500;
const MEDIA_VOLUME = 0.75;
let cueContext: AudioContext | null = null;
let primeAttempted = false;
let primingCueAudio: Promise<void> | null = null;
const cueAudio = new Map<VoiceCue, HTMLAudioElement>();

function getCueContext(): AudioContext | null {
  if (cueContext && cueContext.state !== 'closed') return cueContext;
  const Context = globalThis.AudioContext;
  if (!Context) return null;
  try {
    cueContext = new Context({ latencyHint: 'interactive' });
  } catch {
    return null;
  }
  return cueContext;
}

function cueSource(cue: VoiceCue): string {
  const { file, revision } = CUE_ASSETS[cue];
  // Content-addressed query prevents a replaced cue from reusing Chromium's
  // previously decoded media cache under the same public asset URL.
  return `./voice-cues/scifi/${file}?v=${revision}`;
}

function getCueAudio(cue: VoiceCue): HTMLAudioElement | null {
  const cached = cueAudio.get(cue);
  if (cached) return cached;
  const AudioConstructor = globalThis.Audio;
  if (!AudioConstructor) return null;
  const audio = new AudioConstructor(cueSource(cue));
  audio.preload = 'auto';
  audio.volume = MEDIA_VOLUME;
  cueAudio.set(cue, audio);
  return audio;
}

function primeCueAudio(): Promise<void> {
  if (primingCueAudio) return primingCueAudio;
  if (primeAttempted) return Promise.resolve();
  const audio = getCueAudio('connected');
  if (!audio) return Promise.resolve();
  primeAttempted = true;
  primingCueAudio = (async () => {
    const previousMuted = audio.muted;
    audio.muted = true;
    audio.currentTime = 0;
    try {
      await audio.play();
      audio.pause();
      audio.currentTime = 0;
    } catch {
      primeAttempted = false;
    } finally {
      audio.muted = previousMuted;
      primingCueAudio = null;
    }
  })();
  return primingCueAudio;
}

/**
 * Starts loading the bundled cues and unlocks the media element from a user
 * gesture. No audible cue is played by this function.
 */
export function warmVoiceCues(): void {
  for (const cue of Object.keys(CUE_ASSETS) as VoiceCue[]) getCueAudio(cue);
  void primeCueAudio();
}

function waitForAudioEnd(audio: HTMLAudioElement): Promise<void> {
  if (audio.ended) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onEnded = () => finish();
    const onError = () => finish(new Error('提示音加载失败'));
    const timeout = setTimeout(() => finish(new Error('提示音播放超时')), AUDIO_END_TIMEOUT_MS);
    audio.addEventListener('ended', onEnded, { once: true });
    audio.addEventListener('error', onError, { once: true });
  });
}

async function playAudioCue(cue: VoiceCue): Promise<void> {
  if (primingCueAudio) await primingCueAudio;
  const audio = getCueAudio(cue);
  if (!audio) throw new Error('当前环境不支持媒体播放');
  const ended = waitForAudioEnd(audio);
  audio.muted = false;
  audio.pause();
  audio.currentTime = 0;
  await audio.play();
  await ended;
}

async function playSynthesizedCue(cue: VoiceCue): Promise<void> {
  const context = getCueContext();
  if (!context) return;
  if (context.state === 'suspended') await context.resume();
  if (context.state !== 'running') return;
  const startAt = context.currentTime + 0.015;
  const notes = FALLBACK_CUES[cue];
  for (const note of notes) {
    const start = startAt + note.start;
    const stop = start + note.duration;
    for (const partial of [
      { ratio: 1, type: 'triangle' as OscillatorType, volume: note.volume },
      { ratio: 2, type: 'sine' as OscillatorType, volume: note.harmonicVolume }
    ]) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = partial.type;
      oscillator.frequency.setValueAtTime(note.frequency * partial.ratio, start);
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(partial.volume, start + 0.012);
      gain.gain.exponentialRampToValueAtTime(0.0001, stop);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(start);
      oscillator.stop(stop + 0.02);
    }
  }
  const lastStop = Math.max(...notes.map(note => startAt + note.start + note.duration));
  const waitMs = Math.max(0, Math.ceil((lastStop - context.currentTime) * 1000)) + CUE_TAIL_MS;
  await new Promise<void>(resolve => setTimeout(resolve, waitMs));
}

export async function playVoiceCue(cue: VoiceCue): Promise<void> {
  try {
    await playAudioCue(cue);
  } catch {
    // Bundled media is preferred; keep Live usable if it is unavailable.
    await playSynthesizedCue(cue).catch(() => {});
  }
}
