# Audio Bridge

The audio bridge is a singleton HTTP client that forwards TTS audio
from the browser to a LiveTalking / MuseTalk backend as a
`multipart/form-data` upload to `POST /humanaudio`. The upload body is
a 16 kHz mono 16-bit PCM WAV blob (44-byte RIFF header + Int16 LE
samples).

**File**: `packages/ui/src/lib/voice/avatarAudioBridge.ts`

## Public surface

```ts
import { getAvatarAudioBridge } from '@/lib/voice/avatarAudioBridge';

const bridge = getAvatarAudioBridge();

bridge.connect({ serverUrl: 'http://localhost:8765', imageDataUrl? });
bridge.feedAudioChunk(audioBuffer, sessionId);
bridge.disconnect();
```

### `getAvatarAudioBridge()`

Returns the process-wide singleton. Creating the class directly is
discouraged; everything is wired through the singleton so there is
exactly one logical uplink per browser tab.

### `AvatarAudioBridgeConfig`

| Field | Type | Default | Notes |
|---|---|---|---|
| `serverUrl` | `string` | required | Base HTTP URL, e.g. `http://localhost:8765` |
| `imageDataUrl` | `string?` | `undefined` | **Reserved** — type is accepted but the value is currently dropped in `normalizeConfig`. The AvatarPanel does not yet send an `image` field on `POST /offer` (no portrait picker UI). LiveTalking falls back to its default avatar in that case. |
| `silent` | `boolean` | `false` | Suppress console logging |
| `audioPath` | `string` | `/humanaudio` | Override the upload path |

### `AvatarAudioBridgeState`

| Field | Meaning |
|---|---|
| `connected` | Last `connect()` succeeded and at least one upload is configured |
| `connecting` | A `connect()` call is in flight |
| `framesSent` | Counter of successfully sent frames since the last `connect()` |
| `lastError` | Last error message (or `null`) |

Subscribers are notified on every state change via `subscribe(listener)`.

### `connect(config)`

Cache the server URL and (optionally) image data URL. Safe to call
multiple times — the most recent config wins and a same-config call is
a no-op. The bridge does **not** open a long-lived connection; each
`feedAudioChunk` is an independent HTTP POST.

### `disconnect()`

Clear the cached config and reset state. Subsequent `feedAudioChunk`
calls are no-ops until the next `connect()`.

### `feedAudioChunk(buffer: AudioBuffer, sessionId: string)`

The hot path. Called by `useServerTTS` after `decodeAudioData` once
the WebRTC offer has produced a `sessionId` (see `AvatarPanel`).
Internally:

1. Defensive early return when `sessionId` is empty (the offer has
   not completed yet) — the buffer is dropped, the speaker still
   plays.
2. Mix down to mono (`mixToMono`).
3. Resample to 16 kHz if needed (`resampleLinear`).
4. Pack float32 → Int16 little-endian (`float32ToInt16LE`).
5. Prepend a 44-byte WAV header (`packWav`) so `soundfile.read()` on
   the LiveTalking side can decode the bytes (`POST /humanaudio` does
   not accept raw PCM).
6. `fetch(\`${serverUrl}${audioPath}\`, { method: 'POST', body: formData })`
   where `formData` has `sessionid` + `file` fields.
7. Fire-and-forget: the response is **not awaited**. The audio path
   must not block on the avatar backend.
8. On `response.ok`, increment `framesSent` and clear `lastError`.
   On `!response.ok` or fetch rejection, write the failure into
   `lastError` and drop the frame.

If `sessionId` is empty, or `connect()` has not been called, the
call is a **no-op** (the buffer is dropped). The audio still plays
through the speaker.

## Internal helpers

### `resampleLinear(input, sourceRate, targetRate)` (line 83)

Linear-interpolation resampler. Acceptable for speech audio where
high-frequency content is not perceptually critical. For production
MuseTalk inference a windowed-sinc resampler would be preferable; this is
the smallest correct step that ships today.

```ts
output[i] = input[lower] * (1 - fraction) + input[upper] * fraction
```

### `float32ToInt16LE(samples)` (line 102)

Clamp float32 `[-1, 1]` to Int16 `[-32768, 32767]` (asymmetric — see
`Math.round(sample * 0x8000)` for negative vs `0x7fff` for positive) and
write little-endian.

### `mixToMono(buffer)` (line 119)

