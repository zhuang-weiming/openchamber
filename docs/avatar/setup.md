# Setup

Two external services need to run alongside the OpenChamber dev server. Both
are out-of-tree processes; OpenChamber does not start them for you.

## 1. TTS — Kokoro-FastAPI (port 8880)

The OpenChamber speaker button on a message hits `/api/tts/speak`. That
endpoint forwards to whatever OpenAI-compatible TTS URL you've configured in
**Settings → TTS → Custom TTS**.

### Quick: Docker

```bash
docker run -p 8880:8880 remsky/kokoro-fastapi:latest
```

First run downloads the model weights (~300 MB). After that, startup is a
few seconds.

### Alternative: source install

```bash
git clone https://github.com/remsky/Kokoro-FastAPI.git
cd Kokoro-FastAPI
pip install -r requirements.txt
# Entry point varies across versions; consult the repo's README for the
# current command. Common forms include:
python main.py
# or
python api/src/main.py
# or
uvicorn api.src.main:app --host 0.0.0.0 --port 8880
```

### Verify

```bash
curl -s http://localhost:8880/v1/models | jq
# → list of voices (e.g. af_heart, am_adam, bf_emma, ...)

curl -X POST http://localhost:8880/v1/audio/speech \
  -H 'Content-Type: application/json' \
  -d '{"model":"kokoro","input":"hello world","voice":"af_heart"}' \
  --output /tmp/test.mp3

afplay /tmp/test.mp3   # macOS
# or: aplay /tmp/test.mp3   # Linux
```

### Point OpenChamber at it

**Settings → TTS → Custom TTS**
- **Server URL**: `http://localhost:8880/v1`
- **API Key**: leave blank (Kokoro-FastAPI does not require one)
- **Voice / Model**: any from the `/v1/models` list (e.g. `af_heart`)

Click the speaker icon on any assistant message. If you hear Kokoro's voice,
TTS is wired correctly.

## 2. Avatar — LiveTalking (port 8765)

LiveTalking consumes the 16 kHz mono PCM the bridge sends and produces a
WebRTC video stream of a talking face. MuseTalk is the default inference
engine.

### Source install (macOS, Linux)

```bash
git clone https://github.com/lipku/livetalking.git
cd livetalking
pip install -r requirements.txt

# Pull MuseTalk model weights (see livetalking docs for the exact URL)
# Usually: from Hugging Face lipku/MuseTalk, or gdown from a Google Drive
# link published in livetalking/README.md
```

### Run

```bash
python app.py --model musetalk --port 8765
```

Or with the bundled web demo:

```bash
python app.py --model musetalk --port 8765 --transport webrtc
```

### Verify the demo in a browser

```bash
# Open the LiveTalking web demo (port may differ by version)
open http://localhost:8765/web
```

Upload a portrait + a short wav file. If the demo animates a face, the
backend is healthy. The same `/offer` and `/ws/audio` endpoints the demo
uses are what `AvatarPanel` and `avatarAudioBridge` will hit.

### Endpoints consumed by OpenChamber

| Endpoint | Direction | Used by | Payload |
|---|---|---|---|
| `POST /offer` | browser → LiveTalking | `AvatarPanel` (WebRTC offer/answer) | `{ sdp, type, image? }` |
| `WS /ws/audio` | browser → LiveTalking | `avatarAudioBridge` (PCM uplink) | init JSON frame, then Int16 LE binary frames |
| `GET /` or `GET /web` | browser → LiveTalking | (manual smoke test) | HTML demo page |

> The exact path names can drift between LiveTalking versions. If your
> build uses `/human` or `/audio` instead, override in `AvatarPanel.tsx`
> and `avatarAudioBridge.ts` (see `audioPath` and `buildOfferUrl`).

## 3. OpenChamber dev server

In the OpenChamber repo:

```bash
bun install
bun run dev
```

Open the printed URL (typically `http://localhost:<port>`). The Digital
Human panel is in the top-right of the chat surface; it only renders when
`avatarEnabled` is on and `avatarServerUrl` is non-empty.

## Port map

| Service | Port | Where configured |
|---|---|---|
| OpenChamber dev server | varies (printed by `bun run dev`) | — |
| Kokoro-FastAPI | 8880 | OpenChamber Settings → Custom TTS URL |
| LiveTalking | 8765 | OpenChamber Digital Human panel → Server URL |

All three run on `localhost` for development. For production, point
`avatarServerUrl` at a remote LiveTalking deployment; the panel accepts
`http://` or `https://` (and the bridge auto-rewrites to `ws://` /
`wss://`).

## Resource check

| Component | RAM | Notes |
|---|---|---|
| OpenChamber dev server | ~200 MB | Bun + Vite + React |
| Kokoro-FastAPI | ~1–2 GB | First-run model load dominates |
| LiveTalking (MuseTalk) | ~3–6 GB | GPU strongly recommended |

On a 16 GB MacBook Air you can run all three simultaneously but expect
thermal throttling during long inference runs.
