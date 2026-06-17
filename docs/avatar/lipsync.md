# Lipsync — Audio / Video synchronization

The Digital Human feature has **two parallel output paths** to the user:

1. **Voice** — TTS audio through `AudioContext` (zero pipeline delay)
2. **Face** — WebRTC video of a MuseTalk-rendered mouth (80–300 ms pipeline delay)

If both pipelines start at the same time, the user sees a face that opens
its mouth 100–300 ms **after** the voice starts. We compensate by
delaying the audio to match the video.

## Where the latency comes from

```
                  ┌──── MuseTalk inference (~120 ms typical, GPU)
                  │
POST /humanaudio →│  ┌── ASR queue + WebRTC server-side buffering (~30 ms)
                  │  │
                  ▼  ▼
browser frame ready at t = ~300 ms after `feedAudioChunk`
```

The mouth is rendered for an audio frame that has not yet been heard.
The user sees the mouth animate "in the future" relative to the audio.

If the speaker starts at `t = 0` and the first WebRTC frame is ready
at `t = 150 ms`, the user perceives a 150 ms "delay before the mouth
moves" while the audio is already in their ears.

## How the offset fixes it

```
       t = 0       t = 150 ms         t = 200 ms
        │             │                  │
audio:  │  silenced  │──────────────▶  starts playing
        │             │                  │
video:  │  first WebRTC frame arrives   │  continues rendering
        │             │                  │
user:   │  sees mouth move as sound      │  starts
        │  begins — perceived sync.      │
```

By scheduling the speaker start at `ctx.currentTime + avatarAudioOffsetMs`,
the audio is **delayed** until the avatar backend has had time to produce
its first frame. The same `AudioBuffer` reaches both paths, so once the
audio starts playing the mouth animation is in lockstep with it.

This is the standard trick used in karaoke and AV sync — small audio
delays are imperceptible to humans, but video-audio desync is jarring.

## Why 150 ms default

| Component | Latency | Notes |
|---|---|---|
| MuseTalk inference (first frame) | 80–200 ms | GPU ≈ 80, CPU ≈ 200 |
| `POST /humanaudio` upload + ASR queue | 100–300 ms | `fetch` body upload + LiveTalking's `put_audio_file` → `soundfile.read` → 20ms chunk queue |
| WebRTC ICE / SDP / buffering | 20–50 ms | LAN to localhost is low |
| Browser video decode | ~10 ms | Negligible |
| **Total** | **~300–500 ms** | Recommended starting offset |

## Tuning `avatarAudioOffsetMs`

The value is editable in the AvatarPanel (`0–2000` ms, step 10). Common
adjustments:

| Symptom | Adjustment |
|---|---|
| Mouth moves before voice (lead) | Reduce offset by 20–50 ms |
| Mouth trails voice (lag) | Increase offset by 20–50 ms |
| First word is muted (offset too large) | Reduce offset until first word is audible |
| Avatar face stutters at the start of each message | Increase offset to give the backend more warmup time |

A good starting point: record a 5-second message, listen, observe the
mouth, adjust by 10 ms increments until they align.

> Note: when the audio bridge is in HTTP multipart mode (the default
> for LiveTalking 2.x), the `fetch` upload + server-side
> `soundfile.read` decode adds an extra 100–300 ms of latency compared
> to a hypothetical WebSocket stream. The recommended starting
> `avatarAudioOffsetMs` is **300 ms**, not 150 ms. Tune from there
> using the table above.

## Why we do NOT use WebRTC audio track for sync

An alternative architecture is to send audio through the WebRTC media
stream (a bidirectional audio channel) and let the avatar backend mux
mouth animation directly with the audio the user hears. This avoids the
need for an offset and gives sub-frame sync.

We do not use it because:

1. **Mobile Safari autoplay** — WebRTC audio tracks are subject to
   stricter autoplay rules than `AudioContext`. The existing TTS path
   uses `AudioContext` because it has been battle-tested across browsers.
2. **Existing UX** — the "say" feature already works for messages the
   avatar cannot handle (e.g. very long outputs that exceed LiveTalking's
   session time). Keeping audio out of WebRTC preserves that path.
3. **Failure isolation** — a WebRTC audio track drop would silence
   the entire TTS. The current design has audio independent of the
   avatar pipeline.
4. **Safari output-device claim** — when a `MediaStream` with an audio
   track is bound to a `<video srcObject>`, Safari claims the audio
   output device for that track even when the video element has
   `muted`. This silences the `AudioContext` TTS path. To work around
   this without dropping the WebRTC audio channel entirely,
   `AvatarPanel.ontrack` calls
   `stream.getAudioTracks().forEach(t => t.stop())` before binding
   `srcObject`. The track is requested (to keep SDP symmetric with
   LiveTalking's expectations) and immediately discarded. See
   `avatar-panel.md` → "Why `audio` transceiver is added but unused".

If LiveTalking adds a low-latency server-driven audio path in a future
version, we can re-evaluate. For now, the `offsetSeconds` delay is the
simplest correct solution.

## Future: AudioWorklet-based streaming

The current design is **post-decode tee**: we wait for the entire MP3 to
download and decode, then forward the buffer to the bridge. A
streaming design using `AudioWorklet` would:

1. Start feeding PCM chunks to the bridge **before** the full buffer is
   decoded.
2. Reduce end-to-end latency by the entire MP3 download + decode time
   (~200–800 ms for a long message).

The bridge exposes `feedAudioChunk(audioBuffer, sessionId)` for callers
that want to bypass `useServerTTS` and pipe directly. The
`useServerTTS` refactor to wire `AudioWorklet` is a follow-up tracked
in `audio-bridge.md` → Future work.
