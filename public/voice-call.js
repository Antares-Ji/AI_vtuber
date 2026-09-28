const DEFAULT_CONSTRAINTS = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

export class VoiceCallController {
  constructor({
    getUserMedia = constraints => navigator.mediaDevices.getUserMedia(constraints),
    audioContextFactory = () => new AudioContext(),
    onSpeechStart = () => {},
    onTurn = () => {},
    onStatus = () => {},
    onLevel = () => {},
    constraints = DEFAULT_CONSTRAINTS,
    preRollMs = 650,
    silenceMs = 550,
    maxTurnMs = 18_000,
    minRms = 0.006,
    noiseMultiplier = 3,
    onsetMs = 120,
    onsetFrames = 1
  } = {}) {
    this.getUserMedia = getUserMedia;
    this.audioContextFactory = audioContextFactory;
    this.onSpeechStart = onSpeechStart;
    this.onTurn = onTurn;
    this.onStatus = onStatus;
    this.onLevel = onLevel;
    this.constraints = constraints;
    this.preRollMs = preRollMs;
    this.silenceMs = silenceMs;
    this.maxTurnMs = maxTurnMs;
    this.minRms = minRms;
    this.noiseMultiplier = noiseMultiplier;
    this.onsetMs = onsetMs;
    this._voiceRms = 0;
    this.onsetFrames = Math.max(1, onsetFrames);
    this.state = "idle";
    this.sequence = 0;
    this._generation = 0;
    this._stopped = false;
    this._pending = new Set();
    this._resetVad();
  }

  get isActive() {
    return this.state === "active";
  }

  async start() {
    if (this._stopped) throw new Error("a stopped voice call controller cannot restart");
    if (this.state !== "idle") throw new Error(`voice call is ${this.state}`);
    const generation = ++this._generation;
    this.state = "starting";
    this.onStatus({ state: this.state });
    try {
      this.stream = await this.getUserMedia(this.constraints);
      this._requireCurrent(generation);
      this.context = this.audioContextFactory();
      await this.context.resume?.();
      this._requireCurrent(generation);
      this.sampleRate = this.context.sampleRate || 48_000;
      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(2048, 1, 1);
      this.sink = this.context.createGain();
      this.sink.gain.value = 0;
      this.processor.onaudioprocess = event => this._processFrame(event.inputBuffer.getChannelData(0));
      this.source.connect(this.processor);
      this.processor.connect(this.sink);
      this.sink.connect(this.context.destination);
      this._resetVad();
      this.state = "active";
      this.onStatus({ state: this.state, sampleRate: this.sampleRate });
      return this;
    } catch (error) {
      await this._release();
      if (this._stopped) throw new DOMException("voice call was stopped", "AbortError");
      this.state = "idle";
      this.onStatus({ state: "error", error });
      throw error;
    }
  }

  async stop({ finalize = false } = {}) {
    if (this._stopped) return;
    const generation = this._generation;
    this._generation += 1;
    this._stopped = true;
    this.state = "stopping";
    this.onStatus({ state: this.state, finalize });
    this._disconnectAudio();
    this.stream?.getTracks?.().forEach(track => track.stop());
    this.stream = null;
    // Default is discard. A caller may request one explicit final turn; it is
    // awaited before teardown rather than becoming a late, unowned result.
    if (finalize && this._turnFrames.length) await this._emitTurn(this._turnFrames, false, generation, true);
    for (const controller of this._pending) controller.abort();
    this._turnFrames = [];
    this._preRollFrames = [];
    await this._release();
    this.state = "stopped";
    this.onStatus({ state: this.state });
  }

  _processFrame(input) {
    if (!this.isActive) return;
    const frame = new Float32Array(input);
    const rms = calculateRms(frame);
    const threshold = this._threshold;
    this.onLevel({ rms, threshold, voiceRms: this._voiceRms, noiseRms: this._noiseFloor, speaking: this._inSpeech });
    if (!this._inSpeech) {
      this._rememberPreRoll(frame);
      if (rms < threshold) this._noiseFloor = this._noiseFloor * 0.96 + rms * 0.04;
      if (rms >= threshold) {
        this._onsetCount += 1;
        this._onsetSamples += frame.length;
        if (this._onsetCount >= this.onsetFrames && this._onsetSamples >= this.sampleRate * this.onsetMs / 1000) {
          this._beginSpeech(frame);
          this._learnVoice(rms);
        }
      } else {
        this._onsetCount = 0;
        this._onsetSamples = 0;
      }
      return;
    }
    this._turnFrames.push(frame);
    this._turnSamples += frame.length;
    if (rms >= threshold) this._learnVoice(rms);
    if (rms < threshold * 0.72) this._silenceSamples += frame.length;
    else this._silenceSamples = 0;
    if (this._turnSamples >= this._maxTurnSamples) {
      const frames = this._turnFrames;
      this._turnFrames = [frame];
      this._turnSamples = frame.length;
      void this._emitTurn(frames, true, this._generation);
      return;
    }
    if (this._silenceSamples >= this._silenceSamplesLimit) {
      const frames = this._turnFrames;
      this._resetVad();
      void this._emitTurn(frames, false, this._generation);
    }
  }

