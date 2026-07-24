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
import subprocess
import time

# GStreamer and `websockets` are imported lazily inside _load_gst() / run() so
# this module can be imported (and unit-tested) on machines without the native
# stack installed.
Gst = GstWebRTC = GstSdp = GLib = None

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('hearth-pi-agent')

WS_URL = os.environ.get('SERVER_URL', '').rstrip('/')
if WS_URL and not WS_URL.startswith('ws'):
    WS_URL = 'wss://' + WS_URL
# WS_URL is empty string when SERVER_URL is unset — triggers mDNS discovery.
ROOM_ID = os.environ.get('ROOM_ID', 'default')
DEVICE_LABEL = os.environ.get('DEVICE_LABEL', 'Pi Agent')
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

# Hard cap on simultaneous subscriber pipelines. Each viewer gets its own
# GStreamer pipeline; on a 1GB Pi this bounds memory/CPU. Beyond the cap we
# politely tell the server the subscriber left so the base doesn't hang.
MAX_SUBSCRIBERS = int(os.environ.get('MAX_SUBSCRIBERS', '4'))

DIMS = {'480p': (640, 480), '720p': (1280, 720), '1080p': (1920, 1080)}
STUN = 'stun://stun.l.google.com:19302'


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
        # x264enc (software) properties; `v4l2h264enc` (Pi hardware) rejects
        # both and manages its own GOP, so it gets no extra options. Kept pure
        # (no GStreamer introspection) so the string helper stays unit-testable.
        enc_opts = 'tune=zerolatency key-int-max=30' if enc == 'x264enc' else ''
        if use_libcamerasrc:
            # libcamerasrc outputs NV21; caps set resolution, then convert to I420.
            parts.append(
                '{src} ! video/x-raw,width={w},height={h},framerate={fr}/1 '
                '! videoconvert ! video/x-raw,format=I420 '
                '! {enc} {enc_opts} ! rtph264pay config-interval=-1 ! queue ! wb.'.format(
                    src=src, w=width, h=height, fr=framerate, enc=enc, enc_opts=enc_opts))
        else:
            parts.append(
                '{src} {dev} ! videoconvert ! video/x-raw,format=I420,width={w},height={h},framerate={fr}/1 '
                '! {enc} {enc_opts} ! rtph264pay config-interval=-1 ! queue ! wb.'.format(
                    src=src, dev=dev, w=width, h=height, fr=framerate, enc=enc, enc_opts=enc_opts))
    if has_audio:
        if test_source:
            src = 'audiotestsrc'
            dev = ''
        else:
            src = 'alsasrc'
            dev = ('device=' + audio_device) if audio_device else ''
        if audio_channels > 0:
            parts.append(
                '{src} {dev} ! capsfilter caps=audio/x-raw,channels={ch} '
                '! audioconvert ! audioresample ! opusenc ! rtpopuspay ! queue ! wb.'.format(
                    src=src, dev=dev, ch=audio_channels))
        else:
            parts.append(
                '{src} {dev} ! audioconvert ! audioresample ! opusenc ! rtpopuspay ! queue ! wb.'.format(
                    src=src, dev=dev))
    return ' '.join(parts)


def broadcast_pipeline_str(stun=STUN):
    """Build the broadcast (recvonly) webrtcbin launch string (pure)."""
    return 'webrtcbin name=wb stun-server=' + stun


def audio_sink_str():
    if AUDIO_SINK:
        return AUDIO_SINK
    if SPEAKER_DEVICE:
        return 'alsasink device=' + SPEAKER_DEVICE
    return 'alsasink'


