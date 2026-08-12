#!/usr/bin/env python3
# Hearth-Connect native agent for Raspberry Pi (Pi OS Lite, headless).
#
# Connects to a Hearth-Connect server over WebSocket, enumerates V4L2 cameras and
# ALSA microphones, and publishes whatever media is available (video+audio /
# video-only / audio-only) via GStreamer webrtcbin. Speaks the same signaling
# protocol as the browser kiosk, INCLUDING:
#   - Two-way talkback: the monitor peer connection is sendrecv, so the base
#     station's reverse (talkback) audio arrives on the same audio m-line. We
#     decode and play it through an ALSA sink, gated by TALK_ENABLED/DISABLED
#     (and by the kiosk's audioMode config, which the base sets to 'base' during
#     FaceTalk).
#   - Broadcasts: when the base station publishes a broadcast source the Pi
#     receives SOURCE_ADDED, subscribes (SUBSCRIBE_BROADCAST), answers the base's
#     broadcast offer, and plays the incoming audio (announcements always play;
#     FaceTalk video is received but dropped to fakesink since the Pi is headless).
#
# RAM NOTE: the dominant memory cost is GStreamer + the encoder, which is the
# same native stack regardless of the glue language. Python + PyGObject adds only
# ~50-100MB. We stay well under 1GB by (1) preferring the Pi's hardware H.264
# encoder (v4l2h264enc) over software x264, (2) capping concurrent subscriber
# pipelines (MAX_SUBSCRIBERS), and (3) keeping conservative default resolution.

import asyncio
import json
import logging
import os
import random
import ssl
import string
import socket
import subprocess
import time

# GStreamer and `websockets` are imported lazily inside _load_gst() / run() so
# this module can be imported (and unit-tested) on machines without the native
# stack installed.
Gst = GstWebRTC = GstSdp = GLib = None

_LOG_LEVEL = os.environ.get('LOG_LEVEL', 'INFO').strip().upper()
logging.basicConfig(level=getattr(logging, _LOG_LEVEL, logging.INFO),
                   format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('hearth-pi-agent')

WS_URL = os.environ.get('SERVER_URL', '').rstrip('/')
if WS_URL and not WS_URL.startswith('ws'):
    WS_URL = 'wss://' + WS_URL
# WS_URL is empty string when SERVER_URL is unset — triggers mDNS discovery.
ROOM_ID = os.environ.get('ROOM_ID', 'default')
DEVICE_LABEL = os.environ.get('DEVICE_LABEL', socket.gethostname())
VIDEO_DEVICE = os.environ.get('VIDEO_DEVICE', '')
AUDIO_DEVICE = os.environ.get('AUDIO_DEVICE', '')
# Default resolution/framerate; overridable at runtime from the base station's
# camera config (see Agent.apply_config). Kept as module defaults so the agent
# still works when launched outside systemd (no config.env present).
DEFAULT_RESOLUTION = os.environ.get('RESOLUTION', '720p')
DEFAULT_FRAMERATE = int(os.environ.get('FRAMERATE', '24'))

# Path to the env file the agent was launched from (set by the systemd unit /
# install scripts). Used to persist base-station-driven config changes. If
# unset or missing, the agent recreates it from defaults.
CONFIG_FILE = os.environ.get('CONFIG_FILE', '/opt/hearth-pi-agent/config.env')
CONFIG_PERSIST_FILE = os.environ.get('CONFIG_PERSIST_FILE', '/opt/hearth-pi-agent/config.json')

def _read_env_value(key):
    """Read a KEY=VALUE entry from the env file (CONFIG_FILE).

    Returns the stripped value, or None if the key is absent/blank. Does NOT
    fall back to os.environ (use os.environ directly for that). Comments and
    blank lines are ignored. Used to recover persisted settings like DEVICE_ID
    without shelling out to a parser.
    """
    try:
        if os.path.exists(CONFIG_FILE):
            with open(CONFIG_FILE) as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line:
                        continue
                    k, _, v = line.partition('=')
                    if k.strip() == key:
                        return v.strip() or None
    except Exception:
        pass
    return None

# Test-source mode: substitute videotestsrc/audiotestsrc for v4l2src/alsasrc so
# the agent runs on a headless box with no real camera/mic (used by the e2e
# smoke test, plan 11). Set TEST_SOURCE=1 to enable.
TEST_SOURCE = os.environ.get('TEST_SOURCE') == '1'

# Video source: 'auto' detects Pi camera (unicam → libcamerasrc) vs USB (v4l2src).
# Force 'libcamera' or 'v4l2' to override detection.
VIDEO_SOURCE = os.environ.get('VIDEO_SOURCE', 'auto')  # 'auto', 'libcamera', 'v4l2'

# Talkback / broadcast receive sink configuration.
SPEAKER_DEVICE = os.environ.get('SPEAKER_DEVICE', '')
AUDIO_SINK = os.environ.get('AUDIO_SINK', '')  # e.g. 'alsasink device=hw:0,0' overrides SPEAKER_DEVICE

# Headless audio-only listen-in (plan 15): seed the base-station config so a Pi
# can act as a dedicated "listen to room X" speaker without the base pushing
# config. AUDIO_MONITOR_SOURCE = a sourceId/publisherId or 'auto'. Setting it
# implies AUDIO_MONITOR_ENABLED. Overridden live by CONFIG_UPDATED.
AUDIO_MONITOR_SOURCE = os.environ.get('AUDIO_MONITOR_SOURCE', '')
# Empty/unset falls back to "enabled iff a source is configured" so a bare
# `AUDIO_MONITOR_ENABLED=` line doesn't accidentally disable an intended source.
_am_enabled_raw = os.environ.get('AUDIO_MONITOR_ENABLED', '').strip()
AUDIO_MONITOR_ENABLED = (_am_enabled_raw == '1') if _am_enabled_raw else bool(AUDIO_MONITOR_SOURCE)

# Hard cap on simultaneous subscriber pipelines. Each viewer gets its own
# GStreamer pipeline; on a 1GB Pi this bounds memory/CPU. Beyond the cap we
# politely tell the server the subscriber left so the base doesn't hang.
MAX_SUBSCRIBERS = int(os.environ.get('MAX_SUBSCRIBERS', '4'))

# Grace (seconds) before tearing down a MonitorSession after its subscriber
# leaves (SUBSCRIBER_LEFT). The Pi keeps the camera/audio pipeline LIVE across
# a viewer's screen-lock (WebSocket drop → SUBSCRIBER_LEFT) so the audio keeps
# playing through the lock — the viewer's native-fullscreen media session on iOS
# survives the lock as long as RTP keeps arriving. A reconnect re-subscribes and
# gets a fresh session (new OFFER). The grace is bounded so a truly-gone viewer
# eventually frees the camera instead of leaving the red light on forever.
MONITOR_LINGER_S = int(os.environ.get('MONITOR_LINGER_S', '600'))  # 10 minutes

DIMS = {'480p': (640, 480), '720p': (1280, 720), '1080p': (1920, 1080)}
STUN = 'stun://stun.l.google.com:19302'

# Hotspot / captive portal: SSID for the open AP when WiFi is unavailable.
# Defaults to the device label or auto-detected Pi model name.
HOTSPOT_NAME = os.environ.get('HOTSPOT_NAME', '')


def _no_verify_ssl():
    """SSL context that accepts self-signed certs (LAN-only use).
    Forces HTTP/1.1 by disabling ALPN so WebSocket upgrade works — the Ktor
    Netty server auto-negotiates h2 via ALPN when TLS is enabled, but the
    websockets library expects the traditional HTTP/1.1 101 upgrade."""
    import ssl
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    ctx.set_alpn_protocols(['http/1.1'])
    return ctx


def rand_id(n=8):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=n))


def gst_element_exists(name):
    return Gst.ElementFactory.find(name) is not None


def test_encoder(encoder_name):
    """Quick preroll test: can this encoder actually produce output?

    ``v4l2h264enc`` exists as a GStreamer element on Pi 3B (installed via
    gstreamer1.0-plugins-bad) but the hardware encoder stalls on preroll
    unless an explicit H.264 level is negotiated on its src pad.  This builds
    a tiny test pipeline and checks if it reaches PAUSED (preroll) within a
    short timeout.  Returns True on success, False on failure/timeout.
    """
    _load_gst()
    # The Pi 3B hardware encoder fails to preroll without an explicit level.
    # Force level 4.0 (valid for up to 1080p30) so the test reflects what the
    # live pipeline uses — see https://en.wikipedia.org/wiki/Advanced_Video_Coding#Levels.
    level_caps = ' ! video/x-h264,level=(string)4' if encoder_name == 'v4l2h264enc' else ''
    pipeline_str = (
        'videotestsrc num-buffers=1 ! videoconvert ! '
        'video/x-raw,format=I420,width=320,height=240,framerate=15/1 ! '
        '{enc}{level} ! fakesink'.format(enc=encoder_name, level=level_caps))
    try:
        pipeline = Gst.parse_launch(pipeline_str)
        ret = pipeline.set_state(Gst.State.PAUSED)
        if ret == Gst.StateChangeReturn.FAILURE:
            pipeline.set_state(Gst.State.NULL)
            return False
        # Wait up to 3 s for preroll (Gst.SECOND is nanoseconds).
        ret, state, _pending = pipeline.get_state(3 * Gst.SECOND)
        pipeline.set_state(Gst.State.NULL)
        return state in (Gst.State.PAUSED, Gst.State.PLAYING)
    except Exception:
        return False


def _load_gst():
    """Lazily import GStreamer + WebRTC bindings and init GStreamer.

    Kept out of the module top level so pi-agent.py can be imported (and unit
    tested) without the native stack installed.
    """
    global Gst, GstWebRTC, GstSdp, GLib
    if Gst is not None:
        return
    import gi
    gi.require_version('Gst', '1.0')
    gi.require_version('GstWebRTC', '1.0')
    gi.require_version('GstSdp', '1.0')
    from gi.repository import Gst as _Gst, GstWebRTC as _GstWebRTC, \
        GstSdp as _GstSdp, GLib as _GLib
    Gst, GstWebRTC, GstSdp, GLib = _Gst, _GstWebRTC, _GstSdp, _GLib
    Gst.init(None)


def parse_v4l2_devices(stdout):
    """Parse `v4l2-ctl --list-devices` output into [{id,label}] (plan 06 §A)."""
    devices = []
    cur = None
    for line in (stdout or '').splitlines():
        if line and not line.startswith(('\t', ' ')) and ':' in line:
            cur = line.strip()
        elif '/dev/video' in line:
            dev = line.strip()
            devices.append({'id': dev, 'label': (cur or dev)})
    return filter_real_cameras(devices)


# A few V4L2 nodes exposed by the Pi's GPU are NOT capture devices and should
# not be offered as selectable cameras in the base station:
#   - bcm2835-codec: hardware encode/decode/transcode engine (never a camera)
#   - bcm2835-isp:   ISP processing/scaler nodes (not a raw camera source)
#   - v4l2-loopback: virtual devices
# The onboard Pi Camera (bcm2835-unicam) and USB webcams (UVC, e.g. PS3 Eye)
# ARE real capture sources and must be kept.
_FAKE_VIDEO_PREFIXES = ('bcm2835-codec', 'bcm2835-isp', 'v4l2-loopback')


def filter_real_cameras(devices):
    out = []
    for d in devices:
        label = (d.get('label') or '').lower()
        if any(p in label for p in _FAKE_VIDEO_PREFIXES):
            continue
        out.append(d)
    return out


def is_libcamera_device(video_device):
    """Check if a V4L2 device is managed by libcamera (Pi camera via unicam).

    Returns True for Pi CSI cameras that need libcamerasrc, False for USB/webcam
    devices that use v4l2src.  Checks the sysfs device name for 'unicam' which
    is the Pi's camera interface driver.
    """
    if not video_device:
        return False
    try:
        idx = video_device.replace('/dev/video', '')
        name_path = '/sys/class/video4linux/video' + idx + '/name'
        with open(name_path) as f:
            name = f.read().strip()
        return 'unicam' in name.lower()
    except Exception:
        return False


def should_use_libcamera(video_device):
    """Determine whether to use libcamerasrc for the given device.

    Honours the VIDEO_SOURCE env override; otherwise auto-detects via
    is_libcamera_device().  Also checks that libcamerasrc is available in
    GStreamer (required at pipeline-build time, not at detection time).
    """
    if VIDEO_SOURCE == 'libcamera':
        return True
    if VIDEO_SOURCE == 'v4l2':
        return False
    return is_libcamera_device(video_device)


def parse_v4l2_formats(stdout):
    """Parse `v4l2-ctl --list-formats-ext` into a list of
    {width, height, framerates:[float,...]} (plan 06 §A / PS3Eye fix).

    Cameras like the PS3 Eye only expose discrete framerates (e.g. 15/30/60,
    never 24). Pinning an unsupported framerate in the pipeline caps makes
    v4l2src fail to preroll and the WebRTC session never produces an OFFER,
    so callers use this to clamp to a real mode.
    """
    modes = []
    cur = None  # dict with width/height; collects framerates until next Size
    for line in (stdout or '').splitlines():
        s = line.strip()
        if s.startswith('Size: Discrete'):
            try:
                w, h = s.split('Size: Discrete')[1].strip().split('x')
                cur = {'width': int(w), 'height': int(h), 'framerates': []}
                modes.append(cur)
            except Exception:
                cur = None
        elif s.startswith('Interval: Discrete') and cur is not None:
            # e.g. 'Interval: Discrete 0.033s (30.000 fps)'
            if '(' in s and 'fps' in s:
                try:
                    fps = float(s.split('(')[1].split('fps')[0].strip())
                    cur['framerates'].append(fps)
                except Exception:
                    pass
    return modes


