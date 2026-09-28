const PCM_SAMPLE_RATE = 16_000;
const DEFAULT_ASR_ORIGIN = "http://127.0.0.1:10095";

export async function getStreamingAsrAvailability({ fetchImpl = fetch, healthUrl = `${DEFAULT_ASR_ORIGIN}/health` } = {}) {
  try {
    const response = await fetchImpl(healthUrl, { signal: AbortSignal.timeout(900) });
    if (!response.ok) return { ready: false, reason: `ASR health HTTP ${response.status}` };
    const health = await response.json();
    const streaming = health?.streaming || {};
    return {
      ready: streaming.ready === true,
      reason: streaming.error || null,
      url: streaming.endpoint ? `${DEFAULT_ASR_ORIGIN}${streaming.endpoint}`.replace(/^http/, "ws") : `${DEFAULT_ASR_ORIGIN.replace(/^http/, "ws")}/stream`
    };
  } catch {
    return { ready: false, reason: "streaming ASR health unavailable" };
  }
}

export function downsampleToPcm16(input, inputSampleRate, targetSampleRate = PCM_SAMPLE_RATE) {
  return new Pcm16Resampler(inputSampleRate, targetSampleRate).push(input);
}

export class Pcm16Resampler {
  constructor(inputSampleRate, targetSampleRate = PCM_SAMPLE_RATE) {
    if (!Number.isFinite(inputSampleRate) || inputSampleRate < targetSampleRate) throw new RangeError("input sample rate must be at least target sample rate");
    this.inputSampleRate = inputSampleRate;
    this.targetSampleRate = targetSampleRate;
    this.pending = new Float32Array(0);
    this.pendingStart = 0;
    this.totalInputSamples = 0;
    this.outputIndex = 0;
  }

  push(input) {
  if (!(input instanceof Float32Array)) throw new TypeError("input must be Float32Array");
    const samples = new Float32Array(this.pending.length + input.length);
    samples.set(this.pending);
    samples.set(input, this.pending.length);
    this.totalInputSamples += input.length;
    const output = [];
    // Keep timing in integer sample-rate units. Floating-point phase drift
    // otherwise makes adjacent 4096-frame 44.1 kHz blocks disagree with a
    // one-shot resample after enough callbacks.
    while ((this.outputIndex + 1) * this.inputSampleRate <= this.totalInputSamples * this.targetSampleRate) {
      const startAbsolute = Math.floor(this.outputIndex * this.inputSampleRate / this.targetSampleRate);
      const endAbsolute = Math.ceil((this.outputIndex + 1) * this.inputSampleRate / this.targetSampleRate);
      const start = startAbsolute - this.pendingStart;
      const end = endAbsolute - this.pendingStart;
      let sum = 0;
      for (let sample = start; sample < end; sample += 1) sum += samples[sample] || 0;
      output.push(toPcm16(sum / Math.max(1, end - start)));
      this.outputIndex += 1;
    }
    const nextStart = Math.floor(this.outputIndex * this.inputSampleRate / this.targetSampleRate);
    this.pending = samples.slice(nextStart - this.pendingStart);
    this.pendingStart = nextStart;
    return Int16Array.from(output);
  }
}

function toPcm16(value) {
  const sample = Math.max(-1, Math.min(1, Number(value) || 0));
  return sample < 0 ? Math.round(sample * 32768) : Math.round(sample * 32767);
}

export class StreamingAsrClient {
  constructor({ url, onTranscript = () => {}, webSocketFactory = target => new WebSocket(target), audioContextFactory = () => new AudioContext(), readyTimeoutMs = 1_500, finishTimeoutMs = 3_000, maxBufferedBytes = 128_000 } = {}) {
    if (!url) throw new Error("streaming ASR WebSocket URL is required");
    this.url = url;
    this.onTranscript = onTranscript;
    this.webSocketFactory = webSocketFactory;
    this.audioContextFactory = audioContextFactory;
    this.readyTimeoutMs = readyTimeoutMs;
    this.finishTimeoutMs = finishTimeoutMs;
    this.maxBufferedBytes = maxBufferedBytes;
    this.socket = null;
    this.context = null;
    this.source = null;
    this.processor = null;
    this.sink = null;
    this.state = "idle";
    this.segments = new Map();
    this.finalEvent = null;
    this.resampler = null;
    this._generation = 0;
    this._ready = null;
    this._finished = null;
  }

  get active() {
    return this.state === "recording";
  }

  get transcript() {
    return [...this.segments.entries()].sort(([left], [right]) => left - right).map(([, text]) => text).join("");
  }

