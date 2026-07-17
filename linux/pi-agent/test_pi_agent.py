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


class TestSourceType(unittest.TestCase):
    def test_combos(self):
        self.assertEqual(pa.source_type(True, True), 'video+audio')
        self.assertEqual(pa.source_type(True, False), 'video-only')
        self.assertEqual(pa.source_type(False, True), 'audio-only')
        self.assertEqual(pa.source_type(False, False), 'none')


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
        self.assertIn('level', s)  # audio-threshold element present
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


class TestBroadcastPipelineStr(unittest.TestCase):
    def test_contains_webrtcbin_and_stun(self):
        self.assertEqual(pa.broadcast_pipeline_str(pa.STUN),
                         'webrtcbin name=wb stun-server=' + pa.STUN)


if __name__ == '__main__':
    unittest.main()
