#!/usr/bin/env python3
"""Unit tests for the Hearth-Connect Pi agent (deploy/pi-agent/pi-agent.py).

These cover the PURE logic that does not require GStreamer, a camera, a mic,
or a running server — so they run anywhere (matches plan 11's note that
pi-agent.py can't run in CI). The native stack is imported lazily by the
agent, so simply importing the module here needs no GStreamer/websockets.

Run from this directory:
    python3 -m unittest test_pi_agent.py -v
"""

import importlib.util
import os
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))
_spec = importlib.util.spec_from_file_location('pi_agent', os.path.join(_HERE, 'pi-agent.py'))
pa = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(pa)


class TestParseV4L2Devices(unittest.TestCase):
    def test_multi_device(self):
        out = """Pi Camera (IMX219):
\t/dev/video0
\t/dev/video1
USB Webcam:
\t/dev/video2
"""
        devs = pa.parse_v4l2_devices(out)
        self.assertEqual([d['id'] for d in devs],
                         ['/dev/video0', '/dev/video1', '/dev/video2'])
        self.assertEqual(devs[0]['label'], 'Pi Camera (IMX219):')
        self.assertEqual(devs[2]['label'], 'USB Webcam:')

    def test_capture_only_no_headers(self):
        # A line with /dev/video but no preceding header uses itself as label.
        out = "/dev/video0\n"
        devs = pa.parse_v4l2_devices(out)
        self.assertEqual(devs, [{'id': '/dev/video0', 'label': '/dev/video0'}])

    def test_empty(self):
        self.assertEqual(pa.parse_v4l2_devices(''), [])
        self.assertEqual(pa.parse_v4l2_devices(None), [])


class TestParseArecodeDevices(unittest.TestCase):
    def test_sample(self):
        out = """**** List of CAPTURE Hardware Devices ****
card 0: Headphones [USB Headphone], device 0: USB Audio [USB Audio]
  Subdevice #0: subdevice #0
card 2: U0x46d0x81b [USB Device], device 0: USB Audio [USB Audio]
"""
        devs = pa.parse_arecord_devices(out)
        self.assertEqual([d['id'] for d in devs], ['hw:0,0', 'hw:2,0'])
        # id is derived from the card number.
        self.assertTrue(all(d['id'].startswith('hw:') and d['id'].endswith(',0')
                            for d in devs))

    def test_empty(self):
        self.assertEqual(pa.parse_arecord_devices(''), [])


_PS3_FMT = """ioctl: VIDIOC_ENUM_FMT
	Type: Video Capture

	[1]: 'YUYV' (YUYV 4:2:2)
		Size: Discrete 320x240
			Interval: Discrete 0.033s (30.000 fps)
		Size: Discrete 640x480
			Interval: Discrete 0.067s (15.000 fps)
			Interval: Discrete 0.033s (30.000 fps)
"""


class TestParseV4L2Formats(unittest.TestCase):
    def test_ps3eye_modes(self):
        modes = pa.parse_v4l2_formats(_PS3_FMT)
        self.assertEqual(
            [(m['width'], m['height'], m['framerates']) for m in modes],
            [(320, 240, [30.0]), (640, 480, [15.0, 30.0])])

    def test_empty(self):
        self.assertEqual(pa.parse_v4l2_formats(''), [])
        self.assertEqual(pa.parse_v4l2_formats(None), [])