def supported_framerate(video_device, width, height, desired):
    """Return a framerate the camera actually supports for (width,height), or
    None to leave the pipeline framerate unconstrained.

    PS3 Eye / many UVC cams only support discrete framerates; pinning a
    non-existent one (e.g. the 24fps default) makes v4l2src fail to preroll.
    Picks the nearest supported rate <= desired, else the highest available.
    """
    if not video_device:
        return None
    try:
        out = subprocess.run(
            ['v4l2-ctl', '--device=' + video_device, '--list-formats-ext'],
            capture_output=True, text=True, timeout=10)
        modes = parse_v4l2_formats(out.stdout)
    except Exception:
        return None
    for m in modes:
        if m['width'] == width and m['height'] == height and m['framerates']:
            fr = m['framerates']
            # nearest <= desired
            lower = [f for f in fr if f <= float(desired)]
            if lower:
                return int(max(lower)) if max(lower).is_integer() else max(lower)
            return int(min(fr)) if min(fr).is_integer() else min(fr)
    return None


def best_supported_mode(video_device, width, height, desired_fps):
    """Return (width, height, fps) the camera actually supports, or None.

    Finds the best resolution+framerate combo for the requested dimensions.
    If the exact resolution isn't available, picks the largest resolution
    that is <= the requested one (to avoid upscaling).  If nothing fits,
    returns the largest available mode.  Framerate is clamped to the nearest
    supported rate <= desired_fps, or the highest available.
    """
    if not video_device:
        return None
    try:
        out = subprocess.run(
            ['v4l2-ctl', '--device=' + video_device, '--list-formats-ext'],
            capture_output=True, text=True, timeout=10)
        modes = parse_v4l2_formats(out.stdout)
    except Exception:
        return None
    if not modes:
        return None
    # Filter to modes with at least one framerate.
    usable = [m for m in modes if m['framerates']]
    if not usable:
        return None
    # Exact resolution match?
    exact = [m for m in usable
             if m['width'] == width and m['height'] == height]
    candidates = exact or usable
    # Pick largest resolution <= requested, or just the largest.
    within = [m for m in candidates
              if m['width'] <= width and m['height'] <= height]
    best_res = (max(within, key=lambda m: m['width'] * m['height'])
                if within else max(candidates,
                                   key=lambda m: m['width'] * m['height']))
    fr = best_res['framerates']
    lower = [f for f in fr if f <= float(desired_fps)]
    best_fps = (max(lower) if lower else max(fr))
    best_fps = int(best_fps) if best_fps.is_integer() else best_fps
    return best_res['width'], best_res['height'], best_fps


def parse_arecord_devices(stdout):
    """Parse `arecord -l` output into [{id,label}] (plan 06 §A)."""
    devices = []
    for line in (stdout or '').splitlines():
        if line.startswith('card '):
            parts = line.split(':')
            name = parts[1].strip() if len(parts) > 1 else line
            card = line.split()[1].rstrip(':')
            devices.append({'id': 'hw:' + card + ',0', 'label': name})
    return devices


def parse_aplay_devices(stdout):
    """Parse `aplay -l` output into [{id,label}] — playback (speaker) devices.

    Mirrors parse_arecord_devices but for output. Used to populate the base
    station's "Speaker Output" selector so the operator can route talkback /
    announcement audio to the physically-connected output (e.g. the analog/RCA
    jack) instead of whatever the default ALSA device resolves to (often HDMI
    with no speakers)."""
    devices = []
    for line in (stdout or '').splitlines():
        if line.startswith('card '):
            parts = line.split(':')
            name = parts[1].strip() if len(parts) > 1 else line
            card = line.split()[1].rstrip(':')
            devices.append({'id': 'hw:' + card + ',0', 'label': name})
    return devices


def alsa_channels(device):
    """Detect native channel count for an ALSA device (e.g. 'hw:2,0').

    Returns the native channel count, or 0 if detection fails.  Some USB audio
    devices (camera mics) only work at their native channel count; GStreamer's
    alsasrc fails to preroll when it can't map channel positions for the
    negotiated count.
    """
    if not device:
        return 0
    try:
        out = subprocess.run(
            ['arecord', '-D', device, '--dump-hw-params'],
            input=b'', capture_output=True, timeout=5)
        text = out.stdout.decode() + out.stderr.decode()
        for line in text.splitlines():
            if line.startswith('CHANNELS:'):
                parts = line.split()
                if len(parts) >= 2:
                    return int(parts[1])
    except Exception:
        pass
    return 0


def source_type(has_video, has_audio):
    """Map device availability to the protocol SourceType (plan 01 §7)."""
    if has_video and has_audio:
        return 'video+audio'
    if has_video:
        return 'video-only'
    if has_audio:
        return 'audio-only'
    return 'none'


def audio_monitor_target(cfg, sources, self_id):
    """Pure resolver: which publisher should the Pi listen to (plan 15 §D)?

    The Pi is a headless *audio-only* listen-in monitor. Given the base-station
    config and the current room source list, return the publisherId to subscribe
    to (audio only), or None when disabled / no suitable source exists.

    cfg:     dict with audioMonitorEnabled / audioMonitorSourceId.
    sources: iterable of source dicts ({'id','publisherId','type', ...} as sent
             by the server in WELCOME / SOURCE_ADDED).
    self_id: this agent's deviceId — never listen to our own source.

    Selection rules:
      - audioMonitorEnabled must be truthy, else None.
      - Only sources whose type carries audio ('video+audio' or 'audio-only')
        and that aren't broadcasts or our own are eligible. A 'video-only'
        source has no audio → skipped.
      - audioMonitorSourceId == 'auto' (or empty) → first eligible source.
      - Otherwise it may name either a sourceId or a publisherId; match either.
    """
    if not cfg.get('audioMonitorEnabled'):
        return None
    sel = cfg.get('audioMonitorSourceId') or 'auto'

    def eligible(s):
        if not isinstance(s, dict):
            return False
        if s.get('isBroadcast'):
            return False
        if s.get('publisherId') == self_id:
            return False
        return s.get('type') in ('video+audio', 'audio-only')

    elig = [s for s in (sources or []) if eligible(s)]
    if not elig:
        return None
    if sel == 'auto':
        return elig[0].get('publisherId')
    for s in elig:
        if s.get('id') == sel or s.get('publisherId') == sel:
            return s.get('publisherId')
    return None


def audio_peak_decision(db, state, cfg, now):
    """Pure audio-threshold + hysteresis decision (plan 07 §C/§D).

    state: mutable dict with 'armed' (bool) and 'last_ts' (float, seconds).
    cfg:   dict with audioAlertEnabled / audioAlertThresholdDb /
           audioAlertHysteresisDb.
    Returns (emit_peak, throttled_meter, state). emit_peak / throttled_meter
    are AUDIO_PEAK payloads to send (or None). State is mutated in place and
    also returned.
    """
    enabled = cfg.get('audioAlertEnabled', True)
    threshold = cfg.get('audioAlertThresholdDb', -40)
    hyst = cfg.get('audioAlertHysteresisDb', 6)
    emit_peak = None
    if enabled:
        if db > threshold and state['armed']:
            emit_peak = {'peak': True, 'levelDb': db, 'ts': int(now * 1000)}
            state['armed'] = False
        elif db < threshold - hyst:
            state['armed'] = True
    throttled_meter = None
    if now - state['last_ts'] > 1.0:
        state['last_ts'] = now
        throttled_meter = {'peak': False, 'levelDb': db, 'ts': int(now * 1000)}
    return emit_peak, throttled_meter, state


def monitor_pipeline_str(has_video, has_audio, width, height, framerate,
                         video_device='', audio_device='', enc='x264enc',
                         stun=STUN, test_source=False, use_libcamerasrc=False,
                         audio_channels=0):
    """Build the monitor (sendrecv) GStreamer launch string WITHOUT parsing it.

    Kept pure so it can be unit-tested without GStreamer. test_source swaps in
    videotestsrc/audiotestsrc so the agent runs on a headless box with no real
    camera/mic (used by the e2e smoke test, plan 11).
    """
    parts = ['webrtcbin name=wb stun-server=' + stun]
    if has_video:
        if test_source:
            src = 'videotestsrc'
            dev = ''
            use_libcamerasrc = False
        elif use_libcamerasrc:
            src = 'libcamerasrc'
            dev = ''
        else:
            src = 'v4l2src'
            dev = ('device=' + video_device) if video_device else ''
        # Encoder-specific options. `tune=zerolatency` and `key-int-max` are
        # x264enc (software) properties; `v4l2h264enc` (Pi hardware) manages its
        # own GOP, so it gets no extra options. Kept pure (no GStreamer
        # introspection) so the string helper stays unit-testable.
        if enc == 'v4l2h264enc':
            # The Pi 3B hardware encoder fails to preroll unless an explicit
            # H.264 level is negotiated on its src pad. Level 4.0 supports up to
            # 1080p30 — valid for every resolution this agent uses.
            # See https://en.wikipedia.org/wiki/Advanced_Video_Coding#Levels
            enc_segment = 'v4l2h264enc ! video/x-h264,level=(string)4'
        else:
            enc_opts = 'tune=zerolatency key-int-max=30' if enc == 'x264enc' else ''
            enc_segment = '{enc} {enc_opts}'.format(enc=enc, enc_opts=enc_opts)
        if use_libcamerasrc:
            # libcamerasrc outputs NV21; caps set resolution, then convert to I420.
            parts.append(
                '{src} ! video/x-raw,width={w},height={h},framerate={fr}/1 '
                '! videoconvert ! video/x-raw,format=I420 '
                '! {enc_segment} ! rtph264pay config-interval=-1 '
                '! queue max-size-time=500000000 max-size-bytes=1048576 leaky=downstream ! wb.'.format(
                    src=src, w=width, h=height, fr=framerate, enc_segment=enc_segment))
        else:
            parts.append(
                '{src} {dev} ! videoconvert ! video/x-raw,format=I420,width={w},height={h},framerate={fr}/1 '
                '! {enc_segment} ! rtph264pay config-interval=-1 '
                '! queue max-size-time=500000000 max-size-bytes=1048576 leaky=downstream ! wb.'.format(
                    src=src, dev=dev, w=width, h=height, fr=framerate, enc_segment=enc_segment))
    if has_audio:
        if test_source:
            src = 'audiotestsrc'
            dev = ''
        else:
            src = 'alsasrc'
            dev = ('device=' + audio_device) if audio_device else ''
        # provide-clock=false: don't let the ALSA device's (drifting) clock be the
        # pipeline master. USB/PCI audio clocks tick off true wall-clock, which
        # makes RTP timestamps drift vs NTP and forces the receiver's jitter
        # buffer to grow monotonically -> ever-increasing mic-audio latency. Using
        # the system clock keeps RTP time stable so the receiver stops creeping.
        # The queue is bounded + leaky=downstream so transient Pi CPU/network
        # pressure drops a frame (brief stutter) instead of silently accumulating
        # delay.
        _audio_src = '{src} {dev} provide-clock=false'.format(src=src, dev=dev)
        if audio_channels > 0:
            parts.append(
                '{src} ! capsfilter caps=audio/x-raw,channels={ch} '
                '! audioconvert ! audioresample ! capsfilter caps=audio/x-raw,channels=1 '
                '! level ! opusenc ! rtpopuspay '
                '! queue max-size-time=500000000 max-size-bytes=1048576 leaky=downstream ! wb.'.format(
                    src=_audio_src, dev=dev, ch=audio_channels))
        else:
            parts.append(
                '{src} ! audioconvert ! audioresample ! capsfilter caps=audio/x-raw,channels=1 '
                '! level ! opusenc ! rtpopuspay '
                '! queue max-size-time=500000000 max-size-bytes=1048576 leaky=downstream ! wb.'.format(
                    src=_audio_src, dev=dev))
    return ' '.join(parts)


def _parse_mids(sdp_text):
    """Build mline_index→sdpMid mapping from an SDP string.

    GStreamer webrtcbin uses mids like ``video0``/``audio1`` (not bare
    ``"0"``/``"1"``).  Firefox 127+ enforces strict transceiver mid
    matching on addIceCandidate, so each candidate *must* carry the exact
    mid string from the SDP it belongs to.
    """
    mid_map = {}
    mline_idx = -1
    for line in sdp_text.splitlines():
        if line.startswith('m='):
            mline_idx += 1
        elif line.startswith('a=mid:') and mline_idx >= 0:
            mid_map[mline_idx] = line[6:]
    return mid_map


def broadcast_pipeline_str(stun=STUN):
    """Build the broadcast (recvonly) webrtcbin launch string (pure)."""
    return 'webrtcbin name=wb stun-server=' + stun


def audio_sink_str(speaker_device=None):
    # Precedence: explicit per-device config (speakerDevice) > AUDIO_SINK env >
    # SPEAKER_DEVICE env > default ALSA device. The default often resolves to
    # HDMI (no speakers) on a Pi, so letting the operator pick the analog/RCA
    # jack via config is what makes talkback audible.
    if speaker_device:
        return 'alsasink device=' + speaker_device
    if AUDIO_SINK:
        return AUDIO_SINK
    if SPEAKER_DEVICE:
        return 'alsasink device=' + SPEAKER_DEVICE
    return 'alsasink'