For a mono buffer, returns the underlying channel 0 view directly (no
copy — downstream `resampleLinear` and `float32ToInt16LE` do not mutate
the input). For multi-channel (stereo) buffers, averages all channels
into a single `Float32Array`.

### `packWav(pcm, sampleRate)` (line 142)

Prepends a 44-byte RIFF/WAVE header so the bytes can be decoded by
`soundfile.read(BytesIO(...))` on the LiveTalking side.

| Field | Value |
|---|---|
| ChunkID | `RIFF` |
| Format | `WAVE` |
| Subchunk1ID | `fmt ` |
| AudioFormat | `1` (PCM) |
| NumChannels | `1` |
| SampleRate | `sampleRate` (always 16000 from this bridge) |
| ByteRate | `sampleRate * 2` |
| BlockAlign | `2` |
| BitsPerSample | `16` |
| Subchunk2ID | `data` |
| Subchunk2Size | `pcmInt16.length * 2` |

The 44-byte header is the only RIFF layout MuseTalk's `soundfile`
backend accepts; bare Int16 LE samples are rejected with a decoding
error.

## HTTP protocol

### 1. `POST /humanaudio` request

```
POST /humanaudio HTTP/1.1
Host: localhost:8765
Content-Type: multipart/form-data; boundary=...

--boundary
Content-Disposition: form-data; name="sessionid"

<uuid>
--boundary
Content-Disposition: form-data; name="file"; filename="chunk.wav"
Content-Type: audio/wav

<44-byte WAV header><Int16 LE samples...>
--boundary--
```

The `sessionid` is the UUID returned from `POST /offer`. The
`file` is a single WAV blob (one TTS message). LiveTalking's
`server/routes.py:90` route reads the file, calls
`avatar_session.put_audio_file(filebytes, {})` which decodes via
`soundfile.read(BytesIO(...))` and feeds it to the ASR queue in
20 ms chunks.

### 2. Response

```json
{ "code": 0, "msg": "ok" }
```

`code != 0` is logged into `lastError` and the frame is dropped. The
bridge never throws on the audio path.

### 3. Failure modes

| Symptom | Cause | What the bridge does |
|---|---|---|
| `POST /humanaudio` returns `{"code":-1,"msg":"session not found"}` | `sessionid` invalid (e.g. peer reconnected, old session evicted) | Logs `lastError`, drops the frame |
| `fetch` rejects | Network unreachable, CORS, server down | Logs `lastError`, drops the frame |
| `soundfile.read` fails on server | Bytes were not a valid WAV (header missing or wrong format) | Server returns 500, bridge logs `lastError` |
| `sessionId === ''` | `/offer` has not completed | Bridge no-ops the frame; the speaker still plays |

**All failures are non-fatal to the speaker path.** The bridge exists
purely as an enhancement; the user always hears the message even if the
avatar backend is offline.

## Allocation policy

Per-message buffers (`mixToMono`, `resampleLinear`, `float32ToInt16LE`,
`packWav`) allocate fresh on each call and are immediately eligible for
GC after `fetch(POST, formData)` returns. This is acceptable for the
speech-rate, short-buffer use case here: typical TTS frames are 1–5 s at
16 kHz mono (~32–160 KB Int16) and the browser's young-generation GC
reclaims them cheaply.

A buffer pool was considered and explicitly removed (commit history
contains an earlier draft of `returnToPool`). The complexity was not
worth it: pool draining had to be paired with allocation-side changes
that obscured the per-call shape, and chat-session TTS workloads do not
produce enough frames per minute to benefit from retention.

If allocation pressure becomes a real issue, the right fix is to move
the conversion into an `AudioWorklet` and reuse a small ring buffer of
`SharedArrayBuffer` chunks. See `Future work` below.

## Future work

- **Streaming**: replace the post-decode tee with an `AudioWorklet` that
  forwards PCM chunks as `decodeAudioData` fills the buffer. Cuts end-to-end
  latency by ~150–400 ms.
- **Sinc resampler**: replace `resampleLinear` with a windowed-sinc
  kernel. The 24 kHz → 16 kHz step currently rolls off some HF content
  that MuseTalk's mouth-region model would otherwise use.
- **Heartbeat**: a 5 s ping/pong would help mobile networks detect silent
  drops faster than the 30 s TCP timeout.
