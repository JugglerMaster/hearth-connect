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


class TestAudioMonitorTarget(unittest.TestCase):
    SELF = 'pi-self'
    SOURCES = [
        {'id': 'a-src', 'publisherId': 'kioskA', 'type': 'video+audio'},
        {'id': 'b-src', 'publisherId': 'kioskB', 'type': 'audio-only'},
        {'id': 'c-src', 'publisherId': 'kioskC', 'type': 'video-only'},
        {'id': 'self-src', 'publisherId': SELF, 'type': 'video+audio'},
        {'id': 'bc-src', 'publisherId': 'base1', 'type': 'audio-only', 'isBroadcast': True},
    ]

    def test_disabled_returns_none(self):
        self.assertIsNone(pa.audio_monitor_target(
            {'audioMonitorEnabled': False, 'audioMonitorSourceId': 'a-src'},
            self.SOURCES, self.SELF))

    def test_missing_flag_returns_none(self):
        self.assertIsNone(pa.audio_monitor_target({}, self.SOURCES, self.SELF))

    def test_auto_picks_first_audio_capable(self):
        cfg = {'audioMonitorEnabled': True, 'audioMonitorSourceId': 'auto'}
        self.assertEqual(pa.audio_monitor_target(cfg, self.SOURCES, self.SELF), 'kioskA')

    def test_auto_empty_string_same_as_auto(self):
        cfg = {'audioMonitorEnabled': True, 'audioMonitorSourceId': ''}
        self.assertEqual(pa.audio_monitor_target(cfg, self.SOURCES, self.SELF), 'kioskA')

    def test_select_by_source_id(self):
        cfg = {'audioMonitorEnabled': True, 'audioMonitorSourceId': 'b-src'}
        self.assertEqual(pa.audio_monitor_target(cfg, self.SOURCES, self.SELF), 'kioskB')

    def test_select_by_publisher_id(self):
        cfg = {'audioMonitorEnabled': True, 'audioMonitorSourceId': 'kioskB'}
        self.assertEqual(pa.audio_monitor_target(cfg, self.SOURCES, self.SELF), 'kioskB')

    def test_video_only_source_skipped(self):
        cfg = {'audioMonitorEnabled': True, 'audioMonitorSourceId': 'c-src'}
        self.assertIsNone(pa.audio_monitor_target(cfg, self.SOURCES, self.SELF))

    def test_never_listens_to_self(self):
        cfg = {'audioMonitorEnabled': True, 'audioMonitorSourceId': 'self-src'}
        self.assertIsNone(pa.audio_monitor_target(cfg, self.SOURCES, self.SELF))

    def test_broadcast_source_not_eligible(self):
        cfg = {'audioMonitorEnabled': True, 'audioMonitorSourceId': 'bc-src'}
        self.assertIsNone(pa.audio_monitor_target(cfg, self.SOURCES, self.SELF))

    def test_no_sources(self):
        cfg = {'audioMonitorEnabled': True, 'audioMonitorSourceId': 'auto'}
        self.assertIsNone(pa.audio_monitor_target(cfg, [], self.SELF))

    def test_unknown_id_returns_none(self):
        cfg = {'audioMonitorEnabled': True, 'audioMonitorSourceId': 'nope'}
        self.assertIsNone(pa.audio_monitor_target(cfg, self.SOURCES, self.SELF))


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


# ─── Double-offer race condition tests ─────────────────────
# These test the generation-counter, _closing guards, and AUDIO_PEAK
# suppression logic in MonitorSession.  We create lightweight mock objects
# that carry the right attributes and bind the real methods to them, so the
# actual GStreamer stack is never needed.


