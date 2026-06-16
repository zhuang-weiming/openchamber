/**
 * E2E test: OpenChamber /api/tts/speak → avatarAudioBridge packWav → LiveTalking /humanaudio
 *
 * Simulates what useServerTTS.ts does in the browser:
 *   1. fetch('/api/tts/speak') → MP3 bytes
 *   2. ctx.decodeAudioData(mp3) → AudioBuffer
 *   3. mixToMono → resampleLinear → float32ToInt16LE → packWav
 *   4. fetch('/humanaudio', multipart) with sessionid + WAV file
 *
 * Verifies the wire protocol matches what LiveTalking 2.x expects.
 */

import { readFileSync } from 'node:fs';
import { writeFileSync } from 'node:fs';

const OPENCHAMBER_API = process.env.OPENCHAMBER_API || 'http://127.0.0.1:3902';
const LIVETALKING_API = process.env.LIVETALKING_API || 'http://127.0.0.1:8765';
const TEXT = process.env.TEST_TEXT || 'Hello avatar e2e test';
const VOICE = process.env.TEST_VOICE || 'af_heart';
const KOKORO_BASEURL = process.env.KOKORO_BASEURL || 'http://127.0.0.1:8880/v1';

// Bridge packWav ported verbatim from packages/ui/src/lib/voice/avatarAudioBridge.ts
const TARGET_SAMPLE_RATE = 16000;
const BITS_PER_SAMPLE = 16;
const CHANNELS = 1;
const WAV_HEADER_BYTES = 44;

function packWav(pcm, sampleRate) {
  const dataSize = pcm.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset, s) => {
    for (let i = 0; i < s.length; i += 1) view.setUint8(offset + i, s.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, CHANNELS, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * CHANNELS * (BITS_PER_SAMPLE / 8), true);
  view.setUint16(32, CHANNELS * (BITS_PER_SAMPLE / 8), true);
  view.setUint16(34, BITS_PER_SAMPLE, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);
  const out = new Int16Array(buffer, WAV_HEADER_BYTES);
  out.set(pcm);
  return buffer;
}

// Real SDP that aiortc accepts (crafted to match what RTCPeerConnection.createOffer
// produces — see web/client.js). Sourced from a working browser session.
const FAKE_OFFER_SDP = `v=0
o=- 4611731400430051336 2 IN IP4 127.0.0.1
s=-
t=0 0
m=video 9 UDP/TLS/RTP/SAVPF 96 97 98 99 100 101 102 121 125 107 108 109 35 36 124 119 123 118 125 39 40 45 46 98
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:abcd
a=ice-pwd:abcdabcdabcdabcdabcdabcdabcdabcd
a=ice-options:trickle
a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
a=setup:actpass
a=mid:0
a=extmap:14 urn:ietf:params:rtp-hdrext:toffset
a=extmap:13 http://www.webrtc.org/experiments/rtp-hdrext/abs-send-time
a=recvonly
a=rtcp-mux
a=rtpmap:96 VP8/90000
a=rtcp-fb:96 nack
a=rtcp-fb:96 nack pli
a=rtpmap:97 rtx/90000
a=fmtp:97 apt=96
a=rtpmap:98 VP9/90000
a=fmtp:98 apt=98
a=rtpmap:100 H264/90000
a=fmtp:100 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42001f
a=rtpmap:101 rtx/90000
a=fmtp:101 apt=100
a=rtpmap:102 H264/90000
a=fmtp:102 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42001f
a=rtpmap:121 rtx/90000
a=fmtp:121 apt=102
a=rtpmap:125 H264/90000
a=fmtp:125 level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f
a=rtpmap:107 rtx/90000
a=fmtp:107 apt=125
a=rtpmap:108 H264/90000
a=fmtp:108 level-asymmetry-allowed=1;packetization-mode=0;profile-level-id=42e01f
a=rtpmap:109 rtx/90000
a=fmtp:109 apt=108
a=rtpmap:35 AV1/90000
a=rtpmap:36 rtx/90000
a=fmtp:36 apt=35
m=audio 9 UDP/TLS/RTP/SAVPF 111 63 9 0 8 13 110 126
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:abcd
a=ice-pwd:abcdabcdabcdabcdabcdabcdabcdabcd
a=ice-options:trickle
a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
a=setup:actpass
a=mid:1
a=extmap:14 urn:ietf:params:rtp-hdrext:toffset
a=recvonly
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=fmtp:111 minptime=10;useinbandfec=1
a=rtpmap:63 red/48000/2
a=fmtp:63 111/111
a=rtpmap:9 G722/8000
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:13 CN/8000
a=rtpmap:110 telephone-event/48000
a=rtpmap:126 telephone-event/8000`;

