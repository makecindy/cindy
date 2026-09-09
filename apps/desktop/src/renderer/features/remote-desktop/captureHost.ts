import {
  isDesktopInput,
  parseDesktopIceCandidates,
  REMOTE_DESKTOP_ICE_SERVERS,
  REMOTE_DESKTOP_NETWORK,
  type RemoteDesktopIceCandidate,
  type DesktopInput,
  type RemoteDesktopCursor,
} from '@cindy/device-link';
import type { DesktopCaptureApi } from '../../../shared/remoteDesktop';
import { nativeCaptureStream } from './nativeCaptureStream';

/** Runs exclusively in the isolated capture renderer; never import into the chat entry. */
export function startDesktopCaptureHost(api: DesktopCaptureApi): () => void {
  let peer: RTCPeerConnection | null = null;
  let stream: MediaStream | null = null;
  let generation = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let latestCursor: RemoteDesktopCursor | null | undefined;
  let cursorTimer: ReturnType<typeof setInterval> | null = null;
  let native: Awaited<ReturnType<typeof nativeCaptureStream>> | null = null;
  let recoverCapture: (() => void) | null = null;
  let activeLease: string | null = null;
  let attemptId: string | undefined;
  let localCandidates: RemoteDesktopIceCandidate[] = [];
  let remoteCandidates = new Set<string>();
  let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;
  let gatheringTimer: ReturnType<typeof setTimeout> | undefined;
  let finishGathering: (() => void) | undefined;
  let exchanging = false;
  const stop = () => {
    generation++;
    exchanging = false;
    clearTimeout(disconnectedTimer);
    clearTimeout(gatheringTimer);
    finishGathering?.();
    finishGathering = undefined;
    disconnectedTimer = gatheringTimer = undefined;
    attemptId = undefined;
    localCandidates = [];
    remoteCandidates = new Set();
    latestCursor = undefined;
    if (cursorTimer) clearInterval(cursorTimer);
    cursorTimer = null;
    native?.stop();
    native = null;
    recoverCapture = null;
    activeLease = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    peer?.close();
    peer = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };
  const unsubscribe = api.onCommand((command) => {
    if (command.op === 'ice') {
      const rtc = peer,
        current = generation;
      if (exchanging) {
        void api.reply(command.id, { error: 'DESKTOP_VIDEO_STOPPED' }).catch(() => {});
        return;
      }
      exchanging = true;
      const seen = remoteCandidates;
      void (async () => {
        if (
          !rtc ||
          command.lease !== activeLease ||
          !attemptId ||
          command.attemptId !== attemptId ||
          !Number.isSafeInteger(command.after) ||
          command.after! < 0 ||
          command.after! > localCandidates.length
        )
          throw new Error('DESKTOP_VIDEO_STOPPED');
        for (const candidate of parseDesktopIceCandidates(command.candidates)) {
          if (current !== generation) throw new Error('DESKTOP_VIDEO_STOPPED');
          const key = JSON.stringify(candidate);
          if (seen.has(key)) continue;
          if (seen.size >= REMOTE_DESKTOP_NETWORK.maxCandidates)
            throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
          await rtc.addIceCandidate(candidate);
          seen.add(key);
        }
        if (current !== generation) throw new Error('DESKTOP_VIDEO_STOPPED');
        const candidates = localCandidates.slice(
          command.after,
          command.after! + REMOTE_DESKTOP_NETWORK.batchSize,
        );
        await api.reply(command.id, {
          attemptId,
          candidates,
          next: command.after! + candidates.length,
          complete:
            rtc.iceGatheringState === 'complete' &&
            command.after! + candidates.length === localCandidates.length,
        });
      })()
        .catch(() => api.reply(command.id, { error: 'DESKTOP_VIDEO_STOPPED' }).catch(() => {}))
        .finally(() => {
          if (current === generation) exchanging = false;
        });
      return;
    }
    if (command.op === 'capture-reset') {
      if (command.lease === activeLease) {
        native?.clear();
        recoverCapture?.();
      }
      return;
    }
    stop();
    if (
      command.op !== 'offer' ||
      !command.lease ||
      !command.sdp ||
      (!command.sourceId && !command.nativeCapture)
    )
      return;
    const current = generation;
    const lease = command.lease;
    activeLease = lease;
    attemptId = command.attemptId;
    void (async () => {
      try {
        const capture = () =>
          navigator.mediaDevices.getDisplayMedia({
            audio: command.settings?.audio === true,
            video: {
              frameRate: { ideal: command.settings?.fps ?? 30, max: command.settings?.fps ?? 30 },
            },
          });
        const boundedCapture = async () => {
          if (!command.sourceId) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
          let abandoned = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            return await Promise.race([
              capture().then((value) => {
                if (abandoned || current !== generation) {
                  value.getTracks().forEach((track) => track.stop());
                  throw new Error('DESKTOP_VIDEO_STOPPED');
                }
                return value;
              }),
              new Promise<never>((_, reject) => {
                timeout = setTimeout(
                  () => {
                    abandoned = true;
                    reject(new Error('DESKTOP_VIDEO_TIMEOUT'));
                  },
                  command.nativeCapture ? 2000 : 10000,
                );
              }),
            ]);
          } finally {
            if (timeout) clearTimeout(timeout);
          }
        };
        const nativeStream = async () => {
          const result = await nativeCaptureStream(
            () => api.nativeFrame(lease),
            () => current === generation,
            () => stop(),
            (value) => {
              if (current === generation) latestCursor = value;
            },
            command.cursorOverlay ? (command.settings?.fps ?? 30) : 15,
          );
          if (current !== generation) {
            result.stop();
            throw new Error('DESKTOP_VIDEO_STOPPED');
          }
          native = result;
          return result.stream;
        };
        let captured: MediaStream;
        if (command.cursorOverlay) {
          // Chromium in our runtime exposes no cursor constraint. Use the
          // cursor-free native video while retaining the normal audio track.
          let audioSource: MediaStream | null = null;
          try {
            if (command.settings?.audio && command.sourceId) {
              try {
                audioSource = await boundedCapture();
              } catch (error) {
                if (current !== generation) throw error;
                // Validate the final track set below, including native video.
              }
            }
            captured = await nativeStream();
            if (current !== generation) throw new Error('DESKTOP_VIDEO_STOPPED');
            for (const track of audioSource?.getAudioTracks() ?? []) captured.addTrack(track);
            audioSource?.getVideoTracks().forEach((track) => track.stop());
          } catch (error) {
            audioSource?.getTracks().forEach((track) => track.stop());
            throw error;
          }
        } else
          try {
            captured = await boundedCapture();
          } catch (error) {
            if (!command.nativeCapture || current !== generation) throw error;
            captured = await nativeStream();
          }
        if (current !== generation) {
          captured.getTracks().forEach((track) => track.stop());
          return;
        }
        if (command.settings?.audio && !captured.getAudioTracks().length) {
          captured.getTracks().forEach((track) => track.stop());
          throw new Error('DESKTOP_AUDIO_UNAVAILABLE');
        }
        stream = captured;
        const rtc = new RTCPeerConnection({
          iceServers: REMOTE_DESKTOP_ICE_SERVERS,
        });
        peer = rtc;
        rtc.onicecandidate = ({ candidate }) => {
          if (!command.attemptId || current !== generation || !candidate?.candidate) return;
          if (localCandidates.length >= REMOTE_DESKTOP_NETWORK.maxCandidates) {
            stop();
            return;
          }
          localCandidates.push({
            candidate: candidate.candidate,
            sdpMid: candidate.sdpMid,
            sdpMLineIndex: candidate.sdpMLineIndex,
            ...(candidate.usernameFragment ? { usernameFragment: candidate.usernameFragment } : {}),
          });
        };
        let recovering = false;
        recoverCapture = () => {
          if (!command.nativeCapture || native || recovering || current !== generation) return;
          recovering = true;
          void (async () => {
            const replacement = await nativeStream();
            const sender = rtc.getSenders().find((item) => item.track?.kind === 'video');
            if (!sender || current !== generation) throw new Error('DESKTOP_VIDEO_STOPPED');
            await sender.replaceTrack(replacement.getVideoTracks()[0]);
            captured.getVideoTracks().forEach((track) => {
              track.onended = null;
              track.onmute = null;
              track.stop();
            });
          })().catch(() => {
            if (current === generation) stop();
          });
        };
        captured.getVideoTracks().forEach((track) => {
          track.onended = () => recoverCapture?.();
          track.onmute = () => recoverCapture?.();
        });
        rtc.onconnectionstatechange = () => {
          if (current !== generation) return;
          if (['failed', 'closed'].includes(rtc.connectionState)) {
            stop();
            return;
          }
          if (rtc.connectionState === 'disconnected') {
            if (!disconnectedTimer)
              disconnectedTimer = setTimeout(() => {
                if (current === generation && rtc.connectionState === 'disconnected') stop();
              }, REMOTE_DESKTOP_NETWORK.disconnectedMs);
          } else {
            clearTimeout(disconnectedTimer);
            disconnectedTimer = undefined;
          }
        };
        rtc.ondatachannel = ({ channel }) => {
          if (channel.label !== 'input-v1') {
            channel.close();
            return;
          }
          if (command.cursorOverlay) {
            let lastCursor = '';
            cursorTimer = setInterval(() => {
              if (
                latestCursor === undefined ||
                channel.readyState !== 'open' ||
                current !== generation ||
                channel.bufferedAmount > 65536
              )
                return;
              const data = JSON.stringify({ type: 'cursor', cursor: latestCursor });
              if (data !== lastCursor) {
                channel.send(data);
                lastCursor = data;
              }
            }, 50);
          }
          let pending = 0;
          let challenge = '';
          heartbeat = setInterval(() => {
            // Keep one outstanding challenge until its reply arrives. The host
            // lease bounds silence; replacing it here rejects valid slow pongs.
            if (channel.readyState !== 'open' || current !== generation || challenge) return;
            challenge = crypto.randomUUID();
            channel.send(JSON.stringify({ type: 'viewPing', challenge }));
          }, 2000);
          channel.onmessage = ({ data }) => {
            if (current !== generation) return;
            if (typeof data === 'string' && challenge && data === challenge) {
              challenge = '';
              void api.viewHeartbeat(lease).catch(() => {});
              return;
            }
            if (typeof data !== 'string' || data.length > 32_768 || pending >= 8) {
              stop();
              void api.stop().catch(() => {});
              return;
            }
            try {
              const message = JSON.parse(data) as { sequence: number; events: DesktopInput[] };
              if (
                !Number.isSafeInteger(message.sequence) ||
                !Array.isArray(message.events) ||
                message.events.length > 64 ||
                !message.events.every(isDesktopInput)
              ) {
                stop();
                void api.stop().catch(() => {});
                return;
              }
              pending++;
              void api
                .input(lease, message.sequence, message.events)
                .catch(() => channel.close())
                .finally(() => {
                  pending--;
                });
            } catch {
              stop();
              void api.stop().catch(() => {});
            }
          };
        };
        stream.getTracks().forEach((track) => rtc.addTrack(track, captured));
        await rtc.setRemoteDescription({ type: 'offer', sdp: command.sdp });
        await rtc.setLocalDescription(await rtc.createAnswer());
        for (const sender of rtc.getSenders()) {
          if (sender.track?.kind !== 'video' || !command.settings) continue;
          const parameters = sender.getParameters();
          if (!parameters.encodings?.length) continue;
          for (const encoding of parameters.encodings) {
            encoding.maxFramerate = command.settings.fps;
            if (command.settings.bitrate) encoding.maxBitrate = command.settings.bitrate;
          }
          await sender.setParameters(parameters);
        }
        if (!command.attemptId)
          await new Promise<void>((resolve) => {
            finishGathering = resolve;
            if (rtc.iceGatheringState === 'complete') {
              resolve();
              return;
            }
            gatheringTimer = setTimeout(resolve, REMOTE_DESKTOP_NETWORK.legacyGatherMs);
            rtc.onicegatheringstatechange = () => {
              if (rtc.iceGatheringState === 'complete') {
                clearTimeout(gatheringTimer);
                resolve();
              }
            };
          });
        if (current === generation) await api.reply(command.id, rtc.localDescription?.sdp ?? null);
      } catch (error) {
        if (current === generation) {
          stop();
          const code = error instanceof Error ? error.message : '';
          await api
            .reply(command.id, {
              error:
                code === 'DESKTOP_AUDIO_UNAVAILABLE'
                  ? code
                  : code === 'DESKTOP_VIDEO_TIMEOUT'
                    ? code
                    : 'DESKTOP_VIDEO_UNAVAILABLE',
            })
            .catch(() => {});
        }
      }
    })();
  });
  void api.registerHost().catch(() => stop());

  return () => {
    unsubscribe();
    stop();
  };
}
