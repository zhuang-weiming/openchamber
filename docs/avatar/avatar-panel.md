# AvatarPanel

The AvatarPanel is a floating settings + video panel anchored in the
top-right corner of the chat surface. It runs the WebRTC peer lifecycle,
displays the avatar's face, and lets the user configure the server URL
and audio sync offset.

**File**: `packages/ui/src/components/sections/openchamber/AvatarPanel.tsx`

## Mounting

In `packages/ui/src/components/chat/ChatContainer.tsx:941`:

```tsx
{!isMobile && (
  <div className="pointer-events-none absolute right-3 top-3 z-20">
    <div className="pointer-events-auto">
      <AvatarPanel side="right" />
    </div>
  </div>
)}
```

- Only renders on non-mobile viewports (`!isMobile`).
- Always mounted when on desktop — the panel shows a placeholder
  ("Avatar disabled") until `avatarEnabled` is true and a server URL is
  configured. This lets the user discover the toggle without hunting in
  a settings menu.
- Positioned absolutely inside the chat container — does not affect the
  flow layout of the message list or input area.
- The outer `<div>` has `pointer-events-none` so clicks pass through to
  the chat surface. The inner `<div>` restores them so the panel's form
  controls are interactive.

## Component structure

```
┌──────────────────────────────────────┐
│ [user icon] Digital Human    [Enable]│  ← header row
├──────────────────────────────────────┤
│ ┌──────────────────────────────────┐ │
│ │                                  │ │
│ │          <video> element         │ │  ← aspect-video (16:9)
│ │     or placeholder overlay       │ │
│ │                                  │ │
│ └──────────────────────────────────┘ │
│ [check icon] Live                   │  ← connection status
├──────────────────────────────────────┤
│ LiveTalking server URL              │
│ [http://localhost:8765           ]  │  ← debounced commit (no Apply)
├──────────────────────────────────────┤
│ Audio offset (ms) — sync delay      │
│ [150                              ] │
└──────────────────────────────────────┘
```

All dimensions: `w-72` (288 px), sidebar-width card.

## WebRTC peer lifecycle

`openPeer()` (line 292):

1. **Teardown previous peer** — close old `RTCPeerConnection`, stop all
   senders, detach `srcObject`.
2. **Create peer** with Google STUN (`stun:stun.l.google.com:19302`).
3. **Add transceivers** for `video + audio` (both `recvonly`).
4. **Bind `ontrack`** — attach incoming video stream to `<video>` and
   **stop the WebRTC audio track** (see Safari note below).
5. `createOffer()` → `setLocalDescription()`.
6. `POST /offer` with `{ sdp, type }` to the LiveTalking URL.
7. **Parse answer** — `await response.json()` must return
   `{ sdp, type, sessionid }`. The `sessionid` is a UUID assigned by
   LiveTalking's `SessionManager` (`server/session_manager.py:11`) on
   offer receipt.
8. **Persist `sessionid`** — `setCurrentAvatarSessionId(answer.sessionid)`
   writes the UUID to `useConfigStore`. The audio bridge
   (`useServerTTS.ts:306-315`) reads it back via `getState()` to know
   which `sessionid` to put in the `POST /humanaudio` form. Without
   this step, all subsequent TTS audio uploads are no-ops.
9. `setRemoteDescription()`.

`teardownPeer()` (line 276):
- Closes all senders and tracks.
- Closes the `RTCPeerConnection`.
- Sets `videoRef.current.srcObject = null`.
- **Clears the persisted `sessionid`** via
  `setCurrentAvatarSessionId('')` so a stale UUID never leaks into a
  later bridge upload.

### Why `audio` transceiver is added but unused

LiveTalking's `addTransceiver('audio', 'recvonly')` tells the backend the
browser is willing to receive an audio track. The audio bridge, however,
uploads PCM via `POST /humanaudio` — the WebRTC audio track is **not used
for playback**. It exists only to keep the SDP negotiation symmetrical in
case the backend expects both media lines.

The actual audio for the user's ears is played via the existing
`AudioContext` pipeline (same as any TTS in OpenChamber). This preserves
the app's existing autoplay / focus behavior on iOS and Electron.

**Safari-specific**: in `ontrack` we call
`stream.getAudioTracks().forEach(track => track.stop())` (line 311)
before binding the stream to `<video>`. In Safari, an unstopped audio
track on a `<video srcObject>` claims the audio output device and
silences the `AudioContext` TTS path. Chrome and Edge don't have this
conflict, so the explicit stop is a Safari-targeted no-op there.

## Connection states

| State | Meaning | User sees |
|---|---|---|
| `idle` | No server URL configured | "Not configured" |
| `connecting` | WebRTC offer in flight | "Connecting…" with warning icon |
| `connected` | Remote SDP set, tracks flowing | "Live" with check icon |
| `failed` | Offer rejected or disconnected | "Failed" with error icon |
| `disabled` | URL exists but avatar is toggled off | "Disabled" |

