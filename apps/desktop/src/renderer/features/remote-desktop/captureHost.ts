import {
  isDesktopInput,
  isRemoteDesktopChannelId,
  parseDesktopIceCandidates,
  parseRemoteDesktopChannelRequest,
  REMOTE_DESKTOP_CHANNEL_MAX_BYTES,
  REMOTE_DESKTOP_ICE_SERVERS,
  REMOTE_DESKTOP_NETWORK,
  type RemoteDesktopIceCandidate,
  type DesktopInput,
  type RemoteDesktopCursor,
  type RemoteDesktopChannelReply,
  type RemoteDesktopChannelRequestMessage,
} from '@cindy/device-link';

/** The id of a well-formed channel request envelope, whatever its payload. */
function channelRequestId(message: unknown): string | null {
  if (!message || typeof message !== 'object') return null;
  const value = message as { type?: unknown; id?: unknown };
  return value.type === 'request' && isRemoteDesktopChannelId(value.id) ? value.id : null;
}
import { DESKTOP_AUDIO_RETRY_MS, type DesktopCaptureApi } from '../../../shared/remoteDesktop';
import {
  desktopEncoderLimits,
  desktopVideoFramerate,
  desktopVideoProfile,
  withDesktopBitrateHints,
} from '../../../shared/remoteDesktopQuality';
import { nativeCaptureStream } from './nativeCaptureStream';
import { PortalCaptureStream } from './portalCaptureStream';
import { nativeAudioStream } from './nativeAudioStream';