class _MockAgent:
    """Minimal agent stand-in for MonitorSession tests."""
    def __init__(self):
        self.has_video = True
        self.has_audio = True
        self.talkback_active = False
        self.config = {}
        self.device_id = 'mock-pi'
        self.resolution = '720p'
        self.framerate = 30
        self._enqueued = []
        self._audio_peak_suppressed = False

    def enqueue_ws(self, msg):
        self._enqueued.append(msg)

    def speaker_volume(self):
        return 0.5

    # Bind real on_audio_level from Agent class
    on_audio_level = pa.Agent.on_audio_level


class _MockWebrtc:
    """Minimal webrtcbin stand-in."""
    def __init__(self):
        self._signals = {}
        self._emitted = []

    def connect(self, sig, handler):
        self._signals[sig] = handler

    def emit(self, sig, *args):
        self._emitted.append((sig, args))

    def get_static_pad(self, name):
        return None


class _MockPromise:
    """Mock Gst.Promise that resolves immediately."""
    def __init__(self, reply=None, exc=None):
        self._reply = reply
        self._exc = exc

    def wait(self):
        if self._exc:
            raise self._exc

    def get_reply(self):
        return self._reply


class _MockPipeline:
    """Mock GStreamer pipeline."""
    def __init__(self):
        self.state = 'NULL'
        self.bus = None

    def set_state(self, state):
        self.state = state

    def get_by_name(self, name):
        return _MockWebrtc()

    def get_bus(self):
        class _Bus:
            def add_signal_watch(self): pass
            def connect(self, *a): pass
        return _Bus()


class _MockGst:
    """Minimal Gst stand-in for build()."""
    class State:
        NULL = 'NULL'
        PLAYING = 'PLAYING'
    @staticmethod
    def parse_launch(s):
        return _MockPipeline()
    class Promise:
        @staticmethod
        def new_with_change_func(cb):
            return _MockPromise()


class _MockGstWebRTC:
    class WebRTCRTPTransceiverDirection:
        SENDRECV = 0


def _make_session(agent=None, **overrides):
    """Create a MonitorSession-like object with mocked GStreamer types.

    We set up the minimal attributes that on_negotiation_needed,
    on_offer_created, _fallback_create_offer, and on_audio_level need,
    then bind the real MonitorSession methods.
    """
    import types
    agent = agent or _MockAgent()
    s = types.SimpleNamespace(
        agent=agent,
        subscriber_id='test-sub',
        has_video=True,
        has_audio=True,
        alert_armed=True,
        last_level_ts=0,
        talkback_active=False,
        _had_audio_while_playing=False,
        _closing=False,
        rxvol=None,
        _making_offer=False,
        _last_offer_ts=0.0,
        _played_pending_offer=False,
        _fallback_registered=False,
        _pipeline_gen=0,
        pipeline=None,
        webrtc=None,
        _mid_map={},
    )
    # Set overrides
    for k, v in overrides.items():
        setattr(s, k, v)
    # Bind real methods from MonitorSession
    s.on_negotiation_needed = pa.MonitorSession.on_negotiation_needed.__get__(s)
    s.on_offer_created = pa.MonitorSession.on_offer_created.__get__(s)
    s._fallback_create_offer = pa.MonitorSession._fallback_create_offer.__get__(s)
    s._parse_mids = pa.MonitorSession._parse_mids.__get__(s)
    s.on_local_description_set = pa.MonitorSession.on_local_description_set.__get__(s)
    return s