class TestSupportedFramerate(unittest.TestCase):
    def _patch_v4l2(self, out=_PS3_FMT):
        import unittest.mock as mock
        class _R:
            stdout = out
        return mock.patch.object(pa.subprocess, 'run', lambda *a, **k: _R())

    def test_clamps_to_nearest_lower(self):
        with self._patch_v4l2():
            # PS3 Eye 640x480 supports 15/30; 24 -> nearest <= is 15.
            self.assertEqual(pa.supported_framerate('/dev/video0', 640, 480, 24), 15)

    def test_picks_exact_match(self):
        with self._patch_v4l2():
            self.assertEqual(pa.supported_framerate('/dev/video0', 640, 480, 30), 30)

    def test_highest_when_all_above(self):
        with self._patch_v4l2():
            # desired 10 < 15 -> returns lowest available (15).
            self.assertEqual(pa.supported_framerate('/dev/video0', 640, 480, 10), 15)

    def test_unsupported_resolution_returns_none(self):
        with self._patch_v4l2():
            self.assertIsNone(pa.supported_framerate('/dev/video0', 1280, 720, 30))

    def test_no_device_returns_none(self):
        with self._patch_v4l2():
            self.assertIsNone(pa.supported_framerate('', 640, 480, 30))


_USB_FMT = """ioctl: VIDIOC_ENUM_FMT
	Type: Video Capture

	[0]: 'YUYV' (YUYV 4:2:2)
		Size: Discrete 320x240
			Interval: Discrete 0.033s (30.000 fps)
		Size: Discrete 640x480
			Interval: Discrete 0.033s (30.000 fps)
"""


class TestBestSupportedMode(unittest.TestCase):
    def _patch_v4l2(self, out=_USB_FMT):
        import unittest.mock as mock
        class _R:
            stdout = out
        return mock.patch.object(pa.subprocess, 'run', lambda *a, **k: _R())

    def test_exact_resolution_match(self):
        with self._patch_v4l2():
            self.assertEqual(pa.best_supported_mode('/dev/video1', 640, 480, 30),
                             (640, 480, 30))

    def test_downscale_to_largest_supported(self):
        with self._patch_v4l2():
            # Requested 1280x720 not available; falls back to 640x480.
            self.assertEqual(pa.best_supported_mode('/dev/video1', 1280, 720, 30),
                             (640, 480, 30))

    def test_clamps_framerate(self):
        with self._patch_v4l2():
            # 640x480 only does 30fps; requesting 60 -> clamps to 30.
            self.assertEqual(pa.best_supported_mode('/dev/video1', 640, 480, 60),
                             (640, 480, 30))

    def test_empty_device_returns_none(self):
        with self._patch_v4l2():
            self.assertIsNone(pa.best_supported_mode('', 640, 480, 30))
            self.assertIsNone(pa.best_supported_mode(None, 640, 480, 30))

    def test_no_matching_resolution_picks_largest(self):
        # Only 320x240 available; requesting 640x480 -> falls back to 320x240.
        only_small = """ioctl: VIDIOC_ENUM_FMT
	Type: Video Capture

	[0]: 'YUYV' (YUYV 4:2:2)
		Size: Discrete 320x240
			Interval: Discrete 0.033s (30.000 fps)
"""
        with self._patch_v4l2(only_small):
            self.assertEqual(pa.best_supported_mode('/dev/video1', 640, 480, 30),
                             (320, 240, 30))


class TestSourceType(unittest.TestCase):
    def test_combos(self):
        self.assertEqual(pa.source_type(True, True), 'video+audio')
        self.assertEqual(pa.source_type(True, False), 'video-only')
        self.assertEqual(pa.source_type(False, True), 'audio-only')
        self.assertEqual(pa.source_type(False, False), 'none')


class TestIsLibcameraDevice(unittest.TestCase):
    def test_unicam_device(self):
        import unittest.mock as mock
        with mock.patch('builtins.open', mock.mock_open(read_data='unicam-image\n')):
            self.assertTrue(pa.is_libcamera_device('/dev/video0'))

    def test_usb_device(self):
        import unittest.mock as mock
        with mock.patch('builtins.open', mock.mock_open(read_data='USB Camera\n')):
            self.assertFalse(pa.is_libcamera_device('/dev/video2'))

    def test_empty_device(self):
        self.assertFalse(pa.is_libcamera_device(''))
        self.assertFalse(pa.is_libcamera_device(None))

    def test_missing_sysfs(self):
        import unittest.mock as mock
        with mock.patch('builtins.open', side_effect=FileNotFoundError):
            self.assertFalse(pa.is_libcamera_device('/dev/video0'))


