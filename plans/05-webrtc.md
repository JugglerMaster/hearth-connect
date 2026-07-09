# 05 — WebRTC Manager Track-level Changes

File: `server/public/js/webrtc.js`

## Problem

`startCamera()` (`webrtc.js:23`) does a single combined `getUserMedia`. For the Pi agent and
degraded kiosks we need **independent video/audio acquisition** and **per-kind track
management** so a peer connection can carry video-only, audio-only, or both.

## Changes

1. **Split acquisition helpers** (add to `webrtc.js`):
   - `async startVideo(constraints)` → returns a `MediaStream` with video tracks (or throws).
   - `async startAudio()` → returns a `MediaStream` with audio tracks (or throws).
   - `startCamera(constraints)` becomes a thin wrapper that calls both and merges into
     `this.localStream` (keeps existing callers working).
   - Maintain `this.localStream` as the merged stream used for sending.

2. **`addTracksToPeer(pc)` (`webrtc.js:105`)** — already iterates `localStream.getTracks()` and
   adds each. Works for video-only / audio-only because it adds whatever tracks exist. No change
   required, but ensure it does not assume both kinds.

3. **`updatePeerTracks` support in manager** — `camera.js` owns `updatePeerTracks`; make sure
   `webrtc.js` exposes `localStream` tracks cleanly (already does). Add a manager method
   `syncTracksToPeer(peerId)` that adds missing senders and removes absent ones, used by both
   `camera.js` and `pi-agent.js` on hotplug:

   ```
   syncTracksToPeer(peerId) {
     const pc = this.peerConnections.get(peerId);
     if (!pc || !this.localStream) return;
     const wanted = new Set(this.localStream.getTracks());
     // remove senders whose track is no longer in localStream
     for (const sender of pc.getSenders()) {
       if (sender.track && !wanted.has(sender.track)) pc.removeTrack(sender);
     }
     // add tracks not yet sent
     for (const track of wanted) {
       if (!pc.getSenders().some(s => s.track === track)) pc.addTrack(track, this.localStream);
     }
   }
   ```

4. **`handleOffer` (`webrtc.js:159`)** — recv side. Already creates a `recv` pc and adds talkback
   audio via `additionalAudioStream`. No change needed for track detection; the base station's
   `ontrack` will receive whatever the publisher sends.

5. **`createOffer` (`webrtc.js:138`)** — keep `offerToReceiveAudio: true, offerToReceiveVideo: true`
   so the SDP negotiates both directions; the actual tracks sent depend on what the publisher has.

## No server-side WebRTC changes

The server only relays SDP/ICE (`SignalingHandler.handleRelay`). Track-level negotiation is
peer-to-peer, so no server WebRTC changes are needed for audio-only/video-only.
