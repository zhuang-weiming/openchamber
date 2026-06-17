# TTS Hook — Tee point and avatar-mode speaker mute

**File**: `packages/ui/src/hooks/useServerTTS.ts`

## Where the tee happens (lines 311–315)

```ts
const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

// Mirror this AudioBuffer to the avatar backend so the digital-human
// mouth can move in sync with what is about to play through the speaker.
if (avatarEnabled && avatarServerUrl) {
  const bridge = getAvatarAudioBridge();
  const sessionId = useConfigStore.getState().currentAvatarSessionId;
  bridge.feedAudioChunk(audioBuffer, sessionId);
}
```

The `AudioBuffer` that `decodeAudioData` produces is the canonical decoded
form of the TTS audio. It is consumed by **two paths in parallel**:

```
AudioBuffer
  ├── ctx.createBufferSource() → GainNode → destination    (speaker, gated)
  └── bridge.feedAudioChunk()                               (POST /humanaudio)
```

`sessionId` is read from the store via `getState()` (not a hook), so
`speak` does not need to subscribe to it. The bridge no-ops when
`sessionId` is empty, which happens between disabling the avatar and
the next `openPeer()` completing.

### Why this is the right insertion point

| Point | Why not |
|---|---|
| Raw MP3 blob (before decode) | Would need server-side decode or pipe through an `AudioDecoder`; MP3 is a container format with variable frame sizes |
| `response.body` (fetch ReadableStream) | Streaming is what we want eventually, but the current hook is `await response.blob()` — changing that is a larger refactor |
| `source.start()` after | Too late — the AudioContext would already have queued the buffer for playback and we'd have already lost the sync reference |
| Inside `onended` | Does not help — the audio is over |

## Avatar-mode speaker mute (lines 327–336)

```ts
const speakerMuted =
  avatarMuteSpeaker && avatarEnabled && Boolean(avatarServerUrl);
const volume = speakerMuted ? 0 : (options?.volume ?? 1.0);
const gainNode = ctx.createGain();
gainNode.gain.value = volume;
```

When the user has checked **Mute local speaker** in the AvatarPanel,
the `GainNode` is clamped to `0`. The decoded `AudioBuffer` is still
pushed to the bridge above so LiveTalking can drive the mouth animation;
the user simply hears nothing from OpenChamber's `AudioContext` path.

The remaining audio source is LiveTalking's WebRTC track (rendered
through the browser's picture-in-picture window or the Electron
MiniChat). That audio is **intrinsically in sync with the mouth frames
LiveTalking renders** because both are produced from the same backend
pipeline, so the lips and the voice stay locked without any explicit
offset tuning.

### Why this replaced the old offset knob

The previous design used `avatarAudioOffsetMs` to delay
`source.start(...)` so the avatar backend had a head start before
sound hit the user's ears. In practice:

- MuseTalk / wav2lip inference (80–200 ms) + `POST /humanaudio`
  upload + ASR queue (100–300 ms) + WebRTC video buffering (50–200 ms)
  together produced a non-constant total delay.
- A static offset could not track a varying pipeline, so the lips
  would either lead or trail the speaker even after tuning.
- Worse, the WebRTC audio leaking through the avatar's video element
  produced a **second** voice out of phase with OpenChamber's TTS,
  which the user perceived as a chaotic overlap.

Routing the user to a single audio source (LiveTalking's WebRTC track)
removes the phase problem entirely. The local speaker's exact start
time no longer matters — it is inaudible.

### Micro-timing

```ts
source.start(0);
```

`source.start(0)` schedules playback at `AudioContext` time `0` (i.e.
immediately on the context's clock). `ctx.currentTime` would be
equivalent — the speaker is gated to silence, so the choice between
`0` and `ctx.currentTime` is cosmetic.

## Failure isolation

```ts
if (avatarEnabled && avatarServerUrl) {
  const bridge = getAvatarAudioBridge();
  const sessionId = useConfigStore.getState().currentAvatarSessionId;
  bridge.feedAudioChunk(audioBuffer, sessionId);
}
```

The `feedAudioChunk` call is **not wrapped in try/catch** because the
bridge never throws on call — it only drops frames silently when
`sessionId` is empty or the upload fetch fails. If the bridge were to
throw (unexpected), the speaker path would not execute and the user
would hear nothing. Adding a protective `try/catch` is acceptable but
measuredly unnecessary given the bridge's contract.

## Hook dependency

The `useCallback` dependency list on `speak` includes the avatar
selectors that gate the speaker mute:

```ts
avatarEnabled,
avatarServerUrl,
avatarMuteSpeaker,
```

`currentAvatarSessionId` is read via `useConfigStore.getState()` inside
the callback, so it does not need to be in the dependency list. This
means `speak` is re-created when the avatar config changes.
That is fine — `speak` is called on user click (not on every render),
and the recreate cost is negligible.
