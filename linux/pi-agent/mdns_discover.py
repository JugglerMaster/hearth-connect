"""mDNS / Bonjour service discovery for Hearth-Connect.

Queries the local network for a Hearth-Connect server published via
_hearth-connect._tcp.local. (see server/src/index.ts publishMdns()).

Designed to be imported lazily by pi-agent.py — only called when SERVER_URL
is unset or the configured server is unreachable.  The ``zeroconf`` package
must be installed (via ``apt install python3-zeroconf`` or
``pip install zeroconf``).
"""

import asyncio
import logging
import socket
from typing import Optional

log = logging.getLogger('hearth-pi-agent.mdns')

SERVICE_TYPE = '_hearth-connect._tcp.local.'

# How long to wait for a single mDNS response before giving up.
DEFAULT_TIMEOUT = 5.0


async def discover_server(timeout: float = DEFAULT_TIMEOUT) -> Optional[str]:
    """Browse the LAN for a Hearth-Connect server.

    Returns the ``serverUrl`` from the first responding service's TXT record,
    or ``None`` if nothing is found within *timeout* seconds.
    """
    try:
        from zeroconf.asyncio import AsyncZeroconf, AsyncServiceBrowser
        from zeroconf import ServiceStateChange
    except ImportError:
        log.warning('zeroconf package not installed — mDNS discovery unavailable')
        return None

    found_url: Optional[str] = None
    event = asyncio.Event()

    def on_state_change(zeroconf, service_type, name, state_change, **_kw):
        if state_change == ServiceStateChange.Added:
            asyncio.ensure_future(_resolve(name, service_type))

    async def _resolve(name, stype):
        nonlocal found_url
        info = await zc.async_get_service_info(stype, name)
        if info and info.properties:
            url = info.properties.get(b'serverUrl')
            if url:
                found_url = url.decode('utf-8') if isinstance(url, bytes) else url
                log.info('mDNS discovered server: %s', found_url)
                event.set()

    zc = None
    browser = None
    try:
        zc = AsyncZeroconf()
        # Pass the underlying Zeroconf instance to the browser — AsyncZeroconf
        # in zeroconf >= 0.147 dropped the .cache attribute that
        # ServiceBrowser.__init__ accesses internally.
        browser = AsyncServiceBrowser(
            zc.zeroconf, SERVICE_TYPE, handlers=[on_state_change])
        await asyncio.wait_for(event.wait(), timeout=timeout)
    except asyncio.TimeoutError:
        log.info('mDNS: no server found within %.1fs', timeout)
        found_url = None
    except Exception as e:
        log.warning('mDNS discovery error: %s', e)
        found_url = None
    finally:
        if browser:
            await browser.async_cancel()
        if zc:
            await zc.async_close()
    return found_url


def discover_server_sync(timeout: float = DEFAULT_TIMEOUT) -> Optional[str]:
    """Blocking wrapper around :func:`discover_server` for non-async contexts."""
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop and loop.is_running():
        log.warning('discover_server_sync called from async context — use await instead')
        return None
    return asyncio.run(discover_server(timeout))
