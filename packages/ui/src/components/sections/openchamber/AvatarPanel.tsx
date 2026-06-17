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
 * The avatar identity is determined by LiveTalking's `--avatar_id` startup
 * parameter, not by a portrait uploaded in this panel.
 *
 * The component is designed to fail soft: if the avatar backend is
 * offline, the WebRTC offer fails, or the user has not configured a
 * server URL, the panel renders an empty placeholder rather than
 * throwing. Audio playback and chat are never affected.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useThemeSystem } from '@/contexts/useThemeSystem';
import { useConfigStore } from '@/stores/useConfigStore';
import { Icon } from '@/components/icon/Icon';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { useDebouncedValue } from '@/hooks/useDebouncedValue';
import { getAvatarAudioBridge } from '@/lib/voice/avatarAudioBridge';
import { useI18n } from '@/lib/i18n';
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
  const { t } = useI18n();
  const { currentTheme } = useThemeSystem();
  const avatarServerUrl = useConfigStore((state) => state.avatarServerUrl);
  const avatarEnabled = useConfigStore((state) => state.avatarEnabled);
  const avatarMuteSpeaker = useConfigStore((state) => state.avatarMuteSpeaker);
  const setAvatarServerUrl = useConfigStore((state) => state.setAvatarServerUrl);
  const setAvatarEnabled = useConfigStore((state) => state.setAvatarEnabled);
  const setAvatarMuteSpeaker = useConfigStore((state) => state.setAvatarMuteSpeaker);
  const setCurrentAvatarSessionId = useConfigStore((state) => state.setCurrentAvatarSessionId);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const bridgeRef = useRef(getAvatarAudioBridge());
  const [connectionState, setConnectionState] = useState<ConnectionState>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [serverUrlDraft, setServerUrlDraft] = useState(avatarServerUrl);
  const debouncedServerUrl = useDebouncedValue(serverUrlDraft, 500);

  // Commit the debounced URL to the store. The user types in the draft;
  // we wait for them to stop typing for 500ms before persisting and
  // triggering a WebRTC renegotiation + bridge reconnect. Enter commits
  // immediately (see commitServerUrl). This replaces the older "draft
  // + Apply button" pattern, which failed on Safari due to click-event
  // loss across the pointer-events-none/auto wrapper.
  useEffect(() => {
    commitServerUrl(debouncedServerUrl);
    // avatarServerUrl is read for the comparison but intentionally not
    // listed: re-running on every store update would re-commit the same
    // value and create a feedback loop. See openPeer() below for the
    // same pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [debouncedServerUrl]);

  // Drive the audio bridge from store state. The bridge itself is a
  // singleton: we just open/close it as configuration changes.
  useEffect(() => {
    const bridge = bridgeRef.current;
    if (!avatarEnabled || !avatarServerUrl) {
      bridge.disconnect();
      return;
    }
    bridge.connect({ serverUrl: avatarServerUrl });
    return () => {
      bridge.disconnect();
    };
  }, [avatarEnabled, avatarServerUrl]);

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

    openPeer(serverUrl)
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
  }, [avatarEnabled, avatarServerUrl]);

  const commitServerUrl = useCallback(
    (raw: string): void => {
      const trimmed = raw.trim();
      if (trimmed !== avatarServerUrl) {
        setAvatarServerUrl(trimmed);
      }
    },
    [avatarServerUrl, setAvatarServerUrl],
  );

  const handleServerUrlKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitServerUrl(serverUrlDraft);
    }
  };

  const stateLabel: Record<ConnectionState, string> = {
    idle: t('chat.avatar.status.idle'),
    connecting: t('chat.avatar.status.connecting'),
    connected: t('chat.avatar.status.live'),
    failed: t('chat.avatar.status.failed'),
    disabled: t('chat.avatar.status.notConfigured'),
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
          <span className="font-medium">{t('chat.avatar.title')}</span>
        </div>
        <label className="flex cursor-pointer items-center gap-1.5">
          <Checkbox
            checked={avatarEnabled}
            onChange={setAvatarEnabled}
            ariaLabel={t('chat.avatar.enableLabel')}
          />
          <span className="typography-micro text-[var(--surface-muted-foreground)]">
            {t('chat.avatar.enableLabel')}
          </span>
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
            <span className="typography-meta">{t('chat.avatar.disabledPlaceholder')}</span>
          </div>
        )}
        {connectionState === 'failed' && avatarEnabled && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center"
            style={{ color: currentTheme.colors.status.error }}
          >
            <Icon name="error-warning" className="h-6 w-6" />
            <span className="typography-meta">{errorMessage ?? t('chat.avatar.connectionFailed')}</span>
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
          {t('chat.avatar.serverUrlLabel')}
        </label>
        <Input
          type="text"
          value={serverUrlDraft}
          onChange={(e) => setServerUrlDraft(e.target.value)}
          onKeyDown={handleServerUrlKeyDown}
          placeholder={t('chat.avatar.serverUrlPlaceholder')}
          className="typography-meta"
        />
      </div>

      {avatarEnabled && avatarServerUrl ? (
        <label className="flex cursor-pointer items-center gap-2">
          <Checkbox
            checked={avatarMuteSpeaker}
            onChange={setAvatarMuteSpeaker}
            ariaLabel={t('chat.avatar.muteSpeakerLabel')}
          />
          <span className="typography-meta text-[var(--surface-muted-foreground)]">
            {t('chat.avatar.muteSpeakerLabel')}
          </span>
        </label>
      ) : null}
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
    setCurrentAvatarSessionId('');
  }

  async function openPeer(serverUrl: string): Promise<void> {
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
        // Safari quirk: an unstopped audio track on a <video srcObject>
        // claims the audio output device and silences the AudioContext
        // TTS path. The actual audio for the user's ears flows through
        // `useServerTTS` → AudioContext and `avatarAudioBridge` → POST
        // /humanaudio. The WebRTC audio track exists only for SDP
        // symmetry, so we stop it as soon as the stream arrives.
        stream.getAudioTracks().forEach((track) => track.stop());
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
      }),
    });
    if (!response.ok) {
      throw new Error(`Avatar backend HTTP ${response.status}`);
    }
    const answer = (await response.json()) as { sdp: string; type: RTCSdpType; sessionid?: string };
    if (!answer?.sdp || !answer?.type) {
      throw new Error('Avatar backend returned invalid SDP');
    }
    if (answer.sessionid) {
      setCurrentAvatarSessionId(answer.sessionid);
    }
    await peer.setRemoteDescription({ type: answer.type, sdp: answer.sdp });
  }
}

function buildOfferUrl(serverUrl: string): string {
  const trimmed = serverUrl.replace(/\/+$/, '');
  return `${trimmed}/offer`;
}