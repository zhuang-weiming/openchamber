/**
 * AvatarPanel
 *
 * Renders a digital-human (LiveTalking / MuseTalk) video stream beside the
 * chat surface. The video is delivered over WebRTC: this component performs
 * an SDP offer/answer exchange with `${serverUrl}/offer` and binds the
 * resulting video track to a <video> element.
 *
 * The audio path is intentionally NOT routed through WebRTC: TTS audio
 * continues to play through the regular AudioContext pipeline (so we
 * keep mobile-Safari autoplay / focus behaviour that the rest of the app
 * already depends on). Lip-sync is implicit because both consumers
 * receive the same AudioBuffer at the same time.
 *
 * The component is designed to fail soft: if the avatar backend is
 * offline, the WebRTC offer fails, or the user has not configured a
 * server URL, the panel renders an empty placeholder rather than
 * throwing. Audio playback and chat are never affected.
 */

import { useEffect, useRef, useState } from 'react';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useConfigStore } from '@/stores/useConfigStore';
import { Icon } from '@/components/icon/Icon';
import { getAvatarAudioBridge } from '@/lib/voice/avatarAudioBridge';
import type { IconName } from '@/components/icon/icons';

type ConnectionState = 'idle' | 'connecting' | 'connected' | 'failed' | 'disabled';

interface AvatarPanelProps {
  /**
   * Override the side the panel is anchored to. Defaults to 'right'.
   * The panel is positioned absolute inside its parent and does not
   * affect chat layout.
   */
  side?: 'left' | 'right';
}