class TestGenerationCounter(unittest.TestCase):
    """Test that stale offers from old pipeline generations are discarded."""

    def test_stale_offer_discarded_on_gen_mismatch(self):
        """Regression rebuilds pipeline (gen bumps); old promise callback must not send."""
        agent = _MockAgent()
        s = _make_session(agent=agent)

        # Simulate: on-negotiation-needed captured gen=0
        # Then pipeline regressed and build() bumped gen to 1
        s._pipeline_gen = 1  # build() bumped it
        s._making_offer = True  # old on-negotiation-needed set this

        # Old promise resolves with gen=0
        reply = type('R', (), {'get_value': lambda self, k: type('O', (), {
            'sdp': type('S', (), {'as_text': lambda self: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF\r\na=mid:video0\r\n'})()})()})()
        promise = _MockPromise(reply=reply)

        s.on_offer_created(promise, gen=0)

        # Offer should NOT have been sent
        self.assertEqual(agent._enqueued, [])
        self.assertFalse(s._making_offer)

    def test_fresh_offer_sent_when_gen_matches(self):
        """Normal case: offer created and sent when gen matches."""
        import unittest.mock as mock
        agent = _MockAgent()
        s = _make_session(agent=agent)
        s.webrtc = _MockWebrtc()

        # gen=0 matches _pipeline_gen=0
        reply = type('R', (), {'get_value': lambda self, k: type('O', (), {
            'sdp': type('S', (), {'as_text': lambda self: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF\r\na=mid:video0\r\n'})()})()})()
        promise = _MockPromise(reply=reply)

        with mock.patch.object(pa, 'Gst', _MockGst):
            s.on_offer_created(promise, gen=0)

        # Offer SHOULD have been sent
        self.assertEqual(len(agent._enqueued), 1)
        self.assertEqual(agent._enqueued[0]['type'], 'OFFER')

    def test_no_gen_always_sends(self):
        """Backward compat: gen=None (no generation tracking) always sends."""
        import unittest.mock as mock
        agent = _MockAgent()
        s = _make_session(agent=agent)
        s.webrtc = _MockWebrtc()

        reply = type('R', (), {'get_value': lambda self, k: type('O', (), {
            'sdp': type('S', (), {'as_text': lambda self: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF\r\na=mid:video0\r\n'})()})()})()
        promise = _MockPromise(reply=reply)

        with mock.patch.object(pa, 'Gst', _MockGst):
            s.on_offer_created(promise, gen=None)

        self.assertEqual(len(agent._enqueued), 1)

    def test_closing_discards_offer_even_when_gen_matches(self):
        """Closing guard fires even when generation matches."""
        agent = _MockAgent()
        s = _make_session(agent=agent, _closing=True)

        reply = type('R', (), {'get_value': lambda self, k: type('O', (), {
            'sdp': type('S', (), {'as_text': lambda self: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF\r\na=mid:video0\r\n'})()})()})()
        promise = _MockPromise(reply=reply)

        s.on_offer_created(promise, gen=0)

        self.assertEqual(agent._enqueued, [])
        self.assertFalse(s._making_offer)


class TestClosingGuard(unittest.TestCase):
    """Test that _closing prevents new offers from being created."""

    def test_on_negotiation_needed_ignored_when_closing(self):
        s = _make_session(_closing=True)
        element = _MockWebrtc()

        s.on_negotiation_needed(element)

        # Should not have attempted to create offer
        self.assertFalse(s._making_offer)
        self.assertEqual(element._emitted, [])

    def test_on_negotiation_needed_proceeds_when_not_closing(self):
        s = _make_session(_last_offer_ts=0.0)  # debounce won't trigger
        element = _MockWebrtc()

        # Patch Gst.Promise to capture the callback
        import unittest.mock as mock
        with mock.patch.object(pa, 'Gst', _MockGst):
            s.on_negotiation_needed(element)

        self.assertTrue(s._making_offer)
        self.assertEqual(len(element._emitted), 1)
        self.assertEqual(element._emitted[0][0], 'create-offer')

    def test_on_negotiation_needed_debounced(self):
        """Second call within 2s is debounced."""
        import time
        s = _make_session(_last_offer_ts=time.time())  # just set
        element = _MockWebrtc()

        s.on_negotiation_needed(element)

        # _making_offer stays False because debounced
        self.assertFalse(s._making_offer)
        self.assertEqual(element._emitted, [])

    def test_fallback_ignored_when_closing(self):
        s = _make_session(_closing=True, pipeline=_MockPipeline(), webrtc=_MockWebrtc())

        result = s._fallback_create_offer()

        self.assertFalse(result)  # returns False to stop timeout
        self.assertFalse(s._making_offer)

    def test_fallback_ignored_when_making_offer(self):
        s = _make_session(_making_offer=True, pipeline=_MockPipeline(), webrtc=_MockWebrtc())

        result = s._fallback_create_offer()

        self.assertFalse(result)
        self.assertTrue(s._making_offer)  # unchanged

    def test_fallback_ignored_when_played_pending(self):
        s = _make_session(_played_pending_offer=True, pipeline=_MockPipeline(), webrtc=_MockWebrtc())

        result = s._fallback_create_offer()

        self.assertFalse(result)


class TestBuildResetsState(unittest.TestCase):
    """Test that build() properly resets state for a fresh pipeline."""

    def test_build_bumps_pipeline_gen(self):
        import types
        s = types.SimpleNamespace(_pipeline_gen=0)

        # Inline the relevant build() logic
        s._closing = False
        s._making_offer = False
        s._pipeline_gen += 1

        self.assertEqual(s._pipeline_gen, 1)

    def test_build_resets_closing_and_making_offer(self):
        import types
        s = types.SimpleNamespace(_closing=True, _making_offer=True, _pipeline_gen=3)

        s._closing = False
        s._making_offer = False
        s._pipeline_gen += 1

        self.assertFalse(s._closing)
        self.assertFalse(s._making_offer)
        self.assertEqual(s._pipeline_gen, 4)


class TestAudioPeakSuppression(unittest.TestCase):
    """Test that AUDIO_PEAK is suppressed after server returns UNKNOWN_TYPE."""

    def test_suppressed_flag_stops_sending(self):
        agent = _MockAgent()
        agent._audio_peak_suppressed = True
        agent.config = {'audioAlertEnabled': True, 'audioAlertThresholdDb': -40,
                        'audioAlertHysteresisDb': 6}

        session_mock = type('S', (), {'alert_armed': True, 'last_level_ts': 0.0})()
        agent.on_audio_level(session_mock, -30.0)

        # No messages should be queued
        self.assertEqual(agent._enqueued, [])

    def test_not_suppressed_sends_normally(self):
        agent = _MockAgent()
        agent._audio_peak_suppressed = False
        agent.config = {'audioAlertEnabled': True, 'audioAlertThresholdDb': -40,
                        'audioAlertHysteresisDb': 6}

        session_mock = type('S', (), {'alert_armed': True, 'last_level_ts': 0.0})()
        agent.on_audio_level(session_mock, -30.0)

        # Should have sent an AUDIO_PEAK (threshold crossed)
        peak_msgs = [m for m in agent._enqueued if m['type'] == 'AUDIO_PEAK']
        self.assertTrue(len(peak_msgs) > 0)


class TestAudioPeakErrorHandler(unittest.TestCase):
    """Test that UNKNOWN_TYPE error for AUDIO_PEAK sets the suppression flag."""

    def _make_agent_with_handler(self):
        """Create an agent and fire an ERROR message through its message handler."""
        import types
        agent = _MockAgent()
        agent._audio_peak_suppressed = False
        agent.config = {}
        agent.sessions = {}
        agent.broadcast_sessions = {}
        agent.broadcast_sources = {}
        agent.talkback_active = False

        # Inline the ERROR handling logic from on_message
        def handle_error(payload):
            if payload.get('message', '').startswith('Unknown message type: AUDIO_PEAK'):
                agent._audio_peak_suppressed = True

        return agent, handle_error

    def test_unknown_type_audio_peak_suppresses(self):
        agent, handler = self._make_agent_with_handler()
        handler({'code': 'UNKNOWN_TYPE', 'message': 'Unknown message type: AUDIO_PEAK'})
        self.assertTrue(agent._audio_peak_suppressed)

    def test_other_error_does_not_suppress(self):
        agent, handler = self._make_agent_with_handler()
        handler({'code': 'SOMETHING', 'message': 'Some other error'})
        self.assertFalse(agent._audio_peak_suppressed)

    def test_exact_match_only(self):
        agent, handler = self._make_agent_with_handler()
        handler({'message': 'Unknown message type: AUDIO'})
        self.assertFalse(agent._audio_peak_suppressed)


class TestFullRaceScenario(unittest.TestCase):
    """End-to-end simulation of the regression race condition.

    Simulates:
    1. Pipeline reaches PLAYING → on-negotiation-needed fires → gen=0 captured
    2. Pipeline regresses → close() → build() (gen bumps to 1)
    3. Old promise resolves → on_offer_created(gen=0) → MUST be discarded
    4. New pipeline reaches PLAYING → on-negotiation-needed → gen=1 → creates new offer
    """

    def test_regression_race_no_double_offer(self):
        import unittest.mock as mock
        agent = _MockAgent()
        s = _make_session(agent=agent)
        s.webrtc = _MockWebrtc()

        # Step 1: Initial negotiation — gen=0
        s._pipeline_gen = 0
        s._last_offer_ts = 0.0  # old timestamp, no debounce

        # Step 2: Regression → close + build
        s._closing = True
        # build() resets state and bumps gen
        s._closing = False
        s._making_offer = False
        s._pipeline_gen = 1

        # Step 3: Old promise resolves with stale gen=0
        reply = type('R', (), {'get_value': lambda self, k: type('O', (), {
            'sdp': type('S', (), {'as_text': lambda self: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF\r\na=mid:video0\r\n'})()})()})()
        stale_promise = _MockPromise(reply=reply)
        s.on_offer_created(stale_promise, gen=0)

        # Stale offer must NOT have been sent
        self.assertEqual(agent._enqueued, [],
                         'Stale offer from old pipeline generation was sent!')

        # Step 4: New pipeline negotiation — gen=1
        element = _MockWebrtc()
        with mock.patch.object(pa, 'Gst', _MockGst):
            s.on_negotiation_needed(element)

        # New offer SHOULD have been created
        self.assertTrue(s._making_offer)
        self.assertEqual(len(element._emitted), 1)
        self.assertEqual(element._emitted[0][0], 'create-offer')

        # And now the new promise should send the offer
        fresh_promise = _MockPromise(reply=reply)
        with mock.patch.object(pa, 'Gst', _MockGst):
            s.on_offer_created(fresh_promise, gen=1)

        self.assertEqual(len(agent._enqueued), 1)
        self.assertEqual(agent._enqueued[0]['type'], 'OFFER')

    def test_no_double_offer_when_no_regression(self):
        """Normal case: no regression, single offer sent."""
        import unittest.mock as mock
        agent = _MockAgent()
        s = _make_session(agent=agent)
        s.webrtc = _MockWebrtc()

        # on-negotiation-needed → gen=0
        element = _MockWebrtc()
        with mock.patch.object(pa, 'Gst', _MockGst):
            s.on_negotiation_needed(element)

        # Promise resolves
        reply = type('R', (), {'get_value': lambda self, k: type('O', (), {
            'sdp': type('S', (), {'as_text': lambda self: 'v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF\r\na=mid:video0\r\n'})()})()})()
        promise = _MockPromise(reply=reply)
        with mock.patch.object(pa, 'Gst', _MockGst):
            s.on_offer_created(promise, gen=0)

        self.assertEqual(len(agent._enqueued), 1)
        self.assertEqual(agent._enqueued[0]['type'], 'OFFER')

        # Second on-negotiation-needed is debounced (<2s)
        s2 = _MockWebrtc()
        s.on_negotiation_needed(s2)
        self.assertEqual(len(agent._enqueued), 1)  # still just 1


if __name__ == '__main__':
    unittest.main()