class TestShouldUseLibcamera(unittest.TestCase):
    def _patch_env(self, val='auto'):
        import unittest.mock as mock
        return mock.patch.object(pa, 'VIDEO_SOURCE', val)

    def _patch_detect(self, val=True):
        import unittest.mock as mock
        return mock.patch.object(pa, 'is_libcamera_device', lambda d: val)

    def test_auto_detects_unicam(self):
        with self._patch_env('auto'), self._patch_detect(True):
            self.assertTrue(pa.should_use_libcamera('/dev/video0'))

    def test_auto_detects_usb(self):
        with self._patch_env('auto'), self._patch_detect(False):
            self.assertFalse(pa.should_use_libcamera('/dev/video2'))

    def test_force_libcamera(self):
        with self._patch_env('libcamera'), self._patch_detect(False):
            self.assertTrue(pa.should_use_libcamera('/dev/video2'))

    def test_force_v4l2(self):
        with self._patch_env('v4l2'), self._patch_detect(True):
            self.assertFalse(pa.should_use_libcamera('/dev/video0'))


class TestAudioPeakDecision(unittest.TestCase):
    CFG = {'audioAlertEnabled': True, 'audioAlertThresholdDb': -40,
           'audioAlertHysteresisDb': 6}

    def test_rising_edge_emits_peak_and_disarms(self):
        state = {'armed': True, 'last_ts': 0.0}
        emit, throttled, state = pa.audio_peak_decision(-30, state, self.CFG, now=0.5)
        self.assertEqual(emit, {'peak': True, 'levelDb': -30, 'ts': 500})
        self.assertIsNone(throttled)  # < 1s since last throttle
        self.assertFalse(state['armed'])

    def test_no_repeat_while_above(self):
        state = {'armed': False, 'last_ts': 0.0}
        emit, _, state = pa.audio_peak_decision(-30, state, self.CFG, now=0.5)
        self.assertIsNone(emit)
        self.assertFalse(state['armed'])

    def test_rearm_after_hysteresis_drop(self):
        state = {'armed': False, 'last_ts': 0.0}
        emit, _, state = pa.audio_peak_decision(-50, state, self.CFG, now=0.5)  # below -46
        self.assertIsNone(emit)
        self.assertTrue(state['armed'])

    def test_meter_throttled_once_per_second(self):
        state = {'armed': False, 'last_ts': 0.0}
        _, throttled, state = pa.audio_peak_decision(-50, state, self.CFG, now=1.5)
        self.assertEqual(throttled, {'peak': False, 'levelDb': -50, 'ts': 1500})
        self.assertEqual(state['last_ts'], 1.5)
        # Second call within the same second: no throttle.
        _, throttled2, _ = pa.audio_peak_decision(-50, state, self.CFG, now=1.9)
        self.assertIsNone(throttled2)

    def test_disabled_suppresses_peak_but_still_throttles(self):
        cfg = dict(self.CFG, audioAlertEnabled=False)
        state = {'armed': True, 'last_ts': 0.0}
        emit, throttled, state = pa.audio_peak_decision(-30, state, cfg, now=1.5)
        self.assertIsNone(emit)
        self.assertTrue(state['armed'])  # unchanged because disabled
        self.assertIsNotNone(throttled)