def _sdp_audio_dirs(sdp_text):
    """Return the m=audio lines and their direction (sendrecv/only) from an SDP."""
    out = []
    in_audio = False
    for line in sdp_text.splitlines():
        if line.startswith('m=audio'):
            in_audio = True
            out.append(line)
        elif line.startswith('m='):
            in_audio = False
        elif in_audio and line.startswith('a=') and any(
                d in line for d in ('sendrecv', 'sendonly', 'recvonly', 'inactive')):
            out.append(line)
    return out


def make_audio_recv_chain(pipeline, volume, mute, sink=None):
    """Build an RTP-Opus -> ALSA receive chain and add it to a running pipeline.

    Returns (bin, rxvol_element). The volume element is pre-set so the chain is
    safe to link before any samples arrive. `sink` overrides the ALSA device
    (e.g. a specific speaker output chosen in base-station settings).
    """
    chain = Gst.parse_bin_from_description(
        'queue ! rtpopusdepay ! opusdec ! audioconvert ! audioresample ! '
        'volume name=rxvol ! ' + (sink or audio_sink_str()), True)
    pipeline.add(chain)
    chain.set_state(Gst.State.PLAYING)
    log.info('audio recv chain built (sink=%s)', sink or audio_sink_str())
    rxvol = chain.get_by_name('rxvol')
    rxvol.set_property('volume', volume)
    rxvol.set_property('mute', mute)
    return chain, rxvol


def make_video_recv_chain(pipeline):
    """Receive base video (FaceTalk) and drop it — the Pi is headless (no display)."""
    chain = Gst.parse_bin_from_description(
        'queue ! rtph264depay ! avdec_h264 ! videoconvert ! fakesink', True)
    pipeline.add(chain)
    chain.set_state(Gst.State.PLAYING)
    return chain


def make_video_drop_chain(pipeline):
    """Drop an incoming video RTP pad WITHOUT decoding (headless audio monitor).

    Unlike make_video_recv_chain (which decodes for FaceTalk parity), this never
    instantiates avdec_h264 — the Pi audio-only listen-in monitor (plan 15) has
    no use for the frames, so we sink the raw RTP and save the decode CPU.
    """
    chain = Gst.parse_bin_from_description('queue ! fakesink async=false', True)
    pipeline.add(chain)
    chain.set_state(Gst.State.PLAYING)
    return chain


