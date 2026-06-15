/**
 * Avatar Audio Bridge
 *
 * Streams TTS audio from the browser's AudioBuffer (decoded server TTS)
 * to a LiveTalking / MuseTalk backend over a single WebSocket as
 * 16 kHz mono 16-bit PCM frames.
 *
 * Why this exists:
 *   OpenChamber's server-side TTS (useServerTTS) returns MP3 buffers that
 *   decode to AudioBuffers at the source sample rate (Kokoro emits 24 kHz,
 *   OpenAI emits 24 kHz, browser STT and macOS say emit other rates).
 *   MuseTalk / LiveTalking expect 16 kHz / 16-bit / mono PCM at the wire.
 *
 *   This module:
 *     1. Maintains one persistent WebSocket per avatar session
 *     2. Resamples AudioBuffer -> 16 kHz mono on demand
 *     3. Packs float32 [-1, 1] samples into Int16 little-endian
 *     4. Sends frames as binary WebSocket messages
 *
 * The bridge is intentionally decoupled from any playback path: the same
 * AudioBuffer is fed to both the speaker (AudioContext) and this bridge,
 * so lipsync is implicit and lossless at the source.
 */

const TARGET_SAMPLE_RATE = 16000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;

export interface AvatarAudioBridgeConfig {
  /**
   * Base URL of the LiveTalking / MuseTalk backend, e.g. `http://localhost:8765`.
   * The bridge will connect to `${baseUrl}/ws/audio` for the PCM uplink and
   * use `${baseUrl}/offer` for the WebRTC offer (consumed by AvatarPanel).
   */
  serverUrl: string;
  /**
   * Optional reference image data URL. Sent once on connect so the backend
   * can pick the avatar identity for the session.
   */
  imageDataUrl?: string;
  /**
   * When true, the bridge will not log per-frame activity. Defaults to false
   * for the first version to help bring-up.
   */
  silent?: boolean;
  /**
   * Override the audio endpoint path. Defaults to `/ws/audio`.
   */
  audioPath?: string;
  /**
   * WebSocket binary type. Defaults to `arraybuffer` because Int16 frames
   * are sent as raw bytes.
   */
  binaryType?: BinaryType;
}

export interface AvatarAudioBridgeState {
  /** A WebSocket is currently open and ready to receive frames. */
  connected: boolean;
  /** A WebSocket connect attempt is in flight. */
  connecting: boolean;
  /** Number of frames successfully sent since the last connect. */
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
 * bytes. Clamps overshoot to [-32768, 32767] to keep MuseTalk happy.
 */
function float32ToInt16LE(samples: Float32Array): ArrayBuffer {
  const byteLength = samples.length * 2;
  const buffer = new ArrayBuffer(byteLength);
  const view = new DataView(buffer);
  for (let i = 0; i < samples.length; i += 1) {
    let sample = samples[i];
    if (sample > 1) sample = 1;
    else if (sample < -1) sample = -1;
    const int16 = sample < 0 ? Math.round(sample * 0x8000) : Math.round(sample * 0x7fff);
    view.setInt16(i * 2, int16, true);
  }
  return buffer;
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

class AvatarAudioBridgeImpl {
  private socket: WebSocket | null = null;
  private listeners = new Set<StateListener>();
  private state: AvatarAudioBridgeState = {
    connected: false,
    connecting: false,
    framesSent: 0,
    lastError: null,
  };
  private cfg: AvatarAudioBridgeConfig = { serverUrl: '' };
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private closedByUser = false;

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
   * Open (or re-open) a WebSocket to the configured avatar backend.
   * Safe to call multiple times; the most recent config wins.
   */
  connect(config: AvatarAudioBridgeConfig): void {
    const normalized = this.normalizeConfig(config);
    if (!normalized.serverUrl) {
      this.setState({ lastError: 'avatarServerUrl is empty' });
      return;
    }

    const sameConfig = this.cfg.serverUrl === normalized.serverUrl
      && this.cfg.audioPath === normalized.audioPath
      && this.cfg.binaryType === normalized.binaryType;

    this.cfg = normalized;
    this.closedByUser = false;

    if (this.socket && sameConfig && (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)) {
      return;
    }

    this.teardownSocket();
    this.openSocket();
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.teardownSocket();
    this.setState({ connected: false, connecting: false });
  }

  /**
   * Push a single TTS AudioBuffer to the avatar backend. The buffer is
   * decoded (mono mix) and resampled to 16 kHz once, then forwarded as
   * one or more Int16 LE frames.
   *
   * The bridge is failure-tolerant: if the socket is not open, the
   * call is a no-op (the AudioBuffer is dropped). Audio playback on the
   * speaker side is unaffected; avatar only mirrors what it can.
   */
  feedAudioBuffer(buffer: AudioBuffer): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const mono = mixToMono(buffer);
    const sourceRate = buffer.sampleRate;
    const resampled = sourceRate === TARGET_SAMPLE_RATE
      ? mono
      : resampleLinear(mono, sourceRate, TARGET_SAMPLE_RATE);
    const payload = float32ToInt16LE(resampled);
    try {
      this.socket.send(payload);
      this.setState({ framesSent: this.state.framesSent + 1, lastError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ lastError: `send failed: ${message}` });
    }
  }

  /**
   * Low-level send for callers that already have a 16 kHz mono Int16
   * frame (e.g. an AudioWorklet pipeline). Provided for the streaming
   * follow-up work; not used by the current integration.
   */
  feedInt16Frame(frame: ArrayBuffer | Int16Array): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    const payload = frame instanceof ArrayBuffer ? frame : frame.buffer;
    try {
      this.socket.send(payload);
      this.setState({ framesSent: this.state.framesSent + 1, lastError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ lastError: `send failed: ${message}` });
    }
  }

