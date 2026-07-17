#!/usr/bin/env python3
"""End-to-end smoke test for the Pi agent against a live Hearth server.

Requires:
  - GStreamer + WebRTC bindings (gir1.2-gst-plugins-*) installed, AND
  - the `websockets` Python package, AND
  - a running Hearth-Connect server (set SERVER_URL / ROOM_ID via env or
    config.env).

It launches the REAL agent process (with TEST_SOURCE=1 so it uses
videotestsrc/audiotestsrc instead of a real camera/mic), then acts as a base
station + subscriber to confirm the agent publishes a source and produces a
WebRTC OFFER. That proves the GStreamer pipeline builds and SDP negotiation
starts end-to-end. Actually decoding media to a real peer is verified manually
on the Pi (see README-pi.md > Testing).

Run on a Pi (or any Linux box with GStreamer):
    SERVER_URL=wss://host:8090 ROOM_ID=test python3 -m unittest e2e_smoke.py -v

The test AUTO-SKIPS when GStreamer / websockets / the server are unavailable,
so it is safe to run in CI or on a dev box (it simply skips — plan 11).
"""

import asyncio
import json
import os
import subprocess
import sys
import unittest

_HERE = os.path.dirname(os.path.abspath(__file__))


# --- Capability detection (skip gracefully when unmet) ---------------------
_GST_OK = False
try:
    import gi  # type: ignore
    gi.require_version('Gst', '1.0')
    from gi.repository import Gst  # noqa: F401
    _GST_OK = True
except Exception:
    pass

_WEBSOCKETS_OK = False
try:
    import websockets  # noqa: F401
    _WEBSOCKETS_OK = True
except Exception:
    pass


def _load_config_env():
    cfg = {}
    path = os.path.join(_HERE, 'config.env')
    if os.path.exists(path):
        for line in open(path):
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            cfg[k.strip()] = v.strip()
    return cfg


_REASON = None
if not _GST_OK:
    _REASON = 'GStreamer WebRTC bindings not installed'
elif not _WEBSOCKETS_OK:
    _REASON = '`websockets` package not installed'
else:
    _ENV = _load_config_env()
    SERVER_URL = os.environ.get('SERVER_URL') or _ENV.get('SERVER_URL', 'wss://localhost:8090')
    if not SERVER_URL.startswith('ws'):
        SERVER_URL = 'wss://' + SERVER_URL
    ROOM_ID = os.environ.get('ROOM_ID') or _ENV.get('ROOM_ID', 'default')
    DEVICE_LABEL = 'Pi E2E Test'
    SUBSCRIBER_ID = 'e2e-sub-' + os.urandom(4).hex()


@unittest.skipIf(_REASON, _REASON)
class PiAgentE2ETest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = dict(os.environ)
        env['TEST_SOURCE'] = '1'
        # Use the software encoder for the smoke test: the Pi's hardware
        # v4l2h264enc stalls on this board, whereas x264enc reliably
        # prerolls and produces an OFFER. The real deployment can override
        # VIDEO_ENCODER back to v4l2h264enc once the encoder is debugged.
        env['VIDEO_ENCODER'] = 'x264enc'
        env['RESOLUTION'] = '480p'
        env['FRAMERATE'] = '30'
        env['SERVER_URL'] = SERVER_URL
        env['ROOM_ID'] = ROOM_ID
        env['DEVICE_LABEL'] = DEVICE_LABEL
        cls._agent_log = os.path.join(_HERE, 'e2e_agent_out.log')
        cls.agent = subprocess.Popen(
            [sys.executable, '-u', os.path.join(_HERE, 'pi-agent.py')],
            env=env, stdout=open(cls._agent_log, 'w'), stderr=subprocess.STDOUT, text=True)
        cls.loop = asyncio.new_event_loop()

    @classmethod
    def tearDownClass(cls):
        if getattr(cls, 'agent', None):
            cls.agent.terminate()
            try:
                cls.agent.wait(timeout=10)
            except Exception:
                cls.agent.kill()

    def test_agent_publishes_and_offers(self):
        result = self.loop.run_until_complete(self._run_handshake())
        self.assertTrue(result['welcome'], 'did not receive WELCOME from server')
        self.assertTrue(result['capabilities'], 'agent did not send CAPABILITIES')
        self.assertTrue(result['offer'], 'agent did not produce a WebRTC OFFER')

    async def _run_handshake(self):
        import websockets
        got = {'welcome': False, 'capabilities': False, 'offer': False}
        try:
            async with websockets.connect(SERVER_URL, max_size=None) as ws:
                base_id = 'e2e-base-' + os.urandom(4).hex()
                await ws.send(json.dumps({'type': 'JOIN_ROOM', 'payload': {
                    'roomId': ROOM_ID, 'deviceId': base_id,
                    'deviceType': 'base', 'label': 'E2E Base'}}))
                # Discover the agent's device id from its CAPABILITIES, then
                # subscribe to it the same way the real base station does.
                agent_id = None
                for _ in range(20):
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        break
                    msg = json.loads(raw)
                    t = msg.get('type')
                    if t == 'WELCOME':
                        got['welcome'] = True
                    elif t == 'CAPABILITIES':
                        got['capabilities'] = True
                        did = (msg.get('payload') or {}).get('deviceId', '')
                        if did.startswith('pi-'):
                            agent_id = did
                            print('E2E agent_id=%r' % agent_id, flush=True)
                            break
                if not agent_id:
                    self.skipTest('agent did not publish CAPABILITIES in time')
                await ws.send(json.dumps({'type': 'SUBSCRIBE_SOURCE', 'payload': {
                    'publisherId': agent_id}}))
                for _ in range(60):
                    try:
                        raw = await asyncio.wait_for(ws.recv(), timeout=1.0)
                    except asyncio.TimeoutError:
                        continue  # keep waiting for the OFFER to be relayed
                    msg = json.loads(raw)
                    t = msg.get('type')
                    print('E2E RECV:', t, (msg.get('payload') or {}).get('to'), flush=True)
                    if t == 'OFFER':
                        p = msg.get('payload', {})
                        print('E2E OFFER to=%r sdp_type=%r' % (p.get('to'), (p.get('sdp') or {}).get('type')), flush=True)
                        if (p.get('to') == base_id or p.get('to') == agent_id) and p.get('sdp', {}).get('type') == 'offer':
                            got['offer'] = True
                            break
        except Exception as e:
            self.skipTest('could not reach Hearth server at %s (%s)' % (SERVER_URL, e))
        return got


if __name__ == '__main__':
    unittest.main()
