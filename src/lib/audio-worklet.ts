declare abstract class AudioWorkletProcessor {
  readonly port: MessagePort;

  constructor(options?: unknown);

  abstract process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessor,
): void;

type ResetMessage = {
  type: "reset";
  generation: number;
  playedFrames: number;
};

type AppendMessage = {
  type: "append";
  generation: number;
  frames: number;
  channelCount: number;
  endOfStream: boolean;
  samples: Float32Array;
};

type WorkletMessage = ResetMessage | AppendMessage;

type Chunk = {
  data: Float32Array;
  frames: number;
  channelCount: number;
  index: number;
};

const LOW_WATER_FRAMES = 16_384;
const PROGRESS_INTERVAL_FRAMES = 2_048;

class DarktonePcmPlayerProcessor extends AudioWorkletProcessor {
  private generation = 0;
  private playedFrames = 0;
  private bufferedFrames = 0;
  private endOfStream = false;
  private requestedData = false;
  private sentEnded = false;
  private framesSinceProgress = 0;
  private chunks: Chunk[] = [];

  constructor() {
    super();
    this.port.onmessage = (event: MessageEvent<WorkletMessage>) => {
      this.handleMessage(event.data);
    };
  }

  process(_inputs: Float32Array[][], outputs: Float32Array[][]) {
    const output = outputs[0];
    if (!output || output.length === 0) {
      return true;
    }

    const frameCount = output[0]?.length ?? 0;
    for (let frame = 0; frame < frameCount; frame += 1) {
      const hasAudio = this.writeNextFrame(output, frame);
      if (!hasAudio) {
        for (let channel = 0; channel < output.length; channel += 1) {
          output[channel][frame] = 0;
        }
      }
    }

    if (this.framesSinceProgress >= PROGRESS_INTERVAL_FRAMES) {
      this.emitProgress();
    }

    if (!this.endOfStream && this.bufferedFrames <= LOW_WATER_FRAMES && !this.requestedData) {
      this.requestedData = true;
      this.port.postMessage({
        type: "need-data",
        generation: this.generation,
        bufferedFrames: this.bufferedFrames,
      });
    }

    if (this.endOfStream && this.bufferedFrames === 0 && !this.sentEnded) {
      this.emitProgress();
      this.sentEnded = true;
      this.port.postMessage({
        type: "ended",
        generation: this.generation,
        playedFrames: this.playedFrames,
      });
    }

    return true;
  }

  private handleMessage(message: WorkletMessage) {
    if (message.type === "reset") {
      this.generation = message.generation;
      this.playedFrames = Math.max(0, message.playedFrames);
      this.bufferedFrames = 0;
      this.endOfStream = false;
      this.requestedData = false;
      this.sentEnded = false;
      this.framesSinceProgress = 0;
      this.chunks = [];
      return;
    }

    if (message.generation !== this.generation) {
      return;
    }

    this.requestedData = false;
    this.endOfStream = message.endOfStream;

    if (message.frames === 0) {
      return;
    }

    this.bufferedFrames += message.frames;
    this.chunks.push({
      data: message.samples,
      frames: message.frames,
      channelCount: Math.max(1, message.channelCount),
      index: 0,
    });
  }

  private emitProgress() {
    this.framesSinceProgress = 0;
    this.port.postMessage({
      type: "progress",
      generation: this.generation,
      playedFrames: this.playedFrames,
      bufferedFrames: this.bufferedFrames,
    });
  }

  private writeNextFrame(output: Float32Array[], frameIndex: number) {
    const chunk = this.chunks[0];
    if (!chunk) {
      return false;
    }

    const sampleOffset = chunk.index * chunk.channelCount;
    const left = chunk.data[sampleOffset] ?? 0;
    const right = chunk.channelCount > 1 ? (chunk.data[sampleOffset + 1] ?? left) : left;
    const mono = (left + right) * 0.5;

    output[0][frameIndex] = left;
    for (let channel = 1; channel < output.length; channel += 1) {
      output[channel][frameIndex] = channel === 1 ? right : mono;
    }

    chunk.index += 1;
    this.playedFrames += 1;
    this.bufferedFrames = Math.max(0, this.bufferedFrames - 1);
    this.framesSinceProgress += 1;

    if (chunk.index >= chunk.frames) {
      this.chunks.shift();
    }

    return true;
  }
}

registerProcessor("darktone-pcm-player", DarktonePcmPlayerProcessor);
