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

WS_URL = os.environ.get('SERVER_URL', 'wss://localhost:8090').rstrip('/')
if not WS_URL.startswith('ws'):
    WS_URL = 'wss://' + WS_URL
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

# Talkback / broadcast receive sink configuration.
SPEAKER_DEVICE = os.environ.get('SPEAKER_DEVICE', '')
AUDIO_SINK = os.environ.get('AUDIO_SINK', '')  # e.g. 'alsasink device=hw:0,0' overrides SPEAKER_DEVICE

# Hard cap on simultaneous subscriber pipelines. Each viewer gets its own
# GStreamer pipeline; on a 1GB Pi this bounds memory/CPU. Beyond the cap we
# politely tell the server the subscriber left so the base doesn't hang.
MAX_SUBSCRIBERS = int(os.environ.get('MAX_SUBSCRIBERS', '4'))

DIMS = {'480p': (640, 480), '720p': (1280, 720), '1080p': (1920, 1080)}
STUN = 'stun://stun.l.google.com:19302'


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
#   - v4l2-loopback: virtual devices
# The onboard Pi Camera (bcm2835-unicam / bcm2835-isp) and USB webcams ARE real
# capture sources and must be kept.
_FAKE_VIDEO_PREFIXES = ('bcm2835-codec', 'v4l2-loopback')


def filter_real_cameras(devices):
    out = []
    for d in devices:
        label = (d.get('label') or '').lower()
        if any(p in label for p in _FAKE_VIDEO_PREFIXES):
            continue
        out.append(d)
    return out


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
                         stun=STUN, test_source=False):
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
        else:
            src = 'v4l2src'
            dev = ('device=' + video_device) if video_device else ''
        parts.append(
            '{src} {dev} ! videoconvert ! video/x-raw,format=I420,width={w},height={h},framerate={fr}/1 '
            '! {enc} tune=zerolatency key-int-max=30 ! rtph264pay config-interval=-1 ! queue ! wb'.format(
                src=src, dev=dev, w=width, h=height, fr=framerate, enc=enc))
    if has_audio:
        if test_source:
            src = 'audiotestsrc'
            dev = ''
        else:
            src = 'alsasrc'
            dev = ('device=' + audio_device) if audio_device else ''
        parts.append(
            '{src} {dev} ! audioconvert ! audioresample ! level ! opusenc ! rtpopuspay ! queue ! wb'.format(
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
        self.rxvol = None
        self.build()

    def build(self):
        width, height = DIMS.get(self.agent.resolution, DIMS['720p'])
        cfg_video = self.agent.config.get('videoDevice') or VIDEO_DEVICE
        cfg_audio = self.agent.config.get('audioDevice') or AUDIO_DEVICE
        enc = 'v4l2h264enc' if gst_element_exists('v4l2h264enc') else 'x264enc'
        if enc == 'x264enc':
            log.warning('hardware H.264 encoder (v4l2h264enc) not found — '
                        'falling back to software x264enc (higher RAM/CPU on Pi)')
        pipeline_str = monitor_pipeline_str(
            self.has_video, self.has_audio, width, height, self.agent.framerate,
            cfg_video, cfg_audio, enc, STUN, TEST_SOURCE)
        log.info('monitor session %s pipeline: %s', self.subscriber_id, pipeline_str)
        self.pipeline_str = pipeline_str
        self.pipeline = Gst.parse_launch(pipeline_str)
        self.webrtc = self.pipeline.get_by_name('wb')
        self.webrtc.connect('on-negotiation-needed', self.on_negotiation_needed)
        self.webrtc.connect('on-ice-candidate', self.on_ice_candidate)
        self.webrtc.connect('pad-added', self.on_pad_added)
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
        promise = Gst.Promise.new_with_change_func(self.on_offer_created)
        element.emit('create-offer', None, promise)

    def on_offer_created(self, promise):
        promise.wait()
        reply = promise.get_reply()
        offer = reply.get_value('offer')
        promise2 = Gst.Promise.new_with_change_func(self.on_local_description_set)
        self.webrtc.emit('set-local-description', offer, promise2)
        text = offer.sdp.as_text()
        self.agent.enqueue_ws({'type': 'OFFER', 'payload': {
            'to': self.subscriber_id, 'sdp': {'type': 'offer', 'sdp': text}}})

    def on_local_description_set(self, promise):
        promise.wait()

    def on_ice_candidate(self, element, cand):
        self.agent.enqueue_ws({'type': 'ICE_CANDIDATE', 'payload': {
            'to': self.subscriber_id,
            'candidate': cand.candidate,
            'sdpMLineIndex': cand.sdpMLineIndex,
            'sdpMid': cand.sdpMid,
        }})

    def on_bus_message(self, bus, message):
        if message.type == Gst.MessageType.ELEMENT:
            struct = message.get_structure()
            if struct and struct.get_name() == 'level':
                rms = struct.get_value('rms')
                if rms and len(rms) > 0:
                    db = float(rms[0])
                    self.agent.on_audio_level(self, db)
        return True

    def set_remote_answer(self, sdp_text):
        sdp = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(sdp_text.encode(), sdp)
        answer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.ANSWER, sdp)
        promise = Gst.Promise.new_with_change_func(self.on_remote_set)
        self.webrtc.emit('set-remote-description', answer, promise)

    def add_ice(self, cand, mline, mid):
        self.webrtc.emit('add-ice-candidate', mline, cand)

    def on_remote_set(self, promise):
        promise.wait()

    def close(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None


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
        sdp = GstSdp.SDPMessage.new()
        GstSdp.sdp_message_parse_buffer(sdp_text.encode(), sdp)
        offer = GstWebRTC.WebRTCSessionDescription.new(GstWebRTC.WebRTCSDPType.OFFER, sdp)
        self._remote_set = True
        promise = Gst.Promise.new_with_change_func(self.on_remote_set)
        self.webrtc.emit('set-remote-description', offer, promise)

    def add_ice(self, cand, mline, mid):
        self.webrtc.emit('add-ice-candidate', mline, cand)

    def on_remote_set(self, promise):
        promise.wait()

    def close(self):
        if self.pipeline:
            self.pipeline.set_state(Gst.State.NULL)
            self.pipeline = None


class Agent:
    def __init__(self):
        self.device_id = 'pi-' + rand_id()
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

    def enqueue_ws(self, msg):
        if self.loop:
            self.loop.call_soon_threadsafe(self.ws_queue.put_nowait, msg)
        else:
            asyncio.ensure_future(self.ws_queue.put(msg))

    async def ws_pump(self):
        while True:
            msg = await self.ws_queue.get()
            if self.ws and self.ws.open:
                await self.ws.send(json.dumps(msg))

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
                    sess.add_ice(p['candidate'], p['sdpMLineIndex'], p['sdpMid'])
            elif frm in self.sessions:
                self.sessions[frm].add_ice(p['candidate'], p['sdpMLineIndex'], p['sdpMid'])
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
        while True:
            try:
                log.info('connecting to %s', WS_URL)
                async with websockets.connect(WS_URL, max_size=None) as ws:
                    self.ws = ws
                    self.reconnect_delay = 1
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
            except Exception as e:
                log.warning('connection lost: %s', e)
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
