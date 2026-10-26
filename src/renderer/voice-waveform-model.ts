export interface VoiceWaveformFrame {
  levels: number[];
  activity: 'idle' | 'speaking';
}

export interface VoiceWaveformSmoother {
  next(levels: number[], speech: boolean, deltaMs: number): VoiceWaveformFrame;
}

const IDLE_LEVEL = 0.075;
const MIN_DB = -100;
const MAX_DB = -10;
const ENVELOPE_ATTACK_HALF_LIFE_MS = 36;
const ENVELOPE_RELEASE_HALF_LIFE_MS = 90;
const DISPLAY_ATTACK_HALF_LIFE_MS = 96;
const DISPLAY_RELEASE_HALF_LIFE_MS = 180;
const SETTLED_LEVEL_DELTA = 0.0015;

function approach(current: number, target: number, deltaMs: number, halfLifeMs: number): number {
  return current + (target - current) * (1 - Math.pow(0.5, deltaMs / halfLifeMs));
}

// LiveKit's multiband analyser (packages/react/src/hooks/useTrackVolume.ts,
// Apache-2.0) maps clamped decibels through sqrt. This keeps quiet speech
// visible without collapsing all bands into a flat, high row.
export function normalizeVoiceDb(value: number): number {
  if (!Number.isFinite(value)) return 0;
  const clamped = Math.max(MIN_DB, Math.min(MAX_DB, value));
  return Math.sqrt(1 - (clamped * -1) / 100);
}

export interface VoiceFrequencyBandOptions {
  barCount: number;
  loBin: number;
  hiBin: number;
}

// LiveKit's multiband analyser normalizes every dB bin. A slightly logarithmic
// split gives speech fundamentals more resolution than the wide upper bands;
// otherwise low-frequency energy biases the entire left half of the waveform.
export function createVoiceFrequencyBands(
  frequencies: Float32Array,
  { barCount, loBin, hiBin }: VoiceFrequencyBandOptions
): number[] {
  const startBin = Math.max(0, Math.min(frequencies.length - 1, Math.floor(loBin)));
  const endBin = Math.max(startBin + 1, Math.min(frequencies.length, Math.ceil(hiBin)));
  const totalBins = endBin - startBin;
  const bandPosition = (position: number) => Math.floor(totalBins * Math.pow(position, 1.3));

  return Array.from({ length: barCount }, (_, index) => {
    const start = bandPosition(index / barCount);
    const end = Math.max(start + 1, bandPosition((index + 1) / barCount));
    let sum = 0;
    for (let offset = start; offset < end; offset += 1) {
      sum += normalizeVoiceDb(frequencies[startBin + offset]);
    }
    return sum / Math.max(1, end - start);
  });
}

export function voiceFrequencyBinRange(
  sampleRate: number,
  fftSize: number,
  minHz = 90,
  maxHz = 4_000
): { loBin: number; hiBin: number } {
  const binHz = sampleRate / Math.max(1, fftSize);
  return {
    loBin: Math.max(1, Math.floor(minHz / binHz)),
    hiBin: Math.max(2, Math.ceil(maxHz / binHz))
  };
}

// Anchor the visible envelope to the center voice band, then let each side read
// a different real frequency band as texture. Without the radial profile, the
// natural low-to-high speech slope lifts every left bar before the center.
export function centerVoiceFrequencyBands(bands: number[]): number[] {
  const count = bands.length;
  const center = Math.floor(count / 2);
  const maxBand = Math.max(0, ...bands);
  const centerAnchor = Math.max(bands[0] ?? 0, maxBand * 0.35);
  return Array.from({ length: count }, (_, index) => {
    const distance = Math.abs(index - center);
    const bandIndex = distance === 0
      ? 0
      : 2 * (distance - 1) + (index < center ? 1 : 2);
    const independentBand = bands[Math.min(bands.length - 1, bandIndex)] ?? 0;
    const texture = 0.55 + 0.45 * Math.max(0, Math.min(1, independentBand / Math.max(0.001, maxBand)));
    const radialWeight = Math.max(0.28, 1 - distance * 0.11);
    return centerAnchor * radialWeight * texture;
  });
}

export function createVoiceWaveformSmoother(
  barCount: number
): VoiceWaveformSmoother {
  const envelopes = Array.from({ length: barCount }, () => IDLE_LEVEL);
  const displayed = Array.from({ length: barCount }, () => IDLE_LEVEL);

  return {
    next(levels, speech, deltaMs) {
      const delta = Math.min(48, Math.max(8, deltaMs));
      return {
        activity: speech ? 'speaking' : 'idle',
        levels: displayed.map((value, index) => {
          const currentTarget = speech
            ? Math.max(IDLE_LEVEL, Math.min(1, levels[index] ?? 0))
            : IDLE_LEVEL;
          const target = currentTarget;

          // Two cascaded asymmetric filters remove analyser jitter before motion.
          // The second filter gives the bar velocity continuity, so even a large
          // band-to-band jump reads as an eased rise or fall instead of a snap.
          const envelope = approach(
            envelopes[index],
            target,
            delta,
            target > envelopes[index]
              ? ENVELOPE_ATTACK_HALF_LIFE_MS
              : ENVELOPE_RELEASE_HALF_LIFE_MS
          );
          envelopes[index] = envelope;
          const next = approach(
            value,
            envelope,
            delta,
            envelope > value ? DISPLAY_ATTACK_HALF_LIFE_MS : DISPLAY_RELEASE_HALF_LIFE_MS
          );
          displayed[index] = !speech && Math.abs(next - IDLE_LEVEL) < SETTLED_LEVEL_DELTA
            ? IDLE_LEVEL
            : next;
          return displayed[index];
        })
      };
    }
  };
}
