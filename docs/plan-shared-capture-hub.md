# Plan: Shared-Capture Hub (multi-viewer monitor)

## Problem
The PS3Eye camera (`/dev/video0`) can only be opened by ONE process at a time
(`VIDIOC_REQBUFS: Device or resource busy`). Today each `MonitorSession` builds
its own `v4l2src`, so a 2nd viewer's pipeline fails to open the camera and
disrupts the 1st. iOS works alone; a 2nd device (Firefox) blocks it.

## Goal
Multiple viewers (e.g. iPhone + Firefox) watch the SAME camera feed
simultaneously, with one camera/mic capture shared across all subscriber
`webrtcbin`s.

## Architecture
One long-lived **capture pipeline** owned by a new `MonitorHub` (singleton per
agent). It opens the camera + mic ONCE and fans media out to N subscriber
`webrtcbin`s via `tee`s:

```
v4l2src device=/dev/video0 ! videoconvert ! video/x-raw,format=I420,WxH@fr ! tee name=vtee
alsasrc device=hw:2,0 ! audioconvert ! audioresample ! level ! tee name=atee
```

Each subscriber = a `MonitorSession` that:
- creates a `webrtcbin name=wbN` ADDED TO the hub pipeline (not its own),
- links `vtee.src_%u -> queue -> wbN`'s video send pad,
- links `atee.src_%u -> queue -> wbN`'s audio send pad,
- owns its own transceivers, negotiation, ICE, and **talkback recv** chain
  (per-subscriber, since each base sends its own talkback),
- tears down only its `webrtcbin` + recv chain on leave; the capture pipeline
  stays up while >=1 subscriber exists (stopped on last leave).

## Components / changes
1. `MonitorHub` (new): builds shared capture pipeline + `vtee`/`atee`;
   `add_subscriber(id)` / `remove_subscriber(id)`; starts/stops capture by
   subscriber count; holds `level` for metering; exposes
   `link_send_pads(webrtcbin, has_video, has_audio)`.
2. `MonitorSession` (rewritten): no `v4l2src`/`alsasrc`; receives hub pipeline
   + tees; builds only `webrtcbin` + transceivers + recv chains; links to tees.
3. Agent session map (`self.sessions`): unchanged shape, but creation routes
   through `MonitorHub`. First subscriber starts capture; last leave stops it.
4. `monitor_pipeline_str`: split into `capture_pipeline_str` (shared, pure/
   testable) + per-session `webrtcbin` construction (mostly code, not a string).
5. `apply_config` / device / res / fps changes / shutdown: hub-aware.
6. `close`/shutdown loops: hub-aware — last subscriber stops capture.

## Decisions (from user)
- **Mid-stream config changes**: DEFER applying res/fps/device changes until no
  viewers are connected (avoids risky relink while live). Simplest + safe.
- **Pi 3**: software x264 is expensive. For multi-viewer, CAP to 480p@15 (or
  lower) when >=2 viewers to avoid CPU saturation. Document this.
- **TEST_SOURCE=1** honored in the shared capture (videotestsrc/audiotestsrc).

## Risks
- Linking pads to `webrtcbin` in a shared pipeline is the fiddliest GStreamer
  part (request pads `send_rtp_sink_%u`, tee `src_%u`). Iterative Pi testing.
- Dynamic tee src pad requests must happen AFTER `add-transceiver` (send pad
  must exist).
- CPU: one capture but N software-x264 encodes. Pi 3 must cap multi-viewer res.

## Verification
- Unit: extend `test_pi_agent.py` for `capture_pipeline_str` (pure) + hub
  add/remove-subscriber logic with GStreamer lazy-imported / fake pipeline.
  Keep existing 25 passing.
- Pi: deploy, subscribe with TWO browsers (iPhone + Firefox) simultaneously ->
  both reach `pc:connected` and show video. DBG logs confirm 2 sessions share 1
  capture.
- Strip DBG logging once verified.

## Out of scope (this pass)
- Live res/fps switching with viewers connected (deferred per decision above).
- Hardware `v4l2h264enc` per-subscriber (still software x264; revisit if Pi 3
  can't sustain 2 viewers even at 480p@15).
