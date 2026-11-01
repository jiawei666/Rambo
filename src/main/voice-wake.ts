import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface VoiceWakeSpotterResult {
  keyword: string;
  tokens: string[];
  start_time: number;
}

export interface VoiceWakeStream {
  acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
  inputFinished?(): void;
}

export interface VoiceWakeKeywordSpotter {
  createStream(): VoiceWakeStream;
  isReady(stream: VoiceWakeStream): boolean;
  decode(stream: VoiceWakeStream): void;
  getResult(stream: VoiceWakeStream): VoiceWakeSpotterResult;
  reset(stream: VoiceWakeStream): void;
}

export interface VoiceWakeSpotterConfig {
  featConfig: { sampleRate: number; featureDim: number };
  modelConfig: {
    transducer: { encoder: string; decoder: string; joiner: string };
    tokens: string;
    numThreads: number;
    provider: 'cpu';
    debug: number;
  };
  keywordsFile: string;
  keywordsScore: number;
  keywordsThreshold: number;
  numTrailingBlanks: number;
  maxActivePaths: number;
}

export interface VoiceWakeEngineOptions {
  modelDirectory: string;
  createSpotter: (config: VoiceWakeSpotterConfig) => VoiceWakeKeywordSpotter;
}

const SAMPLE_RATE = 16_000;
const MODEL_FILES = {
  encoder: 'encoder-epoch-13-avg-2-chunk-16-left-64.int8.onnx',
  decoder: 'decoder-epoch-13-avg-2-chunk-16-left-64.onnx',
  joiner: 'joiner-epoch-13-avg-2-chunk-16-left-64.int8.onnx',
  tokens: 'tokens.txt',
  keywords: 'keywords.txt'
} as const;

/**
 * Thin, testable wrapper around sherpa-onnx keyword spotting.
 * Audio remains in memory and is never persisted by this class.
 */
export class VoiceWakeEngine {
  readonly sampleRate = SAMPLE_RATE;
  private spotter: VoiceWakeKeywordSpotter | null = null;
  private stream: VoiceWakeStream | null = null;

  constructor(private readonly options: VoiceWakeEngineOptions) {}

  start(): void {
    this.close();
    const paths = Object.fromEntries(
      Object.entries(MODEL_FILES).map(([key, file]) => [key, join(this.options.modelDirectory, file)])
    ) as Record<keyof typeof MODEL_FILES, string>;
    for (const [name, path] of Object.entries(paths)) {
      if (!existsSync(path)) throw new Error(`本机唤醒模型缺少 ${name} 文件：${path}`);
    }
    const spotter = this.options.createSpotter({
      featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
      modelConfig: {
        transducer: {
          encoder: paths.encoder,
          decoder: paths.decoder,
          joiner: paths.joiner
        },
        tokens: paths.tokens,
        numThreads: 1,
        provider: 'cpu',
        debug: 0
      },
      keywordsFile: paths.keywords,
      keywordsScore: 1.5,
      keywordsThreshold: 0.25,
      numTrailingBlanks: 2,
      maxActivePaths: 4
    });
    this.spotter = spotter;
    this.stream = spotter.createStream();
  }

  push(samples: Float32Array): string | null {
    const spotter = this.spotter;
    const stream = this.stream;
    if (!spotter || !stream || !samples.length) return null;
    if (samples.length > SAMPLE_RATE) throw new Error('唤醒音频分块过大');
    stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
    // Bound each drain so malformed native state cannot block the main process.
    for (let decoded = 0; decoded < 64 && spotter.isReady(stream); decoded += 1) {
      spotter.decode(stream);
      const result = spotter.getResult(stream);
      if (result.keyword) {
        spotter.reset(stream);
        return result.keyword;
      }
    }
    return null;
  }

  close(): void {
    const spotter = this.spotter;
    const stream = this.stream;
    this.spotter = null;
    this.stream = null;
    if (!spotter || !stream) return;
    try {
      spotter.reset(stream);
      stream.inputFinished?.();
    } catch {
      // Closing a partially decoded native stream is best effort.
    }
  }
}
