# Architecture

## Data flow diagram

```
  LLM (OpenCode)
     │  response text
     ▼
 Chat UI ─────────────────────────────────────────┐
     │                                             │
     │  "speak this message" (speaker icon)        │
     ▼                                             │
 /api/tts/speak (OpenChamber server, unchanged)    │
     │                                             │
     │  audio/mpeg (MP3 stream)                    │
     ▼                                             │
 useServerTTS (packages/ui/src/hooks/useServerTTS.ts:297-315)
     │                                             │
     │  fetch → blob → arrayBuffer → decodeAudioData
     ▼                                             │
 AudioBuffer (24 kHz float32, N channels)          │
     │                                             │
     ├────────────────┬────────────────────────────┘
      │                │
      ▼                ▼
  AudioContext      avatarAudioBridge
  (speaker)         (HTTP multipart upload)
      │                │
      │                │  16 kHz / 16-bit / mono / Int16 LE
      │                │  packed as a 44-byte WAV header + samples
      │                ▼
      │             LiveTalking / MuseTalk (:8765)
     │                │
     │                │  WebRTC video stream
     │                ▼
     │             AvatarPanel (<video> element)
     │
     ▼
  You hear voice    You see face with moving lips
```

The key property: **both sides consume the same `AudioBuffer`**. The speaker
plays through `AudioContext.createBufferSource()`; the bridge resamples
and uploads via `POST /humanaudio`. Lipsync is implicit at the source.

## Design decisions

### Method B: front-end AudioContext interception (chosen)

| Criterion | Method A: Kokoro-side tee | Method B (chosen): browser-side tee | Method C: OpenChamber server tee |
|---|---|---|---|
| Server changes | Breaks OpenAI-compatible contract | **Zero** | New `/api/avatar/stream` route |
| Latency | One extra copy | **Zero-copy** (same buffer) | One extra copy |
| Failure isolation | Kokoro failure kills avatar | **Avatar failure does not affect TTS** | Server failure kills both |
| Electron / VSCode | Works | **Works** | Works |
| Streaming future | Hard | **Easier** (AudioWorklet) | Hard |
| Implementation | 1 line | **~80 lines (HTTP multipart)** | ~60 lines |

> Wire-format note: Method B is implemented as `POST /humanaudio` with
> `multipart/form-data` (LiveTalking 2.x). Older 1.x deployments that
> accepted `WS /ws/audio` binary frames are no longer supported by the
> default config; see `audio-bridge.md` for the protocol mapping.

### Why the server is untouched

- Kokoro-FastAPI serves a standard OpenAI-compatible `/v1/audio/speech`
  endpoint. Teeing inside the streaming response would break chunked transfer
  or require an opaque buffer. The server doesn't even know LiveTalking exists.
- The `/api/tts/speak` route (OpenChamber's own TTS endpoint) has the same
  property: it's MP3-out, thoughtless of downstream consumers.
- Both endpoints serve the browser `Say` button (user-initiated per-message
  playback) and the `read aloud` action. The bridge gets every `AudioBuffer`
  that reaches the speaker, period.

### Audio path is intentionally NOT through WebRTC

- Mobile Safari blocks WebRTC audio tracks on autoplay; the existing
  `AudioContext` unlock path (user gesture → `ctx.resume()`) works reliably.
- Voice calls and `read aloud` from the previous message should not
  force a new WebRTC negotiation.
- If the avatar backend is offline, the speaker still works — audio is the
  primary communication channel, video is enhancement.

### Singleton bridge, not per-message

`getAvatarAudioBridge()` in `packages/ui/src/lib/voice/avatarAudioBridge.ts`
returns a singleton that owns the configured server URL and the cached
`imageDataUrl`. There is no long-lived connection — each
`feedAudioChunk` is a fresh `fetch(POST, formData)`. The
`disconnect()` + `connect()` cycle happens when the user toggles the
feature or changes the server URL.

## Module ownership

| Module | Owns | Called by |
|---|---|---|
| `useConfigStore` | Persisted avatar config (URL, image, enable, offset, sessionid) | `AvatarPanel`, `useServerTTS`, `ChatContainer` |
| `useServerTTS` | Fetch MP3 → decode → tee to bridge + speaker | Chat message `Say` handler |
| `getAvatarAudioBridge` | HTTP multipart upload lifecycle, resample, PCM pack, RIFF/WAVE header | `useServerTTS` (audio upload) |
| `AvatarPanel` | WebRTC peer, `/offer` handshake (returns sessionid), settings UI | `ChatContainer` (conditional mount) |
| `LiveTalking` (external) | Audio → video inference, WebRTC output | — |
| `Kokoro-FastAPI` (external) | Text → TTS audio (OpenAI-compatible) | OpenChamber's server-side TTS |

## Startup order

1. Kokoro-FastAPI on `:8880` (must be up before first TTS request)
2. LiveTalking on `:8765` (must be up before avatar panel tries to connect)
3. OpenChamber dev server (auto)
4. OpenChamber browser UI
   - User configures Custom TTS → Kokoro URL → verify speaker
   - User configures Digital Human → LiveTalking URL → upload portrait → enable
5. On each assistant message: user clicks speaker → TTS plays → bridge pushes audio → LiveTalking animates → WebRTC feeds video

WebRTC peer and audio upload connect lazily when `avatarEnabled && avatarServerUrl` is true. No startup dependency on the avatar backend.
