"""
Backward-compatibility shim — re-exports from ``fitaly_voice.bus``.

All existing imports like::

    from fitaly_voice.bus_adapter import IBusAdapter, RedisBusAdapter, StdoutBusAdapter

continue to work unchanged.
"""
from .bus.adapters import IBusAdapter, RedisBusAdapter, StdoutBusAdapter  # noqa: F401

__all__ = ["IBusAdapter", "RedisBusAdapter", "StdoutBusAdapter"]
