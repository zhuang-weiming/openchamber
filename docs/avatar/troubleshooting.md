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

- The panel is mounted on **non-mobile** viewports only (`!isMobile` in
  `ChatContainer.tsx:941`). On mobile, the panel is intentionally
  hidden — see `docs/avatar/setup.md` for the rationale. Use a desktop
  browser or DevTools mobile-emulator set to a desktop viewport to
  inspect.
- The panel is always mounted (not gated on `avatarEnabled` /
  `avatarServerUrl`) — it shows an "Avatar disabled" placeholder until
  the user toggles it on and pastes a server URL.

### 2.2. AvatarPanel renders but shows "Failed" status

Open Network tab. The most likely failure is `POST /offer` returning a
non-2xx.

| Symptom | Cause | Fix |
|---|---|---|
| `POST /offer` returns 404 | LiveTalking version uses a different path | Check LiveTalking's actual endpoint; override `buildOfferUrl` in `AvatarPanel.tsx:341` |
| `POST /offer` returns 500 | Backend error | Check LiveTalking's stdout/log for the stack trace; usually a missing model weight or CUDA error |
| `POST /offer` hangs forever | Network unreachable | Verify the URL is reachable from the browser: `curl <url>` |
| `POST /offer` returns CORS error | LiveTalking CORS not configured | LiveTalking's FastAPI server must allow the OpenChamber origin; check `--cors-allow-origins` or its config |

### 2.3. WebRTC offer succeeds but no video frames

- Check `<video>` element for `srcObject` in DevTools Elements panel.
- Look for ICE failures in the Console. The default STUN is
  `stun:stun.l.google.com:19302`; if Google STUN is blocked (corporate
  networks, China), you may need a TURN server.
- The browser adds `recvonly` video + audio transceivers; the audio
  track is **stopped in `ontrack`** (`AvatarPanel.tsx:311`) because
  Safari would otherwise claim the audio output device and silence the
  TTS path. LiveTalking must still send the audio track in its answer
  for SDP symmetry; only the browser-side consumption is dropped.

## 3. Two voices overlap / audio is out of sync with lips

The previous `avatarAudioOffsetMs` knob is **removed**. With avatar
mode active the recommended workflow is:

1. Enable **Mute local speaker** in the AvatarPanel (`avatarMuteSpeaker`).
   OpenChamber's `AudioContext` TTS is clamped to `0`; the bridge still
   uploads audio to LiveTalking so the mouth animates.
2. Open the avatar's video in your browser's picture-in-picture window
   (Edge / Chrome right-click → "Picture in Picture"), or use the
   Electron MiniChat. Unmute the PiP speaker button — that audio comes
   from LiveTalking's WebRTC track and is intrinsically in sync with
   the mouth frames.

### 3.1. Mouth and voice still don't align with mute on

This means LiveTalking's WebRTC audio is itself out of sync with its
own video. Causes:

- LiveTalking is using CPU inference. Switch to a GPU or reduce the
  model size.
- The `POST /humanaudio` upload is slow. Check `lastError` on the
  bridge state.
- The network between browser and LiveTalking has high jitter. The
  offset knob that previously helped here is gone; the cleanest fix is
  to run LiveTalking on the same machine as the browser.

### 3.2. PiP / MiniChat shows no audio

- Edge / Chrome: the PiP speaker button is muted by default. Click it
  to enable audio. If still silent, verify the avatar's WebRTC
  connection is `connected` in the AvatarPanel status row.
- Electron MiniChat: the MiniChat window's avatar inherits the same
  `<video muted>` element as the main chat. The PiP-style speaker
  control lives in the browser-native PiP affordance, not the MiniChat
  window itself.

### 3.3. First word of each message is muted (legacy symptom)

This used to be caused by an over-large `avatarAudioOffsetMs`. The
offset knob no longer exists, so this symptom now points to the bridge
upload timing out before LiveTalking's audio pipeline is primed.
Check `[avatar-bridge] upload failed:` in the Console.

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

## 5. Server URL change does nothing in the panel

The URL field uses a 500 ms debounced commit. Type the URL, pause for
half a second, and the WebRTC peer will renegotiate. If you want the
commit to happen immediately, press **Enter** in the URL field — that
flushes the debounce without waiting.

If the panel does not respond at all (no debounce fires, Enter does
nothing, the Enable toggle does nothing either), the panel itself is
likely broken in the build. Re-check `bun run type-check` / `bun run
lint` and the browser console for render errors.

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
`buildOfferUrl` in `AvatarPanel.tsx:341` and `audioPath` in the
bridge config, and rewrite `feedAudioChunk` to use `new WebSocket(...)`
and binary `socket.send(...)` instead of `fetch(POST, formData)`. The
`packWav` helper can stay (the 1.x audio path also wants valid PCM),
but you would need to chunk the upload by hand instead of one WAV per
message.

## 10. Avatar lips don't match the spoken language

LiveTalking is a **lip-sync engine, not a TTS engine**. In the
OpenChamber integration it never generates audio of its own — the
avatar receives the audio you upload to `POST /humanaudio` and animates
the mouth to match. The language of the lips therefore follows the
language of the audio you feed in:

- If you use Kokoro's English voices (`af_heart`, `bf_lily`, `am_adam`,
  `bf_emma`, …), the mouth will move to English phonemes.
- If you use a Chinese Kokoro voice (`zf_xiaobei`, `zm_yunyang`, …),
  the mouth will move to Chinese phonemes.

LiveTalking's `--tts` CLI flag (e.g. `--tts edgetts`, `--tts cosyvoice`,
`--tts gpt-sovits`) selects LiveTalking's *internal* TTS for sessions
that arrive via `POST /human` with `type: 'chat'`. **OpenChamber does
not use that path** — it always goes through `POST /humanaudio` with
pre-rendered audio. So `--tts` does not affect what the avatar says in
the OpenChamber integration.

If the lips look wrong for the language you're speaking, the cause is
the inference engine, not the language setting:

| Engine | Audio feature (`LiveTalking-2.0.3/avatars/audio_features/`) | Language behaviour |
|---|---|---|
| `wav2lip` | `MelASR` (mel-spectrogram only) | Language-agnostic. Best default for English. |
| `musetalk` | `WhisperASR` (whisper-tiny encoder) | Multilingual but trained mostly on Chinese; English phonemes may not align well. |
| `ultralight` | `HubertASR` (HuBERT features) | Language-agnostic. |

Switch engines with `--model wav2lip|musetalk|ultralight` on the
LiveTalking CLI. If you stay on `wav2lip` and the lips still look off,
the cause is more likely the avatar pipeline's inference latency than
language. With `avatarMuteSpeaker` on, the audio you hear is produced
by LiveTalking itself, so any mismatch between mouth and voice points
at LiveTalking rather than OpenChamber.
