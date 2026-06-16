# Troubleshooting

Common failure modes and how to diagnose them. For everything below, the
first step is to open browser DevTools → Network and Console tabs.

## 1. Speaker button plays nothing at all

**Not avatar-related**, but worth ruling out first.

| Check | Command |
|---|---|
| Server TTS endpoint returns 200 | `curl -X POST http://localhost:<port>/api/tts/speak -H 'Content-Type: application/json' -d '{...}' -I` |
| Custom TTS URL is correct in Settings | OpenChamber Settings → TTS → Custom TTS |
| Kokoro-FastAPI running | `curl http://localhost:8880/v1/models` |
| Browser console shows `[useServerTTS] Decoding audio data...` | If absent, the fetch itself failed |

## 2. Speaker works, but no avatar video

### 2.1. AvatarPanel does not render

- Check that `avatarEnabled` is `true` AND `avatarServerUrl` is non-empty.
- Mobile viewports never render the panel (`!isMobile` in
  `ChatContainer.tsx:944`). Use a desktop browser or DevTools mobile
  emulator to desktop mode.

### 2.2. AvatarPanel renders but shows "Failed" status

Open Network tab. The most likely failure is `POST /offer` returning a
non-2xx.

| Symptom | Cause | Fix |
|---|---|---|
| `POST /offer` returns 404 | LiveTalking version uses a different path | Check LiveTalking's actual endpoint; override `buildOfferUrl` in `AvatarPanel.tsx:369` |
| `POST /offer` returns 500 | Backend error | Check LiveTalking's stdout/log for the stack trace; usually a missing model weight or CUDA error |
| `POST /offer` hangs forever | Network unreachable | Verify the URL is reachable from the browser: `curl <url>` |
| `POST /offer` returns CORS error | LiveTalking CORS not configured | LiveTalking's FastAPI server must allow the OpenChamber origin; check `--cors-allow-origins` or its config |

### 2.3. WebRTC offer succeeds but no video frames

- Check `<video>` element for `srcObject` in DevTools Elements panel.
- Look for ICE failures in the Console. The default STUN is
  `stun:stun.l.google.com:19302`; if Google STUN is blocked (corporate
  networks, China), you may need a TURN server.
- Check LiveTalking's `addTransceiver` setup. The browser adds
  `recvonly` video + audio; backend must send both.

## 3. Avatar video plays but is not lipsynced

### 3.1. Mouth moves before voice (video leads audio)

- Reduce `avatarAudioOffsetMs` by 20–50 ms. Try 100, 80, 60…
- Do not reduce below 50 ms — the first WebRTC frame still needs time to
  arrive.

### 3.2. Mouth moves after voice (video lags audio)

- Increase `avatarAudioOffsetMs` by 20–50 ms. Try 200, 250, 300…
- If you need more than 500 ms, the avatar backend is overloaded or
  using CPU-only inference. Check LiveTalking's GPU utilization.

### 3.3. First word of each message is muted

- `avatarAudioOffsetMs` is too large. The first 100–200 ms of audio
  is being scheduled in the future, but the message starts silent.
- Reduce until the first word is audible.

## 4. Uploads fail with "session not found"

Open Console. Look for `[avatar-bridge] upload failed: ...` and the
`lastError` exposed on the bridge state. Common causes:

| Cause | Symptom |
|---|---|
| `currentAvatarSessionId` is empty (no `/offer` handshake yet) | Upload is silently no-op'd by the bridge; no `lastError` is set |
| Peer reconnected; old `sessionid` is stale | Server returns `{"code":-1,"msg":"session not found"}`; `lastError: "upload failed: HTTP 200"` if LiveTalking still 200s, or `lastError: "upload failed: HTTP 500"` on 500s |
| LiveTalking crashed mid-session | Server returns 500; subsequent uploads also fail |
| Wrong port in `avatarServerUrl` | `fetch` rejects with `TypeError: Failed to fetch`; `lastError: "upload failed: <message>"` |

The bridge is **fire-and-forget**: failed uploads are logged and the
frame is dropped. The speaker still plays. To recover, fix the
underlying cause and trigger a new `openPeer()` (toggle avatar off and
on, or change the server URL).

## 5. Image upload not persisted across page reloads

- The base64 data URL exceeded the localStorage quota. The setter catches
  the error (`useConfigStore.ts:2282`) and rolls back the in-memory copy
  so the store and persistent storage stay in sync.
- **Fix**: reduce image resolution before upload. A 256×256 JPEG at 80%
  quality is usually under 50 KB and persists fine.
- Future: switch from localStorage to IndexedDB for image persistence
  (out of scope for v1).

## 6. High CPU usage on mobile or low-power devices

- Disable avatar when not in use. Each `feedAudioChunk` resample pass
  walks the entire `Float32Array` in a tight loop. For a 30-second
  message at 24 kHz mono, that's 720,000 samples × linear interpolation
  per message.
- The `<video>` element with WebRTC also keeps the GPU busy decoding
  every frame.
- Mobile viewports already don't render the panel (`!isMobile` guard),
  so this is mostly a concern for tablets and laptops on battery.

## 7. `bun run dev` does not start

This is a project-wide issue, not avatar-specific. Verify:

```bash
bun install
bun run type-check
bun run lint
```

If those pass, `bun run dev` should start on the next available port.
The dev server URL is printed at startup.

## 8. Diagnostics: log levels

The bridge writes to `lastError` (exposed on `AvatarAudioBridgeState`)
on every failure. There are no `console.log` calls in the HTTP path —
failures are observable only via the state object.

| Event | `lastError` value |
|---|---|
| `fetch` rejected (network, CORS) | `"upload failed: <Error message>"` |
| `POST /humanaudio` returned non-2xx | `"upload failed: HTTP <status>"` |
| `currentAvatarSessionId === ''` | (silent — frame dropped, no error reported) |
| `connect()` not called or empty URL | (silent — frame dropped, no error reported) |

`useServerTTS` adds two logs of its own around the tee:

- `[useServerTTS] Decoding audio data...` — MP3 fully downloaded.
- `[useServerTTS] Starting audio playback via Web Audio API...` —
  just before `source.start(when)`.

If you see the first but not the second, the decoder succeeded but
the speaker start failed (rare). If you see neither, the fetch itself
returned a non-OK status.

## 9. LiveTalking version compatibility

The endpoints `/offer` (HTTP) and `/humanaudio` (HTTP multipart) are
documented in LiveTalking's [docs/api.md](https://github.com/lipku/LiveTalking/blob/main/docs/api.md).
They have changed across versions:

| Version | Offer path | Audio path | Audio format |
|---|---|---|---|
| 2.x (current fork) | `POST /offer` | `POST /humanaudio` | multipart/form-data `file` field, 16 kHz mono PCM WAV |
| 1.x | `POST /offer` | `WS /ws/audio` | binary Int16 LE frames |
| 0.8.x | `POST /human` | `WS /human/audio` | binary Int16 LE frames |

This fork uses the 2.x row. If you downgrade to 1.x, override
`buildOfferUrl` in `AvatarPanel.tsx:374` and `audioPath` in the
bridge config, and rewrite `feedAudioChunk` to use `new WebSocket(...)`
and binary `socket.send(...)` instead of `fetch(POST, formData)`. The
`packWav` helper can stay (the 1.x audio path also wants valid PCM),
but you would need to chunk the upload by hand instead of one WAV per
message.
