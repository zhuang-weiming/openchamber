/**
 * Avatar Audio Bridge
 *
 * Forwards TTS audio from the browser's AudioBuffer (decoded server TTS)
 * to a LiveTalking / MuseTalk backend as a multipart/form-data upload
 * to `POST /humanaudio`. Each upload is a 16 kHz mono 16-bit PCM WAV
 * blob (44-byte RIFF header + Int16 LE samples).
 *
 * Why this exists:
 *   OpenChamber's server-side TTS (useServerTTS) returns MP3 buffers that
 *   decode to AudioBuffers at the source sample rate (Kokoro emits 24 kHz,
 *   OpenAI emits 24 kHz, browser STT and macOS say emit other rates).
 *   LiveTalking's `/humanaudio` endpoint (`server/routes.py:90`) decodes
 *   the upload via `soundfile.read(BytesIO(...))` and feeds 20 ms
 *   chunks into the ASR queue. Soundfile requires a recognized audio
 *   container header — bare Int16 LE PCM is rejected.
 *
 *   This module:
  *     1. Holds the configured server URL as state
 *     2. Resamples AudioBuffer -> 16 kHz mono on demand
 *     3. Packs float32 [-1, 1] samples into Int16 little-endian
 *     4. Prepends a 44-byte RIFF/WAVE header so soundfile can decode
 *     5. Posts the WAV blob to /humanaudio with multipart/form-data
 *        (fire-and-forget — the speaker path is never blocked on the
 *        avatar backend)
 *
 * The bridge is intentionally decoupled from any playback path: the same
 * AudioBuffer is fed to both the speaker (AudioContext) and this bridge,
 * so lipsync is implicit and lossless at the source.
 */

const TARGET_SAMPLE_RATE = 16000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
const WAV_HEADER_BYTES = 44;

export interface AvatarAudioBridgeConfig {
  /**
   * Base URL of the LiveTalking / MuseTalk backend, e.g. `http://localhost:8765`.
   * The bridge uploads to `${baseUrl}/humanaudio` (or `audioPath` if set).
   * `AvatarPanel` uses `${baseUrl}/offer` for the WebRTC offer separately.
   */
  serverUrl: string;
  /**
   * When true, the bridge will not log per-frame activity. Defaults to false
   * for the first version to help bring-up.
   */
  silent?: boolean;
  /**
   * Override the audio endpoint path. Defaults to `/humanaudio`.
   */
  audioPath?: string;
}

export interface AvatarAudioBridgeState {
  /** Last `connect()` succeeded and config is cached. */
  connected: boolean;
  /** A `connect()` call is in flight (currently always synchronous — kept for API parity). */
  connecting: boolean;
  /** Number of frames successfully dispatched since the last connect. */
  framesSent: number;
  /** Last error message captured, or null. */
  lastError: string | null;
}

type StateListener = (state: AvatarAudioBridgeState) => void;

/**
 * Linear-interpolation resampler. Good enough for speech-rate audio where
 * we trade a tiny bit of HF roll-off for the simplicity of staying in pure
 * Web Audio math (no Worker, no AudioWorklet host required).
 *
 * For production MuseTalk inference a higher-quality resampler (e.g. sinc)
 * is preferable; this is the smallest correct step that ships today.
 */
function resampleLinear(input: Float32Array, sourceRate: number, targetRate: number): Float32Array {
  if (sourceRate === targetRate) return input;
  const ratio = sourceRate / targetRate;
  const outputLength = Math.max(1, Math.floor(input.length / ratio));
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i += 1) {
    const sourceIndex = i * ratio;
    const lower = Math.floor(sourceIndex);
    const upper = Math.min(lower + 1, input.length - 1);
    const fraction = sourceIndex - lower;
    output[i] = input[lower] * (1 - fraction) + input[upper] * fraction;
  }
  return output;
}

/**
 * Convert a mono float32 PCM buffer (range [-1, 1]) to Int16 little-endian
 * samples. Clamps overshoot to [-32768, 32767] to keep MuseTalk happy.
 */
function float32ToInt16LE(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i += 1) {
    let sample = samples[i];
    if (sample > 1) sample = 1;
    else if (sample < -1) sample = -1;
    out[i] = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
  }
  return out;
}

/**
 * Mix an arbitrary number of channels down to a single mono channel by
 * averaging samples. LiveTalking / MuseTalk only consume mono, and TTS
 * outputs are overwhelmingly mono already; this branch only matters for
 * the rare stereo sample (e.g. browser SpeechSynthesis).
 */
function mixToMono(buffer: AudioBuffer): Float32Array {
  const { numberOfChannels, length } = buffer;
  if (numberOfChannels === 1) {
    return buffer.getChannelData(0);
  }
  const output = new Float32Array(length);
  for (let channel = 0; channel < numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) {
      output[i] += data[i] / numberOfChannels;
    }
  }
  return output;
}