  _beginSpeech(frame) {
    this._inSpeech = true;
    this._silenceSamples = 0;
    this._turnFrames = [...this._preRollFrames];
    this._turnSamples = this._turnFrames.reduce((total, item) => total + item.length, 0);
    // The current frame is already in pre-roll. Keep it only once so onset
    // preserves leading phonemes without duplicating an entire callback.
    if (!this._turnFrames.length) this._turnFrames.push(frame);
    this._turnSamples = this._turnFrames.reduce((total, item) => total + item.length, 0);
    const generation = this._generation;
    Promise.resolve(this.onSpeechStart({ sequence: this.sequence + 1, generation })).catch(() => {});
    this.onStatus({ state: "speech", threshold: this._threshold });
  }

  _rememberPreRoll(frame) {
    this._preRollFrames.push(frame);
    this._preRollSamples += frame.length;
    while (this._preRollSamples > this._preRollSamplesLimit && this._preRollFrames.length) {
      this._preRollSamples -= this._preRollFrames.shift().length;
    }
  }

  async _emitTurn(frames, continuation, generation, allowStopped = false) {
    if (!frames.length || (!allowStopped && !this._isCurrent(generation))) return;
    const blob = encodeWav(frames, this.sampleRate);
    const controller = new AbortController();
    this._pending.add(controller);
    const sequence = ++this.sequence;
    try {
      await this.onTurn(blob, sequence, controller.signal, { continuation });
      if (this._isCurrent(generation)) this.onStatus({ state: "turn-complete", sequence, continuation });
    } catch (error) {
      if (!controller.signal.aborted && this._isCurrent(generation)) this.onStatus({ state: "turn-error", sequence, error });
    } finally {
      this._pending.delete(controller);
    }
  }

  _resetVad() {
    // Calibration belongs to the call, not one utterance. Keep it across turns.
    this._noiseFloor ??= this.minRms * 0.3;
    this._onsetCount = 0;
    this._onsetSamples = 0;
    this._inSpeech = false;
    this._silenceSamples = 0;
    this._preRollFrames = [];
    this._preRollSamples = 0;
    this._turnFrames = [];
    this._turnSamples = 0;
  }

  get _threshold() {
    return Math.max(this.minRms, this._noiseFloor * this.noiseMultiplier, Math.min(0.04, this._voiceRms * 0.28));
  }

  _learnVoice(rms) {
    // Bound spikes; slow adaptation cannot let one shout raise the threshold
    // permanently. This is a session-local level estimate, not speaker ID.
    if (!this._voiceRms) this._voiceRms = Math.min(rms, 0.14);
    else this._voiceRms += 0.025 * (Math.min(rms, this._voiceRms * 2) - this._voiceRms);
  }

  get _preRollSamplesLimit() { return Math.max(1, Math.round(this.sampleRate * this.preRollMs / 1000)); }
  get _silenceSamplesLimit() { return Math.max(1, Math.round(this.sampleRate * this.silenceMs / 1000)); }
  get _maxTurnSamples() { return Math.max(this.sampleRate, Math.round(this.sampleRate * this.maxTurnMs / 1000)); }

  _disconnectAudio() {
    if (this.processor) this.processor.onaudioprocess = null;
    try { this.source?.disconnect(); } catch {}
    try { this.processor?.disconnect(); } catch {}
    try { this.sink?.disconnect(); } catch {}
    this.source = null;
    this.processor = null;
    this.sink = null;
  }

  async _release() {
    this._disconnectAudio();
    this.stream?.getTracks?.().forEach(track => track.stop());
    this.stream = null;
    try { await this.context?.close?.(); } catch {}
    this.context = null;
  }

  _isCurrent(generation) { return !this._stopped && this.isActive && this._generation === generation; }
  _requireCurrent(generation) {
    if (this._stopped || this._generation !== generation) throw new DOMException("voice call was stopped", "AbortError");
  }
}

function calculateRms(frame) {
  let sum = 0;
  for (const sample of frame) sum += sample * sample;
  return Math.sqrt(sum / Math.max(1, frame.length));
}

function encodeWav(frames, sampleRate) {
  const samples = frames.reduce((total, frame) => total + frame.length, 0);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  writeText(view, 0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  writeText(view, 8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeText(view, 36, "data");
  view.setUint32(40, samples * 2, true);
  let offset = 44;
  for (const frame of frames) for (const sample of frame) {
    const value = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, value < 0 ? Math.round(value * 32768) : Math.round(value * 32767), true);
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

function writeText(view, offset, text) {
  for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
}