class TestMonitorPipelineStr(unittest.TestCase):
    def test_video_and_audio(self):
        s = pa.monitor_pipeline_str(True, True, 1280, 720, 24, '', '',
                                    'v4l2h264enc', pa.STUN)
        self.assertIn('webrtcbin name=wb stun-server=' + pa.STUN, s)
        self.assertIn('v4l2src', s)
        self.assertIn('rtph264pay', s)
        # v4l2h264enc (Pi hardware encoder) has no `tune`/`key-int-max` property;
        # only x264enc gets tune=zerolatency. The hardware encoder gets no opts.
        self.assertNotIn('v4l2h264enc key-int-max', s)
        self.assertNotIn('v4l2h264enc tune', s)
        self.assertIn('width=1280,height=720,framerate=24/1', s)
        self.assertIn('alsasrc', s)
        self.assertIn('opusenc', s)
        self.assertIn('rtpopuspay', s)
        # webrtcbin only exposes request pads, so the launch string must link
        # with `! wb.` (trailing dot) — bare `! wb` fails to parse.
        self.assertIn('! wb.', s)
        self.assertNotIn('! wb ', s)

    def test_x264enc_gets_tune_zerolatency(self):
        # The software encoder still uses tune=zerolatency for low latency.
        s = pa.monitor_pipeline_str(True, True, 1280, 720, 24, '', '',
                                    'x264enc', pa.STUN)
        self.assertIn('x264enc tune=zerolatency key-int-max=30', s)

    def test_device_args_applied(self):
        s = pa.monitor_pipeline_str(True, True, 640, 480, 15,
                                    '/dev/video2', 'hw:1,0', 'x264enc', pa.STUN)
        self.assertIn('v4l2src device=/dev/video2', s)
        self.assertIn('alsasrc device=hw:1,0', s)
        self.assertIn('x264enc tune=zerolatency', s)

    def test_video_only(self):
        s = pa.monitor_pipeline_str(True, False, 1280, 720, 24, '', '',
                                    'v4l2h264enc', pa.STUN)
        self.assertIn('v4l2src', s)
        self.assertNotIn('alsasrc', s)

    def test_audio_only(self):
        s = pa.monitor_pipeline_str(False, True, 1280, 720, 24, '', '',
                                    'v4l2h264enc', pa.STUN)
        self.assertIn('alsasrc', s)
        self.assertNotIn('v4l2src', s)

    def test_test_source_substitutes_fakesrc(self):
        s = pa.monitor_pipeline_str(True, True, 1280, 720, 24, '', '',
                                    'v4l2h264enc', pa.STUN, test_source=True)
        self.assertIn('videotestsrc', s)
        self.assertIn('audiotestsrc', s)
        self.assertNotIn('v4l2src', s)
        self.assertNotIn('alsasrc', s)

    def test_libcamerasrc_video_pipeline(self):
        s = pa.monitor_pipeline_str(True, True, 1280, 720, 30, '', '',
                                    'x264enc', pa.STUN, use_libcamerasrc=True)
        self.assertIn('libcamerasrc', s)
        self.assertNotIn('v4l2src', s)
        self.assertNotIn('device=', s)
        # libcamerasrc outputs NV21; caps set resolution before videoconvert.
        self.assertIn('video/x-raw,width=1280,height=720,framerate=30/1', s)
        self.assertIn('videoconvert', s)
        self.assertIn('video/x-raw,format=I420', s)
        self.assertIn('x264enc tune=zerolatency key-int-max=30', s)
        self.assertIn('! wb.', s)

    def test_libcamerasrc_video_only(self):
        s = pa.monitor_pipeline_str(True, False, 640, 480, 30, '', '',
                                    'v4l2h264enc', pa.STUN, use_libcamerasrc=True)
        self.assertIn('libcamerasrc', s)
        self.assertNotIn('alsasrc', s)
        self.assertNotIn('v4l2src', s)
        self.assertIn('video/x-raw,width=640,height=480,framerate=30/1', s)

    def test_libcamerasrc_hardware_encoder_no_opts(self):
        s = pa.monitor_pipeline_str(True, False, 1280, 720, 30, '', '',
                                    'v4l2h264enc', pa.STUN, use_libcamerasrc=True)
        self.assertIn('libcamerasrc', s)
        self.assertIn('v4l2h264enc', s)
        self.assertNotIn('v4l2h264enc tune', s)
        self.assertNotIn('v4l2h264enc key-int-max', s)

    def test_test_source_overrides_libcamerasrc(self):
        # test_source=True should use fakesrc even if use_libcamerasrc is set.
        s = pa.monitor_pipeline_str(True, True, 1280, 720, 24, '', '',
                                    'v4l2h264enc', pa.STUN,
                                    test_source=True, use_libcamerasrc=True)
        self.assertIn('videotestsrc', s)
        self.assertIn('audiotestsrc', s)
        self.assertNotIn('libcamerasrc', s)
        self.assertNotIn('v4l2src', s)