class MonitorSession:
    """Per-subscriber sendrecv session: publishes Pi media AND receives the
    base station's talkback audio on the same audio m-line."""

    def __init__(self, agent, subscriber_id):
        self.agent = agent
        self.subscriber_id = subscriber_id
        self.has_video = agent.has_video
        self.has_audio = agent.has_audio
        self.alert_armed = True
        self.last_level_ts = 0
        self.talkback_active = agent.talkback_active
        self._had_audio_while_playing = False  # track if we had audio in PLAYING state
        self._closing = False  # set during close() to prevent regression rebuilds on a dead session
        self.rxvol = None
        self.rxchain = None  # the audio receive bin, so we can rebuild it live
        self._audio_recv_pad = None  # webrtcbin recv pad feeding rxchain
        self._making_offer = False
        self._answering = False  # True while we are answering a renegotiation OFFER
        self._last_offer_ts = 0.0
        self._pipeline_gen = 0  # bumped by build(); stale offers from old gens are discarded
        self._mid_map = {}
        self._offer_timeout = None  # TimerHandle: clears _making_offer if no ANSWER arrives
        self.pipeline = None
        self.build()

    def build(self):
        # Tear down any existing pipeline first so two pipelines never race
        # for the same V4L2/ALSA device node.
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None
        # Reset closing/offer state so the rebuilt pipeline can negotiate
        # fresh.  Called from the regression handler after close().
        self._closing = False
        self._making_offer = False
        self._pipeline_gen += 1
        width, height = DIMS.get(self.agent.resolution, DIMS['720p'])
        cfg_video = self.agent.config.get('videoDevice') or VIDEO_DEVICE
        cfg_audio = self.agent.config.get('audioDevice') or AUDIO_DEVICE
        # VIDEO_ENCODER lets you force the H.264 encoder (e.g. x264enc on Pis
        # whose hardware v4l2h264enc misbehaves, or for headless test sources).
        env_enc = os.environ.get('VIDEO_ENCODER')
        if env_enc:
            enc = env_enc
        elif gst_element_exists('v4l2h264enc') and test_encoder('v4l2h264enc'):
            enc = 'v4l2h264enc'
        else:
            if gst_element_exists('v4l2h264enc'):
                log.warning('v4l2h264enc element exists but failed preroll test — '
                            'falling back to software x264enc')
            enc = 'x264enc'
        if enc == 'x264enc':
            log.warning('using software x264enc (higher RAM/CPU on Pi)')
        # Determine video source: libcamerasrc for Pi cameras, v4l2src for USB.
        use_libcamera = not TEST_SOURCE and should_use_libcamera(cfg_video)
        if use_libcamera:
            log.info('using libcamerasrc for Pi camera')
        # Clamp the framerate to one the camera actually supports for this
        # resolution.  Skip for libcamerasrc which handles negotiation internally.
        if use_libcamera:
            framerate = self.agent.framerate
        else:
            mode = best_supported_mode(cfg_video, width, height, self.agent.framerate)
            if mode is not None:
                w, h, fr = mode
                if w != width or h != height:
                    log.warning('camera %s does not support %s — using %dx%d',
                                cfg_video or 'default', self.agent.resolution, w, h)
                    width, height = w, h
                if fr != self.agent.framerate:
                    log.warning('camera %s does not support %dfps — using %dfps',
                                cfg_video or 'default', self.agent.framerate, fr)
                framerate = fr
            else:
                framerate = self.agent.framerate
        pipeline_str = monitor_pipeline_str(
            self.has_video, self.has_audio, width, height, framerate,
            cfg_video, cfg_audio, enc, STUN, TEST_SOURCE, use_libcamera,
            audio_channels=alsa_channels(cfg_audio) if self.has_audio else 0)
        log.info('monitor session %s pipeline: %s', self.subscriber_id, pipeline_str)
        self.pipeline_str = pipeline_str
        self.pipeline = Gst.parse_launch(pipeline_str)
        self.webrtc = self.pipeline.get_by_name('wb')
        self.webrtc.connect('on-negotiation-needed', self.on_negotiation_needed)
        self.webrtc.connect('on-ice-candidate', self.on_ice_candidate)
        self.webrtc.connect('pad-added', self.on_pad_added)
        # Do NOT call add-transceiver here.  Request pads (! wb.) linked by the
        # pipeline string correctly create transceivers in GStreamer ≥ 1.20.
        # Calling add-transceiver alongside request pads creates ghost
        # transceivers that steal the RTP routing — media encodes but never
        # reaches the browser.
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect('message', self.on_bus_message)
        self.pipeline.set_state(Gst.State.PLAYING)

    def on_pad_added(self, element, pad):
        # The recv (talkback) audio pad appears dynamically. (Video on the
        # monitor PC is sendonly, so no recv video pad is expected here.)
        caps = pad.get_current_caps()
        if not caps:
            log.warning('on_pad_added (monitor): pad %s has no caps yet — skipping', pad)
            return
        st = caps.get_structure(0)
        media = st.get_string('media')
        log.info('on_pad_added (monitor): media=%s enc=%s', media, st.get_string('encoding-name'))
        if media == 'audio' or 'OPUS' in (st.get_string('encoding-name') or ''):
            chain, self.rxvol = make_audio_recv_chain(
                self.pipeline, self.agent.speaker_volume(), self._initial_mute(),
                audio_sink_str(self.agent.config.get('speakerDevice')))
            self.rxchain = chain
            self._audio_recv_pad = pad
            try:
                pad.link(chain.get_static_pad('sink'))
            except Exception as e:
                log.warning('audio recv link failed: %s', e)
            self.apply_rx_volume()
        elif media == 'video':
            try:
                chain = make_video_recv_chain(self.pipeline)
                pad.link(chain.get_static_pad('sink'))
            except Exception as e:
                log.warning('video recv link failed: %s', e)

    def _initial_mute(self):
        # Muted until talkback is enabled or the base sets audioMode='base'.
        return not (self.agent.talkback_active or self.agent.config.get('audioMode') == 'base')

    def _parse_mids(self, sdp_text):
        # Thin wrapper so broadcast/listen-in sessions (which aren't subclasses)
        # can share the module-level _parse_mids helper, and so the unit tests
        # that bind MonitorSession._parse_mids still work.
        return _parse_mids(sdp_text)

    def set_talkback(self, active):
        self.talkback_active = active
        self.apply_rx_volume()

    def apply_rx_volume(self):
        if not self.rxvol:
            return
        self.rxvol.set_property('volume', self.agent.speaker_volume())
        allowed = self.agent.talkback_active or self.agent.config.get('audioMode') == 'base'
        self.rxvol.set_property('mute', not allowed)

    def rebuild_audio_sink(self):
        """Swap the speaker output device live (no WebRTC renegotiation).

        Tear down the existing RTP-Opus→ALSA receive bin and rebuild it against
        the newly-selected speaker device, relinking the same webrtcbin recv
        pad. Called when the operator changes `speakerDevice` in base-station
        settings. The video/send pipeline is untouched, so the monitor feed
        keeps playing while only the talkback/announcement output reroutes.
        """
        if not self.rxchain or not self._audio_recv_pad:
            # No receive chain yet (talkback pad hasn't appeared). The next
            # on_pad_added will pick up the new device automatically.
            return
        log.info('rebuilding audio sink for %s -> device %s',
                 self.subscriber_id, self.agent.config.get('speakerDevice') or 'default')
        try:
            sinkpad = self.rxchain.get_static_pad('sink')
            try:
                self._audio_recv_pad.unlink(sinkpad)
            except Exception:
                pass
            self.rxchain.set_state(Gst.State.NULL)
            self.pipeline.remove(self.rxchain)
        except Exception as e:
            log.warning('audio sink teardown failed: %s', e)
        chain, self.rxvol = make_audio_recv_chain(
            self.pipeline, self.agent.speaker_volume(), self._initial_mute(),
            audio_sink_str(self.agent.config.get('speakerDevice')))
        self.rxchain = chain
        try:
            self._audio_recv_pad.link(chain.get_static_pad('sink'))
        except Exception as e:
            log.warning('audio recv relink failed: %s', e)
        self.apply_rx_volume()

    def on_negotiation_needed(self, element):
        # set-local-description re-triggers on-negotiation-needed, which would
        # otherwise create a fresh OFFER every time and loop forever (the base
        # briefly connects then gets reset into pc:new). Guard so only one
        # in-flight offer exists per session; cleared once the answer lands.
        # Also debounce: set-remote-description triggers on-negotiation-needed
        # after _making_offer is cleared, causing a feedback loop of rapid
        # OFFERs. Require a minimum gap between offers.
        if self._closing:
            log.debug('on-negotiation-needed ignored — session %s is closing',
                      self.subscriber_id)
            return
        if self._answering:
            # We are answering a renegotiation OFFER from the base station
            # (e.g. it added a talkback track). Don't fire a competing OFFER
            # back — that causes glare and the talkback audio never connects.
            log.debug('on-negotiation-needed ignored — answering re-offer for %s',
                      self.subscriber_id)
            return
        now = time.time()
        log.info('on-negotiation-needed fired for session %s (making_offer=%s dt=%.1f)',
                 self.subscriber_id, self._making_offer, now - self._last_offer_ts)
        if self._making_offer:
            return
        if now - self._last_offer_ts < 2.0:
            log.debug('on-negotiation-needed debounced for %s', self.subscriber_id)
            return
        self._making_offer = True
        self._last_offer_ts = now
        gen = self._pipeline_gen
        promise = Gst.Promise.new_with_change_func(lambda p: self.on_offer_created(p, gen))
        element.emit('create-offer', None, promise)

    def on_offer_created(self, promise, gen=None):
        try:
            log.info('on_offer_created called for %s (closing=%s gen=%s/%s)',
                     self.subscriber_id, self._closing, gen, self._pipeline_gen)
            promise.wait()
            if gen is not None and gen != self._pipeline_gen:
                log.debug('on_offer_created: pipeline gen mismatch (%s != %s) — '
                          'discarding stale offer for %s',
                          gen, self._pipeline_gen, self.subscriber_id)
                self._making_offer = False
                return
            if self._closing:
                log.debug('on_offer_created: session %s closed while offer '
                          'was being created — discarding stale offer',
                          self.subscriber_id)
                self._making_offer = False
                return
            reply = promise.get_reply()
            if reply is None:
                log.error('on_offer_created: reply is None for %s', self.subscriber_id)
                return
            offer = reply.get_value('offer')
            if offer is None:
                log.error('on_offer_created: offer is None for %s', self.subscriber_id)
                return
            promise2 = Gst.Promise.new_with_change_func(self.on_local_description_set)
            self.webrtc.emit('set-local-description', offer, promise2)
            text = offer.sdp.as_text()
            self._mid_map = _parse_mids(text)
            # Log the number of m= lines to verify video+audio are in the offer
            m_lines = [l for l in text.splitlines() if l.startswith('m=')]
            m_types = []
            for l in m_lines:
                parts = l.split()
                media = parts[0].split('=', 1)[1]  # e.g. "video" from "m=video"
                m_types.append(media)
            log.info('OFFER SDP for %s: %d m-lines (%s)',
                     self.subscriber_id, len(m_lines),
                     ', '.join(m_types))
            for line in text.splitlines():
                if line.startswith(('m=', 'a=mid:', 'a=rtpmap:', 'a=send')):
                    log.info('OFFER SDP line: %s', line)
            self.agent.enqueue_ws({'type': 'OFFER', 'payload': {
                'to': self.subscriber_id, 'sdp': {'type': 'offer', 'sdp': text}}})
            log.info('OFFER sent for %s', self.subscriber_id)
            if self.agent.loop:
                if self._offer_timeout:
                    self._offer_timeout.cancel()
                self._offer_timeout = self.agent.loop.call_later(
                    10, self._offer_timeout_fired)
        except Exception as e:
            log.error('on_offer_created FAILED for %s: %s', self.subscriber_id, e)
            self._making_offer = False

    def on_local_description_set(self, promise):
        promise.wait()

    def _offer_timeout_fired(self):
        self._offer_timeout = None
        if self._making_offer and not self._closing:
            log.warning('no ANSWER received within 10s for %s — clearing _making_offer',
                        self.subscriber_id)
            self._making_offer = False

    def on_ice_candidate(self, element, mline_index, candidate):
        # GStreamer >= 1.20 emits (element, mline_index:int, candidate:str).
        # Older bindings passed a WebRTCICECandidate object instead; handle both.
        # Firefox requires sdpMid to match the SDP's a=mid (e.g. "video0",
        # "audio1") or addIceCandidate fails; Chrome/iOS tolerate null/mismatch.
        if isinstance(candidate, str):
            cand_str = candidate
            mid = self._mid_map.get(mline_index)
        else:
            cand_str = candidate.candidate
            mline_index = candidate.sdpMLineIndex
            mid = candidate.sdpMid
        self.agent.enqueue_ws({'type': 'ICE_CANDIDATE', 'payload': {
            'to': self.subscriber_id,
            'candidate': cand_str,
            'sdpMLineIndex': mline_index,
            'sdpMid': mid,
        }})

    def on_bus_message(self, bus, message):
        if message.type == Gst.MessageType.ERROR:
            # Ignore errors from a previous (now-stalled) pipeline.  Without
            # this guard a stale "Device busy" on the old pipeline would tear
            # down the freshly-built replacement session.
            if message.src != self.pipeline:
                return True
            err, debug = message.parse_error()
            log.error('GStreamer ERROR: %s\n%s', err.message, debug or '')
            # Audio device busy: previous pipeline still holds it.  Tear down
            # and rebuild video-only so the base station gets *something*.
            # Only match audio-related busy errors — a video device busy error
            # (e.g. '/dev/video0 is busy') must NOT trigger this path.
            msg_lower = (err.message or '').lower()
            is_audio_busy = ('alsasrc' in msg_lower or 'audio' in msg_lower) and 'busy' in msg_lower
            if is_audio_busy:
                if self.has_audio:
                    log.warning('audio device busy — rebuilding pipeline video-only')
                    self.has_audio = False
                    self.close()
                    self.build()
                    return True
            # Video device busy: v4l2src failed to open the camera.  Tear down
            # the session so the base station can reconnect fresh (the camera may
            # have been temporarily unavailable).
            is_video_busy = 'v4l2src' in msg_lower or '/dev/video' in msg_lower
            if is_video_busy and 'busy' in msg_lower:
                log.warning('video device busy — tearing down session for fresh reconnect')
                self.close()
                self.agent.sessions.pop(self.subscriber_id, None)
                return True
            # Fatal: tear down session so the base station can reconnect fresh.
            self.close()
            self.agent.sessions.pop(self.subscriber_id, None)
        elif message.type == Gst.MessageType.WARNING:
            err, debug = message.parse_warning()
            log.warning('GStreamer WARN: %s', err.message)
        elif message.type == Gst.MessageType.EOS:
            if message.src != self.pipeline:
                return True
            log.info('GStreamer EOS on session %s', self.subscriber_id)
            self.close()
            self.agent.sessions.pop(self.subscriber_id, None)
        elif message.type == Gst.MessageType.STATE_CHANGED:
            old, new, pending = message.parse_state_changed()
            if message.src == self.pipeline:
                log.info('pipeline %s state: %s -> %s', self.subscriber_id,
                         old.value_nick, new.value_nick)
                # Reset flag when leaving PLAYING (before any regression checks).
                if old == Gst.State.PLAYING:
                    self._had_audio_while_playing = False
                # Track when we enter PLAYING with audio so we can detect
                # subsequent regression through PAUSED → READY.
                if new == Gst.State.PLAYING and self.has_audio:
                    self._had_audio_while_playing = True
                # If the pipeline regresses from PLAYING to PAUSED (audio
                # preroll failure without a bus ERROR), rebuild video-only.
                if old == Gst.State.PLAYING and new == Gst.State.PAUSED and self.has_audio:
                    if self._closing:
                        log.debug('pipeline regressed during close — skipping rebuild')
                        return True
                    log.warning('pipeline regressed from PLAYING — audio preroll failed, '
                                'rebuilding video-only')
                    self.has_audio = False
                    self._had_audio_while_playing = False
                    self.close()
                    self.build()
                    return True
                # If the pipeline reaches READY after we were in PLAYING with
                # audio, that means the audio source died (preroll timeout,
                # device removed, etc.) without an explicit bus ERROR.
                if old == Gst.State.PAUSED and new == Gst.State.READY and self._had_audio_while_playing:
                    if self._closing:
                        log.debug('pipeline regressed during close — skipping rebuild')
                        return True
                    log.warning('pipeline regressed from PLAYING→PAUSED→READY — audio source lost, '
                                'rebuilding video-only')
                    self.has_audio = False
                    self._had_audio_while_playing = False
                    self.close()
                    self.build()
                    return True
        elif message.type == Gst.MessageType.ELEMENT:
            struct = message.get_structure()
            if struct and struct.get_name() == 'level':
                rms = struct.get_value('rms')
                if rms and len(rms) > 0:
                    db = float(rms[0])
                    self.agent.on_audio_level(self, db)
        return True

    def set_remote_answer(self, sdp_text):
        # GStreamer >= 1.20 returns (SDPResult, message) from SDPMessage.new().
        log.info('RX ANSWER audio-dir: %s', _sdp_audio_dirs(sdp_text))
        _ret, sdp = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(sdp_text.encode(), sdp)
        answer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.ANSWER, sdp)
        promise = Gst.Promise.new_with_change_func(self.on_remote_set)
        self.webrtc.emit('set-remote-description', answer, promise)
        self._making_offer = False
        if self._offer_timeout:
            self._offer_timeout.cancel()
            self._offer_timeout = None

    def set_remote_offer(self, sdp_text):
        """Answer a renegotiation OFFER from the base station (e.g. it added a
        talkback audio track).

        The monitor PC is normally the offerer, but the browser answerer can
        re-offer when it adds/removes a track. If we silently ignore that OFFER
        (as the old code did), the new m-line is never negotiated and the
        talkback audio never reaches the Pi's speaker.
        """
        if self._closing:
            return
        # Ignore renegotiation offers arriving while the pipeline is still building
        # (state < PLAYING) — webrtcbin's create-answer returns None in that window,
        # which logged "answer is None" and left the session wedged. The base
        # station re-answers on its own recovery loop, so skipping here is safe.
        if self.pipeline is None:
            log.warning('RX RENEG-OFFER but pipeline not ready for %s — ignoring',
                        self.subscriber_id)
            return
        try:
            _ret, state, _pending = self.pipeline.get_state(0)
        except Exception:
            state = None
        if state != Gst.State.PLAYING:
            log.warning('RX RENEG-OFFER but pipeline not PLAYING (%s) for %s — ignoring',
                        getattr(state, 'value_nick', state), self.subscriber_id)
            return
        log.info('RX RENEG-OFFER audio-dir: %s', _sdp_audio_dirs(sdp_text))
        _ret, sdp = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(sdp_text.encode(), sdp)
        offer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, sdp)
        self._mid_map = _parse_mids(sdp_text)
        log.info('monitor session %s answering renegotiation OFFER', self.subscriber_id)
        self._answering = True
        promise = Gst.Promise.new_with_change_func(self.on_remote_offer_set)
        self.webrtc.emit('set-remote-description', offer, promise)

    def on_remote_offer_set(self, promise):
        promise.wait()
        try:
            apromise = Gst.Promise.new_with_change_func(self.on_answer_created)
            self.webrtc.emit('create-answer', None, apromise)
        except Exception as e:
            log.warning('monitor session %s create-answer emit failed: %s',
                        self.subscriber_id, e)
            self._answering = False

    def on_answer_created(self, promise):
        try:
            promise.wait()
            reply = promise.get_reply()
            answer = reply.get_value('answer')
            if answer is None:
                log.error('monitor session %s answer is None', self.subscriber_id)
                self._answering = False
                return
            promise2 = Gst.Promise.new_with_change_func(self.on_local_description_set)
            self.webrtc.emit('set-local-description', answer, promise2)
            text = answer.sdp.as_text()
            self.agent.enqueue_ws({'type': 'ANSWER', 'payload': {
                'to': self.subscriber_id, 'sdp': {'type': 'answer', 'sdp': text}}})
            log.info('monitor session %s ANSWER sent for renegotiation', self.subscriber_id)
        finally:
            self._answering = False

    def add_ice(self, cand, mline, mid):
        # Browsers send the candidate as a JSON dict (RTCPeerConnection
        # .toJSON()); GStreamer's add-ice-candidate expects the raw SDP
        # candidate string ("candidate:..."). Extract it, and pull the mline
        # from the dict when the top-level field is missing. Passing the dict
        # straight through made the agent silently drop every inbound candidate
        # and left ICE stuck at checking/connecting.
        if isinstance(cand, dict):
            cand_str = cand.get('candidate') or ''
            if mline is None:
                mline = cand.get('sdpMLineIndex')
            if mid is None:
                mid = cand.get('sdpMid')
        else:
            cand_str = cand
        if not cand_str:
            return
        if mline is None:
            mline = 0
        self.webrtc.emit('add-ice-candidate', mline, cand_str)

    def on_remote_set(self, promise):
        promise.wait()
        try:
            apromise = Gst.Promise.new_with_change_func(self.on_answer_created)
            self.webrtc.emit('create-answer', None, apromise)
        except Exception as e:
            log.warning('create-answer emit failed: %s', e)

    def close(self):
        if self.pipeline:
            self._closing = True
            if self._offer_timeout:
                self._offer_timeout.cancel()
                self._offer_timeout = None
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None
            # Non-blocking: do NOT wait for the device to release here.
            # The GLib main loop thread drives the state change asynchronously.
            # Blocking would freeze the asyncio event loop (preventing
            # SUBSCRIBER_JOINED from being processed) and fuser -k would kill
            # our own process since *we* are the device holder.
            # If the device is still busy when the next pipeline opens, the
            # GStreamer bus ERROR handler ("Device busy") will tear it down
            # and trigger a clean rebuild.


