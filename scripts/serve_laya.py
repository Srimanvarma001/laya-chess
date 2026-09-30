"""
Start laya-serve with Windows power throttling (EcoQoS) disabled for this process.

On Intel hybrid CPUs (P-cores + E-cores), Windows treats a console server that is
not the foreground window as background work and throttles it onto the efficiency
cores, especially on battery or the Balanced power plan. Measured on a Core Ultra 7
255H (20-candidate choice request, CPU): ~1200 ms throttled vs ~530 ms with
throttling off. Nothing about Laya or the request changes; the process just keeps
its fast cores.

On macOS/Linux this is a no-op wrapper around `laya-serve`.

Usage (same LAYA_* env vars as laya-serve):
    python scripts/serve_laya.py
"""

from __future__ import annotations

import sys


def disable_power_throttling() -> bool:
    """Opt this process out of EcoQoS execution-speed throttling. True on success."""
    if sys.platform != "win32":
        return False
    import ctypes
    from ctypes import wintypes

    class PROCESS_POWER_THROTTLING_STATE(ctypes.Structure):
        _fields_ = [
            ("Version", wintypes.ULONG),
            ("ControlMask", wintypes.ULONG),
            ("StateMask", wintypes.ULONG),
        ]

    PROCESS_POWER_THROTTLING_CURRENT_VERSION = 1
    PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1
    ProcessPowerThrottling = 4  # PROCESS_INFORMATION_CLASS

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    # Explicit HANDLE types matter: GetCurrentProcess() returns the pseudo-handle -1,
    # which the default int restype truncates on 64-bit and the call then fails.
    kernel32.GetCurrentProcess.restype = wintypes.HANDLE
    kernel32.SetProcessInformation.argtypes = [
        wintypes.HANDLE, ctypes.c_int, ctypes.c_void_p, wintypes.DWORD
    ]
    kernel32.SetProcessInformation.restype = wintypes.BOOL

    # ControlMask selects EXECUTION_SPEED; StateMask 0 = never throttle it.
    state = PROCESS_POWER_THROTTLING_STATE(
        PROCESS_POWER_THROTTLING_CURRENT_VERSION,
        PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        0,
    )
    return bool(
        kernel32.SetProcessInformation(
            kernel32.GetCurrentProcess(),
            ProcessPowerThrottling,
            ctypes.byref(state),
            ctypes.sizeof(state),
        )
    )


def main() -> None:
    if sys.platform == "win32":
        ok = disable_power_throttling()
        print(f"[serve_laya] Windows power throttling disabled: {ok}", flush=True)
    # Imported after the opt-out so torch's worker threads start unthrottled.
    from laya.serve import main as laya_serve_main

    laya_serve_main()


if __name__ == "__main__":
    main()