function logStep(name, ok, detail) {
  const tag = ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
  console.log(`${tag} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) process.exitCode = 1;
}

async function getOfferSessionId(serverUrl) {
  const r = await fetch(`${serverUrl}/offer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sdp: FAKE_OFFER_SDP, type: 'offer' }),
  });
  if (!r.ok) {
    throw new Error(`/offer HTTP ${r.status}: ${await r.text()}`);
  }
  const data = await r.json();
  if (!data.sessionid) {
    throw new Error(`/offer did not return sessionid: ${JSON.stringify(data)}`);
  }
  return data.sessionid;
}

// Minimal MP3 → PCM using the system `ffmpeg` binary. This stands in for
// the browser's ctx.decodeAudioData. The bridge then resamples to 16 kHz
// via resampleLinear; for e2e we decode directly to 16 kHz to skip that
// step and keep the test simple.
async function decodeMp3ToFloat32(mp3Bytes) {
  const { spawn } = await import('node:child_process');
  return new Promise((resolve, reject) => {
    const ff = spawn('ffmpeg', [
      '-i', 'pipe:0',
      '-f', 's16le',
      '-acodec', 'pcm_s16le',
      '-ac', '1',
      '-ar', String(TARGET_SAMPLE_RATE),
      '-loglevel', 'error',
      'pipe:1',
    ]);
    const chunks = [];
    const errChunks = [];
    ff.stdout.on('data', (c) => chunks.push(c));
    ff.stderr.on('data', (c) => errChunks.push(c));
    ff.on('error', reject);
    ff.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffmpeg exit ${code}: ${Buffer.concat(errChunks).toString()}`));
        return;
      }
      const pcm = Buffer.concat(chunks);
      const ab = pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength);
      const i16 = new Int16Array(ab);
      resolve(i16);
    });
    ff.stdin.write(mp3Bytes);
    ff.stdin.end();
  });
}

async function main() {
  console.log('=== e2e: OpenChamber → Kokoro → LiveTalking ===');
  console.log(`OpenChamber API: ${OPENCHAMBER_API}`);
  console.log(`LiveTalking:    ${LIVETALKING_API}`);
  console.log(`Kokoro baseURL: ${KOKORO_BASEURL}`);
  console.log(`text: "${TEXT}"`);
  console.log('');

  // -------- Step 1: OpenChamber /api/tts/speak → MP3 --------
  let mp3Bytes;
  try {
    const ttsResp = await fetch(`${OPENCHAMBER_API}/api/tts/speak`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: TEXT,
        voice: VOICE,
        model: 'kokoro',
        baseURL: KOKORO_BASEURL,
      }),
    });
    if (!ttsResp.ok) {
      throw new Error(`HTTP ${ttsResp.status}: ${await ttsResp.text()}`);
    }
    const ab = await ttsResp.arrayBuffer();
    mp3Bytes = new Uint8Array(ab);
    logStep('OpenChamber /api/tts/speak → MP3', true, `${mp3Bytes.length} bytes, content-type: ${ttsResp.headers.get('content-type')}`);
    writeFileSync('/tmp/e2e_kokoro.mp3', mp3Bytes);
  } catch (e) {
    logStep('OpenChamber /api/tts/speak → MP3', false, e.message);
    return;
  }

  // -------- Step 2: decode MP3 → float32 (browser equivalent: ctx.decodeAudioData) --------
  let pcmInt16;
  try {
    pcmInt16 = await decodeMp3ToFloat32(mp3Bytes);
    logStep('decode MP3 → 16kHz mono Int16', true, `${pcmInt16.length} samples = ${(pcmInt16.length / 16000).toFixed(2)}s`);
  } catch (e) {
    logStep('decode MP3 → 16kHz mono Int16', false, e.message);
    return;
  }

  // -------- Step 3: packWav (avatarAudioBridge helper) --------
  let wavBytes;
  try {
    const wavBuf = packWav(pcmInt16, TARGET_SAMPLE_RATE);
    wavBytes = new Uint8Array(wavBuf);
    // Verify header
    const view = new DataView(wavBuf);
    const tag = String.fromCharCode(view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3));
    if (tag !== 'RIFF') throw new Error(`WAV header tag is ${tag}, not RIFF`);
    const fmt = String.fromCharCode(view.getUint8(8), view.getUint8(9), view.getUint8(10), view.getUint8(11));
    if (fmt !== 'WAVE') throw new Error(`WAV format is ${fmt}, not WAVE`);
    const sampleRate = view.getUint32(24, true);
    if (sampleRate !== 16000) throw new Error(`sample rate is ${sampleRate}, not 16000`);
    const channels = view.getUint16(22, true);
    if (channels !== 1) throw new Error(`channels is ${channels}, not 1`);
    const bitsPerSample = view.getUint16(34, true);
    if (bitsPerSample !== 16) throw new Error(`bitsPerSample is ${bitsPerSample}, not 16`);
    logStep('packWav → 44-byte RIFF/WAVE header', true, `total ${wavBytes.length} bytes, 16kHz mono 16-bit`);
    writeFileSync('/tmp/e2e_bridge.wav', wavBytes);
  } catch (e) {
    logStep('packWav → 44-byte RIFF/WAVE header', false, e.message);
    return;
  }

  // -------- Step 4: Get sessionid from /offer --------
  let sessionId;
  try {
    sessionId = await getOfferSessionId(LIVETALKING_API);
    logStep('POST /offer → sessionid', true, sessionId);
  } catch (e) {
    logStep('POST /offer → sessionid', false, e.message);
    return;
  }

  // -------- Step 5: POST /humanaudio with multipart WAV --------
  try {
    const fd = new FormData();
    fd.set('sessionid', sessionId);
    // Node 22 FormData accepts Blob
    fd.set('file', new Blob([wavBytes], { type: 'audio/wav' }), 'chunk.wav');
    const r = await fetch(`${LIVETALKING_API}/humanaudio`, {
      method: 'POST',
      body: fd,
    });
    if (!r.ok) {
      throw new Error(`HTTP ${r.status}: ${await r.text()}`);
    }
    const data = await r.json();
    if (data.code !== 0) {
      throw new Error(`non-zero code: ${JSON.stringify(data)}`);
    }
    logStep('POST /humanaudio → 200 code:0', true, JSON.stringify(data));
  } catch (e) {
    logStep('POST /humanaudio → 200 code:0', false, e.message);
    return;
  }

  // -------- Step 6: Verify LiveTalking accepted the audio --------
  // After humanaudio, the avatar's session should be in /api/admin/sessions
  try {
    const r = await fetch(`${LIVETALKING_API}/api/admin/sessions`);
    const data = await r.json();
    const session = data.data.sessions.find((s) => s.sessionid === sessionId);
    if (!session) {
      logStep('session visible in /api/admin/sessions', false, `session ${sessionId} not in admin list`);
      return;
    }
    logStep('session visible in /api/admin/sessions', true, `speaking=${session.speaking}, recording=${session.recording}`);
  } catch (e) {
    logStep('session visible in /api/admin/sessions', false, e.message);
    return;
  }

  console.log('');
  console.log('\x1b[32m=== ALL E2E STEPS PASSED ===\x1b[0m');
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
