# Config Store — Avatar fields

**File**: `packages/ui/src/stores/useConfigStore.ts`

## New fields

| Field | Type | Default | Persisted key | Setter |
|---|---|---|---|---|
| `avatarServerUrl` | `string` | `''` (empty → disabled) | `avatarServerUrl` | `setAvatarServerUrl(url)` |
| `avatarImageDataUrl` | `string` | `''` (none) | `avatarImageDataUrl` | `setAvatarImageDataUrl(dataUrl)` |
| `avatarEnabled` | `boolean` | `false` | `avatarEnabled` | `setAvatarEnabled(enabled)` |
| `avatarAudioOffsetMs` | `number` | `150` | `avatarAudioOffsetMs` | `setAvatarAudioOffsetMs(ms)` |

All four are read from `localStorage` on initialization and written to
`localStorage` on every setter call.

## Initialization (lines 907–943)

```ts
avatarServerUrl: (() => {
  if (typeof window !== 'undefined') {
    const saved = localStorage.getItem('avatarServerUrl');
    if (saved) return saved;
  }
  return '';
})(),
```

The `typeof window !== 'undefined` guard is required because Zustand's
`create` runs during module evaluation, which on the server (SSR) has no
`localStorage`. On the client the guard passes and the last saved URL is
restored.

Same pattern for all four fields. `avatarAudioOffsetMs` also validates the
parsed number is within `[0, 2000]` before accepting it; otherwise the
default `150` sticks.

## Setters

Each setter is a one-liner:

```ts
setAvatarServerUrl: (url) => {
  set({ avatarServerUrl: url });
  if (typeof window !== 'undefined') {
    localStorage.setItem('avatarServerUrl', url);
  }
},
```

### localStorage quota concern for image data URLs

`avatarImageDataUrl` can be a very large string (a high-res JPEG at
base64 can be 2–5 MB). `localStorage` is usually capped at 5–10 MB per
origin. The setter wraps `setItem` in try/catch so a quota overflow
does not crash the app:

```ts
setAvatarImageDataUrl: (dataUrl) => {
  set({ avatarImageDataUrl: dataUrl });
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem('avatarImageDataUrl', dataUrl);
    } catch {
      // Data URLs can exceed the localStorage quota; keep in-memory copy.
    }
  }
},
```

When the quota is exceeded the store retains the data URL in memory
(so the avatar panel still has it for the `image` field in the WebSocket
init frame) but it is not persisted across page reloads.

## Subscribers

| Subscriber | Field(s) consumed | File |
|---|---|---|
| `AvatarPanel` | `avatarServerUrl`, `avatarImageDataUrl`, `avatarEnabled`, `avatarAudioOffsetMs` | `avatar-panel.tsx:41-48` |
| `useServerTTS` | `avatarServerUrl`, `avatarEnabled`, `avatarAudioOffsetMs` | `useServerTTS.ts:144-146` |
| `ChatContainer` | `avatarEnabled`, `avatarServerUrl` | `ChatContainer.tsx:555-556` |

Only the fields each component actually needs are selected via Zustand
leaf selectors — no component subscribes to the entire `ConfigStore`.
