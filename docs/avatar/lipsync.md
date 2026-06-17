# Lipsync — Audio / Video synchronization

The Digital Human feature has **two parallel output paths** to the user:

1. **Voice** — LiveTalking's WebRTC audio track (rendered through the
   browser's picture-in-picture window or the Electron MiniChat).
2. **Face** — LiveTalking's WebRTC video track of the MuseTalk / wav2lip
   rendered mouth.

Both come from the **same backend pipeline**, so the voice and mouth
animation are intrinsically in lockstep — no offset tuning is needed.

OpenChamber's `AudioContext` TTS path also exists, but in avatar mode
its local `GainNode` is clamped to `0` (see "Avatar-mode mute" below).
That keeps OpenChamber's voice from competing with LiveTalking's voice.

## Where the latency comes from

```
                   ┌──── MuseTalk / wav2lip inference (~120 ms typical, GPU)
                   │
POST /humanaudio → │  ┌── ASR queue + WebRTC server-side buffering (~30 ms)
                   │  │
                   ▼  ▼
browser frame ready at t = ~300 ms after `feedAudioChunk`
```

Even though LiveTalking takes ~300 ms to render the first mouth frame,
the user perceives perfect sync because the **audio** they hear is also
LiveTalking's — produced from the same audio frames that drive the
mouth animation.

## Avatar-mode mute (the new design)

When the user enables **Mute local speaker** in the AvatarPanel
(`avatarMuteSpeaker = true`), `useServerTTS` sets the local `GainNode`
to `0`:

```
AudioBuffer
  ├── ctx.createBufferSource() → GainNode (gain = 0) → destination    (silent)
  └── bridge.feedAudioChunk()                                          (POST /humanaudio)
```

The TTS audio still flows to LiveTalking (the bridge upload is
unaffected) so the mouth animation runs as before. The user simply does
not hear OpenChamber's voice — they hear LiveTalking's WebRTC audio
instead, which is intrinsically in sync.

### Why this replaced the old `avatarAudioOffsetMs` knob

The previous design ran OpenChamber's `AudioContext` TTS at full
volume *and* delivered LiveTalking's WebRTC audio through the avatar
`<video>` element. With two audio sources present, every additional
millisecond of latency in the WebRTC video pipeline manifested as
phase drift between the two voices. Static offsets could not track a
non-constant pipeline (MuseTalk inference + multipart upload +
WebRTC buffering + browser decode each vary), so the offset knob was
a best-effort heuristic at best.

Routing the user to a single audio source (LiveTalking's WebRTC track)
removes the phase problem. The local `GainNode` value no longer
affects what the user hears, so timing becomes irrelevant.

## Why we do NOT use WebRTC audio track for sync (legacy rationale)

> **Historical note**: in the previous design, OpenChamber stopped the
> WebRTC audio track in `AvatarPanel.ontrack` and played the speaker
> path instead. The new avatar-mode mute design **does not** stop the
> track — the WebRTC audio is the only audible path when the mute is
> on, and the AudioContext TTS is gated to silence.

The legacy rationale for stopping the WebRTC audio:

1. **Mobile Safari autoplay** — WebRTC audio tracks are subject to
   stricter autoplay rules than `AudioContext`. The existing TTS path
   uses `AudioContext` because it has been battle-tested across browsers.
2. **Existing UX** — the "say" feature already works for messages the
   avatar cannot handle (e.g. very long outputs that exceed LiveTalking's
   session time). Keeping audio out of WebRTC preserves that path.
3. **Failure isolation** — a WebRTC audio track drop would silence
   the entire TTS. The previous design had audio independent of the
   avatar pipeline.
4. **Safari output-device claim** — when a `MediaStream` with an audio
   track is bound to a `<video srcObject>`, Safari claims the audio
   output device for that track even when the video element has
   `muted`. This silenced the `AudioContext` TTS path. To work around
   this without dropping the WebRTC audio channel entirely,
   `AvatarPanel.ontrack` previously called
   `stream.getAudioTracks().forEach(t => t.stop())` before binding
   `srcObject`. With the new mute design, this Safari claim becomes a
   feature — it naturally silences `AudioContext` on Safari when the
   avatar is active.

If LiveTalking adds a low-latency server-driven audio path in a future
version, we can re-evaluate. For now, the avatar-mode mute is the
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