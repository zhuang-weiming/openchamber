# Setup

## Architecture

```
┌─ OpenChamber (:5180) ─────────────────────┐   ┌─ LiveTalking (:8765) ────┐
│                                            │   │                           │
│  Chat UI  ─ TTS ─→ Kokoro (:8880)         │   │  POST /offer  ← WebRTC   │
│  AvatarPanel (WebRTC video)                │   │  POST /humanaudio         │
│       ↓                                    │   │  GET /index.html (debug)  │
│  avatarAudioBridge ─ HTTP multipart ───────┼──→│                           │
└────────────────────────────────────────────┘   └───────────────────────────┘
```

OpenChamber's **AvatarPanel** creates WebRTC via `POST /offer`, renders the
avatar video in the chat surface, and feeds TTS audio to the same LiveTalking
session via `POST /humanaudio`. The LiveTalking demo page at `/index.html` is
for manual debugging only — the product uses the OpenChamber-internal panel.

Two external services run alongside the OpenChamber dev server. Both are
out-of-tree processes; OpenChamber does not start them for you.

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
WebRTC video stream of a talking face. The 2.x fork supports three
inference engines:

- **`wav2lip`** — fastest setup, smallest weights (~300 MB total). Best
  for first-run validation on a MacBook (CPU or MPS).
- **`musetalk`** — better visual quality, larger weights (~3.6 GB).
  Recommended for production if you have a discrete GPU; on Apple
  Silicon MPS expect 5–15 FPS.
- **`ultralight`** — Ultralight-Digital-Human checkpoint. Smallest
  runtime, requires a separately trained checkpoint.