## Video element

```tsx
<video ref={videoRef} autoPlay playsInline muted className="h-full w-full object-cover" />
```

| Attribute | Reason |
|---|---|
| `autoPlay` | Start rendering as soon as `srcObject` is set |
| `playsInline` | Required on iOS Safari to avoid fullscreen takeover |
| `muted` | Suppresses the (already stopped) WebRTC audio track; actual audio plays through the `AudioContext` TTS path. `muted` alone is not enough on Safari — see `ontrack` note above. |

## User controls

| Control | Component | Store binding | Notes |
|---|---|---|---|
| Enable checkbox | shared `<Checkbox>` | `avatarEnabled` / `setAvatarEnabled` | Persisted to localStorage |
| Server URL input | shared `<Input>` | `avatarServerUrl` / local draft state | Draft is debounced 500ms then committed; Enter commits immediately |
| Audio offset | shared `<NumberInput>` | `avatarAudioOffsetMs` | Min 0, max 2000, step 10; commits on change |

The bridge also consumes `currentAvatarSessionId` from the store, but
that field is **not** user-editable — it is written automatically by
`openPeer()` step 8 and cleared by `teardownPeer()`. See
`audio-bridge.md` for the multipart upload protocol.

The Audio offset commits directly to the store on every change — the
value is read on the next `speak()` call, and applying it mid-utterance
would cause a one-off glitch that is worse than a slightly stale value.

Server URL uses a debounced-commit pattern (`useDebouncedValue` with
500 ms delay) instead of an explicit Apply button. The debounce
guarantees that only the final value triggers the `bridge.connect()`
round-trip and the WebRTC peer renegotiation, so the user can type a
full URL without the panel reconnecting on every keystroke. Pressing
Enter flushes the commit immediately. This matches the "live save"
style used by the rest of the OpenChamber settings — no Save / Apply
button — and avoids a Safari-specific bug where the previous
draft + Apply pattern lost clicks across the
`pointer-events-none` / `pointer-events-auto` wrapper around the panel.

### Avatar identity

The avatar face is determined by LiveTalking's `--avatar_id` startup
parameter, not by anything the user configures in this panel. The
`avatarImageDataUrl` field in `useConfigStore` is reserved for a future
portrait picker UI — it is currently unwired (no input element calls
its setter), so the panel never sends an `image` field on `POST /offer`.
LiveTalking falls back to its default avatar in that case.

### Shared UI primitives

This component uses three of the shared form primitives (`Input`,
`NumberInput`, `Checkbox`). Where the previous version used raw HTML
elements with hand-rolled Tailwind classes, the current version
defers to `packages/ui/src/components/ui/*` so:

- `Input` provides focus rings, hover transitions, and error states for
  free.
- `NumberInput` provides mobile +/- buttons and step normalization.
- `Checkbox` provides `ariaLabel`, indeterminate state, and Base UI's
  built-in keyboard handling.

## Internationalization

Every user-facing string is routed through `useI18n()` with keys in the
`chat.avatar.*` namespace. Keys live in `packages/ui/src/lib/i18n/messages/*.ts`
across all 9 supported locales (en, zh-CN, zh-TW, es, fr, ko, pl, pt-BR, uk).

| Key | Purpose |
|---|---|
| `chat.avatar.title` | Panel header |
| `chat.avatar.enableLabel` | Checkbox label and aria-label |
| `chat.avatar.disabledPlaceholder` | Empty-state hint when toggled off |
| `chat.avatar.connectionFailed` | Fallback message when WebRTC fails |
| `chat.avatar.serverUrlLabel` / `.serverUrlPlaceholder` | URL field |
| `chat.avatar.audioOffsetLabel` | Sync offset field |
| `chat.avatar.status.{idle,connecting,live,failed,notConfigured}` | Connection state labels |

The following keys are **reserved** in all 9 locales for a future
portrait picker / Apply button restoration. They are not currently
referenced by any component and can be safely removed if the
corresponding UI is confirmed out of scope:

- `chat.avatar.uploadPrompt`, `chat.avatar.portraitLabel`,
  `chat.avatar.removePortrait` — portrait picker UI
- `chat.avatar.apply` — Apply CTA (replaced by debounced commit)
- `chat.avatar.toast.portraitTooLarge`,
  `chat.avatar.toast.portraitQuotaExceeded` — portrait upload errors

Connection state values that depend on `connectionState` are resolved
inside the component on every render so locale changes propagate without
remount.

## Theme integration

Uses `useThemeSystem()` to read `currentTheme` tokens. Every styled element
references theme CSS variables directly (e.g.
`backgroundColor: currentTheme.colors.surface.elevated`). No hardcoded Tailwind
color classes.
