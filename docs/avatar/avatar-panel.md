# AvatarPanel

The AvatarPanel is a floating settings + video panel anchored in the
top-right corner of the chat surface. It runs the WebRTC peer lifecycle,
displays the avatar's face, and lets the user configure server URL, portrait,
and sync offset.

**File**: `packages/ui/src/components/sections/openchamber/AvatarPanel.tsx`

## Mounting

In `packages/ui/src/components/chat/ChatContainer.tsx:944`:

```tsx
{avatarEnabled && avatarServerUrl && !isMobile && (
  <div className="pointer-events-none absolute right-3 top-3 z-20">
    <div className="pointer-events-auto">
      <AvatarPanel side="right" />
    </div>
  </div>
)}
```

- Only renders on non-mobile viewports (`!isMobile`).
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
│ [http://localhost:8765           ]  │
├──────────────────────────────────────┤
│ Portrait (image)                    │
│ [Choose File]  [Remove portrait]    │
├──────────────────────────────────────┤
│ Audio offset (ms) — sync delay      │
│ [150                              ] │
├──────────────────────────────────────┤
│ [           Apply            ]       │
└──────────────────────────────────────┘
```

All dimensions: `w-72` (288 px), sidebar-width card.

## WebRTC peer lifecycle

`openPeer()` (line 329–366):

1. **Teardown previous peer** — close old `RTCPeerConnection`, stop all
   senders, detach `srcObject`.
2. **Create peer** with Google STUN (`stun:stun.l.google.com:19302`).
3. **Add transceivers** for `video + audio` (both `recvonly`).
4. **Bind `ontrack`** — attach incoming video/audio to `<video>` element.
5. `createOffer()` → `setLocalDescription()`.
6. `POST /offer` with `{ sdp, type, image? }` to the LiveTalking URL.
7. **Parse answer** — `await response.json()` must return `{ sdp, type }`.
8. `setRemoteDescription()`.

`teardownPeer()` (line 314–327):
- Closes all senders and tracks.
- Closes the `RTCPeerConnection`.
- Sets `videoRef.current.srcObject = null`.

### Why `audio` transceiver is added but unused

LiveTalking's `addTransceiver('audio', 'recvonly')` tells the backend the
browser is willing to receive an audio track. The audio bridge, however,
sends PCM over WebSocket — the WebRTC audio track is **not used for
playback**. It exists only to keep the SDP negotiation symmetrical in case
the backend expects both media lines.

The actual audio for the user's ears is played via the existing
`AudioContext` pipeline (same as any TTS in OpenChamber). This preserves
the app's existing autoplay / focus behavior on iOS and Electron.

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
| `muted` | Prevents AudioContext conflicts — WebRTC audio track is not used |

## User controls

| Control | Store binding | Notes |
|---|---|---|
| Enable checkbox | `avatarEnabled` / `setAvatarEnabled` | Persisted to localStorage |
| Server URL input | `avatarServerUrl` / local draft state | Draft only; saved on Apply |
| Portrait file picker | `avatarImageDataUrl` / `setAvatarImageDataUrl` | Base64 data URL; may exceed localStorage quota |
| Remove portrait | `setAvatarImageDataUrl('')` | Clears image; bridge reconnects without init frame |
| Audio offset | `avatarAudioOffsetMs` / local draft state | Min 0, max 2000, step 10 |
| Apply button | Calls all setters | Must be clicked after URL or offset change |

## Theme integration

Uses `useThemeSystem()` to read `currentTheme` tokens. Every styled element
references theme CSS variables directly (e.g.
`backgroundColor: currentTheme.colors.surface.elevated`). No hardcoded Tailwind
color classes.
