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
origin and OpenChamber's `useConfigStore` is shared with many other
keys, so a large portrait can blow the budget and break unrelated
settings.

Two defenses work together:

**1. Client-side size guard** in `AvatarPanel.tsx` — files larger than
`PORTRAIT_MAX_BYTES` (512 KB, ~2–4× a typical 256×256 JPEG) are rejected
before any `FileReader` work runs:

```ts
if (file.size > PORTRAIT_MAX_BYTES) {
  toast.error(t('chat.avatar.toast.portraitTooLarge', {
    maxKb: Math.round(PORTRAIT_MAX_BYTES / 1024),
  }));
  return;
}
```

**2. Rollback on quota overflow** in the setter (`useConfigStore.ts`):

```ts
setAvatarImageDataUrl: (dataUrl) => {
  set({ avatarImageDataUrl: dataUrl });
  if (typeof window !== 'undefined') {
    try {
      localStorage.setItem('avatarImageDataUrl', dataUrl);
    } catch {
      // Quota exceeded or storage unavailable. Roll back the in-memory copy
      // so the store and persistent storage stay in sync.
      set({ avatarImageDataUrl: '' });
    }
  }
},
```

When the quota is exceeded the setter clears the in-memory copy and
returns the store to its prior state. `AvatarPanel` then surfaces a
`chat.avatar.toast.portraitQuotaExceeded` toast so the user understands
why their portrait is gone.

This is intentionally stricter than the original "keep in memory even
if persistence fails" behavior: a partially-persisted state (in-memory
≠ localStorage) was confusing during refresh — the user would see their
portrait working, then lose it on a reload with no explanation.

Note that the avatar fields are **not** in the `persist()` partializer
(`useConfigStore.ts:2609-2630`), so zustand's `persist` middleware does
not re-serialize the data URL on every state change. Persistence is
fully delegated to the manual `localStorage` calls above — which is the
established pattern for all voice fields in this store.

## Subscribers

| Subscriber | Field(s) consumed | File |
|---|---|---|
| `AvatarPanel` | `avatarServerUrl`, `avatarImageDataUrl`, `avatarEnabled`, `avatarAudioOffsetMs` | `avatar-panel.tsx:41-48` |
| `useServerTTS` | `avatarServerUrl`, `avatarEnabled`, `avatarAudioOffsetMs` | `useServerTTS.ts:144-146` |
| `ChatContainer` | `avatarEnabled`, `avatarServerUrl` | `ChatContainer.tsx:555-556` |

Only the fields each component actually needs are selected via Zustand
leaf selectors — no component subscribes to the entire `ConfigStore`.