/**
 * Pack Int16 LE PCM samples into a complete WAV file (44-byte RIFF header
 * + samples). LiveTalking's `put_audio_file` calls `soundfile.read(BytesIO(...))`
 * which requires a recognized audio container — bare PCM is rejected.
 *
 * Always emits 16 kHz / mono / 16-bit PCM (little-endian) which is what
 * MuseTalk's ASR pipeline expects.
 */
function packWav(pcm: Int16Array, sampleRate: number): ArrayBuffer {
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset: number, s: string): void => {
    for (let i = 0; i < s.length; i += 1) {
      view.setUint8(offset + i, s.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * CHANNELS * (BITS_PER_SAMPLE / 8), true);
  view.setUint16(32, CHANNELS * (BITS_PER_SAMPLE / 8), true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const out = new Int16Array(buffer, WAV_HEADER_BYTES);
  out.set(pcm);

  return buffer;
}

class AvatarAudioBridgeImpl {
  private listeners = new Set<StateListener>();
  private state: AvatarAudioBridgeState = {
    connected: false,
    connecting: false,
    framesSent: 0,
    lastError: null,
  };
  private cfg: AvatarAudioBridgeConfig = { serverUrl: '' };

  subscribe(listener: StateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getState(): AvatarAudioBridgeState {
    return this.state;
  }

  /**
   * Cache the server URL (and optional image data URL). Safe to call
   * multiple times — the most recent config wins. The bridge holds no
   * long-lived connection; each `feedAudioChunk` is a fresh HTTP POST.
   */
  connect(config: AvatarAudioBridgeConfig): void {
    const normalized = this.normalizeConfig(config);
    if (!normalized.serverUrl) {
      this.setState({ lastError: 'avatarServerUrl is empty' });
      return;
    }
    this.cfg = normalized;
    this.setState({ connected: true, connecting: false, framesSent: 0, lastError: null });
  }

  disconnect(): void {
    this.cfg = { serverUrl: '' };
    this.setState({ connected: false, connecting: false, framesSent: 0, lastError: null });
  }

  /**
   * Push a single TTS AudioBuffer to the avatar backend. The buffer is
   * mixed to mono, resampled to 16 kHz, packed as a 16-bit PCM WAV
   * (44-byte RIFF header + Int16 LE samples), and POSTed to
   * `${serverUrl}/humanaudio` with `sessionid` + `file` form fields.
   *
   * The upload is fire-and-forget: the caller never observes the HTTP
   * response. The speaker path is unaffected if the avatar backend is
   * offline or returns an error.
   *
   * Returns silently when:
   *   - `connect()` has not been called
   *   - `sessionId` is empty (the WebRTC `/offer` has not completed)
   *   - the upload fetch throws (e.g. network unreachable)
   */
  feedAudioChunk(buffer: AudioBuffer, sessionId: string): void {
    if (!this.cfg.serverUrl) {
      return;
    }
    if (!sessionId) {
      return;
    }

    const mono = mixToMono(buffer);
    const sourceRate = buffer.sampleRate;
    const resampled = sourceRate === TARGET_SAMPLE_RATE
      ? mono
      : resampleLinear(mono, sourceRate, TARGET_SAMPLE_RATE);
    const int16 = float32ToInt16LE(resampled);
    const wav = packWav(int16, TARGET_SAMPLE_RATE);

    const form = new FormData();
    form.set('sessionid', sessionId);
    form.set('file', new Blob([wav], { type: 'audio/wav' }), 'chunk.wav');

    const audioPath = this.cfg.audioPath ?? '/humanaudio';
    const url = `${this.cfg.serverUrl}${audioPath}`;

    void fetch(url, { method: 'POST', body: form })
      .then((response) => {
        if (!response.ok) {
          this.setState({ lastError: `upload failed: HTTP ${response.status}` });
          return;
        }
        this.setState({ framesSent: this.state.framesSent + 1, lastError: null });
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        this.setState({ lastError: `upload failed: ${message}` });
      });
  }

  private normalizeConfig(input: AvatarAudioBridgeConfig): AvatarAudioBridgeConfig {
    const serverUrl = input.serverUrl.replace(/\/+$/, '');
    return {
      serverUrl,
      silent: input.silent ?? false,
      audioPath: input.audioPath ?? '/humanaudio',
    };
  }

  private setState(patch: Partial<AvatarAudioBridgeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }
}

let singleton: AvatarAudioBridgeImpl | null = null;

export function getAvatarAudioBridge(): AvatarAudioBridgeImpl {
  if (!singleton) singleton = new AvatarAudioBridgeImpl();
  return singleton;
}

export type { AvatarAudioBridgeImpl };
