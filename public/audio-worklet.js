// This file is intentionally plain JavaScript so packaged desktop builds
// always ship a loadable AudioWorklet module instead of a raw TypeScript asset.

const LOW_WATER_FRAMES = 16_384;
const PROGRESS_INTERVAL_FRAMES = 2_048;

class DarktonePcmPlayerProcessor extends AudioWorkletProcessor {
  generation = 0;
  operationToken = 0;
  playedFrames = 0;
  bufferedFrames = 0;
  endOfStream = false;
  requestedData = false;
  sentEnded = false;
  framesSinceProgress = 0;
  chunks = [];

  constructor() {
    super();
    this.port.onmessage = (event) => {
      this.handleMessage(event.data);
    };
  }

  process(_inputs, outputs) {
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
        operationToken: this.operationToken,
        bufferedFrames: this.bufferedFrames,
      });
    }

    if (this.endOfStream && this.bufferedFrames === 0 && !this.sentEnded) {
      this.emitProgress();
      this.sentEnded = true;
      this.port.postMessage({
        type: "ended",
        generation: this.generation,
        operationToken: this.operationToken,
        playedFrames: this.playedFrames,
      });
    }

    return true;
  }

  handleMessage(message) {
    if (message.type === "reset") {
      this.generation = message.generation;
      this.operationToken = message.operationToken;
      this.playedFrames = Math.max(0, message.playedFrames);
      this.bufferedFrames = 0;
      this.endOfStream = false;
      this.requestedData = false;
      this.sentEnded = false;
      this.framesSinceProgress = 0;
      this.chunks = [];
      return;
    }

    if (
      message.generation !== this.generation ||
      message.operationToken !== this.operationToken
    ) {
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

  emitProgress() {
    this.framesSinceProgress = 0;
    this.port.postMessage({
      type: "progress",
      generation: this.generation,
      operationToken: this.operationToken,
      playedFrames: this.playedFrames,
      bufferedFrames: this.bufferedFrames,
    });
  }

  writeNextFrame(output, frameIndex) {
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