/** Runs exclusively in the isolated capture renderer; never import into the chat entry. */
export function startDesktopCaptureHost(api: DesktopCaptureApi): () => void {
  const portal = new PortalCaptureStream(() => {
    stop();
    void api.stop().catch(() => {});
  });
  let peer: RTCPeerConnection | null = null;
  let stream: MediaStream | null = null;
  let generation = 0;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let latestCursor: RemoteDesktopCursor | null | undefined;
  let cursorTimer: ReturnType<typeof setInterval> | null = null;
  let native: Awaited<ReturnType<typeof nativeCaptureStream>> | null = null;
  let audio: Awaited<ReturnType<typeof nativeAudioStream>> | null = null;
  let recoverCapture: (() => void) | null = null;
  let resetAudio: ((resume: boolean) => void) | null = null;
  let activeLease: string | null = null;
  let attemptId: string | undefined;
  let localCandidates: RemoteDesktopIceCandidate[] = [];
  let remoteCandidates = new Set<string>();
  let disconnectedTimer: ReturnType<typeof setTimeout> | undefined;
  let gatheringTimer: ReturnType<typeof setTimeout> | undefined;
  let finishGathering: (() => void) | undefined;
  let exchanging = false;
  let audioRetryTimer: ReturnType<typeof setTimeout> | undefined;
  // A hidden viewer pauses the video encoder in place; audio, input and the
  // data channel keep running, and showing the viewer resumes the same stream.
  let viewerHidden = false;
  // A background viewer (phone picture-in-picture) gets the saver ceilings on
  // the same stream; returning to fullscreen restores the negotiated tier.
  let background = false;
  let applyEncoder: (() => Promise<boolean>) | null = null;
  // setParameters rejects stale parameters, so every sender update is queued.
  let senderUpdates = Promise.resolve();
  /** Resolves false when an encoder update was rejected. */
  const updateVideoSenders = (
    update: (parameters: RTCRtpSendParameters) => boolean,
  ): Promise<boolean> => {
    const rtc = peer,
      current = generation;
    const run = senderUpdates.then(async () => {
      for (const sender of rtc?.getSenders() ?? []) {
        if (current !== generation || sender.track?.kind !== 'video') continue;
        const parameters = sender.getParameters();
        if (parameters.encodings?.length && update(parameters))
          await sender.setParameters(parameters);
      }
    });
    senderUpdates = run.catch(() => {});
    return run.then(
      () => true,
      () => false,
    );
  };
  const applyViewerHidden = () =>
    updateVideoSenders((parameters) => {
      if (parameters.encodings.every((encoding) => encoding.active === !viewerHidden)) return false;
      for (const encoding of parameters.encodings) encoding.active = !viewerHidden;
      return true;
    });
  const stop = () => {
    generation++;
    viewerHidden = false;
    background = false;
    applyEncoder = null;
    exchanging = false;
    clearTimeout(disconnectedTimer);
    clearTimeout(gatheringTimer);
    clearTimeout(audioRetryTimer);
    audioRetryTimer = undefined;
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
    audio?.stop();
    audio = null;
    recoverCapture = null;
    resetAudio = null;
    activeLease = null;
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = null;
    peer?.close();
    peer = null;
    stream?.getTracks().forEach((track) => track.stop());
    stream = null;
  };
  const unsubscribe = api.onCommand((command) => {
    if (command.op === 'prepare') {
      if (command.portalCapture && command.lease) portal.prepare(command.lease);
      return;
    }
    if (command.op === 'frame') {
      try {
        void api
          .reply(command.id, command.lease ? portal.frame(command.lease) : null)
          .catch(() => {});
      } catch {
        void api.reply(command.id, { error: 'DESKTOP_VIDEO_UNAVAILABLE' }).catch(() => {});
      }
      return;
    }
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
        resetAudio?.(command.nativeAudio === true);
      }
      return;
    }
    if (command.op === 'display-hold') {
      if (command.lease === activeLease) native?.hold();
      return;
    }
    if (command.op === 'display-swap') {
      // Only a live native stream follows the new display; browser capture
      // stays on the old one, so the main process rebuilds the video instead.
      const kept = command.lease === activeLease && native?.resume() === true;
      void api.reply(command.id, kept).catch(() => {});
      return;
    }
    if (command.op === 'viewer-hidden') {
      if (command.lease !== activeLease || typeof command.hidden !== 'boolean') {
        void api.reply(command.id, false).catch(() => {});
        return;
      }
      viewerHidden = command.hidden;
      void applyViewerHidden().then((applied) => api.reply(command.id, applied).catch(() => {}));
      return;
    }
    if (command.op === 'background-viewing') {
      if (command.lease !== activeLease) return;
      background = command.background === true;
      void applyEncoder?.();
      return;
    }
    stop();
    if (
      command.op !== 'offer' ||
      !command.lease ||
      !command.sdp ||
      (!command.sourceId && !command.nativeCapture && !command.portalCapture)
    )
      return;
    if (!command.portalCapture) portal.stop();
    const current = generation;
    const lease = command.lease;
    activeLease = lease;
    background = command.background === true;
    attemptId = command.attemptId;
    void (async () => {
      try {
        let captureSettled: Promise<void> = Promise.resolve();
        const profile = desktopVideoProfile(command.settings);
        const fps = desktopVideoFramerate(command.settings);
        // Native capture reports whether the screen is moving; tiers that stay
        // sharp when still trade frame rate for resolution only while still.
        let moving = true;
        // Below these ceilings WebRTC's congestion controller picks the rate;
        // the tier decides whether resolution or frame rate gives way first.
        const tune = () =>
          updateVideoSenders((parameters) => {
            const limits = desktopEncoderLimits(command.settings!, background);
            const degradation =
              moving || !limits.sharpWhenStill ? limits.degradation : 'maintain-resolution';
            let changed = parameters.degradationPreference !== degradation;
            parameters.degradationPreference = degradation;
            for (const encoding of parameters.encodings) {
              changed ||=
                encoding.maxBitrate !== limits.maxBitrate ||
                encoding.maxFramerate !== limits.maxFramerate;
              encoding.maxBitrate = limits.maxBitrate;
              encoding.maxFramerate = limits.maxFramerate;
            }
            return changed;
          });
        const onMotion = (next: boolean) => {
          moving = next;
          if (current === generation) void applyEncoder?.();
        };
        const capture = () =>
          navigator.mediaDevices.getDisplayMedia({
            audio: command.settings?.audio === true,
            video: {
              frameRate: { ideal: fps, max: fps },
            },
          });
        const boundedCapture = async () => {
          if (!command.sourceId) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
          let abandoned = false;
          let timeout: ReturnType<typeof setTimeout> | undefined;
          try {
            const request = capture().then((value) => {
              if (abandoned || current !== generation) {
                value.getTracks().forEach((track) => track.stop());
                throw new Error('DESKTOP_VIDEO_STOPPED');
              }
              return value;
            });
            // A timeout does not cancel getDisplayMedia or its permission prompt.
            // Never overlap another request while the old one is still pending.
            captureSettled = request.then(
              () => {},
              () => {},
            );
            return await Promise.race([
              request,
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
            command.cursorOverlay || command.continuousNativeCapture ? fps : 15,
            // Any tier may become the saver tier in the background, so motion is always tracked.
            command.settings ? onMotion : undefined,
          );
          if (current !== generation) {
            result.stop();
            throw new Error('DESKTOP_VIDEO_STOPPED');
          }
          native = result;
          return result.stream;
        };
        let captured: MediaStream;
        if (command.portalCapture) captured = await portal.capture(lease);
        else if (command.cursorOverlay) {
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
        stream = captured;
        if (command.nativeAudio && command.settings?.audio && api.nativeAudio) {
          try {
            const value = await nativeAudioStream(
              () => api.nativeAudio!(lease),
              () => current === generation,
            );
            if (current !== generation) {
              value.stop();
              return;
            }
            audio = value;
            captured.addTrack(value.track);
          } catch {
            // Optional audio owns only its resources; video and the lease stay alive.
            if (current !== generation) return;
          }
        }
        stream = captured;
        const rtc = new RTCPeerConnection({
          iceServers: command.iceServers ?? REMOTE_DESKTOP_ICE_SERVERS,
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
            const video = replacement.getVideoTracks()[0];
            if (video) video.contentHint = profile.contentHint;
            await sender.replaceTrack(video);
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
          let requests = 0;
          let challenge = '';
          heartbeat = setInterval(() => {
            // Encoder ceilings follow state, not events: an update the encoder
            // rejected converges here, and a matching encoder is left untouched.
            if (current === generation) void applyEncoder?.();
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
            if (typeof data !== 'string' || data.length > 32_768) {
              stop();
              void api.stop().catch(() => {});
              return;
            }
            try {
              const message = JSON.parse(data) as { sequence: number; events: DesktopInput[] };
              // Control requests share the channel so they keep their order with input.
              const id = channelRequestId(message);
              if (id) {
                const send = (reply: RemoteDesktopChannelReply) => {
                  if (current !== generation || channel.readyState !== 'open') return;
                  let data = JSON.stringify(reply);
                  if (data.length > REMOTE_DESKTOP_CHANNEL_MAX_BYTES)
                    data = JSON.stringify({
                      type: 'reply',
                      id,
                      ok: false,
                      error: 'DESKTOP_REPLY_TOO_LARGE',
                    } satisfies RemoteDesktopChannelReply);
                  channel.send(data);
                };
                let request: RemoteDesktopChannelRequestMessage | null = null;
                try {
                  request = parseRemoteDesktopChannelRequest(message);
                } catch {}
                // A newer viewer may move more operations here; refusing one
                // lets it fall back to the relay instead of losing the session.
                if (!request || !api.request) {
                  send({ type: 'reply', id, ok: false, error: 'DESKTOP_CHANNEL_UNSUPPORTED' });
                  return;
                }
                // Requests have their own bound so they never end the input session.
                if (requests >= 8) {
                  send({ type: 'reply', id, ok: false, error: 'DESKTOP_CHANNEL_BUSY' });
                  return;
                }
                requests++;
                void api
                  .request(lease, request.request)
                  .then(
                    (result): RemoteDesktopChannelReply =>
                      result.ok
                        ? { type: 'reply', id: request.id, ok: true, result: result.result }
                        : { type: 'reply', id: request.id, ok: false, error: result.error },
                    (): RemoteDesktopChannelReply => ({
                      type: 'reply',
                      id: request.id,
                      ok: false,
                      error: 'DESKTOP_REQUEST_FAILED',
                    }),
                  )
                  .then(send)
                  .finally(() => {
                    requests--;
                  });
                return;
              }
              // Only input batches count toward the input overflow bound.
              if (
                pending >= 8 ||
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
        stream.getTracks().forEach((track) => {
          if (track.kind === 'video') track.contentHint = profile.contentHint;
          rtc.addTrack(track, captured);
        });
        await rtc.setRemoteDescription({
          type: 'offer',
          sdp:
            command.settings && command.sdp
              ? withDesktopBitrateHints(command.sdp, profile)
              : command.sdp,
        });
        // Negotiate audio now even when permission is not ready. replaceTrack
        // can fill this sender later without interrupting video or the data channel.
        const audioTransceiver =
          command.settings?.audio && !captured.getAudioTracks().length
            ? rtc.getTransceivers().find((item) => item.receiver.track.kind === 'audio')
            : undefined;
        const audioSender =
          audioTransceiver?.sender ??
          rtc.getSenders().find((sender) => sender.track?.kind === 'audio');
        if (audioTransceiver && audioSender) {
          audioTransceiver.direction = 'sendonly';
          // Both receivers must belong to the same stream, including when
          // the viewer observes the initially silent audio track before video.
          audioSender.setStreams(captured);
        }
        if (command.nativeAudio && command.settings?.audio && api.nativeAudio && audioSender) {
          let reset = 0;
          resetAudio = (resume) => {
            const revision = ++reset;
            audio?.stop();
            audio = null;
            const valid = () => current === generation && revision === reset;
            if (!resume) return;
            void (async () => {
              let replacement: Awaited<ReturnType<typeof nativeAudioStream>> | undefined;
              try {
                replacement = await nativeAudioStream(() => api.nativeAudio!(lease), valid);
                if (!valid()) return;
                await audioSender.replaceTrack(replacement.track);
                if (!valid()) return;
                captured.getAudioTracks().forEach((track) => captured.removeTrack(track));
                captured.addTrack(replacement.track);
                audio = replacement;
                replacement = undefined;
              } catch {
                // Optional audio must not interrupt the live video connection.
              } finally {
                replacement?.stop();
              }
            })();
          };
        }
        await rtc.setLocalDescription(await rtc.createAnswer());
        if (current !== generation) throw new Error('DESKTOP_VIDEO_STOPPED');
        if (command.settings) {
          // Published before the first update, so a change arriving meanwhile queues after it.
          applyEncoder = tune;
          if (!(await tune())) throw new Error('DESKTOP_VIDEO_UNAVAILABLE');
        }
        // A pause that arrived while this peer was still being set up applies now.
        if (viewerHidden) void applyViewerHidden();
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
        const retryAudio = async (retry: number): Promise<void> => {
          await captureSettled;
          if (!audioSender || current !== generation || retry >= DESKTOP_AUDIO_RETRY_MS.length)
            return;
          audioRetryTimer = setTimeout(() => {
            audioRetryTimer = undefined;
            void (async () => {
              let replacement: MediaStream | undefined;
              let retained: MediaStreamTrack | undefined;
              try {
                if (current !== generation) return;
                replacement = await boundedCapture();
                const track = replacement.getAudioTracks()[0];
                if (!track || current !== generation) return;
                await audioSender.replaceTrack(track);
                if (current !== generation) return;
                captured.addTrack(track);
                retained = track;
              } catch {
                // Audio recovery never tears down the working video connection.
              } finally {
                replacement?.getTracks().forEach((track) => {
                  if (track !== retained) track.stop();
                });
                if (!retained) void retryAudio(retry + 1);
              }
            })();
          }, DESKTOP_AUDIO_RETRY_MS[retry]);
        };
        if (audioTransceiver && !command.nativeAudio) void retryAudio(0);
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
    portal.stop();
  };
}
