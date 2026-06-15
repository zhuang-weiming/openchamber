# TTS Hook — Tee point and audio offset

**File**: `packages/ui/src/hooks/useServerTTS.ts`

## Where the tee happens (lines 302–312)

```ts
const audioBuffer = await ctx.decodeAudioData(arrayBuffer);

// Mirror this AudioBuffer to the avatar backend so the digital-human
// mouth can move in sync with what is about to play through the speaker.
if (avatarEnabled && avatarServerUrl) {
  const bridge = getAvatarAudioBridge();
  bridge.feedAudioBuffer(audioBuffer);
}
```

The `AudioBuffer` that `decodeAudioData` produces is the canonical decoded
form of the TTS audio. It is consumed by **two paths in parallel**:

```
AudioBuffer
  ├── ctx.createBufferSource() → GainNode → destination    (speaker)
  └── bridge.feedAudioBuffer()                              (WebSocket)
```

### Why this is the right insertion point

| Point | Why not |
|---|---|
| Raw MP3 blob (before decode) | Would need server-side decode or pipe through an `AudioDecoder`; MP3 is a container format with variable frame sizes |
| `response.body` (fetch ReadableStream) | Streaming is what we want eventually, but the current hook is `await response.blob()` — changing that is a larger refactor |
| `source.start()` after | Too late — the AudioContext would already have queued the buffer for playback and we'd have already lost the sync reference |
| Inside `onended` | Does not help — the audio is over |

## Audio offset for lipsync (lines 348–355)

```ts
const offsetSeconds = avatarEnabled && avatarServerUrl
  ? Math.max(0, avatarAudioOffsetMs) / 1000
  : 0;
if (offsetSeconds > 0) {
  source.start(ctx.currentTime + offsetSeconds);
} else {
  source.start(0);
}
```

`AvatarPanel.handleOffsetChange` clamps the value to `[0, 2000]` before
storing, so the `Math.max(0, …)` here is defense-in-depth — by the time
`avatarAudioOffsetMs` reaches this hook it is always non-negative.

### Why a delay is needed

LiveTalking / MuseTalk inference has a per-frame latency of
80–200 ms. The WebRTC pipeline adds another ~50 ms. If the speaker
plays the audio immediately (`source.start(0)`), the user hears the
voice before the mouth starts moving — the classic "dubbed movie"
effect.

Scheduling the speaker start `offsetSeconds` into the future gives the
avatar backend a head start. The AudioBuffer has already been pushed
to the bridge *before* `source.start(when)` is called, so the avatar
backend can begin processing while the speaker waits.

### Default: 150 ms

The default `avatarAudioOffsetMs = 150` (defined in `useConfigStore`).
Users can tune this in the AvatarPanel (0–2000 ms, step 10). The optimal
value depends on:

- MuseTalk inference time (GPU vs CPU, model size)
- Network latency between browser and LiveTalking
- Audio frame size (longer utterances have higher effective latency
  because the backend can pipeline)

### Micro-timing

```ts
source.start(ctx.currentTime + offsetSeconds);
```

`ctx.currentTime` is the `AudioContext`'s clock, not `Date.now()`. This
means the delay is accurate to the sample frame level — no drift from
macrotask scheduling or event loop jitter.

## Failure isolation

```ts
if (avatarEnabled && avatarServerUrl) {
  const bridge = getAvatarAudioBridge();
  bridge.feedAudioBuffer(audioBuffer);
}
```

The `feedAudioBuffer` call is **not wrapped in try/catch** because the
bridge never throws on call — it only drops frames silently if the socket
is closed. If the bridge were to throw (unexpected), the speaker path
would not execute and the user would hear nothing. Adding a protective
`try/catch` is acceptable but measuredly unnecessary given the bridge's
contract.

## Hook dependency

The `useCallback` dependency list on `speak` adds three new selectors
(line 369):

```ts
avatarEnabled,
avatarServerUrl,
avatarAudioOffsetMs,
```

This means `speak` is re-created when the avatar config changes.
That is fine — `speak` is called on user click (not on every render),
and the recreate cost is negligible.
