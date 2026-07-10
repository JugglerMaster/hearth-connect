#!/usr/bin/env python3
"""Hearth-Connect native agent for Raspberry Pi (Pi OS Lite, headless).

Connects to a Hearth-Connect server over WebSocket, enumerates V4L2 cameras and ALSA
microphones, and publishes whatever media is available (video+audio / video-only /
audio-only) via GStreamer webrtcbin. Speaks the same signaling protocol as the browser kiosk.
"""

import asyncio
import json
import logging
import os
import random
import string
import subprocess
import time

import gi

gi.require_version('Gst', '1.0')
gi.require_version('GstWebRTC', '1.0')
gi.require_version('GstSdp', '1.0')

from gi.repository import Gst, GstWebRTC, GstSdp, GLib
import websockets

logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s %(message)s')
log = logging.getLogger('hearth-pi-agent')

WS_URL = os.environ.get('SERVER_URL', 'wss://localhost:8090').rstrip('/')
if not WS_URL.startswith('ws'):
    WS_URL = 'wss://' + WS_URL
ROOM_ID = os.environ.get('ROOM_ID', 'default')
DEVICE_LABEL = os.environ.get('DEVICE_LABEL', 'Pi Agent')
VIDEO_DEVICE = os.environ.get('VIDEO_DEVICE', '')
AUDIO_DEVICE = os.environ.get('AUDIO_DEVICE', '')
RESOLUTION = os.environ.get('RESOLUTION', '720p')
FRAMERATE = int(os.environ.get('FRAMERATE', '24'))

DIMS = {'480p': (640, 480), '720p': (1280, 720), '1080p': (1920, 1080)}

STUN = 'stun://stun.l.google.com:19302'


def rand_id(n=8):
    return ''.join(random.choices(string.ascii_lowercase + string.digits, k=n))


def gst_element_exists(name):
    return Gst.ElementFactory.find(name) is not None


class WebrtcSession:
    def __init__(self, agent, subscriber_id):
        self.agent = agent
        self.subscriber_id = subscriber_id
        self.pipeline = None
        self.webrtc = None
        self.has_video = agent.has_video
        self.has_audio = agent.has_audio
        self.alert_armed = True
        self.last_level_ts = 0
        self.build()

    def build(self):
        width, height = DIMS.get(RESOLUTION, DIMS['720p'])
        parts = ['webrtcbin name=wb stun-server=' + STUN]
        cfg_video = self.agent.config.get('videoDevice') or VIDEO_DEVICE
        cfg_audio = self.agent.config.get('audioDevice') or AUDIO_DEVICE
        if self.has_video:
            enc = 'v4l2h264enc' if gst_element_exists('v4l2h264enc') else 'x264enc'
            dev = ('device=' + cfg_video) if cfg_video else ''
            parts.append(
                'v4l2src {dev} ! videoconvert ! video/x-raw,format=I420,width={w},height={h},framerate={fr}/1 '
                '! {enc} tune=zerolatency key-int-max=30 ! rtph264pay config-interval=-1 ! queue ! wb'.format(
                    dev=dev, w=width, h=height, fr=FRAMERATE, enc=enc))
        if self.has_audio:
            dev = ('device=' + cfg_audio) if cfg_audio else ''
            parts.append(
                'alsasrc {dev} ! audioconvert ! audioresample ! level ! opusenc ! rtpopuspay ! queue ! wb'.format(dev=dev))
        pipeline_str = ' '.join(parts)
        log.info('session %s pipeline: %s', self.subscriber_id, pipeline_str)
        self.pipeline = Gst.parse_launch(pipeline_str)
        self.webrtc = self.pipeline.get_by_name('wb')
        self.webrtc.connect('on-negotiation-needed', self.on_negotiation_needed)
        self.webrtc.connect('on-ice-candidate', self.on_ice_candidate)
        bus = self.pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect('message', self.on_bus_message)
        self.pipeline.set_state(Gst.State.PLAYING)

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
        self.agent.enqueue_ws({'type': 'OFFER', 'payload': {'to': self.subscriber_id, 'sdp': {'type': 'offer', 'sdp': text}}})

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