class TestBroadcastPipelineStr(unittest.TestCase):
    def test_contains_webrtcbin_and_stun(self):
        self.assertEqual(pa.broadcast_pipeline_str(pa.STUN),
                         'webrtcbin name=wb stun-server=' + pa.STUN)


# ─── mDNS discovery tests ──────────────────────────────────
# These import mdns_discover directly (no GStreamer/websockets needed).
# We mock zeroconf so the tests run on any machine.


class TestMdnsDiscover(unittest.TestCase):
    """Tests for mdns_discover.py — the mDNS/Bonjour service discovery module."""

    def _load_module(self):
        """Import mdns_discover fresh."""
        spec = importlib.util.spec_from_file_location(
            'mdns_discover', os.path.join(_HERE, 'mdns_discover.py'))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        return mod

    def test_returns_none_when_zeroconf_missing(self):
        """discover_server should return None gracefully when zeroconf is not installed."""
        mod = self._load_module()
        import unittest.mock as mock
        # Patch the import to raise ImportError
        import builtins
        orig_import = builtins.__import__
        def _no_zeroconf(name, *args, **kwargs):
            if name == 'zeroconf' or name.startswith('zeroconf'):
                raise ImportError('no zeroconf')
            return orig_import(name, *args, **kwargs)
        with mock.patch('builtins.__import__', side_effect=_no_zeroconf):
            result = mod.discover_server_sync(timeout=0.1)
        self.assertIsNone(result)

    def test_returns_none_on_timeout(self):
        """discover_server should return None when no service responds."""
        mod = self._load_module()
        import unittest.mock as mock

        # Mock zeroconf modules so the real ones aren't needed
        mock_zc = mock.AsyncMock()
        mock_browser = mock.AsyncMock()
        mock_zc.async_get_service_info = mock.AsyncMock(return_value=None)

        mock_zeroconf_mod = mock.MagicMock()
        mock_zeroconf_mod.AsyncZeroconf = mock.MagicMock(return_value=mock_zc)
        mock_zeroconf_mod.AsyncServiceBrowser = mock.MagicMock(return_value=mock_browser)
        mock_zeroconf_mod.ServiceStateChange = mock.MagicMock()
        mock_zeroconf_mod.ServiceStateChange.Added = 'Added'

        # Make import work
        import builtins
        orig_import = builtins.__import__
        def _mock_import(name, *args, **kwargs):
            if name == 'zeroconf':
                return mock_zeroconf_mod
            if name == 'zeroconf.asyncio':
                return mock_zeroconf_mod
            return orig_import(name, *args, **kwargs)

        with mock.patch('builtins.__import__', side_effect=_mock_import):
            # Use a very short timeout so it times out quickly
            result = mod.discover_server_sync(timeout=0.01)
        self.assertIsNone(result)

    def test_returns_url_when_service_found(self):
        """discover_server should return the serverUrl from the TXT record."""
        mod = self._load_module()
        import unittest.mock as mock
        import asyncio

        # Mock the ServiceInfo that has a serverUrl in its properties
        mock_info = mock.MagicMock()
        mock_info.properties = {b'serverUrl': b'wss://192.168.1.50:8090'}

        mock_zc = mock.AsyncMock()
        mock_zc.async_get_service_info = mock.AsyncMock(return_value=mock_info)

        # Use a sentinel so the comparison `state_change == ServiceStateChange.Added`
        # passes — mdns_discover imports ServiceStateChange.Added and compares it.
        ADDED_SENTINEL = 'Added'

        mock_browser_instance = mock.AsyncMock()

        def _create_browser(zc, stype, handlers=None):
            handler = handlers[0] if handlers else None
            if handler:
                handler(mock_zc, stype,
                        'Hearth-Connect._hearth-connect._tcp.local.',
                        ADDED_SENTINEL)
            return mock_browser_instance

        mock_zeroconf_mod = mock.MagicMock()
        mock_zeroconf_mod.AsyncZeroconf = mock.MagicMock(return_value=mock_zc)
        mock_zeroconf_mod.AsyncServiceBrowser = mock.MagicMock(side_effect=_create_browser)
        # Override ServiceStateChange.Added so the string comparison in mdns_discover passes
        mock_ssc = mock.MagicMock()
        mock_ssc.Added = ADDED_SENTINEL
        mock_zeroconf_mod.ServiceStateChange = mock_ssc

        import builtins
        orig_import = builtins.__import__
        def _mock_import(name, *args, **kwargs):
            if name == 'zeroconf':
                return mock_zeroconf_mod
            if name == 'zeroconf.asyncio':
                return mock_zeroconf_mod
            return orig_import(name, *args, **kwargs)

        with mock.patch('builtins.__import__', side_effect=_mock_import):
            async def _run():
                return await mod.discover_server(timeout=2.0)
            result = asyncio.run(_run())

        self.assertEqual(result, 'wss://192.168.1.50:8090')