  private normalizeConfig(input: AvatarAudioBridgeConfig): AvatarAudioBridgeConfig {
    const serverUrl = input.serverUrl.replace(/\/+$/, '');
    return {
      serverUrl,
      imageDataUrl: input.imageDataUrl,
      silent: input.silent ?? false,
      audioPath: input.audioPath ?? '/ws/audio',
      binaryType: input.binaryType ?? 'arraybuffer',
    };
  }

  private openSocket(): void {
    const { serverUrl, imageDataUrl, silent } = this.cfg;
    const audioPath = this.cfg.audioPath ?? '/ws/audio';
    const binaryType: BinaryType = this.cfg.binaryType ?? 'arraybuffer';
    const url = this.toWebSocketUrl(serverUrl, audioPath);
    this.setState({ connecting: true, lastError: null });
    let socket: WebSocket;
    try {
      socket = new WebSocket(url);
      socket.binaryType = binaryType;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ connecting: false, lastError: `socket init failed: ${message}` });
      this.scheduleReconnect();
      return;
    }

    this.socket = socket;

    socket.onopen = () => {
      this.reconnectAttempts = 0;
      this.setState({ connected: true, connecting: false, lastError: null, framesSent: 0 });
      if (imageDataUrl) {
        try {
          socket.send(JSON.stringify({ type: 'init', image: imageDataUrl, sampleRate: TARGET_SAMPLE_RATE, channels: CHANNELS, bitsPerSample: BITS_PER_SAMPLE }));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.setState({ lastError: `init send failed: ${message}` });
        }
      }
      if (!silent) {
        console.log('[avatar-bridge] connected to', url);
      }
    };

    socket.onerror = (event) => {
      const message = (event as Event & { message?: string }).message ?? 'WebSocket error';
      this.setState({ lastError: message });
    };

    socket.onclose = (event) => {
      this.socket = null;
      this.setState({ connected: false, connecting: false });
      if (!silent) {
        console.log('[avatar-bridge] closed', { code: event.code, reason: event.reason });
      }
      if (!this.closedByUser) {
        this.scheduleReconnect();
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closedByUser) return;
    this.reconnectAttempts += 1;
    const delay = Math.min(30_000, 500 * 2 ** Math.min(this.reconnectAttempts, 6));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closedByUser) this.openSocket();
    }, delay);
  }

  private teardownSocket(): void {
    if (!this.socket) return;
    try {
      this.socket.onopen = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      this.socket.onmessage = null;
      if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING) {
        this.socket.close(1000, 'teardown');
      }
    } catch {
      // Ignore close-time errors; the socket is going away regardless.
    }
    this.socket = null;
  }

  private setState(patch: Partial<AvatarAudioBridgeState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  private toWebSocketUrl(baseHttpUrl: string, path: string): string {
    if (!baseHttpUrl) return path;
    if (baseHttpUrl.startsWith('ws://') || baseHttpUrl.startsWith('wss://')) {
      return `${baseHttpUrl.replace(/\/+$/, '')}${path}`;
    }
    const replaced = baseHttpUrl.replace(/^http:\/\//, 'ws://').replace(/^https:\/\//, 'wss://');
    return `${replaced.replace(/\/+$/, '')}${path}`;
  }
}

let singleton: AvatarAudioBridgeImpl | null = null;

export function getAvatarAudioBridge(): AvatarAudioBridgeImpl {
  if (!singleton) singleton = new AvatarAudioBridgeImpl();
  return singleton;
}

export type { AvatarAudioBridgeImpl };