def make_audio_recv_chain(pipeline, volume, mute):
    """Build an RTP-Opus -> ALSA receive chain and add it to a running pipeline.

    Returns (bin, rxvol_element). The volume element is pre-set so the chain is
    safe to link before any samples arrive.
    """
    chain = Gst.parse_bin_from_description(
        'queue ! rtpopusdepay ! opusdec ! audioconvert ! audioresample ! '
        'volume name=rxvol ! ' + audio_sink_str(), True)
    pipeline.add(chain)
    chain.set_state(Gst.State.PLAYING)
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
        self._making_offer = False
        self._last_offer_ts = 0.0
        self._mid_map = {}
        self.pipeline = None
        self.build()

    def build(self):
        # Tear down any existing pipeline first so two pipelines never race
        # for the same V4L2/ALSA device node.
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None
        width, height = DIMS.get(self.agent.resolution, DIMS['720p'])
        cfg_video = self.agent.config.get('videoDevice') or VIDEO_DEVICE
        cfg_audio = self.agent.config.get('audioDevice') or AUDIO_DEVICE
        # VIDEO_ENCODER lets you force the H.264 encoder (e.g. x264enc on Pis
        # whose hardware v4l2h264enc misbehaves, or for headless test sources).
        enc = os.environ.get('VIDEO_ENCODER') or (
            'v4l2h264enc' if gst_element_exists('v4l2h264enc') else 'x264enc')
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
        # webrtcbin does not auto-create transceivers from linked request pads;
        # explicitly declare one per media (SENDRECV so talkback audio can be
        # received). Must happen before the pipeline goes to PLAYING or
        # on-negotiation-needed never fires.
        direction = GstWebRTC.WebRTCRTPTransceiverDirection.SENDRECV
        if self.has_video:
            self.webrtc.emit('add-transceiver', direction, None)
        if self.has_audio:
            self.webrtc.emit('add-transceiver', direction, None)
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect('message', self.on_bus_message)
        self.pipeline.set_state(Gst.State.PLAYING)

    def on_pad_added(self, element, pad):
        # The recv (talkback) audio pad appears dynamically. (Video on the
        # monitor PC is sendonly, so no recv video pad is expected here.)
        caps = pad.get_current_caps()
        if not caps:
            return
        st = caps.get_structure(0)
        media = st.get_string('media')
        if media == 'audio' or 'OPUS' in (st.get_string('encoding-name') or ''):
            chain, self.rxvol = make_audio_recv_chain(
                self.pipeline, self.agent.speaker_volume(), self._initial_mute())
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

    def set_talkback(self, active):
        self.talkback_active = active
        self.apply_rx_volume()

    def apply_rx_volume(self):
        if not self.rxvol:
            return
        self.rxvol.set_property('volume', self.agent.speaker_volume())
        allowed = self.agent.talkback_active or self.agent.config.get('audioMode') == 'base'
        self.rxvol.set_property('mute', not allowed)

    def on_negotiation_needed(self, element):
        # set-local-description re-triggers on-negotiation-needed, which would
        # otherwise create a fresh OFFER every time and loop forever (the base
        # briefly connects then gets reset into pc:new). Guard so only one
        # in-flight offer exists per session; cleared once the answer lands.
        # Also debounce: set-remote-description triggers on-negotiation-needed
        # after _making_offer is cleared, causing a feedback loop of rapid
        # OFFERs. Require a minimum gap between offers.
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
        promise = Gst.Promise.new_with_change_func(self.on_offer_created)
        element.emit('create-offer', None, promise)

    def on_offer_created(self, promise):
        try:
            log.info('on_offer_created called for %s', self.subscriber_id)
            promise.wait()
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
            self._mid_map = self._parse_mids(text)
            self.agent.enqueue_ws({'type': 'OFFER', 'payload': {
                'to': self.subscriber_id, 'sdp': {'type': 'offer', 'sdp': text}}})
            log.info('OFFER sent for %s', self.subscriber_id)
        except Exception as e:
            log.error('on_offer_created FAILED for %s: %s', self.subscriber_id, e)
            self._making_offer = False

    def on_local_description_set(self, promise):
        promise.wait()

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
        _ret, sdp = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(sdp_text.encode(), sdp)
        answer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.ANSWER, sdp)
        promise = Gst.Promise.new_with_change_func(self.on_remote_set)
        self.webrtc.emit('set-remote-description', answer, promise)
        self._making_offer = False

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

    def close(self):
        if self.pipeline:
            self._closing = True
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
        self._remote_set = False
        self.build()

    def build(self):
        log.info('broadcast session from %s', self.publisher_id)
        self.pipeline_str = broadcast_pipeline_str(STUN)
        self.pipeline = Gst.parse_launch(self.pipeline_str)
        self.webrtc = self.pipeline.get_by_name('wb')
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
                    self.pipeline, self.agent.speaker_volume(), False)  # announcements always play
                pad.link(chain.get_static_pad('sink'))
            elif media == 'video':
                chain = make_video_recv_chain(self.pipeline)
                pad.link(chain.get_static_pad('sink'))
        except Exception as e:
            log.warning('broadcast recv link failed: %s', e)

    def on_negotiation_needed(self, element):
        # We are the answerer: only create an answer once the remote offer is set.
        if not self._remote_set:
            return
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

    def on_ice_candidate(self, element, cand):
        self.agent.enqueue_ws({'type': 'ICE_CANDIDATE', 'payload': {
            'to': self.publisher_id,
            'candidate': cand.candidate,
            'sdpMLineIndex': cand.sdpMLineIndex,
            'sdpMid': cand.sdpMid,
            'isBroadcast': True,
        }})

    def on_bus_message(self, bus, message):
        # No audio-level alerts on the receive side.
        return True

    def set_remote_offer(self, sdp_text):
        _ret, sdp = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(sdp_text.encode(), sdp)
        offer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, sdp)
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
        self.ws = None
        self.has_video = False
        self.has_audio = False
        self.config = {}
        self.video_devices = []
        self.audio_devices = []
        self.sessions = {}          # subscriberId -> MonitorSession (sendrecv, talkback)
        self.broadcast_sessions = {}  # publisherId -> BroadcastSession (recvonly)
        self.broadcast_sources = {}   # publisherId -> source dict from SOURCE_ADDED
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
        self._mdns_attempted = False  # only try mDNS once per startup unless re-triggered

    def _load_device_id(self):
        """Return a stable device id, generating and persisting one on first run."""
        import os as _os
        try:
            if _os.path.exists(self.device_id_file):
                with open(self.device_id_file) as f:
                    existing = f.read().strip()
                if existing:
                    return existing
        except Exception:
            pass
        new_id = 'pi-' + rand_id()
        try:
            _os.makedirs(_os.path.dirname(self.device_id_file) or '.', exist_ok=True)
            with open(self.device_id_file, 'w') as f:
                f.write(new_id)
        except Exception as e:
            log.warning('could not persist device id: %s', e)
        return new_id

    async def _discover_server_via_mdns(self):
        """Query mDNS for a Hearth-Connect server. Updates WS_URL on success."""
        global WS_URL
        if WS_URL:
            return  # already configured
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

    def source_type(self):
        return source_type(self.has_video, self.has_audio)

    def send_capabilities(self):
        log.info('send_capabilities: v=%d a=%d (%s)',
                 len(self.video_devices), len(self.audio_devices), self.device_id)
        self.enqueue_ws({'type': 'CAPABILITIES', 'payload': {
            'deviceId': self.device_id,
            'videoDevices': self.video_devices,
            'audioDevices': self.audio_devices,
        }})

    async def handle_message(self, msg):
        t = msg.get('type')
        p = msg.get('payload', {})
        log.info('received msg type=%s payload_keys=%s', t, list(p.keys()) if isinstance(p, dict) else p)
        if t == 'WELCOME':
            self.device_id = p.get('deviceId', self.device_id)
            self.config = p.get('config', {}) or {}
            self.enumerate_devices()
            self.pick_defaults()
            self.send_capabilities()
            self.ensure_media()
        elif t == 'SUBSCRIBER_JOINED':
            sub = p.get('subscriberId')
            is_broadcast = p.get('isBroadcast')
            if is_broadcast:
                return  # broadcast sessions are driven by the base's OFFER
            if sub and sub not in self.sessions:
                if len(self.sessions) >= MAX_SUBSCRIBERS:
                    log.warning('subscriber cap %d reached — rejecting %s', MAX_SUBSCRIBERS, sub)
                    self.enqueue_ws({'type': 'SUBSCRIBER_LEFT', 'payload': {'subscriberId': sub}})
                    return
                self.sessions[sub] = MonitorSession(self, sub)
        elif t == 'SUBSCRIBER_LEFT':
            sub = p.get('subscriberId')
            sess = self.sessions.pop(sub, None)
            if sess:
                sess.close()
        elif t == 'OFFER':
            frm = p.get('from')
            is_broadcast = p.get('isBroadcast')
            if is_broadcast:
                sess = self.broadcast_sessions.get(frm)
                if not sess:
                    sess = BroadcastSession(self, frm)
                    self.broadcast_sessions[frm] = sess
                sess.set_remote_offer(p['sdp']['sdp'])
            else:
                # The Pi is the offerer on the monitor PC; the base never offers
                # there. Ignore (a renegotiation offer would need answerer logic).
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
        elif t == 'CONFIG_UPDATED':
            self.config = p.get('config', {}) or {}
            self.apply_config()
        elif t == 'ERROR':
            log.warning('server error: %s', p)

    def _teardown_all_sessions(self):
        """Close every active session and release camera/mic devices.

        Called when the WebSocket drops so orphaned GStreamer pipelines don't
        keep the camera red light on or block device access on reconnect."""
        for sess in self.sessions.values():
            sess.close()
        self.sessions.clear()
        for sess in self.broadcast_sessions.values():
            sess.close()
        self.broadcast_sessions.clear()
        self.broadcast_sources.clear()
        self.talkback_active = False

    def ensure_media(self):
        self.enumerate_devices()
        self.send_capabilities()
        if self.source_type() != 'none':
            self.publish_source()
            self._last_published_type = self.source_type()

    def publish_source(self):
        self.enqueue_ws({'type': 'PUBLISH_SOURCE', 'payload': {
            'sourceId': self.device_id + '-src',
            'label': DEVICE_LABEL,
            'type': self.source_type(),
        }})

    def apply_config(self):
        # Re-apply speaker volume live to any active receive chains.
        for s in self.sessions.values():
            s.apply_rx_volume()
        for s in self.broadcast_sessions.values():
            if s.rxvol:
                s.rxvol.set_property('volume', self.speaker_volume())

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
        FRAMERATE. Any other env vars (SERVER_URL, ROOM_ID, SPEAKER_DEVICE,
        AUDIO_SINK, MAX_SUBSCRIBERS, TEST_SOURCE, …) are left untouched.
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
                out.append(line)
            out.append('VIDEO_DEVICE=' + str(self._last_video_device))
            out.append('AUDIO_DEVICE=' + str(self._last_audio_device))
            out.append('RESOLUTION=' + str(self.resolution))
            out.append('FRAMERATE=' + str(self.framerate))
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

    async def run(self):
        self.loop = asyncio.get_event_loop()
        _load_gst()
        glib_loop = GLib.MainLoop()
        import threading
        threading.Thread(target=glib_loop.run, daemon=True).start()
        import websockets

        # If no SERVER_URL is configured, try mDNS discovery before first connect.
        if not WS_URL:
            await self._discover_server_via_mdns()
            self._mdns_attempted = True

        while True:
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
                        'deviceType': 'kiosk', 'label': DEVICE_LABEL}}))
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
                # After 3 consecutive failures, try mDNS re-discovery in case
                # the server moved to a new IP.
                if self._consecutive_failures >= 3:
                    log.info('consecutive failures >= 3 — attempting mDNS re-discovery')
                    self._mdns_attempted = False
                    self._consecutive_failures = 0
            await asyncio.sleep(self.reconnect_delay)
            self.reconnect_delay = min(self.reconnect_delay * 2, 30)


def main():
    agent = Agent()
    try:
        asyncio.run(agent.run())
    except KeyboardInterrupt:
        log.info('stopped')


if __name__ == '__main__':
    main()
