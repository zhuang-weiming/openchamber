# Config Store — Avatar fields

**File**: `packages/ui/src/stores/useConfigStore.ts`

## New fields

| Field | Type | Default | Persisted key | Setter | Status |
|---|---|---|---|---|---|
| `avatarServerUrl` | `string` | `''` (empty → disabled) | `avatarServerUrl` | `setAvatarServerUrl(url)` | wired in `AvatarPanel` |
| `avatarEnabled` | `boolean` | `false` | `avatarEnabled` | `setAvatarEnabled(enabled)` | wired in `AvatarPanel` |
| `avatarMuteSpeaker` | `boolean` | `false` | `avatarMuteSpeaker` | `setAvatarMuteSpeaker(enabled)` | wired in `AvatarPanel`; gated on `avatarEnabled && avatarServerUrl` |
| `currentAvatarSessionId` | `string` | `''` (none) | `currentAvatarSessionId` | `setCurrentAvatarSessionId(id)` | auto-written on `POST /offer` |
| `avatarImageDataUrl` | `string` | `''` (none) | `avatarImageDataUrl` | `setAvatarImageDataUrl(dataUrl)` | **reserved** — no UI calls the setter yet |

All five are read from `localStorage` on initialization and written to
`localStorage` on every setter call. `currentAvatarSessionId` is
written by `AvatarPanel` on every successful `POST /offer` and cleared
on `teardownPeer()`; it is not user-editable. The `avatarImageDataUrl`
setter is implemented with a quota-rollback safety (see below) for the
day a portrait picker is added.

## Initialization (lines 913–956)

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

Same pattern for all four fields. `avatarMuteSpeaker` is a plain
boolean — `'true'` / `'false'` strings are matched against
`localStorage.getItem('avatarMuteSpeaker')`, anything else falls back
to `false`.

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

`avatarImageDataUrl` is reserved for a future portrait picker. When the
UI lands, a high-res JPEG at base64 can be 2–5 MB, and `localStorage` is
usually capped at 5–10 MB per origin — the rest of `useConfigStore`
shares the same budget, so an unchecked portrait could blow the budget
and break unrelated settings.

Two defenses are wired in the store today:

**1. Quota-rollback safety in the setter** (`useConfigStore.ts:2278`):

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
returns the store to its prior state. This is intentionally stricter
than the original "keep in memory even if persistence fails" behavior:
a partially-persisted state (in-memory ≠ localStorage) was confusing
during refresh — the user would see their portrait working, then lose
it on a reload with no explanation.

**2. The future client-side size guard** will live in `AvatarPanel.tsx`
— files larger than `PORTRAIT_MAX_BYTES` (512 KB) will be rejected
before any `FileReader` work runs, surfacing a
`chat.avatar.toast.portraitTooLarge` toast. The matching
`chat.avatar.toast.portraitQuotaExceeded` toast will be surfaced by
the setter above once the picker is wired.

Note that the avatar fields are **not** in the `persist()` partializer
(`useConfigStore.ts:2628-2649`), so zustand's `persist` middleware does
not re-serialize the (potentially large) image data URL on every state
change. Persistence is fully delegated to the manual `localStorage`
calls above — which is the established pattern for all voice fields in
this store.

## Subscribers

| Subscriber | Field(s) consumed | File |
|---|---|---|
| `AvatarPanel` | `avatarServerUrl`, `avatarEnabled`, `avatarMuteSpeaker`, `setCurrentAvatarSessionId` | `avatar-panel.tsx:50-56` |
| `useServerTTS` | `avatarServerUrl`, `avatarEnabled`, `avatarMuteSpeaker` | `useServerTTS.ts:145-147` |
| `useServerTTS` (via `getState()`) | `currentAvatarSessionId` | `useServerTTS.ts:313` |
| `ChatContainer` | (mount-only) | `ChatContainer.tsx:941-947` |

Only the fields each component actually needs are selected via Zustand
leaf selectors — no component subscribes to the entire `ConfigStore`.