class BroadcastSession:
    """Recvonly session for a base-station broadcast (FaceTalk / announcement).

    The base is the offerer; the Pi answers. Audio (always played) and video
    (dropped to fakesink, headless) are wired up dynamically as their RTP pads
    appear, so both audio-only announcements and video+audio FaceTalk work.
    """

    def __init__(self, agent, publisher_id):
        self.agent = agent
        self.publisher_id = publisher_id
        self.rxvol = None
        self.rxchain = None
        self._audio_recv_pad = None
        self._remote_set = False
        self._mid_map = {}
        self.build()

    def build(self):
        log.info('broadcast session from %s', self.publisher_id)
        # Build the webrtcbin element programmatically rather than via
        # parse_launch: a single unlinked element string ("webrtcbin name=wb
        # stun-server=...") parses but get_by_name('wb') then returns None
        # (GStreamer parse quirk), which made every .connect() below crash with
        # 'NoneType' has no attribute 'connect' and the broadcast answer was
        # never produced.
        self.pipeline = Gst.Pipeline.new('broadcast-%s' % self.publisher_id)
        self.webrtc = Gst.ElementFactory.make('webrtcbin', 'wb')
        if self.webrtc is None:
            log.error('broadcast: webrtcbin element unavailable')
            return
        if STUN:
            self.webrtc.set_property('stun-server', STUN)
        self.pipeline.add(self.webrtc)
        self.webrtc.connect('on-negotiation-needed', self.on_negotiation_needed)
        self.webrtc.connect('on-ice-candidate', self.on_ice_candidate)
        self.webrtc.connect('pad-added', self.on_pad_added)
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect('message', self.on_bus_message)
        self.pipeline.set_state(Gst.State.PLAYING)

    def on_pad_added(self, element, pad):
        caps = pad.get_current_caps()
        if not caps:
            log.warning('on_pad_added (broadcast): pad %s has no caps yet — skipping', pad)
            return
        st = caps.get_structure(0)
        media = st.get_string('media')
        log.info('on_pad_added (broadcast): media=%s enc=%s', media, st.get_string('encoding-name'))
        try:
            if media == 'audio' or 'OPUS' in (st.get_string('encoding-name') or ''):
                chain, self.rxvol = make_audio_recv_chain(
                    self.pipeline, self.agent.speaker_volume(), False,
                    audio_sink_str(self.agent.config.get('speakerDevice')))
                self.rxchain = chain
                self._audio_recv_pad = pad
                pad.link(chain.get_static_pad('sink'))
            elif media == 'video':
                chain = make_video_recv_chain(self.pipeline)
                pad.link(chain.get_static_pad('sink'))
        except Exception as e:
            log.warning('broadcast recv link failed: %s', e)

    def rebuild_audio_sink(self):
        """Swap the speaker output device live for this broadcast session."""
        if not self.rxchain or not self._audio_recv_pad:
            return
        log.info('rebuilding broadcast audio sink -> device %s',
                 self.agent.config.get('speakerDevice') or 'default')
        try:
            sinkpad = self.rxchain.get_static_pad('sink')
            try:
                self._audio_recv_pad.unlink(sinkpad)
            except Exception:
                pass
            self.rxchain.set_state(Gst.State.NULL)
            self.pipeline.remove(self.rxchain)
        except Exception as e:
            log.warning('broadcast audio sink teardown failed: %s', e)
        chain, self.rxvol = make_audio_recv_chain(
            self.pipeline, self.agent.speaker_volume(), False,
            audio_sink_str(self.agent.config.get('speakerDevice')))
        self.rxchain = chain
        try:
            self._audio_recv_pad.link(chain.get_static_pad('sink'))
        except Exception as e:
            log.warning('broadcast audio recv relink failed: %s', e)

    def on_remote_set(self, promise):
        # Answerer: just satisfy the set-remote-description change func. The
        # answer is generated by on_negotiation_needed (fired once the remote
        # offer is applied). Without this method, set_remote_offer references a
        # non-existent callback and the broadcast answer is never produced.
        promise.wait()
        log.info('broadcast on_remote_set fired (answerer)')

    def on_negotiation_needed(self, element):
        # We are the answerer: only create an answer once the remote offer is set.
        if not self._remote_set:
            return
        log.info('broadcast on_negotiation_needed — creating answer')
        # 'create-answer' takes a different signature than 'create-offer' in
        # some GStreamer versions, so guard both call styles.
        try:
            promise = Gst.Promise.new_with_change_func(self.on_answer_created)
            element.emit('create-answer', None, promise)
        except Exception as e:
            log.warning('create-answer emit failed: %s', e)

    def on_answer_created(self, promise):
        promise.wait()
        reply = promise.get_reply()
        answer = reply.get_value('answer')
        promise2 = Gst.Promise.new_with_change_func(self.on_local_description_set)
        self.webrtc.emit('set-local-description', answer, promise2)
        text = answer.sdp.as_text()
        self.agent.enqueue_ws({'type': 'ANSWER', 'payload': {
            'to': self.publisher_id, 'sdp': {'type': 'answer', 'sdp': text},
            'isBroadcast': True}})

    def on_local_description_set(self, promise):
        promise.wait()

    def on_ice_candidate(self, element, mline_index, candidate):
        # GStreamer >= 1.20 emits (element, mline_index:int, candidate:str).
        # Older bindings passed a WebRTCICECandidate object instead; handle both.
        if isinstance(candidate, str):
            cand_str = candidate
            mid = self._mid_map.get(mline_index)
        else:
            cand_str = candidate.candidate
            mline_index = candidate.sdpMLineIndex
            mid = candidate.sdpMid
        self.agent.enqueue_ws({'type': 'ICE_CANDIDATE', 'payload': {
            'to': self.publisher_id,
            'candidate': cand_str,
            'sdpMLineIndex': mline_index,
            'sdpMid': mid,
            'isBroadcast': True,
        }})

    def on_bus_message(self, bus, message):
        # No audio-level alerts on the receive side.
        return True

    def set_remote_offer(self, sdp_text):
        _ret, sdp = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(sdp_text.encode(), sdp)
        offer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, sdp)
        self._mid_map = _parse_mids(sdp_text)
        self._remote_set = True
        promise = Gst.Promise.new_with_change_func(self.on_remote_set)
        self.webrtc.emit('set-remote-description', offer, promise)

    def add_ice(self, cand, mline, mid):
        # Browsers send the candidate as a JSON dict (RTCPeerConnection
        # .toJSON()); GStreamer's add-ice-candidate expects the raw SDP
        # candidate string ("candidate:..."). Extract it, and pull the mline
        # from the dict when the top-level field is missing. Passing the dict
        # straight through made the agent silently drop every inbound candidate
        # and left ICE stuck at checking/connecting.
        if isinstance(cand, dict):
            cand_str = cand.get('candidate') or ''
            if mline is None:
                mline = cand.get('sdpMLineIndex')
            if mid is None:
                mid = cand.get('sdpMid')
        else:
            cand_str = cand
        if not cand_str:
            return
        if mline is None:
            mline = 0
        self.webrtc.emit('add-ice-candidate', mline, cand_str)

    def on_remote_set(self, promise):
        promise.wait()
        try:
            apromise = Gst.Promise.new_with_change_func(self.on_answer_created)
            self.webrtc.emit('create-answer', None, apromise)
        except Exception as e:
            log.warning('create-answer emit failed: %s', e)

    def close(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None


class AudioMonitorSession:
    """Recvonly *audio-only* listen-in on another room source (plan 15).

    The Pi subscribes (SUBSCRIBE_SOURCE) to a normal camera/mic source and plays
    its audio through the local ALSA sink. The publisher is the offerer (same as
    a browser subscriber), so the Pi answers. Because the Pi is headless, any
    offered video m-line is accepted but its RTP is dropped WITHOUT decoding
    (make_video_drop_chain) — only the audio is decoded and played.
    """

    def __init__(self, agent, publisher_id):
        self.agent = agent
        self.publisher_id = publisher_id
        self.rxvol = None
        self.rxchain = None
        self._audio_recv_pad = None
        self._remote_set = False
        self._mid_map = {}
        self.build()

    def _volume(self):
        v = self.agent.config.get('audioMonitorVolume')
        if v is None:
            return self.agent.speaker_volume()
        try:
            return max(0.0, min(1.0, float(v)))
        except (TypeError, ValueError):
            return self.agent.speaker_volume()

    def build(self):
        log.info('audio-monitor session listening to %s', self.publisher_id)
        # Same get_by_name('wb') parse quirk as BroadcastSession — build the
        # webrtcbin element programmatically so the recv pipeline is usable.
        self.pipeline = Gst.Pipeline.new('audio-monitor-%s' % self.publisher_id)
        self.webrtc = Gst.ElementFactory.make('webrtcbin', 'wb')
        if self.webrtc is None:
            log.error('audio-monitor: webrtcbin element unavailable')
            return
        if STUN:
            self.webrtc.set_property('stun-server', STUN)
        self.pipeline.add(self.webrtc)
        self.webrtc.connect('on-negotiation-needed', self.on_negotiation_needed)
        self.webrtc.connect('on-ice-candidate', self.on_ice_candidate)
        self.webrtc.connect('pad-added', self.on_pad_added)
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect('message', self.on_bus_message)
        self.pipeline.set_state(Gst.State.PLAYING)

    def on_pad_added(self, element, pad):
        caps = pad.get_current_caps()
        if not caps:
            return
        st = caps.get_structure(0)
        media = st.get_string('media')
        try:
            if media == 'audio' or 'OPUS' in (st.get_string('encoding-name') or ''):
                chain, self.rxvol = make_audio_recv_chain(
                    self.pipeline, self._volume(), False,
                    audio_sink_str(self.agent.config.get('speakerDevice')))
                self.rxchain = chain
                self._audio_recv_pad = pad
                pad.link(chain.get_static_pad('sink'))
            elif media == 'video':
                # Headless: drop video without decoding — audio only.
                chain = make_video_drop_chain(self.pipeline)
                pad.link(chain.get_static_pad('sink'))
        except Exception as e:
            log.warning('audio-monitor recv link failed: %s', e)

    def rebuild_audio_sink(self):
        """Swap the speaker output device live for this listen-in session."""
        if not self.rxchain or not self._audio_recv_pad:
            return
        log.info('rebuilding audio-monitor sink -> device %s',
                 self.agent.config.get('speakerDevice') or 'default')
        try:
            sinkpad = self.rxchain.get_static_pad('sink')
            try:
                self._audio_recv_pad.unlink(sinkpad)
            except Exception:
                pass
            self.rxchain.set_state(Gst.State.NULL)
            self.pipeline.remove(self.rxchain)
        except Exception as e:
            log.warning('audio-monitor sink teardown failed: %s', e)
        chain, self.rxvol = make_audio_recv_chain(
            self.pipeline, self._volume(), False,
            audio_sink_str(self.agent.config.get('speakerDevice')))
        self.rxchain = chain
        try:
            self._audio_recv_pad.link(chain.get_static_pad('sink'))
        except Exception as e:
            log.warning('audio-monitor recv relink failed: %s', e)

    def on_negotiation_needed(self, element):
        if not self._remote_set:
            return
        try:
            promise = Gst.Promise.new_with_change_func(self.on_answer_created)
            element.emit('create-answer', None, promise)
        except Exception as e:
            log.warning('audio-monitor create-answer emit failed: %s', e)

    def on_answer_created(self, promise):
        promise.wait()
        reply = promise.get_reply()
        answer = reply.get_value('answer')
        promise2 = Gst.Promise.new_with_change_func(self.on_local_description_set)
        self.webrtc.emit('set-local-description', answer, promise2)
        text = answer.sdp.as_text()
        self.agent.enqueue_ws({'type': 'ANSWER', 'payload': {
            'to': self.publisher_id, 'sdp': {'type': 'answer', 'sdp': text}}})

    def on_local_description_set(self, promise):
        promise.wait()

    def on_ice_candidate(self, element, mline_index, candidate):
        # GStreamer >= 1.20 emits (element, mline_index:int, candidate:str).
        # Older bindings passed a WebRTCICECandidate object instead; handle both.
        if isinstance(candidate, str):
            cand_str = candidate
            mid = self._mid_map.get(mline_index)
        else:
            cand_str = candidate.candidate
            mline_index = candidate.sdpMLineIndex
            mid = candidate.sdpMid
        self.agent.enqueue_ws({'type': 'ICE_CANDIDATE', 'payload': {
            'to': self.publisher_id,
            'candidate': cand_str,
            'sdpMLineIndex': mline_index,
            'sdpMid': mid,
        }})

    def on_bus_message(self, bus, message):
        return True

    def set_remote_offer(self, sdp_text):
        _ret, sdp = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(sdp_text.encode(), sdp)
        offer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, sdp)
        self._mid_map = _parse_mids(sdp_text)
        self._remote_set = True
        promise = Gst.Promise.new_with_change_func(self.on_remote_set)
        self.webrtc.emit('set-remote-description', offer, promise)

    def add_ice(self, cand, mline, mid):
        if isinstance(cand, dict):
            cand_str = cand.get('candidate') or ''
            if mline is None:
                mline = cand.get('sdpMLineIndex')
            if mid is None:
                mid = cand.get('sdpMid')
        else:
            cand_str = cand
        if not cand_str:
            return
        if mline is None:
            mline = 0
        self.webrtc.emit('add-ice-candidate', mline, cand_str)

    def on_remote_set(self, promise):
        promise.wait()

    def apply_volume(self):
        if self.rxvol:
            self.rxvol.set_property('volume', self._volume())

    def close(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None


class Agent:
    def __init__(self):
        # Stable device id: persist across restarts so the base station doesn't
        # accumulate duplicate "Pi Agent" entries (a fresh random id every launch
        # would show as a new device on each restart / page refresh).
        import os as _os
        id_dir = _os.path.dirname(CONFIG_FILE) or '.'
        self.device_id_file = _os.path.join(id_dir, 'device_id')
        self.device_id = self._load_device_id()
        self.device_label = self._load_device_label()
        self.config = self._load_persisted_config()
        self.ws = None
        self.has_video = False
        self.has_audio = False
        self.config = {}
        self.video_devices = []
        self.audio_devices = []
        self.sessions = {}          # subscriberId -> MonitorSession (sendrecv, talkback)
        # Linger bookkeeping: subscriberId -> asyncio timer handle / ts, so a
        # session kept alive after SUBSCRIBER_LEFT can be torn down after the
        # grace or cancelled when the subscriber re-subscribes.
        self._stale_timers = {}
        self._stale_since = {}
        self.broadcast_sessions = {}  # publisherId -> BroadcastSession (recvonly)
        self.broadcast_sources = {}   # publisherId -> source dict from SOURCE_ADDED
        self.room_sources = {}        # sourceId -> source dict (all non-broadcast sources seen)
        self.audio_monitor_sessions = {}  # publisherId -> AudioMonitorSession (recvonly audio)
        self.audio_monitor_pub = None  # publisherId we're currently subscribed to (listen-in)
        self.ws_queue = asyncio.Queue()
        self.loop = None
        self.reconnect_delay = 1
        self.talkback_active = False
        self.resolution = DEFAULT_RESOLUTION
        self.framerate = DEFAULT_FRAMERATE
        self._last_published_type = None
        self._last_video_device = VIDEO_DEVICE
        self._last_audio_device = AUDIO_DEVICE
        self._last_resolution = DEFAULT_RESOLUTION
        self._last_framerate = DEFAULT_FRAMERATE
        self._consecutive_failures = 0
        self._audio_peak_suppressed = False  # set True on first UNKNOWN_TYPE from server
        self._mdns_attempted = False  # only try mDNS once per startup unless re-triggered
        self._label_persisted = False  # persist device_label on first WELCOME
        self._label_changed = False    # base station renamed the device

    def _load_device_id(self):
        """Return a stable per-install device id.

        Precedence:
          1. explicit DEVICE_ID env var (set via the systemd EnvironmentFile)
          2. DEVICE_ID persisted inside config.env (CONFIG_FILE)
          3. legacy device_id file next to config.env (older installs)
          4. generate 'pi-<rand>' and persist to BOTH config.env and the
             legacy file so every restart reports the SAME id to the server.

        A stable id is what keeps the server from accumulating duplicate
        "Pi Agent" entries and from orphaning subscriptions on reconnect: the
        server keys a device's sources/subscriptions by this id, so a fresh
        random id every launch looks like a brand-new device.
        """
        env_id = os.environ.get('DEVICE_ID', '').strip()
        if env_id:
            return env_id
        cfg_id = _read_env_value('DEVICE_ID')
        if cfg_id:
            return cfg_id
        # Legacy: a device_id file next to config.env (older installs).
        try:
            import os as _os
            if _os.path.exists(self.device_id_file):
                with open(self.device_id_file) as f:
                    existing = f.read().strip()
                if existing:
                    self._persist_device_id(existing)  # migrate into config.env
                    return existing
        except Exception:
            pass
        new_id = 'pi-' + rand_id()
        self._persist_device_id(new_id)
        return new_id

    def _persist_device_id(self, device_id):
        """Persist device_id to the legacy file and to config.env (DEVICE_ID=)."""
        try:
            import os as _os
            _os.makedirs(_os.path.dirname(self.device_id_file) or '.', exist_ok=True)
            with open(self.device_id_file, 'w') as f:
                f.write(device_id)
        except Exception as e:
            log.warning('could not persist device id file: %s', e)
        try:
            lines = []
            if os.path.exists(CONFIG_FILE):
                with open(CONFIG_FILE) as f:
                    lines = f.read().splitlines()
            out = []
            replaced = False
            for line in lines:
                key = line.split('=', 1)[0].strip() if '=' in line else ''
                if key == 'DEVICE_ID':
                    out.append('DEVICE_ID=' + device_id)
                    replaced = True
                    continue
                out.append(line)
            if not replaced:
                out.append('DEVICE_ID=' + device_id)
            os.makedirs(os.path.dirname(CONFIG_FILE) or '.', exist_ok=True)
            with open(CONFIG_FILE, 'w') as f:
                f.write('\n'.join(out) + '\n')
            log.info('persisted DEVICE_ID=%s to %s', device_id, CONFIG_FILE)
        except Exception as e:
            log.warning('could not persist DEVICE_ID to %s: %s', CONFIG_FILE, e)

    def _load_device_label(self):
        """Return the device label: env var > persisted file > hostname."""
        env_label = os.environ.get('DEVICE_LABEL', '').strip()
        if env_label:
            return env_label
        label_file = os.path.join(os.path.dirname(self.device_id_file) or '.', 'device_label')
        try:
            if os.path.exists(label_file):
                with open(label_file) as f:
                    existing = f.read().strip()
                # Ignore a stale cached "Pi Agent" (the old shipped default) so a
                # blank DEVICE_LABEL correctly falls through to the hostname.
                if existing and existing.lower() != 'pi agent':
                    return existing
        except Exception:
            pass
        return socket.gethostname()

    def _persist_device_label(self, label):
        """Write the device label so it survives reinstalls."""
        label_file = os.path.join(os.path.dirname(self.device_id_file) or '.', 'device_label')
        try:
            os.makedirs(os.path.dirname(label_file) or '.', exist_ok=True)
            with open(label_file, 'w') as f:
                f.write(label)
            log.info('persisted device label=%s to %s', label, label_file)
        except Exception as e:
            log.warning('could not persist device label: %s', e)

    def _load_persisted_config(self):
        """Load previously-persisted operator config (e.g. speakerDevice) so
        settings survive agent restarts. Returns a dict (possibly empty)."""
        try:
            if os.path.exists(CONFIG_PERSIST_FILE):
                with open(CONFIG_PERSIST_FILE) as f:
                    return json.load(f)
        except Exception as e:
            log.warning('could not load persisted config: %s', e)
        return {}

    def _persist_config(self):
        """Persist the current operator config to disk."""
        try:
            d = os.path.dirname(CONFIG_PERSIST_FILE) or '.'
            os.makedirs(d, exist_ok=True)
            with open(CONFIG_PERSIST_FILE, 'w') as f:
                json.dump(self.config, f)
            log.info('persisted config to %s: %s', CONFIG_PERSIST_FILE, self.config)
        except Exception as e:
            log.warning('could not persist config: %s', e)

    async def _discover_server_via_mdns(self):
        """Query mDNS for a Hearth-Connect server. Updates WS_URL on success.

        Runs even when SERVER_URL is already configured — if the configured
        server is unreachable (wrong IP after a network change, etc.), mDNS
        discovery finds the real one on the LAN and overrides WS_URL so the
        agent can still connect once it has internet.
        """
        global WS_URL
        try:
            from mdns_discover import discover_server
            log.info('mDNS: searching for Hearth-Connect server on LAN...')
            url = await discover_server(timeout=5.0)
            if url:
                WS_URL = url.rstrip('/')
                if not WS_URL.startswith('ws'):
                    WS_URL = 'wss://' + WS_URL
                log.info('mDNS: found server at %s', WS_URL)
                self._persist_server_url(WS_URL)
            else:
                log.warning('mDNS: no server found — will retry in %ds', self.reconnect_delay)
        except ImportError:
            log.warning('zeroconf not installed — mDNS discovery unavailable')
        except Exception as e:
            log.warning('mDNS discovery error: %s', e)

    def _persist_server_url(self, url):
        """Write the discovered SERVER_URL back to config.env so it survives restarts."""
        try:
            lines = []
            if os.path.exists(CONFIG_FILE):
                with open(CONFIG_FILE) as f:
                    lines = f.read().splitlines()
            out = []
            found = False
            for line in lines:
                key = line.split('=', 1)[0].strip() if '=' in line else ''
                if key == 'SERVER_URL':
                    found = True
                    continue  # drop old value; re-emit below
                out.append(line)
            out.insert(0, 'SERVER_URL=' + url)
            os.makedirs(os.path.dirname(CONFIG_FILE) or '.', exist_ok=True)
            with open(CONFIG_FILE, 'w') as f:
                f.write('\n'.join(out) + '\n')
            log.info('persisted SERVER_URL=%s to %s', url, CONFIG_FILE)
        except Exception as e:
            log.warning('failed to persist SERVER_URL to %s: %s', CONFIG_FILE, e)

    def enqueue_ws(self, msg):
        if self.loop:
            self.loop.call_soon_threadsafe(self.ws_queue.put_nowait, msg)
        else:
            asyncio.ensure_future(self.ws_queue.put(msg))

    def _ws_connected(self):
        ws = self.ws
        if not ws:
            return False
        # Connection-state attribute varies across websockets versions:
        #   >= 11: ws.state is an int enum (OPEN == 1); .open/.closed removed
        #   < 11:  ws.open / ws.closed booleans
        state = getattr(ws, 'state', None)
        if state is not None:
            return state == 1 or str(state).upper().endswith('OPEN')
        if hasattr(ws, 'closed'):
            return not ws.closed
        if hasattr(ws, 'open'):
            return bool(ws.open)
        return True

    async def ws_pump(self):
        while True:
            msg = await self.ws_queue.get()
            if self._ws_connected():
                try:
                    await self.ws.send(json.dumps(msg))
                except Exception as e:
                    log.warning('ws send failed: %s', e)

    def speaker_volume(self):
        v = self.config.get('speakerVolume')
        if v is None:
            return 0.5
        return max(0.0, min(1.0, float(v)))

    def on_audio_level(self, session, db):
        if self._audio_peak_suppressed:
            return
        now = time.time()
        state = {'armed': session.alert_armed, 'last_ts': session.last_level_ts}
        emit_peak, throttled, state = audio_peak_decision(db, state, self.config, now)
        session.alert_armed = state['armed']
        session.last_level_ts = state['last_ts']
        if emit_peak is not None:
            self.enqueue_ws({'type': 'AUDIO_PEAK', 'payload': {
                'deviceId': self.device_id, **emit_peak}})
        if throttled is not None:
            self.enqueue_ws({'type': 'AUDIO_PEAK', 'payload': {
                'deviceId': self.device_id, **throttled}})

    def enumerate_devices(self):
        self.video_devices = []
        self.audio_devices = []
        self.audio_output_devices = []
        try:
            out = subprocess.run(['v4l2-ctl', '--list-devices'], capture_output=True, text=True, timeout=10)
            self.video_devices = parse_v4l2_devices(out.stdout)
        except Exception as e:
            log.warning('v4l2-ctl failed: %s', e)
        try:
            out = subprocess.run(['arecord', '-l'], capture_output=True, text=True, timeout=10)
            self.audio_devices = parse_arecord_devices(out.stdout)
        except Exception as e:
            log.warning('arecord -l failed: %s', e)
        try:
            out = subprocess.run(['aplay', '-l'], capture_output=True, text=True, timeout=10)
            self.audio_output_devices = parse_aplay_devices(out.stdout)
        except Exception as e:
            log.warning('aplay -l failed: %s', e)
        self.has_video = bool(self.video_devices)
        self.has_audio = bool(self.audio_devices)

    def refresh_devices(self):
        """Re-enumerate devices and, if the available set changed (e.g. a USB
        camera was plugged in after boot, or udev was slow to create the node),
        re-send CAPABILITIES so the base station sees the new input. Also
        re-runs ensure_media so a late-arriving camera starts publishing.

        Cameras on a Pi frequently aren't ready when the service starts, so the
        one-shot enumeration at WELCOME can miss them; this catches that up."""
        prev_v = self.video_devices
        prev_a = self.audio_devices
        self.enumerate_devices()
        if self.video_devices != prev_v or self.audio_devices != prev_a:
            log.info('device set changed (v=%d a=%d) — re-sending capabilities',
                     len(self.video_devices), len(self.audio_devices))
            self.pick_defaults()
            self.send_capabilities()
            if self.source_type() != 'none':
                self.ensure_media()

    def pick_defaults(self):
        if not VIDEO_DEVICE and self.video_devices:
            self.config.setdefault('videoDevice', self.video_devices[0]['id'])
        if not AUDIO_DEVICE and self.audio_devices:
            self.config.setdefault('audioDevice', self.audio_devices[0]['id'])
        # Seed audio-monitor listen-in from env if the base hasn't set it (plan 15 §E).
        if AUDIO_MONITOR_ENABLED:
            self.config.setdefault('audioMonitorEnabled', True)
        if AUDIO_MONITOR_SOURCE:
            self.config.setdefault('audioMonitorSourceId', AUDIO_MONITOR_SOURCE)

    def source_type(self):
        return source_type(self.has_video, self.has_audio)

    def send_capabilities(self):
        log.info('send_capabilities: v=%d a=%d out=%d (%s)',
                 len(self.video_devices), len(self.audio_devices),
                 len(self.audio_output_devices), self.device_id)
        self.enqueue_ws({'type': 'CAPABILITIES', 'payload': {
            'deviceId': self.device_id,
            'videoDevices': self.video_devices,
            'audioDevices': self.audio_devices,
            'audioOutputDevices': self.audio_output_devices,
        }})

    async def handle_message(self, msg):
        t = msg.get('type')
        p = msg.get('payload', {})
        log.info('received msg type=%s payload_keys=%s', t, list(p.keys()) if isinstance(p, dict) else p)
        if t == 'WELCOME':
            # Keep our stable local device id authoritative. The server echoes
            # the id we sent in JOIN_ROOM, so this is normally a no-op — but if
            # the server ever returns a different id we must NOT adopt it, or
            # every reconnect would look like a new device (orphaned sources /
            # subscriptions, duplicate "Pi Agent" entries).
            server_dev = p.get('deviceId')
            if server_dev and server_dev != self.device_id:
                log.warning('server WELCOME deviceId %r differs from local %r '
                            '— keeping local stable id', server_dev, self.device_id)
            self.config.update(p.get('config', {}) or {})
            self._persist_config()
            if not self._label_persisted:
                self._persist_device_label(self.device_label)
                self._label_persisted = True
            for src in (p.get('sources') or []):
                if isinstance(src, dict) and not src.get('isBroadcast') and src.get('id'):
                    self.room_sources[src['id']] = src
            self.enumerate_devices()
            self.pick_defaults()
            self.send_capabilities()
            self.ensure_media()
            self.reconcile_audio_monitor()
        elif t == 'SUBSCRIBER_JOINED':
            sub = p.get('subscriberId')
            is_broadcast = p.get('isBroadcast')
            if is_broadcast:
                return  # broadcast sessions are driven by the base's OFFER
            existing = self.sessions.get(sub)
            if existing is not None:
                # Viewer reconnected after a screen-lock (or re-subscribed).
                # The session was kept alive (linger) so audio kept playing
                # through the lock; rebuild it fresh so a NEW OFFER is generated
                # to the viewer's new peer connection. The old pipeline is torn
                # down first (build() handles that) to free the camera device.
                self._cancel_stale(sub)
                existing.close()
                if self.loop:
                    # Small delay so the old pipeline releases /dev/video* before
                    # the new one opens it (avoids the device-busy race).
                    self.loop.call_later(0.5, existing.build)
                else:
                    existing.build()
                return
            # A NEW subscriber wants the feed. The Pi's physical camera/mic can
            # only be held by ONE GStreamer pipeline at a time, so if any session
            # already holds the device we must preempt the oldest one to free it
            # for the newcomer — regardless of MAX_SUBSCRIBERS. (Several browsers
            # could subscribe, but only the most recent actually gets media; the
            # rest would otherwise fail with "device busy" and hang at pc/ice
            # "new".) Send SESSION_KICKED so the displaced viewer shows a message
            # and auto-closes instead of looping on recovery.
            if self.sessions:
                evicted = self._evict_oldest_stale()
                if evicted is None:
                    kicked = self._preempt_oldest_active()
                    if kicked is None:
                        log.warning('session exists but none preemptable for %s — rejecting', sub)
                        self.enqueue_ws({'type': 'SUBSCRIBER_LEFT', 'payload': {'subscriberId': sub}})
                        return
                # Delay the new session so the preempted pipeline releases
                # /dev/video* before the new one opens it (libcamera is slow to
                # release, so use 1s rather than the 300ms reconnect delay).
                if self.loop:
                    self.loop.call_later(1.0, self._deferred_session, sub)
                    return
            self.sessions[sub] = MonitorSession(self, sub)
        elif t == 'SUBSCRIBER_LEFT':
            sub = p.get('subscriberId')
            sess = self.sessions.get(sub)
            if sess:
                # DO NOT close immediately. A viewer's WebSocket drops the
                # instant the iOS screen locks, but the native-fullscreen media
                # session keeps audio alive as long as RTP keeps arriving. Keep
                # the pipeline live for a grace period (MONITOR_LINGER_S); a
                # re-subscribe within that window reuses/rebuilds the session.
                self._mark_stale(sub)
        elif t == 'OFFER':
            frm = p.get('from')
            is_broadcast = p.get('isBroadcast')
            if is_broadcast:
                sess = self.broadcast_sessions.get(frm)
                if not sess:
                    sess = BroadcastSession(self, frm)
                    self.broadcast_sessions[frm] = sess
                sess.set_remote_offer(p['sdp']['sdp'])
            elif frm == self.audio_monitor_pub or frm in self.audio_monitor_sessions:
                # Listen-in (plan 15): we subscribed to this source, so the
                # publisher offers and we answer with an audio-only recv session.
                sess = self.audio_monitor_sessions.get(frm)
                if not sess:
                    sess = AudioMonitorSession(self, frm)
                    self.audio_monitor_sessions[frm] = sess
                sess.set_remote_offer(p['sdp']['sdp'])
            else:
                # The Pi is normally the offerer on the monitor PC. But the base
                # station renegotiates (e.g. addTalkback adds a mic track) by
                # sending a re-offer; answer it or the new m-line never connects.
                if frm in self.sessions:
                    self.sessions[frm].set_remote_offer(p['sdp']['sdp'])
                else:
                    log.debug('ignoring non-broadcast OFFER from %s', frm)
        elif t == 'ANSWER':
            # Only the monitor PC (offerer) receives an ANSWER. The broadcast PC
            # is the answerer, so it never gets one — ignore broadcast ANSWERs.
            frm = p.get('from')
            if not p.get('isBroadcast') and frm in self.sessions:
                self.sessions[frm].set_remote_answer(p['sdp']['sdp'])
        elif t == 'ICE_CANDIDATE':
            frm = p.get('from')
            is_broadcast = p.get('isBroadcast')
            if is_broadcast:
                sess = self.broadcast_sessions.get(frm)
                if sess:
                    sess.add_ice(p.get('candidate'), p.get('sdpMLineIndex'), p.get('sdpMid'))
            elif frm in self.audio_monitor_sessions:
                self.audio_monitor_sessions[frm].add_ice(
                    p.get('candidate'), p.get('sdpMLineIndex'), p.get('sdpMid'))
            elif frm in self.sessions:
                self.sessions[frm].add_ice(p.get('candidate'), p.get('sdpMLineIndex'), p.get('sdpMid'))
        elif t == 'TALK_ENABLED':
            log.info('talkback ENABLED from %s', p.get('from'))
            self.talkback_active = True
            for s in self.sessions.values():
                s.set_talkback(True)
        elif t == 'TALK_DISABLED':
            log.info('talkback DISABLED from %s', p.get('from'))
            self.talkback_active = False
            for s in self.sessions.values():
                s.set_talkback(False)
        elif t == 'SET_DISPLAY_CONFIG':
            self.config['audioMode'] = p.get('audioMode')
            self.config['displayMode'] = p.get('displayMode')
            log.info('display config: audio=%s display=%s', p.get('audioMode'), p.get('displayMode'))
            for s in self.sessions.values():
                s.apply_rx_volume()
        elif t == 'SOURCE_ADDED':
            src = p
            if src.get('isBroadcast') and src.get('publisherId') != self.device_id:
                tid = src.get('targetDeviceId')
                if tid and tid != self.device_id:
                    log.info('broadcast targeted elsewhere (%s) — ignoring', tid)
                    return
                if self.config.get('broadcastDisabled'):
                    log.info('broadcasts disabled — ignoring broadcast source %s', src.get('id'))
                    return
                pub = src.get('publisherId')
                self.broadcast_sources[pub] = src
                log.info('subscribing to broadcast from %s', pub)
                self.enqueue_ws({'type': 'SUBSCRIBE_BROADCAST', 'payload': {'publisherId': pub}})
            elif not src.get('isBroadcast') and src.get('id'):
                # Track normal sources so the audio-monitor resolver (plan 15)
                # can pick a listen-in target (e.g. 'auto' or a late-arriving one).
                self.room_sources[src['id']] = src
                self.reconcile_audio_monitor()
        elif t == 'PLAY_CLIP':
            # Record-then-play announcement (plan 18). The WAV is already on the
            # server; just fetch and play it. No peer connection required.
            if self.config.get('broadcastDisabled'):
                log.info('broadcasts disabled — ignoring PLAY_CLIP %s', p.get('clipId'))
                return
            self._play_clip(p)
        elif t == 'SOURCE_REMOVED':
            sid = p.get('sourceId')
            for pub, src in list(self.broadcast_sources.items()):
                if src.get('id') == sid:
                    log.info('broadcast source removed: %s — unsubscribing', sid)
                    self.enqueue_ws({'type': 'UNSUBSCRIBE_BROADCAST', 'payload': {'publisherId': pub}})
                    sess = self.broadcast_sessions.pop(pub, None)
                    if sess:
                        sess.close()
                    del self.broadcast_sources[pub]
            if sid in self.room_sources:
                del self.room_sources[sid]
                self.reconcile_audio_monitor()
        elif t == 'CONFIG_UPDATED':
            self.config = p.get('config', {}) or {}
            self._persist_config()
            self.apply_config()
        elif t == 'ERROR':
            log.warning('server error: %s', p)
            if p.get('message', '').startswith('Unknown message type: AUDIO_PEAK'):
                self._audio_peak_suppressed = True
                log.info('server does not support AUDIO_PEAK — suppressed')

    def _mark_stale(self, sub):
        """Keep a session alive after SUBSCRIBER_LEFT; schedule grace teardown."""
        if sub in self._stale_timers:
            return  # already lingering
        self._stale_since[sub] = time.time()
        if self.loop:
            self._stale_timers[sub] = self.loop.call_later(
                MONITOR_LINGER_S, self._teardown_stale, sub)
        log.info('subscriber %s left — lingering session %ds for lock-audio',
                 sub, MONITOR_LINGER_S)

    def _cancel_stale(self, sub):
        h = self._stale_timers.pop(sub, None)
        if h:
            h.cancel()
        self._stale_since.pop(sub, None)

    def _teardown_stale(self, sub):
        self._stale_timers.pop(sub, None)
        self._stale_since.pop(sub, None)
        sess = self.sessions.pop(sub, None)
        if sess:
            log.info('monitor session %s lingered %ds — closing', sub, MONITOR_LINGER_S)
            sess.close()

    def _evict_oldest_stale(self):
        """Close the oldest lingering session to free a slot for a new viewer."""
        oldest = None
        oldest_ts = None
        for s, ts in self._stale_since.items():
            if oldest is None or ts < oldest_ts:
                oldest = s
                oldest_ts = ts
        if oldest is None:
            return None
        self._cancel_stale(oldest)
        sess = self.sessions.pop(oldest, None)
        if sess:
            log.info('evicting stale monitor session %s for new viewer', oldest)
            sess.close()
        return oldest

    def _preempt_oldest_active(self):
        """Kick the oldest active (non-stale) session to free the camera for a
        new viewer. Sends SESSION_KICKED so the displaced base station shows a
        message and closes the feed instead of looping on recovery."""
        for s in list(self.sessions):
            if s not in self._stale_since:
                sess = self.sessions.pop(s, None)
                if sess:
                    log.info('preempting active session %s for new viewer', s)
                    sess.close()
                self.enqueue_ws({'type': 'SESSION_KICKED',
                                 'payload': {'subscriberId': s}})
                return s
        return None

    def _deferred_session(self, sub):
        """Create a MonitorSession after a short delay (lets the preempted
        pipeline release /dev/video* first)."""
        if sub in self.sessions:
            return
        self.sessions[sub] = MonitorSession(self, sub)

    def _teardown_all_sessions(self):
        """Close every active session and release camera/mic devices.

        Called when the WebSocket drops so orphaned GStreamer pipelines don't
        keep the camera red light on or block device access on reconnect."""
        for h in self._stale_timers.values():
            h.cancel()
        self._stale_timers.clear()
        self._stale_since.clear()
        for sess in self.sessions.values():
            sess.close()
        self.sessions.clear()
        for sess in self.broadcast_sessions.values():
            sess.close()
        self.broadcast_sessions.clear()
        self.broadcast_sources.clear()
        for sess in self.audio_monitor_sessions.values():
            sess.close()
        self.audio_monitor_sessions.clear()
        self.audio_monitor_pub = None
        self.room_sources.clear()
        self.talkback_active = False

    def _play_clip(self, payload):
        """Fetch a recorded announcement WAV and play it locally (plan 18).

        Runs a GStreamer playbin via gst-launch so resampling is handled for us
        (the clip is 16 kHz; most Pi ALSA sinks aren't). Falls back to aplay if
        gst-launch is unavailable. Fire-and-forget: playback isn't awaited.
        """
        import subprocess
        import tempfile
        import threading
        import urllib.request

        clip_id = payload.get('clipId', '')
        rel_url = payload.get('url', '')
        if not clip_id or not rel_url:
            log.warning('PLAY_CLIP missing clipId/url — ignoring')
            return
        base = WS_URL.replace('wss://', 'https://').replace('ws://', 'http://')
        url = base.rstrip('/') + rel_url
        try:
            resp = urllib.request.urlopen(url, context=_no_verify_ssl(), timeout=15)
            data = resp.read()
        except Exception as e:
            log.error('PLAY_CLIP download failed for %s: %s', clip_id, e)
            return
        if not data:
            log.warning('PLAY_CLIP empty body for %s', clip_id)
            return

        vol = float(self.config.get('speakerVolume', 0.5))
        sink = audio_sink_str(self.config.get('speakerDevice') or None)
        tmp = tempfile.NamedTemporaryFile(prefix='hearth-clip-', suffix='.wav',
                                          delete=False)
        tmp.write(data)
        tmp.close()
        path = tmp.name

        # gst-launch needs the audio-sink as a single pipeline token; the sink
        # string ('alsasink device=...') is already space-separated correctly.
        cmd = ['gst-launch-1.0', '-q',
               'filesrc', 'location=' + path,
               '!', 'wavparse', '!', 'audioconvert', '!', 'audioresample',
               '!', 'volume', 'volume=' + repr(vol),
               '!', sink]

        def _cleanup(proc):
            proc.wait()
            try:
                os.unlink(path)
            except OSError:
                pass

        try:
            proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL,
                                    stderr=subprocess.DEVNULL)
        except FileNotFoundError:
            # No gst-launch — last-ditch aplay (may fail on non-native rates).
            log.warning('gst-launch-1.0 not found — falling back to aplay')
            try:
                proc = subprocess.Popen(['aplay', '-q', path],
                                        stdout=subprocess.DEVNULL,
                                        stderr=subprocess.DEVNULL)
            except FileNotFoundError:
                log.error('no audio player available for PLAY_CLIP %s', clip_id)
                try:
                    os.unlink(path)
                except OSError:
                    pass
                return
        threading.Thread(target=_cleanup, args=(proc,), daemon=True).start()
        log.info('PLAY_CLIP %s playing (%.1fs, vol=%.2f)',
                 clip_id, (payload.get('durationMs') or 0) / 1000.0, vol)

    def reconcile_audio_monitor(self):
        """Subscribe/unsubscribe the headless audio-only listen-in (plan 15).

        Resolves the desired publisher from config + known room sources and, if
        it changed, tears down the old AudioMonitorSession (UNSUBSCRIBE_SOURCE)
        and subscribes to the new one (SUBSCRIBE_SOURCE). The publisher then
        offers and AudioMonitorSession answers audio-only."""
        target = audio_monitor_target(self.config, self.room_sources.values(), self.device_id)
        if target == self.audio_monitor_pub:
            return
        old = self.audio_monitor_pub
        if old:
            log.info('audio-monitor: stopping listen-in on %s', old)
            self.enqueue_ws({'type': 'UNSUBSCRIBE_SOURCE', 'payload': {'publisherId': old}})
            sess = self.audio_monitor_sessions.pop(old, None)
            if sess:
                sess.close()
        self.audio_monitor_pub = target
        if target:
            log.info('audio-monitor: starting listen-in on %s', target)
            self.enqueue_ws({'type': 'SUBSCRIBE_SOURCE', 'payload': {'publisherId': target}})

    def ensure_media(self):
        self.enumerate_devices()
        self.send_capabilities()
        if self.source_type() != 'none':
            self.publish_source()
            self._last_published_type = self.source_type()

    def publish_source(self):
        self.enqueue_ws({'type': 'PUBLISH_SOURCE', 'payload': {
            'sourceId': self.device_id + '-src',
            'label': self.device_label,
            'type': self.source_type(),
        }})

    def apply_config(self):
        # Device label: the base station can rename the device. When it does,
        # adopt the new name and persist it to config.env so it survives a
        # restart and is used for things like the hotspot SSID.
        new_label = (self.config.get('label') or '').strip()
        if new_label and new_label != self.device_label:
            log.info('device label changed via config: %s -> %s',
                     self.device_label, new_label)
            self.device_label = new_label
            self._label_changed = True
            self._persist_device_label(new_label)
            self.persist_env()

        # Re-apply speaker volume live to any active receive chains.
        for s in self.sessions.values():
            s.apply_rx_volume()
        for s in self.broadcast_sessions.values():
            if s.rxvol:
                s.rxvol.set_property('volume', self.speaker_volume())
        for s in self.audio_monitor_sessions.values():
            s.apply_volume()

        # Speaker output device change: reroute every active receive chain to
        # the newly-selected ALSA device (talkback, broadcasts, listen-in) live,
        # without tearing down the WebRTC session.
        new_speaker = self.config.get('speakerDevice') or None
        if new_speaker != getattr(self, '_last_speaker_device', None):
            log.info('speakerDevice changed: %s -> %s',
                     getattr(self, '_last_speaker_device', None), new_speaker)
            self._last_speaker_device = new_speaker
            for s in self.sessions.values():
                s.rebuild_audio_sink()
            for s in self.broadcast_sessions.values():
                s.rebuild_audio_sink()
            for s in self.audio_monitor_sessions.values():
                s.rebuild_audio_sink()
            self.persist_env()

        # Listen-in target may have changed (enabled/disabled or new source id).
        self.reconcile_audio_monitor()

        # If broadcasts were just disabled, tear down any active broadcast sessions
        # AND proactively unsubscribe from any sources we'd tracked (a source may
        # be queued before its OFFER arrives; the base still holds our subscribe).
        if self.config.get('broadcastDisabled'):
            for pub, sess in list(self.broadcast_sessions.items()):
                sess.close()
                self.enqueue_ws({'type': 'UNSUBSCRIBE_BROADCAST', 'payload': {'publisherId': pub}})
            self.broadcast_sessions.clear()
            for pub in list(self.broadcast_sources.keys()):
                self.enqueue_ws({'type': 'UNSUBSCRIBE_BROADCAST', 'payload': {'publisherId': pub}})
            self.broadcast_sources.clear()

        # Source (device) switching: rebuild monitor sessions if the device or
        # source type changed.
        self.enumerate_devices()
        prev_type = self._last_published_type
        prev_video = self._last_video_device
        prev_audio = self._last_audio_device
        self.publish_source()
        self._last_published_type = self.source_type()
        if prev_type != self.source_type():
            for sess in self.sessions.values():
                sess.has_video = self.has_video
                sess.has_audio = self.has_audio
        device_changed = (
            self.config.get('videoDevice', VIDEO_DEVICE) != prev_video or
            self.config.get('audioDevice', AUDIO_DEVICE) != prev_audio
        )
        if device_changed:
            for sess in self.sessions.values():
                sess.close()
            self.sessions.clear()
            self._last_video_device = self.config.get('videoDevice', VIDEO_DEVICE)
            self._last_audio_device = self.config.get('audioDevice', AUDIO_DEVICE)
            self.persist_env()

        # Resolution / framerate: the base station can change these via the
        # camera config. They're baked into the GStreamer pipeline caps, so a
        # change requires rebuilding the monitor sessions.
        new_resolution = self.config.get('resolution') or DEFAULT_RESOLUTION
        new_framerate = int(self.config.get('framerate', DEFAULT_FRAMERATE))
        res_changed = new_resolution != self._last_resolution
        fr_changed = new_framerate != self._last_framerate
        if res_changed or fr_changed:
            log.info('resolution/framerate changed: %s@%d -> %s@%d',
                     self._last_resolution, self._last_framerate,
                     new_resolution, new_framerate)
            self.resolution = new_resolution
            self.framerate = new_framerate
            for sess in self.sessions.values():
                sess.close()
            self.sessions.clear()
            self._last_resolution = new_resolution
            self._last_framerate = new_framerate
            self.persist_env()

    def persist_env(self):
        """Write base-station-driven settings back to the env file so they
        survive a restart. The values persisted are exactly the ones the base
        station can change live: VIDEO_DEVICE, AUDIO_DEVICE, RESOLUTION,
        FRAMERATE, and (when the device has been renamed) DEVICE_LABEL. Any
        other env vars (SERVER_URL, ROOM_ID, SPEAKER_DEVICE, AUDIO_SINK,
        MAX_SUBSCRIBERS, TEST_SOURCE, …) are left untouched.
        Recreates the file from defaults if it is missing."""
        try:
            lines = []
            if os.path.exists(CONFIG_FILE):
                with open(CONFIG_FILE) as f:
                    lines = f.read().splitlines()
            out = []
            dropped = set()
            for line in lines:
                key = line.split('=', 1)[0].strip() if '=' in line else ''
                if key in ('VIDEO_DEVICE', 'AUDIO_DEVICE', 'RESOLUTION', 'FRAMERATE'):
                    dropped.add(key)
                    continue  # drop old value; re-emit below
                if key == 'DEVICE_LABEL' and self._label_changed:
                    continue  # re-emit below with the new name
                out.append(line)
            out.append('VIDEO_DEVICE=' + str(self._last_video_device))
            out.append('AUDIO_DEVICE=' + str(self._last_audio_device))
            out.append('RESOLUTION=' + str(self.resolution))
            out.append('FRAMERATE=' + str(self.framerate))
            if self._label_changed:
                out.append('DEVICE_LABEL=' + self.device_label)
                self._label_changed = False
            os.makedirs(os.path.dirname(CONFIG_FILE) or '.', exist_ok=True)
            with open(CONFIG_FILE, 'w') as f:
                f.write('\n'.join(out) + '\n')
            log.info('persisted device/resolution/framerate to %s', CONFIG_FILE)
        except Exception as e:
            log.warning('failed to persist env file %s: %s', CONFIG_FILE, e)

    async def _refresh_loop(self):
        """Background task: re-scan devices periodically while connected."""
        while True:
            await asyncio.sleep(10)
            try:
                self.refresh_devices()
            except Exception as e:
                log.warning('device refresh failed: %s', e)

    async def _wifi_monitor(self):
        """Poll WiFi connectivity every 10s. Tear the hotspot down once a station
        WiFi is connected. If the hotspot has been up 10 min with no internet,
        try to bring up a saved WiFi connection to recover connectivity."""
        from captive_portal import (check_wifi_connected, teardown_hotspot,
                                    has_internet, connect_saved_wifi)
        elapsed = 0
        while True:
            await asyncio.sleep(10)
            elapsed += 10
            if check_wifi_connected():
                log.info('WiFi detected — tearing down hotspot')
                teardown_hotspot()
                return
            if elapsed >= 600 and not has_internet():
                # Hotspot has been up 10 min with no internet: try a saved WiFi.
                log.info('hotspot up 10 min with no internet — trying saved WiFi')
                await asyncio.to_thread(connect_saved_wifi)
                elapsed = 0  # re-attempt recovery every 10 min

    async def run(self, hotspot_active=False):
        self.loop = asyncio.get_event_loop()
        _load_gst()
        glib_loop = GLib.MainLoop()
        import threading
        threading.Thread(target=glib_loop.run, daemon=True).start()
        import websockets

        # If a hotspot was started, monitor for WiFi and tear it down when ready.
        if hotspot_active:
            asyncio.ensure_future(self._wifi_monitor())

        # If no SERVER_URL is configured, try mDNS discovery before first connect.
        if not WS_URL:
            await self._discover_server_via_mdns()
            self._mdns_attempted = True

        from captive_portal import wifi_configured_event

        while True:
            # If WiFi was just provisioned via the captive portal, fall back to
            # mDNS discovery now (the configured SERVER_URL may be stale/wrong).
            if wifi_configured_event.is_set():
                wifi_configured_event.clear()
                await self._discover_server_via_mdns()
                self._consecutive_failures = 0

            if not WS_URL:
                log.warning('no SERVER_URL — retrying discovery in %ds', self.reconnect_delay)
                await asyncio.sleep(self.reconnect_delay)
                self.reconnect_delay = min(self.reconnect_delay * 2, 30)
                if not self._mdns_attempted:
                    await self._discover_server_via_mdns()
                    self._mdns_attempted = True
                continue

            try:
                log.info('connecting to %s', WS_URL)
                async with websockets.connect(WS_URL, max_size=None, ssl=_no_verify_ssl()) as ws:
                    self.ws = ws
                    self.reconnect_delay = 1
                    self._consecutive_failures = 0
                    await ws.send(json.dumps({'type': 'JOIN_ROOM', 'payload': {
                        'roomId': ROOM_ID, 'deviceId': self.device_id,
                        'deviceType': 'kiosk', 'label': self.device_label}}))
                    pump = asyncio.ensure_future(self.ws_pump())
                    # Periodically re-scan for devices so cameras plugged in
                    # after boot (or slow to enumerate) get reported.
                    refresh_task = asyncio.ensure_future(self._refresh_loop())
                    async for raw in ws:
                        try:
                            await self.handle_message(json.loads(raw))
                        except Exception as e:
                            log.error('handle error: %s', e)
                    pump.cancel()
                    refresh_task.cancel()
                # WS dropped — tear down all active sessions.  The server has
                # already wiped our subscription state and sent SUBSCRIBER_LEFT
                # to publishers (if it could reach them), so any surviving
                # GStreamer pipelines are orphaned and holding camera/mic
                # devices.  Without this teardown the camera red light stays on
                # and the next reconnect can't open the device (REGRESSION FIX).
                self._teardown_all_sessions()
            except Exception as e:
                log.warning('connection lost: %s', e)
                self._consecutive_failures += 1
                # After 3 consecutive failures, fall back to mDNS discovery in case
                # the configured SERVER_URL is stale/unreachable (e.g. wrong IP
                # after the network changed). The discovered URL overrides WS_URL.
                if self._consecutive_failures >= 3:
                    log.info('consecutive failures >= 3 — attempting mDNS re-discovery')
                    await self._discover_server_via_mdns()
                    self._consecutive_failures = 0
            await asyncio.sleep(self.reconnect_delay)
            self.reconnect_delay = min(self.reconnect_delay * 2, 30)