This section uses **`wav2lip`** for the verified happy path. See
[Switching to MuseTalk](#switching-to-musetalk) at the end for the
MuseTalk-specific extension.

### Source install (macOS, Linux)

```bash
git clone https://github.com/lipku/livetalking.git
cd livetalking
pip install -r requirements.txt
```

### wav2lip weights and sample avatar

Download the **Quark cloud drive** bundle
(<https://pan.quark.cn/s/83a750323ef0>) and lay out the three files
into the project:

```bash
LT=/Users/weimingzhuang/Documents/source_code/LiveTalking-2.0.3
# 1) wav2lip model checkpoint (rename to wav2lip.pth)
cp /Users/weimingzhuang/Downloads/wav2lip/wav2lip256.pth $LT/models/wav2lip.pth

# 2) S3FD face detector
mkdir -p $LT/wav2lip/face_detection/detection/sfd
cp /Users/weimingzhuang/Downloads/wav2lip/s3fd.pth $LT/wav2lip/face_detection/detection/sfd/s3fd.pth

# 3) Sample avatar precompute
mkdir -p $LT/data/avatars
unzip -q /Users/weimingzhuang/Downloads/wav2lip/wav2lip256_avatar1.zip -d $LT/data/avatars/
rm -rf $LT/data/avatars/__MACOSX    # zip cruft
```

The result is:

```
$LT/
├── models/
│   └── wav2lip.pth                                (214 MB)
├── wav2lip/
│   └── face_detection/detection/sfd/
│       └── s3fd.pth                               (89 MB)
└── data/avatars/
    └── wav2lip256_avatar1/
        ├── coords.pkl
        ├── full_imgs/   (550 PNGs)
        └── face_imgs/   (550 PNGs)
```

`wav2lip_avatar.py:load_avatar` reads these three files at startup.

### Run

```bash
python app.py --model wav2lip --avatar_id wav2lip256_avatar1 --listenport 8765 --transport webrtc
```

You should see in the log:

```
INFO:utils.logger:Using mps for inference.           (Apple Silicon) or
INFO:utils.logger:Using cuda for inference.          (NVIDIA GPU) or
INFO:utils.logger:Using cpu for inference.           (no GPU)
INFO:utils.logger:Registered avatar/wav2lip: LipReal
INFO:utils.logger:Load checkpoint from: ./models/wav2lip.pth
... (550 frames loaded, ~1 s)
INFO:utils.logger:warmup model...
INFO:utils.logger:start http server; http://<serverip>:8765/index.html
```

> Note: LiveTalking's current CLI uses `--listenport`, not `--port`. The
> older `--port` flag was removed in the 2.x rewrite. If you see
> `app.py: error: unrecognized arguments: --port`, you are on a 2.x build.

### Verify the backend is up

```bash
curl -s -o /dev/null -w "GET /: HTTP %{http_code}\n" http://127.0.0.1:8765/
curl -s -o /dev/null -w "GET /index.html: HTTP %{http_code}\n" http://127.0.0.1:8765/index.html
curl -s -o /dev/null -w "GET /api/admin/config: HTTP %{http_code}\n" http://127.0.0.1:8765/api/admin/config
```

Expected: `/` → 403 (CORS gate, no Origin), `/index.html` → 200,
`/api/admin/config` → 200 with JSON containing your model + avatar_id.

The web demo at `http://localhost:8765/index.html` is the manual smoke
test: it runs the same `/offer` + `/humanaudio` flow that OpenChamber's
`AvatarPanel` and `avatarAudioBridge` use.

### macOS-specific gotchas

#### 1. `ModuleNotFoundError: No module named 'torchvision'`

Symptom (a fatal one, the server refuses to start):

```
Traceback (most recent call last):
  ...
  File ".../avatars/musetalk/models/vae.py", line 3, in <module>
    import torchvision.transforms as transforms
ModuleNotFoundError: No module named 'torchvision'
```

Root cause: MuseTalk's `avatars/musetalk/models/vae.py:3` imports
`torchvision.transforms`, but `requirements.txt` only lists `torch`.
You need to install `torchvision` separately, and its build **must
match your `torch` build** (CUDA version + Python version).

Step 1 — check your existing torch install:

```bash
cd /Users/weimingzhuang/Documents/source_code/LiveTalking-2.0.3
source .venv/bin/activate
python -c "import torch; print(torch.__version__, torch.version.cuda)"
```

Step 2 — install the matching `torchvision`. Pick the row that matches
your output from step 1, from <https://pytorch.org/get-started/locally/>:

```bash
# CPU only (e.g. torch==2.5.1+cpu on macOS):
pip install torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cpu

# CUDA 12.4 (e.g. torch==2.5.1+cu124 on a Linux GPU box):
pip install torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu124

# CUDA 11.8:
pip install torchvision==0.20.1 --index-url https://download.pytorch.org/whl/cu118
```

> Versioning rule: `torchvision` and `torch` share the same minor
> version. `torch==2.5.1` ↔ `torchvision==0.20.1`. PyTorch's install
> matrix has the exact mapping.

After install, verify:

```bash
python -c "import torchvision, torch; print(torchvision.__version__, torch.__version__)"
```

If both print without error, re-run `python app.py --model wav2lip --avatar_id wav2lip256_avatar1 --listenport 8765 --transport webrtc`.

#### 2. `AVFFrameReceiver` / `AVFAudioReceiver` duplicate class warnings

Symptom (printed to stderr, **not** a crash):

```
objc[77800]: Class AVFFrameReceiver is implemented in both
  .../av/.dylibs/libavdevice.62.1.100.dylib and
  .../cv2/.dylibs/libavdevice.61.3.100.dylib
objc[77800]: Class AVFAudioReceiver is implemented in both
  .../av/.dylibs/libavdevice.62.1.100.dylib and
  .../cv2/.dylibs/libavdevice.61.3.100.dylib
```

Root cause: PyAV (`av` package) and `opencv-python` (the
`opencv-python-headless` variant) each bundle their own FFmpeg
`libavdevice` on macOS. The Objective-C runtime complains about the
duplicate class registration. This is **noise** — the warnings print
and the server continues to load.

To silence (optional, not required for the avatar to work):

```bash
pip uninstall opencv-python
pip install opencv-python-headless==4.10.0.84
```

`opencv-python-headless` does not bundle FFmpeg, so PyAV becomes the
single FFmpeg provider. After this, the warnings disappear but the
server still runs identically.

If you continue to see `ImportError: numpy.core.multiarray failed to
import` after switching, the headless wheel pulled a numpy that
conflicts with the rest of the stack; pin the version:

```bash
pip install "numpy<2"
```

### Endpoints consumed by OpenChamber

| Endpoint | Direction | Used by | Payload |
|---|---|---|---|
| `POST /offer` | browser → LiveTalking | `AvatarPanel` (WebRTC offer/answer) | `{ sdp, type }` |
| `POST /humanaudio` | browser → LiveTalking | `avatarAudioBridge` (PCM upload) | `multipart/form-data` with `sessionid` + `file` (16 kHz mono PCM WAV) |
| `GET /` or `GET /web` | browser → LiveTalking | (manual smoke test) | HTML demo page |
| `GET /api/admin/{config,sessions}` | browser → LiveTalking | (admin / debug) | JSON |

> The exact path names can drift between LiveTalking versions. If your
> build uses `/human` or `/audio` instead, override in `AvatarPanel.tsx`
> and `avatarAudioBridge.ts` (see `audioPath` and `buildOfferUrl`).
>
> The avatar identity is determined by LiveTalking's `--avatar_id` startup
> parameter, not by an uploaded portrait. The `POST /offer` protocol accepts
> an `avatar` string (the avatar_id), not an image blob. To use a different
> avatar, restart LiveTalking with a different `--avatar_id` or create one
> via the `genavatar` CLI tool.

### Switching to MuseTalk

The `wav2lip` path is the recommended first-run. To upgrade to
MuseTalk for higher visual quality:

1. **Download three HuggingFace repos** into the project (the
   `requirements.txt` does not vendor them, and the `quark.cn` bundle
   only covers wav2lip):

   ```bash
   cd /Users/weimingzhuang/Documents/source_code/LiveTalking-2.0.3
   source .venv/bin/activate
   python << 'PY'
   from huggingface_hub import snapshot_download
   import os, shutil

   # (a) SD-VAE-FT-MSE (image encoder/decoder for MuseTalk)
   p = snapshot_download(
       repo_id='stabilityai/sd-vae-ft-mse',
       local_dir='./models/sd-vae',
       allow_patterns=['*.json', 'diffusion_pytorch_model.safetensors'],
   )

   # (b) MuseTalk V15 UNet (mouth-region inference)
   os.makedirs('./models/musetalkV15', exist_ok=True)
   tmp = snapshot_download(
       repo_id='TMElyralab/MuseTalk',
       local_dir='./models/.hf-muse',
       allow_patterns=['musetalkV15/*.json', 'musetalkV15/unet.pth'],
   )
   for f in os.listdir(os.path.join(tmp, 'musetalkV15')):
       shutil.copy(os.path.join(tmp, 'musetalkV15', f),
                   os.path.join('./models/musetalkV15', f))
   shutil.rmtree('./models/.hf-muse')

   # (c) Whisper-tiny (audio feature extraction)
   os.makedirs('./models/whisper', exist_ok=True)
   tmp = snapshot_download(
       repo_id='openai/whisper-tiny',
       local_dir='./models/.hf-whisper',
       allow_patterns=['*.json', '*.safetensors', 'tokenizer.json',
                       'merges.txt', 'vocab.json', 'normalizer.json',
                       'special_tokens_map.json', 'added_tokens.json'],
   )
   for f in os.listdir(tmp):
       if not f.startswith('.') and os.path.isfile(os.path.join(tmp, f)):
           shutil.copy(os.path.join(tmp, f), os.path.join('./models/whisper', f))
   shutil.rmtree('./models/.hf-whisper')
   PY
   ```

   Sizes: `sd-vae` ~334 MB, `musetalkV15` ~3.2 GB, `whisper` ~144 MB.

2. **Generate the MuseTalk avatar** from a "silent" reference video
   (mouth closed, no speech, 3–5 seconds, 25 fps, ≥512×512):

   ```bash
   pip install "setuptools<81" face_recognition   # needs cmake + XCode CLT
   python -m avatars.musetalk.genavatar \
       --avatar_id musetalk_avatar1 \
       --file /path/to/silent_reference.mp4
   ```

   This writes `data/avatars/musetalk_avatar1/{latents.pt, coords.pkl,
   mask/, mask_coords.pkl, full_imgs/, avator_info.json}`. The
   `wav2lip256_avatar1/` precompute is **not** reusable — MuseTalk
   and wav2lip use different latent layouts.

3. **Run with MuseTalk**:

   ```bash
   python app.py --model musetalk --avatar_id musetalk_avatar1 \
       --listenport 8765 --transport webrtc
   ```

> `face_recognition` requires native compilation (`dlib` + `cmake`).
> On Apple Silicon this takes 5–10 minutes. If you do not want to
> install those, the `quark.cn` bundle is the only other documented
> source for a precomputed MuseTalk avatar (`musetalk_avatar1.tar.gz`
> in the same link).

## 3. OpenChamber dev server

In the OpenChamber repo:

```bash
bun install
bun run dev
```

Open the printed URL (typically `http://localhost:<port>`). The Digital
Human panel is in the top-right of the chat surface; it only renders when
`avatarEnabled` is on and `avatarServerUrl` is non-empty.

### End-to-end API test

Once all three services are up, you can verify the full data flow
without a browser by running the included Node.js script:

```bash
cd /Users/weimingzhuang/Documents/source_code/openchamber
node scripts/e2e-avatar.mjs
```

Expected output:

```
=== e2e: OpenChamber → Kokoro → LiveTalking ===
OpenChamber API: http://127.0.0.1:3902
LiveTalking:    http://127.0.0.1:8765
Kokoro baseURL: http://127.0.0.1:8880/v1
text: "Hello avatar e2e test"

✓ OpenChamber /api/tts/speak → MP3 — 33068 bytes, content-type: audio/mpeg
✓ decode MP3 → 16kHz mono Int16 — 33024 samples = 2.06s
✓ packWav → 44-byte RIFF/WAVE header — total 66092 bytes, 16kHz mono 16-bit
✓ POST /offer → sessionid — <UUID>
✓ POST /humanaudio → 200 code:0 — {"code":0,"msg":"ok"}
✓ session visible in /api/admin/sessions — speaking=false, recording=false

=== ALL E2E STEPS PASSED ===
```

The script does six things in order, mirroring what
`useServerTTS.ts:302-315` and `avatarAudioBridge.ts:feedAudioChunk` do
in the browser:

1. **TTS** — `POST /api/tts/speak` with `baseURL: http://localhost:8880/v1`
   to make OpenChamber forward to Kokoro. Returns MP3 bytes.
2. **Decode** — `ffmpeg` decodes MP3 → 16 kHz mono s16le PCM. Browser
   equivalent: `ctx.decodeAudioData(mp3)`.
3. **Pack WAV** — `packWav` builds a 44-byte RIFF/WAVE header (matches
   `avatarAudioBridge.ts:packWav` byte-for-byte). The output verifies
   soundfile can decode it (which is what LiveTalking does internally
   on the server side).
4. **WebRTC offer** — `POST /offer` with a real-shaped SDP, returns a
   `sessionid`.
5. **Bridge upload** — `POST /humanaudio` with `multipart/form-data`
   containing `sessionid` + `file` (the WAV blob).
6. **Verify** — `GET /api/admin/sessions` shows the new session.

Step 4's SDP is hardcoded in the script (it has to be a real-shaped SDP
for aiortc to accept it). The script does **not** open a real
peer-connection or render any video — it only verifies the audio bridge
wire protocol. To verify the full video rendering, open
`http://localhost:8765/index.html` in a browser and click "Start".

## Port map

| Service | Port | Where configured |
|---|---|---|
| OpenChamber dev server | varies (printed by `bun run dev`) | — |
| Kokoro-FastAPI | 8880 | OpenChamber Settings → Custom TTS URL |
| LiveTalking | 8765 | OpenChamber Digital Human panel → Server URL |

All three run on `localhost` for development. For production, point
`avatarServerUrl` at a remote LiveTalking deployment; the panel accepts
`http://` or `https://` URLs. The bridge uses the URL as-is for HTTP
`fetch` — there is no transport rewriting.

## Resource check

| Component | RAM | Disk | Notes |
|---|---|---|---|
| OpenChamber dev server | ~200 MB | — | Bun + Vite + React |
| Kokoro-FastAPI | ~1–2 GB | ~300 MB | First-run model load dominates |
| LiveTalking (wav2lip path) | ~1–2 GB | ~660 MB | `wav2lip.pth` + `s3fd.pth` + `wav2lip256_avatar1/` |
| LiveTalking (MuseTalk path) | ~3–6 GB | ~3.6 GB | `sd-vae` + `musetalkV15` + `whisper` |

On a 16 GB MacBook Air:

- `wav2lip` path: all three services run comfortably on MPS or CPU.
- `musetalk` path: runs on MPS at ~5–15 FPS (vs 42–72 FPS on RTX
  3080 Ti / RTX 4090). Expect thermal throttling on long inference
  runs.

Apple Silicon GPU acceleration is automatic: when `torch` is built
with MPS support, LiveTalking logs `Using mps for inference` at
startup. No `CUDA_VISIBLE_DEVICES` or `PYTORCH_ENABLE_MPS_FALLBACK`
tweaks are required.
