# Audio Bridge

The audio bridge is a singleton WebSocket client that forwards TTS audio
from the browser to a LiveTalking / MuseTalk backend as 16 kHz mono
16-bit PCM.

**File**: `packages/ui/src/lib/voice/avatarAudioBridge.ts`

## Public surface

```ts
import { getAvatarAudioBridge } from '@/lib/voice/avatarAudioBridge';

const bridge = getAvatarAudioBridge();

bridge.connect({ serverUrl: 'http://localhost:8765', imageDataUrl? });
bridge.feedAudioBuffer(audioBuffer);
bridge.disconnect();
```

### `getAvatarAudioBridge()`

Returns the process-wide singleton. Creating the class directly is
discouraged; everything is wired through the singleton so there is exactly
one WebSocket per browser tab.

### `AvatarAudioBridgeConfig`

| Field | Type | Default | Notes |
|---|---|---|---|
| `serverUrl` | `string` | required | Base HTTP URL, e.g. `http://localhost:8765` |
| `imageDataUrl` | `string?` | `undefined` | Sent once on connect as part of the `init` frame |
| `silent` | `boolean` | `false` | Suppress console logging |
| `audioPath` | `string` | `/ws/audio` | Override the WebSocket path |
| `binaryType` | `BinaryType` | `arraybuffer` | WebSocket binary type |

### `AvatarAudioBridgeState`

| Field | Meaning |
|---|---|
| `connected` | WebSocket is `OPEN` and frames are flowing |
| `connecting` | A connect attempt is in flight |
| `framesSent` | Counter of successfully sent frames since last connect |
| `lastError` | Last error message (or `null`) |

Subscribers are notified on every state change via `subscribe(listener)`.

### `connect(config)`

Open (or re-open) a WebSocket to the configured avatar backend. Safe to
call multiple times — the most recent config wins and a same-config call
on an open/connecting socket is a no-op.

### `disconnect()`

Close the WebSocket, cancel any scheduled reconnect, mark state `closed`.
The caller is responsible for `connect()` again to resume.

### `feedAudioBuffer(buffer: AudioBuffer)`

The hot path. Called by `useServerTTS` after `decodeAudioData`. Internally:

1. Mix down to mono (`mixToMono`).
2. Resample to 16 kHz if needed (`resampleLinear`).
3. Pack float32 → Int16 little-endian (`float32ToInt16LE`).
4. `socket.send(payload)` as a binary WebSocket frame.
5. Increment `framesSent`.

If the WebSocket is not open, the call is a **no-op** (the buffer is
dropped). The audio still plays through the speaker.

### `feedInt16Frame(frame: ArrayBuffer | Int16Array)`

Low-level send for callers that already have a 16 kHz mono Int16 frame
(e.g. an `AudioWorklet` pipeline). Not used by the current integration;
reserved for the streaming follow-up.

## Internal helpers

### `resampleLinear(input, sourceRate, targetRate)` (line 79)

Linear-interpolation resampler. Acceptable for speech audio where
high-frequency content is not perceptually critical. For production
MuseTalk inference a windowed-sinc resampler would be preferable; this is
the smallest correct step that ships today.

```ts
output[i] = input[lower] * (1 - fraction) + input[upper] * fraction
```

### `float32ToInt16LE(samples)` (line 98)

Clamp float32 `[-1, 1]` to Int16 `[-32768, 32767]` (asymmetric — see
`Math.round(sample * 0x8000)` for negative vs `0x7fff` for positive) and
write little-endian.

### `mixToMono(buffer)` (line 118)

For a mono buffer, returns a copy of channel 0. For multi-channel
(stereo) buffers, averages all channels into a single `Float32Array`.

## WebSocket protocol

### 1. Open

`new WebSocket(ws://localhost:8765/ws/audio)` with `binaryType = 'arraybuffer'`.

### 2. On open — `init` frame (JSON text)

Sent exactly once, only if `imageDataUrl` was provided:

```json
{
  "type": "init",
  "image": "data:image/jpeg;base64,...",
  "sampleRate": 16000,
  "channels": 1,
  "bitsPerSample": 16
}
```

If the user's `imageDataUrl` is empty, the `init` frame is **omitted**.
The backend then keeps whatever portrait it has (or rejects the connection,
depending on implementation).

### 3. Audio frames (binary)

Each `feedAudioBuffer` produces one binary frame: a flat sequence of Int16
samples (little-endian, mono, 16 kHz). Frame size in bytes = `samples × 2`.

The backend is expected to consume these and drive lip animation
accordingly. There is no ACK protocol — the bridge fires frames as the
TTS plays.

### 4. Close

The server may close the socket at any time. The bridge schedules a
reconnect with exponential backoff (capped at 30 s) unless `disconnect()`
was called explicitly by user code.

## Reconnect logic

`scheduleReconnect()` (line 311):

```
delay = min(30_000, 500 * 2^min(attempts, 6))
```

| Attempt | Delay (ms) |
|---|---|
| 1 | 500 |
| 2 | 1000 |
| 3 | 2000 |
| 4 | 4000 |
| 5 | 8000 |
| 6 | 16000 |
| 7+ | 30000 (capped) |

Reconnect is suppressed while the user has explicitly called
`disconnect()`. This matches the OpenChamber SSE reconnect policy in
`packages/ui/src/sync/event-pipeline.ts` (long backoff cap, no aggressive
retry on user-toggled-off state).

## Buffer pool

`resampleBufferPool` keeps up to 8 recently-used `Float32Array`s around
so consecutive TTS messages of similar size can reuse memory. This is
deliberately bounded — running TTS in a chat session does not produce
enough frames for the pool to grow without bound.

## Failure modes

| Symptom | Cause | What the bridge does |
|---|---|---|
| `socket.send` throws | WebSocket closed mid-send | Logs `lastError`, drops the frame |
| `socket.onerror` fires | Network failure | Logs `lastError`, triggers reconnect |
| `socket.onclose` fires | Server-side close | Schedules reconnect |
| `new WebSocket(url)` throws | Bad URL scheme | Logs `lastError`, schedules reconnect |
| `feedAudioBuffer` while disconnected | TTS plays during outage | Drops the frame silently |

**All failures are non-fatal to the speaker path.** The bridge exists
purely as an enhancement; the user always hears the message even if the
avatar backend is offline.

## Future work

- **Streaming**: replace the post-decode tee with an `AudioWorklet` that
  forwards PCM chunks as `decodeAudioData` fills the buffer. Cuts end-to-end
  latency by ~150–400 ms.
- **Sinc resampler**: replace `resampleLinear` with a windowed-sinc
  kernel. The 24 kHz → 16 kHz step currently rolls off some HF content
  that MuseTalk's mouth-region model would otherwise use.
- **Bidirectional control**: LiveTalking can signal "end of utterance"
  via the WebSocket. We currently infer end-of-message from the
  AudioContext `onended` event; consuming server signals would let us
  re-use the same frame for any number of partial replays.
- **Heartbeat**: a 5 s ping/pong would help mobile networks detect silent
  drops faster than the 30 s TCP timeout.