def main():
    from captive_portal import (check_wifi_connected, setup_hotspot, has_internet,
                                CaptivePortal, get_device_name, _do_scan)

    hotspot_active = False

    # The hotspot (captive portal) runs whenever the device has no usable
    # internet, regardless of whether SERVER_URL is configured. FORCE_HOTSPOT=1
    # forces it on unconditionally — useful for debugging the AP itself.
    force = os.environ.get('FORCE_HOTSPOT', '').strip().lower() in ('1', 'true', 'yes')

    if force:
        log.info('FORCE_HOTSPOT set — starting captive portal immediately')
        start_hotspot = True
    else:
        # Poll for internet for up to 60s before giving up.
        log.info('checking internet connectivity...')
        online = False
        for i in range(60):
            if has_internet():
                online = True
                break
            if i == 0:
                log.info('no internet detected — will evaluate hotspot need')
            time.sleep(1)
        if online:
            log.info('internet available')
            start_hotspot = False
        elif check_wifi_connected():
            # A station WiFi is already connected but has no internet. Guard against
            # opening the hotspot: hold off for 5 minutes in case the link comes
            # up, and only then fall back to the captive portal.
            log.info('WiFi connected but no internet — waiting 5 min before hotspot')
            start_hotspot = False
            for _ in range(30):  # 30 * 10s = 5 min
                time.sleep(10)
                if has_internet():
                    log.info('internet available (deferred)')
                    break
            else:
                # Loop finished without breaking — still no internet.
                log.info('still no internet after 5 min — setting up hotspot')
                start_hotspot = True
        else:
            log.info('no internet and no station WiFi — setting up hotspot')
            start_hotspot = True

    if start_hotspot:
        device_name = HOTSPOT_NAME or get_device_name()
        # Scan for nearby WiFi *before* bringing up the AP, while the radio is
        # still in station mode. This populates the cached network list so the
        # captive portal can show available networks without dropping the phone's
        # connection later.
        log.info('scanning for nearby WiFi before starting hotspot')
        try:
            _do_scan()
        except Exception as e:
            log.warning('startup scan failed: %s', e)
        portal = CaptivePortal()
        portal.start()
        setup_hotspot(device_name)
        hotspot_active = True

    agent = Agent()
    try:
        asyncio.run(agent.run(hotspot_active=hotspot_active))
    except KeyboardInterrupt:
        log.info('stopped')


if __name__ == '__main__':
    main()