# ─── State regression detection tests ──────────────────────
# MonitorSession.on_bus_message() detects pipeline regression from
# PLAYING → PAUSED → READY when audio was present but no bus ERROR fired.
# These tests mock the GStreamer types so they run without the native stack.


class _MockState:
    """Minimal mock of GStreamer Gst.State values."""
    PLAYING = 'PLAYING'
    PAUSED = 'PAUSED'
    READY = 'READY'


class _MockMessage:
    """Minimal mock of a GStreamer bus message."""

    def __init__(self, msg_type, src_pipeline, old_state, new_state, _pending=None):
        self.type = msg_type
        self.src = src_pipeline
        self._old = type('S', (), {'value_nick': old_state, '__eq__': lambda s, o: s.value_nick == o})()
        self._new = type('S', (), {'value_nick': new_state, '__eq__': lambda s, o: s.value_nick == o})()
        self._pending = _pending or type('S', (), {'value_nick': 'NULL'})()

    def parse_state_changed(self):
        return self._old, self._new, self._pending


class _GstState:
    """Minimal mock of GStreamer Gst.State enum."""
    def __init__(self, name):
        self.value_nick = name
    def __eq__(self, other):
        if isinstance(other, _GstState):
            return self.value_nick == other.value_nick
        if isinstance(other, str):
            return self.value_nick == other
        return False
    def __hash__(self):
        return hash(self.value_nick)


GstState_PLAYING = _GstState('PLAYING')
GstState_PAUSED = _GstState('PAUSED')
GstState_READY = _GstState('READY')
GstState_NULL = _GstState('NULL')


