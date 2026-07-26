# 15 — Pi Agent Audio Playback (Headless Audio-Only Monitor)

Give the Pi agent the ability to **subscribe to another room source and play its audio**,
turning a headless Pi into a "listen-in" speaker (e.g. a Pi in the bedroom that plays the
baby's room audio). Because the Pi has **no screen, it never requests or decodes video** —
the subscribe negotiation is **audio-only** (recvonly audio, zero video m-lines), which
saves the H.264 decode CPU and the video bandwidth a headless box would only throw away.

> This is distinct from the two features the agent already has:
> - `MonitorSession` (`pi-agent.py:491`) — the Pi is *published* and plays *talkback* on the
>   reverse audio m-line.
> - `BroadcastSession` (`pi-agent.py:915`) — the Pi receives base-station *announcements*.
>
> New here: the Pi is a **subscriber/monitor of a normal camera source**, audio only.

## A. Why audio-only (headless constraint)

- The Pi OS Lite box has no display stack; a decoded video frame has nowhere to go.
- Requesting video would force `avdec_h264`/`v4l2h264dec` + a `fakesink`, burning CPU for
  frames that are immediately discarded, plus the full video bitrate over the network.
- So the subscribe PC offers **one recvonly audio transceiver and no video transceiver**.
  The publisher (kiosk / other Pi) sees an audio-only subscription and can send just audio.
- Works against any source whose `SourceType` includes audio (`video+audio` or `audio-only`).
  A `video-only` source produces no audio track → the Pi logs "no audio" and does not play.

## B. New session class: `AudioMonitorSession` (IMPLEMENTED)

Added alongside `MonitorSession` / `BroadcastSession` in `pi-agent.py`:

- **Role: answerer, recvonly.** In this codebase the *publisher* is the offerer for a
  subscription (server relays `SUBSCRIBER_JOINED` → publisher offers). So `AudioMonitorSession`
  mirrors `BroadcastSession`: it builds a bare `webrtcbin` (`broadcast_pipeline_str`), waits for
  the publisher's `OFFER`, and creates an `ANSWER`.
- **Pad handler:** on `pad-added`, audio pads → `make_audio_recv_chain()` (Opus → ALSA sink);
  **video pads → `make_video_drop_chain()`** which sinks the RTP **without decoding** (no
  `avdec_h264`) since the Pi is headless. That is how "audio-only" is honored even when the
  publisher offers video+audio.
- **Volume:** `AudioMonitorSession._volume()` uses `config.audioMonitorVolume` (0.0–1.0),
  falling back to `speaker_volume()`. `apply_volume()` re-applies live on `CONFIG_UPDATED`.
- **Teardown:** sessions live in `self.audio_monitor_sessions` and are closed in
  `_teardown_all_sessions()` so a WS drop releases the speaker cleanly.

## C. Signaling (reuse existing subscribe protocol) (IMPLEMENTED)

The Pi acts like a subscriber, reusing the base station's subscribe messages:

1. `reconcile_audio_monitor()` resolves the target publisher and sends
   `SUBSCRIBE_SOURCE { publisherId }`.
2. Publisher gets `SUBSCRIBER_JOINED` and sends `OFFER { to: pi }`. The Pi routes non-broadcast
   offers from that publisher into an `AudioMonitorSession` (answerer) and replies `ANSWER`.
3. `ICE_CANDIDATE` both ways; the handler routes candidates from a monitored publisher to the
   `AudioMonitorSession` before the publish path (see the GStreamer mid note in AGENTS.md).
4. On `SOURCE_REMOVED`, config change, or a new resolved target, `reconcile_audio_monitor()`
   sends `UNSUBSCRIBE_SOURCE` and closes the old `AudioMonitorSession`.

> Note: an alternative "Pi-offers recvonly-audio (no video m-line)" design would avoid even
> receiving the video RTP, but requires the Pi to be the offerer — which does not match the
> publisher-offers subscription flow used everywhere else. The answerer + `make_video_drop_chain`
> approach was chosen for protocol symmetry; it saves the decode CPU (the main cost) while
> accepting the video bytes are still received.

## D. Config (which source to listen to)

Drive selection from `CONFIG_UPDATED` (no new message):

- `audioMonitorEnabled?: boolean` — master on/off for listen-in playback (default false).
- `audioMonitorSourceId?: string` — the source to listen to. `'auto'` = first audio-capable
  source in the room that isn't the Pi's own.
- `audioMonitorVolume?: number` — 0.0–1.0, applied to the `rxvol` element (falls back to
  `speaker_volume()`).

`apply_config()` (`pi-agent.py:1372`) reconciles: if enabled and the target differs from the
current session, tear down the old `AudioMonitorSession` and subscribe to the new one; if
disabled, tear all down. Re-evaluate when `SOURCE_ADDED` arrives (a newly-appeared source may
be the `auto` target).

## E. Env / defaults

Add to `config.env` (optional, for headless-only speaker appliances):

- `AUDIO_MONITOR_SOURCE` — default source id or `auto`.
- `RECEIVE_ONLY=1` already exists for the Sonos plan (12); reuse it so a Pi with no
  camera/mic still joins and can be a pure listen-in speaker.
- `SPEAKER_DEVICE` / `AUDIO_SINK` already select the ALSA output (`pi-agent.py:72,457`).

## F. Testing (zero-dep, per AGENTS.md philosophy)

- **Unit (`test_pi_agent.py`):** add pure-logic helpers and test them without GStreamer:
  - `audio_monitor_target(config, sources, self_id)` → resolves `auto`/explicit source id and
    skips `video-only` sources and self. Table-test the resolution rules.
  - `recvonly_audio_offer_munge(sdp)` (if the publisher-offers fallback is used) → asserts the
    video m-line is set inactive/port-0 and audio kept.
- **e2e (`e2e_smoke.py`):** with `TEST_SOURCE=1`, publish an `audiotestsrc` source from one
  agent instance and a second `RECEIVE_ONLY=1` agent with `AUDIO_MONITOR_SOURCE=auto`; assert
  the monitor agent sends `SUBSCRIBE_SOURCE`, produces an **audio-only OFFER (no video m-line)**,
  and reaches ICE connected. Auto-skips when GStreamer/websockets/server are absent.
- Real check on a Pi: confirm audio comes out the ALSA sink and **no `avdec_h264` element is
  ever instantiated** (grep the pipeline dump / `GST_DEBUG`).

## G. Notes / edge cases

- **No video, ever** — the whole point; never add a video transceiver or a video recv chain
  on this PC, even if the publisher offers video.
- **Interaction with talkback** — audio-monitor playback and talkback playback can both target
  the same ALSA device; keep them on separate `webrtcbin` PCs and let ALSA (dmix) mix, or gate
  one when the other is active. Default: listen-in ducks when talkback is active.
- **Device contention** — a single ALSA sink may not open twice; prefer `dmix` or route
  audio-monitor to `AUDIO_SINK` while talkback uses `SPEAKER_DEVICE`.
- **Reconnect** — `AudioMonitorSession`s are torn down on WS drop (§B) and re-established from
  `apply_config()` after re-`JOIN_ROOM`, same as broadcast subscriptions.