class Agent:
    def __init__(self):
        self.device_id = 'pi-' + rand_id()
        self.ws = None
        self.has_video = False
        self.has_audio = False
        self.config = {}
        self.video_devices = []
        self.audio_devices = []
        self.sessions = {}
        self.ws_queue = asyncio.Queue()
        self.loop = None
        self.reconnect_delay = 1

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

    def on_audio_level(self, session, db):
        now = time.time()
        enabled = self.config.get('audioAlertEnabled', True)
        threshold = self.config.get('audioAlertThresholdDb', -40)
        hyst = self.config.get('audioAlertHysteresisDb', 6)
        if enabled:
            if db > threshold and session.alert_armed:
                self.enqueue_ws({'type': 'AUDIO_PEAK', 'payload': {
                    'deviceId': self.device_id, 'levelDb': db, 'peak': True, 'ts': int(now * 1000)}})
            elif db < threshold - hyst:
                session.alert_armed = True
        if now - session.last_level_ts > 1.0:
            session.last_level_ts = now
            self.enqueue_ws({'type': 'AUDIO_PEAK', 'payload': {
                'deviceId': self.device_id, 'levelDb': db, 'peak': False, 'ts': int(now * 1000)}})

    def enumerate_devices(self):
        self.video_devices = []
        self.audio_devices = []
        try:
            out = subprocess.run(['v4l2-ctl', '--list-devices'], capture_output=True, text=True, timeout=10)
            cur = None
            for line in out.stdout.splitlines():
                if line and not line.startswith(('\t', ' ')) and ':' in line:
                    cur = line.strip()
                elif '/dev/video' in line:
                    dev = line.strip()
                    self.video_devices.append({'id': dev, 'label': (cur or dev)})
        except Exception as e:
            log.warning('v4l2-ctl failed: %s', e)
        try:
            out = subprocess.run(['arecord', '-l'], capture_output=True, text=True, timeout=10)
            for line in out.stdout.splitlines():
                if line.startswith('card '):
                    parts = line.split(':')
                    name = parts[1].strip() if len(parts) > 1 else line
                    card = line.split()[1]
                    self.audio_devices.append({'id': 'hw:' + card + ',0', 'label': name})
        except Exception as e:
            log.warning('arecord -l failed: %s', e)
        if not self.video_devices:
            self.has_video = False
        if not self.audio_devices:
            self.has_audio = False

    def pick_defaults(self):
        if not VIDEO_DEVICE and self.video_devices:
            self.config['videoDevice'] = self.video_devices[0]['id']
        if not AUDIO_DEVICE and self.audio_devices:
            self.config['audioDevice'] = self.audio_devices[0]['id']

    def source_type(self):
        if self.has_video and self.has_audio:
            return 'video+audio'
        if self.has_video:
            return 'video-only'
        if self.has_audio:
            return 'audio-only'
        return 'none'

    def send_capabilities(self):
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
            if sub and sub not in self.sessions:
                self.sessions[sub] = WebrtcSession(self, sub)
        elif t == 'SUBSCRIBER_LEFT':
            sub = p.get('subscriberId')
            sess = self.sessions.pop(sub, None)
            if sess:
                sess.close()
        elif t == 'ANSWER':
            if p.get('from') in self.sessions:
                self.sessions[p['from']].set_remote_answer(p['sdp']['sdp'])
        elif t == 'ICE_CANDIDATE':
            if p.get('from') in self.sessions:
                self.sessions[p['from']].add_ice(p['candidate'], p['sdpMLineIndex'], p['sdpMid'])
        elif t == 'CONFIG_UPDATED':
            self.config = p.get('config', {}) or {}
            self.apply_config()
        elif t == 'ERROR':
            log.warning('server error: %s', p)

    def ensure_media(self):
        self.enumerate_devices()
        self.has_video = bool(self.video_devices)
        self.has_audio = bool(self.audio_devices)
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

    _last_published_type = None
    _last_video_device = VIDEO_DEVICE
    _last_audio_device = AUDIO_DEVICE

    async def run(self):
        self.loop = asyncio.get_event_loop()
        Gst.init(None)
        glib_thread = GLib.MainLoop()
        import threading
        threading.Thread(target=glib_thread.run, daemon=True).start()
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
                    async for raw in ws:
                        try:
                            await self.handle_message(json.loads(raw))
                        except Exception as e:
                            log.error('handle error: %s', e)
                    pump.cancel()
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