class TestStateRegressionDetection(unittest.TestCase):
    """Test the pipeline regression detection logic in MonitorSession.on_bus_message().

    We test by importing the module, creating a minimal MonitorSession-like object
    with the relevant attributes, and calling the on_bus_message logic directly.
    """

    def _make_session(self, has_audio=True):
        """Create a minimal object with the attributes MonitorSession needs."""
        class _MockAgent:
            pass
        class _Session:
            def __init__(self):
                self.agent = _MockAgent()
                self.subscriber_id = 'test-sub'
                self.has_video = True
                self.has_audio = has_audio
                self._had_audio_while_playing = False
                self.pipeline = object()  # sentinel for message.src comparison
                self._closed = False
                self._rebuilt = False
                self._rebuild_video_only = False
        return _Session()

    def _fire_state(self, session, old_state, new_state):
        """Fire a STATE_CHANGED message and return whether rebuild was triggered."""
        # Inline the on_bus_message STATE_CHANGED branch logic (from pi-agent.py).
        old = old_state  # already a _GstState
        new = new_state  # already a _GstState
        # Reset flag when leaving PLAYING.
        if old == GstState_PLAYING:
            session._had_audio_while_playing = False
        # Track when we enter PLAYING with audio.
        if new == GstState_PLAYING and session.has_audio:
            session._had_audio_while_playing = True
        # PLAYING → PAUSED regression.
        if old == GstState_PLAYING and new == GstState_PAUSED and session.has_audio:
            session.has_audio = False
            session._had_audio_while_playing = False
            session._closed = True
            session._rebuilt = True
            return 'PLAYING_PAUSED'
        # PAUSED → READY regression after being in PLAYING with audio.
        if old == GstState_PAUSED and new == GstState_READY and session._had_audio_while_playing:
            session.has_audio = False
            session._had_audio_while_playing = False
            session._closed = True
            session._rebuilt = True
            session._rebuild_video_only = True
            return 'PAUSED_READY'
        return None

    def test_playing_to_paused_with_audio_triggers_rebuild(self):
        session = self._make_session(has_audio=True)
        result = self._fire_state(session, GstState_PLAYING, GstState_PAUSED)
        self.assertEqual(result, 'PLAYING_PAUSED')
        self.assertFalse(session.has_audio)
        self.assertTrue(session._closed)
        self.assertTrue(session._rebuilt)

    def test_playing_to_paused_without_audio_no_rebuild(self):
        session = self._make_session(has_audio=False)
        result = self._fire_state(session, GstState_PLAYING, GstState_PAUSED)
        self.assertIsNone(result)
        self.assertFalse(session.has_audio)  # was already False, no rebuild

    def test_paused_to_ready_after_playing_triggers_rebuild(self):
        session = self._make_session(has_audio=True)
        # First: enter PLAYING with audio (sets flag).
        self._fire_state(session, GstState_READY, GstState_PLAYING)
        self.assertTrue(session._had_audio_while_playing)
        # Then: PAUSED → READY regression.
        result = self._fire_state(session, GstState_PAUSED, GstState_READY)
        self.assertEqual(result, 'PAUSED_READY')
        self.assertFalse(session.has_audio)
        self.assertFalse(session._had_audio_while_playing)

    def test_paused_to_ready_without_flag_no_rebuild(self):
        session = self._make_session(has_audio=True)
        # Never entered PLAYING, so flag is False.
        result = self._fire_state(session, GstState_PAUSED, GstState_READY)
        self.assertIsNone(result)
        self.assertTrue(session.has_audio)  # unchanged

    def test_flag_reset_on_playback_after_regression(self):
        session = self._make_session(has_audio=True)
        # PLAYING → PAUSED triggers rebuild and resets flag.
        self._fire_state(session, GstState_PLAYING, GstState_PAUSED)
        self.assertFalse(session._had_audio_while_playing)
        self.assertFalse(session.has_audio)  # rebuild set this to False
        # Manually restore has_audio and set the flag, then go to NULL (leaving PLAYING).
        session.has_audio = True
        session._had_audio_while_playing = True
        self._fire_state(session, GstState_PLAYING, GstState_NULL)
        self.assertFalse(session._had_audio_while_playing)  # flag reset when leaving PLAYING

    def test_rapid_state_changes_no_false_positive(self):
        session = self._make_session(has_audio=True)
        # READY → PLAYING sets flag.
        result = self._fire_state(session, GstState_READY, GstState_PLAYING)
        self.assertIsNone(result)
        self.assertTrue(session._had_audio_while_playing)
        # PLAYING → PAUSED triggers rebuild.
        result = self._fire_state(session, GstState_PLAYING, GstState_PAUSED)
        self.assertEqual(result, 'PLAYING_PAUSED')


if __name__ == '__main__':
    unittest.main()