export function AvatarPanel({ side = 'right' }: AvatarPanelProps): React.JSX.Element | null {
  const { currentTheme } = useThemeSystem();
  const avatarServerUrl = useConfigStore((state) => state.avatarServerUrl);
  const avatarImageDataUrl = useConfigStore((state) => state.avatarImageDataUrl);
  const avatarEnabled = useConfigStore((state) => state.avatarEnabled);
  const avatarAudioOffsetMs = useConfigStore((state) => state.avatarAudioOffsetMs);
  const setAvatarServerUrl = useConfigStore((state) => state.setAvatarServerUrl);
  const setAvatarImageDataUrl = useConfigStore((state) => state.setAvatarImageDataUrl);
  const setAvatarEnabled = useConfigStore((state) => state.setAvatarEnabled);
  const setAvatarAudioOffsetMs = useConfigStore((state) => state.setAvatarAudioOffsetMs);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const bridgeRef = useRef(getAvatarAudioBridge());
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverUrlDraft, setServerUrlDraft] = useState(avatarServerUrl);
  const [offsetDraft, setOffsetDraft] = useState(String(avatarAudioOffsetMs));

  useEffect(() => {
    setServerUrlDraft(avatarServerUrl);
  }, [avatarServerUrl]);

  useEffect(() => {
    setOffsetDraft(String(avatarAudioOffsetMs));
  }, [avatarAudioOffsetMs]);

  // Drive the audio bridge from store state. The bridge itself is a
  // singleton: we just open/close it as configuration changes.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!avatarEnabled || !avatarServerUrl) {
      bridge.disconnect();
      return;
    }
    bridge.connect({
      serverUrl: avatarServerUrl,
      imageDataUrl: avatarImageDataUrl || undefined,
    });
    return () => {
      bridge.disconnect();
    };
  }, [avatarEnabled, avatarServerUrl, avatarImageDataUrl]);

  // Open / close the WebRTC peer whenever the avatar server config flips.
  useEffect(() => {
    if (!avatarEnabled || !avatarServerUrl) {
      teardownPeer();
      setConnectionState(avatarServerUrl ? 'disabled' : 'idle');
      return;
    }

    let cancelled = false;
    setConnectionState('connecting');
    setErrorMessage(null);

    const teardown = teardownPeer;
    const serverUrl = avatarServerUrl;
    const image = avatarImageDataUrl;

    openPeer(serverUrl, image)
      .then(() => {
        if (cancelled) return;
        setConnectionState('connected');
      })
      .catch((err) => {
        if (cancelled) return;
        setConnectionState('failed');
        setErrorMessage(err instanceof Error ? err.message : String(err));
      });

    return () => {
      cancelled = true;
      teardown();
    };
    // openPeer and teardownPeer are stable per-render and intentionally
    // captured via local references above to keep the effect dependency
    // list narrow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [avatarEnabled, avatarServerUrl, avatarImageDataUrl]);

  const handleImageUpload = (event: React.ChangeEvent<HTMLInputElement>): void => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setAvatarImageDataUrl(reader.result);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleSaveSettings = (): void => {
    setAvatarServerUrl(serverUrlDraft.trim());
    const parsed = Number(offsetDraft);
    if (!Number.isNaN(parsed)) {
      setAvatarAudioOffsetMs(Math.max(0, Math.min(2000, parsed)));
    }
  };

  const stateLabel: Record<ConnectionState, string> = {
    idle: 'Idle',
    connecting: 'Connecting…',
    connected: 'Live',
    failed: 'Failed',
    disabled: 'Not configured',
  };

  const stateColor: Record<ConnectionState, string> = {
    idle: 'var(--surface-muted-foreground)',
    connecting: 'var(--status-warning)',
    connected: 'var(--status-success)',
    failed: 'var(--status-error)',
    disabled: 'var(--surface-muted-foreground)',
  };

  const statusIcon: IconName = connectionState === 'connected'
    ? 'check'
    : connectionState === 'connecting'
      ? 'loader-4'
      : connectionState === 'failed'
        ? 'error-warning'
        : 'user';

  return (
    <div
      data-avatar-panel="true"
      data-side={side}
      className="flex w-72 flex-col gap-3 rounded-md border p-3 typography-ui-label"
      style={{
        backgroundColor: currentTheme.colors.surface.elevated,
        borderColor: currentTheme.colors.interactive.border,
        color: currentTheme.colors.surface.foreground,
      }}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Icon name="user" className="h-4 w-4" />
          <span className="font-medium">Digital Human</span>
        </div>
        <label className="flex cursor-pointer items-center gap-1.5">
          <input
            type="checkbox"
            checked={avatarEnabled}
            onChange={(e) => setAvatarEnabled(e.target.checked)}
            className="h-3.5 w-3.5 cursor-pointer"
          />
          <span className="typography-micro text-[var(--surface-muted-foreground)]">Enable</span>
        </label>
      </div>

      <div
        className="relative aspect-video w-full overflow-hidden rounded border"
        style={{
          backgroundColor: currentTheme.colors.surface.background,
          borderColor: currentTheme.colors.interactive.border,
        }}
      >
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className="h-full w-full object-cover"
        />
        {!avatarEnabled && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center"
            style={{ color: currentTheme.colors.surface.mutedForeground }}
          >
            <Icon name="user" className="h-6 w-6" />
            <span className="typography-meta">Avatar disabled</span>
          </div>
        )}
        {avatarEnabled && !avatarImageDataUrl && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center"
            style={{ color: currentTheme.colors.surface.mutedForeground }}
          >
            <Icon name="file-image" className="h-6 w-6" />
            <span className="typography-meta">Upload a portrait below</span>
          </div>
        )}
        {connectionState === 'failed' && avatarEnabled && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center"
            style={{ color: currentTheme.colors.status.error }}
          >
            <Icon name="error-warning" className="h-6 w-6" />
            <span className="typography-meta">{errorMessage ?? 'Connection failed'}</span>
          </div>
        )}
      </div>

      <div className="flex items-center gap-2">
        <Icon name={statusIcon} className="h-3.5 w-3.5" style={{ color: stateColor[connectionState] }} />
        <span className="typography-micro" style={{ color: stateColor[connectionState] }}>
          {stateLabel[connectionState]}
        </span>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="typography-micro text-[var(--surface-muted-foreground)]">
          LiveTalking server URL
        </label>
        <input
          type="text"
          value={serverUrlDraft}
          onChange={(e) => setServerUrlDraft(e.target.value)}
          placeholder="http://localhost:8765"
          className="w-full rounded border bg-transparent px-2 py-1 typography-meta"
          style={{
            borderColor: currentTheme.colors.interactive.border,
            color: currentTheme.colors.surface.foreground,
          }}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="typography-micro text-[var(--surface-muted-foreground)]">
          Portrait (image)
        </label>
        <input
          type="file"
          accept="image/*"
          onChange={handleImageUpload}
          className="typography-micro"
        />
        {avatarImageDataUrl && (
          <button
            type="button"
            onClick={() => setAvatarImageDataUrl('')}
            className="self-start typography-micro hover:underline"
            style={{ color: currentTheme.colors.status.error }}
          >
            Remove portrait
          </button>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="typography-micro text-[var(--surface-muted-foreground)]">
          Audio offset (ms) — sync delay to match avatar processing
        </label>
        <input
          type="number"
          min={0}
          max={2000}
          step={10}
          value={offsetDraft}
          onChange={(e) => setOffsetDraft(e.target.value)}
          className="w-full rounded border bg-transparent px-2 py-1 typography-meta"
          style={{
            borderColor: currentTheme.colors.interactive.border,
            color: currentTheme.colors.surface.foreground,
          }}
        />
      </div>

      <button
        type="button"
        onClick={handleSaveSettings}
        className="rounded border px-3 py-1.5 typography-ui-label hover:bg-[var(--interactive-hover)]"
        style={{
          borderColor: currentTheme.colors.interactive.border,
          backgroundColor: currentTheme.colors.interactive.selection,
          color: currentTheme.colors.interactive.selectionForeground,
        }}
      >
        Apply
      </button>
    </div>
  );

  function teardownPeer(): void {
    const peer = peerRef.current;
    peerRef.current = null;
    if (!peer) return;
    try {
      peer.getSenders().forEach((sender) => {
        try { sender.track?.stop(); } catch { /* ignore */ }
      });
      peer.close();
    } catch { /* ignore */ }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }

  async function openPeer(serverUrl: string, imageDataUrl: string): Promise<void> {
    teardownPeer();
    const peer = new RTCPeerConnection({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
    peerRef.current = peer;

    peer.addTransceiver('video', { direction: 'recvonly' });
    peer.addTransceiver('audio', { direction: 'recvonly' });

    peer.ontrack = (event) => {
      const [stream] = event.streams;
      if (videoRef.current && stream) {
        videoRef.current.srcObject = stream;
      }
    };

    const offer = await peer.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
    await peer.setLocalDescription(offer);

    const response = await fetch(buildOfferUrl(serverUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sdp: offer.sdp,
        type: offer.type,
        ...(imageDataUrl ? { image: imageDataUrl } : {}),
      }),
    });
    if (!response.ok) {
      throw new Error(`Avatar backend HTTP ${response.status}`);
    }
    const answer = (await response.json()) as { sdp: string; type: RTCSdpType };
    if (!answer?.sdp || !answer?.type) {
      throw new Error('Avatar backend returned invalid SDP');
    }
    await peer.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
  }
}

function buildOfferUrl(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, '');
  return `${trimmed}/offer`;
}
