"""Bounded local NetProbe validation transport used by the privilege broker.

The socket is independent of Telnet; it never takes over an interactive console.
Only the broker may choose the runtime path, after validating a typed request.
"""
import ipaddress
import os
import re
import socket
import stat
import struct
import time


def allowed_command(command):
    if not isinstance(command, str) or len(command) > 500:
        return False
    if not re.fullmatch(r"[\x20-\x7e]+", command):
        return False
    words = command.split(" ")

    def ip(value):
        try:
            return ipaddress.ip_address(value).version == 4
        except ValueError:
            return False

    def number(value, low, high):
        return bool(re.fullmatch(r"[0-9]{1,5}", value)) and low <= int(value) <= high

    if words == ["show", "ip"]:
        return True
    if len(words) in (6, 7) and words[0] == "ping":
        return (ip(words[1]) and words[2] == "-c" and number(words[3], 1, 5)
                and words[4] == "-s" and number(words[5], 0, 1472)
                and (len(words) == 6 or words[6] == "-D"))
    if len(words) == 6 and words[0] == "trace":
        return (ip(words[1]) and words[2] == "-m" and number(words[3], 1, 8)
                and words[4:] == ["-q", "1"])
    if len(words) == 4 and words[:2] == ["tcp", "connect"]:
        return ip(words[2]) and number(words[3], 1, 65535)
    if len(words) in (3, 4) and words[0] == "nslookup":
        return (len(words[1]) <= 253 and bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.-]*", words[1]))
                and words[2] in ("A", "AAAA", "CNAME", "PTR")
                and (len(words) == 3 or (words[3].startswith("@") and ip(words[3][1:]))))
    return False


def validate_node(runpath, command):
    if not isinstance(runpath, str) or not re.fullmatch(r"/opt/unetlab/tmp/[0-9]+/[0-9]+", runpath):
        raise ValueError("Invalid node runtime path")
    if not allowed_command(command):
        raise ValueError("Unsupported validation command")
    path = os.path.join(runpath, "validation.sock")
    # Resolve every component before the privileged connect; never follow a
    # user-created symlink to an unrelated host service.
    if os.path.realpath(path) != path:
        raise ValueError("Validation socket path contains a symbolic link")
    try:
        info = os.lstat(path)
    except FileNotFoundError:
        return {"transport": "unavailable", "output": "Validation channel unavailable. Upgrade the NetProbe package and restart this node."}
    if not stat.S_ISSOCK(info.st_mode):
        raise ValueError("Validation channel is not a socket")
    deadline = time.monotonic() + 15
    data = bytearray()
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as client:
            client.settimeout(2)
            client.connect(path)
            # A rename between lstat and connect must not redirect the root
            # broker into a service owned by another account.
            _pid, peer_uid, _gid = struct.unpack("3i", client.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, 12))
            if peer_uid != info.st_uid or peer_uid == 0:
                return {"transport": "error", "output": "Validation socket peer does not match the node account"}
            client.sendall(command.encode("ascii") + b"\n")
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    return {"transport": "timeout", "output": "Validation channel timed out"}
                client.settimeout(remaining)
                chunk = client.recv(4096)
                if not chunk:
                    break
                data.extend(chunk)
                if len(data) > 32848:
                    return {"transport": "error", "output": "Validation output exceeded its limit"}
    except (socket.timeout, TimeoutError):
        return {"transport": "timeout", "output": "Validation channel timed out"}
    except OSError:
        return {"transport": "unavailable", "output": "Validation channel is not ready; check that the node is running"}
    header, sep, output = bytes(data).partition(b"\n")
    match = re.fullmatch(rb"(DONE|TIMEOUT|ERROR) ([0-9]{1,5})", header)
    if not sep or not match or int(match[2]) != len(output) or len(output) > 32768:
        return {"transport": "error", "output": "Invalid validation response"}
    status = {b"DONE": "done", b"TIMEOUT": "timeout", b"ERROR": "error"}[match[1]]
    return {"transport": status, "output": output.decode("utf-8", "replace")}