  async start(mediaStream) {
    if (this.state !== "idle") throw new Error(`streaming ASR is ${this.state}`);
    const generation = ++this._generation;
    this.state = "connecting";
    try {
      await this._connect(generation);
      this._requireCurrent(generation);
      this.context = this.audioContextFactory();
      await this.context.resume?.();
      this._requireCurrent(generation);
      this.source = this.context.createMediaStreamSource(mediaStream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;
      this.processor.onaudioprocess = event => this._sendAudio(event.inputBuffer);
      this.source.connect(this.processor);
      this.processor.connect(this.sink);
      this.sink.connect(this.context.destination);
      this._requireCurrent(generation);
      this.state = "recording";
      return this;
    } catch (error) {
      await this.cancel();
      throw error;
    }
  }

  async finish() {
    if (this.state === "socket-closed") {
      await this._release();
      return this.finalEvent || null;
    }
    if (this.state !== "recording") return this.finalEvent || null;
    const generation = this._generation;
    this._disconnectAudio();
    this.state = "finishing";
    try {
      if (this.socket?.readyState !== 1) return null;
      this.socket.send(JSON.stringify({ type: "finish" }));
      await withTimeout(this._finished, this.finishTimeoutMs, "streaming ASR finish timeout");
      if (!this._isCurrent(generation)) return null;
      return this.finalEvent;
    } catch {
      return null;
    } finally {
      this.socket?.close();
      await this._release();
    }
  }

  async cancel() {
    if (this.state === "closed") return;
    this._generation += 1;
    this._rejectReady?.(new DOMException("streaming ASR was cancelled", "AbortError"));
    const shouldSignal = this.socket?.readyState === 1;
    this._disconnectAudio();
    this.state = "cancelled";
    if (shouldSignal) this.socket.send(JSON.stringify({ type: "cancel" }));
    this.socket?.close();
    await this._release();
  }

  async _connect(generation) {
    const socket = this.webSocketFactory(this.url);
    this.socket = socket;
    socket.binaryType = "arraybuffer";
    this._finished = new Promise(resolve => { this._resolveFinished = resolve; });
    this._ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("streaming ASR ready timeout")), this.readyTimeoutMs);
      this._resolveReady = () => { clearTimeout(timeout); resolve(); };
      this._rejectReady = error => { clearTimeout(timeout); reject(error); };
    });
    socket.onopen = () => {
      if (this._isCurrent(generation)) socket.send(JSON.stringify({ type: "start", sampleRate: PCM_SAMPLE_RATE, channels: 1, format: "pcm_s16le" }));
    };
    socket.onmessage = event => { if (this._isCurrent(generation)) this._receive(event.data); };
    socket.onerror = () => { if (this._isCurrent(generation)) this._rejectReady?.(new Error("streaming ASR WebSocket failed")); };
    socket.onclose = () => {
      this._resolveFinished?.();
      if (!this._isCurrent(generation)) return;
      if (this.state === "connecting") this._rejectReady?.(new Error("streaming ASR WebSocket closed before ready"));
      if (this.state === "recording") {
        this._disconnectAudio();
        const context = this.context;
        this.context = null;
        this.socket = null;
        this.state = "socket-closed";
        void context?.close?.();
      }
    };
    await this._ready;
  }

  _receive(data) {
    let event;
    try { event = typeof data === "string" ? JSON.parse(data) : data; } catch { return; }
    if (event?.type === "ready") return this._resolveReady?.();
    if (typeof event?.sequence === "number" && (event.type === "partial" || event.type === "final")) {
      this.segments.set(event.sequence, String(event.text || ""));
      if (event.type === "final" || event.isFinal) this.finalEvent = { ...event, text: this.transcript };
      this.onTranscript({ ...event, text: this.transcript });
      if (event.type === "final" || event.isFinal) this._resolveFinished?.();
    }
  }

  _sendAudio(buffer) {
    if (!this.active || this.socket?.readyState !== 1) return;
    if (this.socket.bufferedAmount > this.maxBufferedBytes) {
      this._fail(new Error("streaming ASR transport backpressure"));
      return;
    }
    const channel = buffer.getChannelData(0);
    if (!this.resampler || this.resampler.inputSampleRate !== buffer.sampleRate) this.resampler = new Pcm16Resampler(buffer.sampleRate);
    const pcm = this.resampler.push(channel);
    if (pcm.byteLength) this.socket.send(pcm.buffer);
  }

  _disconnectAudio() {
    if (this.processor) this.processor.onaudioprocess = null;
    try { this.source?.disconnect(); } catch {}
    try { this.processor?.disconnect(); } catch {}
    try { this.sink?.disconnect(); } catch {}
    this.source = null;
    this.processor = null;
    this.sink = null;
    this.resampler = null;
  }

  async _release() {
    if (this.state === "closed") return;
    this._disconnectAudio();
    try { await this.context?.close?.(); } catch {}
    this.context = null;
    this.socket = null;
    this.state = "closed";
  }

  _fail(error) {
    if (this.state === "failed" || this.state === "closed") return;
    this.failure = error;
    this._generation += 1;
    this._disconnectAudio();
    const context = this.context;
    this.context = null;
    this.socket?.close();
    this.socket = null;
    this.state = "failed";
    this._resolveFinished?.();
    void context?.close?.();
  }

  _isCurrent(generation) {
    return this._generation === generation && this.state !== "cancelled" && this.state !== "closed";
  }

  _requireCurrent(generation) {
    if (!this._isCurrent(generation)) throw new DOMException("streaming ASR was cancelled", "AbortError");
  }
}

function withTimeout(promise, timeoutMs, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    Promise.resolve(promise).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}
