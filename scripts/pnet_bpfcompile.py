#!/usr/bin/env python3
"""Compile classic-BPF expressions through the installed libpcap."""

import ctypes
import ctypes.util


DLT_EN10MB = 1
# The accept instruction emitted for ``len >= 0`` exposes this snaplen.
TCPDUMP_DDD_SNAPLEN = 262144
PCAP_OPTIMIZE = 1
PCAP_NETMASK = 0
_LIBPCAP_ABSOLUTE = "/usr/lib/x86_64-linux-gnu/libpcap.so.0.8"


class BpfInsn(ctypes.Structure):
    _fields_ = [
        ("code", ctypes.c_ushort),
        ("jt", ctypes.c_ubyte),
        ("jf", ctypes.c_ubyte),
        ("k", ctypes.c_uint32),
    ]


class BpfProgram(ctypes.Structure):
    _fields_ = [
        ("bf_len", ctypes.c_uint),
        ("bf_insns", ctypes.POINTER(BpfInsn)),
    ]


if (ctypes.sizeof(BpfInsn) != 8 or
        BpfInsn.code.offset != 0 or
        BpfInsn.jt.offset != 2 or
        BpfInsn.jf.offset != 3 or
        BpfInsn.k.offset != 4):
    raise RuntimeError("unsupported classic-BPF instruction ABI")


_PCAP = None


def _configure_pcap(lib):
    lib.pcap_open_dead.argtypes = [ctypes.c_int, ctypes.c_int]
    lib.pcap_open_dead.restype = ctypes.c_void_p
    lib.pcap_compile.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(BpfProgram),
        ctypes.c_char_p,
        ctypes.c_int,
        ctypes.c_uint32,
    ]
    lib.pcap_compile.restype = ctypes.c_int
    lib.pcap_geterr.argtypes = [ctypes.c_void_p]
    lib.pcap_geterr.restype = ctypes.c_char_p
    lib.pcap_freecode.argtypes = [ctypes.POINTER(BpfProgram)]
    lib.pcap_freecode.restype = None
    lib.pcap_close.argtypes = [ctypes.c_void_p]
    lib.pcap_close.restype = None
    return lib


def _load_pcap():
    global _PCAP
    if _PCAP is not None:
        return _PCAP

    try:
        discovered = ctypes.util.find_library("pcap")
    except Exception:
        discovered = None
    candidates = []
    for candidate in (discovered, "libpcap.so.0.8", _LIBPCAP_ABSOLUTE):
        if candidate and candidate not in candidates:
            candidates.append(candidate)

    failures = []
    for candidate in candidates:
        try:
            _PCAP = _configure_pcap(ctypes.CDLL(candidate))
            return _PCAP
        except (OSError, AttributeError) as exc:
            failures.append("%s (%s)" % (candidate, exc))

    attempted = ", ".join(candidates)
    detail = "; ".join(failures)
    raise OSError("unable to load libpcap; attempted candidates: %s%s" %
                  (attempted, "; errors: %s" % detail if detail else ""))


def _pcap_error(lib, handle):
    message = lib.pcap_geterr(handle)
    if not message:
        return ""
    if not isinstance(message, bytes):
        message = ctypes.string_at(message)
    return message.decode("utf-8", "replace").strip()


def compile_bpf(expr: str) -> tuple[int, bytes]:
    """Return ``(instruction_count, native classic-BPF bytes)`` for *expr*."""
    lib = _load_pcap()
    expression = expr.encode("utf-8")
    program = BpfProgram()
    handle = lib.pcap_open_dead(DLT_EN10MB, TCPDUMP_DDD_SNAPLEN)
    compiled = False
    try:
        if not handle:
            raise RuntimeError("tcpdump -ddd failed for %r: pcap_open_dead failed" %
                               expr)
        result = lib.pcap_compile(
            handle, ctypes.byref(program), expression, PCAP_OPTIMIZE,
            PCAP_NETMASK)
        if result != 0:
            error = _pcap_error(lib, handle)
            raise RuntimeError("tcpdump -ddd failed for %r: %s" %
                               (expr, error))
        compiled = True
        count = int(program.bf_len)
        raw = ctypes.string_at(program.bf_insns,
                               count * ctypes.sizeof(BpfInsn))
        return count, raw
    finally:
        try:
            if compiled:
                lib.pcap_freecode(ctypes.byref(program))
        finally:
            if handle:
                lib.pcap_close(handle)
