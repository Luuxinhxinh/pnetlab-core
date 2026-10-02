#!/usr/bin/env python3
# pnet-wifi-truth — read the REAL 802.11 association state of ONE wireless node over
# its serial console and return it as JSON. Invoked by pnetlab-brokerd's wifi_truth
# verb (root); never called directly by the web tier.
#
# WHY: the Wi-Fi Painter's association/RSSI is MODELLED (SSID match + canvas distance).
# That is a drawing, not the truth: a wrong-PSK station still "looks" connected because
# the model can't see the failed 4-way handshake. This driver logs into the node's
# console (the qemu_wrapper_telnet TCP server) and asks the guest what is ACTUALLY
# happening, so pnq-wifi.php can flag model-vs-actual divergence.
#
#   --role sta : `wpa_cli -i <ifc> status` (wpa_state/ssid/bssid/freq) + the RX signal
#                from /proc/net/wireless (driver-agnostic; hwsim has no `iw`/signal_poll).
#   --role ap  : `hostapd_cli -i <bss> all_sta` (associated station MACs + per-STA signal)
#                + the AP's own BSSID. Needs hostapd's ctrl_interface (=/var/run/hostapd),
#                which the AP day-0 seed now configures.
#
# The wireless node images are Debian/Ubuntu with a `cisco`/`cisco` login and passwordless
# sudo, so this is a LINUX shell driver (prompt `user@host:~$`), unlike the IOS-oriented
# pnet-showcmd.py; the telnet/expect plumbing is the same minimal approach.
#
# READ-ONLY by contract: only fixed, hard-coded query commands are ever sent (wpa_cli
# status / hostapd_cli all_sta / cat of /proc + /sys). No argument becomes a shell command.
#
# LIMITATION: a serial console typically accepts ONE client. If the lab user has the web
# console open on this node, the read may conflict; the caller surfaces that as a transient
# error and keeps the modelled value. We never send `exit` (that would log out the shared
# line); we log in only if we see a login prompt, run our reads, and disconnect.

import argparse
import json
import os
import re
import socket
import sys
import time

# Linux shell prompt: user@host:cwd$  (or # for root). Anchored at end of buffer.
_PROMPT_RE = re.compile(rb"[\w.\-]+@[\w.\-]+:[^\r\n]*[#$]\s*$")
_LOGIN_RE = re.compile(rb"[Ll]ogin:\s*$")
_PASS_RE = re.compile(rb"[Pp]assword:\s*$")

DEF_USER = "cisco"
DEF_PASS = "cisco"


class LinuxConsole:
    def __init__(self, host, port, sockpath=None):
        self.host, self.port = host or "127.0.0.1", int(port or 0)
        self.sockpath = sockpath                       # unix console.sock (preferred)
        self.sock = None
        self.buf = bytearray()

    def connect(self, attempts=3, delay=1.0):
        # Prefer the qemu console UNIX socket (always present while the node runs);
        # the TCP telnet port only listens when the on-demand web-console bridge is up,
        # so it is unreliable for an unattended read. Fall back to TCP if no socket.
        for _ in range(attempts):
            try:
                if self.sockpath:
                    s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                    s.settimeout(6)
                    s.connect(self.sockpath)
                else:
                    s = socket.create_connection((self.host, self.port), timeout=6)
                s.settimeout(1.0)
                self.sock = s
                return True
            except OSError:
                time.sleep(delay)
        return False

    def close(self):
        try:
            if self.sock:
                self.sock.close()
        except OSError:
            pass

    def _strip_iac(self, data):
        out, resp = bytearray(), bytearray()
        i, n = 0, len(data)
        while i < n:
            b = data[i]
            if b == 255:                                   # IAC
                if i + 1 >= n:
                    break
                cmd = data[i + 1]
                if cmd == 250:                             # SB ... IAC SE
                    j = i + 2
                    while j + 1 < n and not (data[j] == 255 and data[j + 1] == 240):
                        j += 1
                    i = j + 2
                    continue
                if cmd in (251, 252, 253, 254):
                    if i + 2 >= n:
                        break
                    opt = data[i + 2]
                    if cmd == 251:                         # WILL -> DONT
                        resp += bytes([255, 254, opt])
                    elif cmd == 253:                       # DO   -> WONT
                        resp += bytes([255, 252, opt])
                    i += 3
                    continue
                i += 2
                continue
            out.append(b)
            i += 1
        if resp and self.sock:
            try:
                self.sock.sendall(bytes(resp))
            except OSError:
                pass
        return bytes(out)

    def _pump(self, window=0.5):
        self.sock.settimeout(window)
        try:
            d = self.sock.recv(4096)
            if d:
                self.buf += self._strip_iac(d)
        except (socket.timeout, OSError):
            pass

    def expect(self, patterns, timeout=15):
        end = time.time() + timeout
        while time.time() < end:
            self._pump()
            tail = bytes(self.buf[-4096:])
            for idx, p in enumerate(patterns):
                if p.search(tail):
                    return idx
        return -1

    def send(self, line=""):
        self.buf = bytearray()
        try:
            self.sock.sendall((line + "\n").encode())
        except OSError:
            pass

    def login(self, user, password, timeout=40):
        """Reach a shell prompt: already logged in, at a login prompt, or a quiet line."""
        deadline = time.time() + timeout
        self.send("")                                      # wake the line
        while time.time() < deadline:
            idx = self.expect([_PROMPT_RE, _LOGIN_RE, _PASS_RE], timeout=8)
            if idx == 0:
                return True
            elif idx == 1:
                self.send(user)
            elif idx == 2:
                self.send(password)
            else:
                self.send("")                              # nudge
        return False

    def run(self, cmd, timeout=20):
        """Send one command, capture until the prompt returns, strip the echoed
        command line and the trailing prompt."""
        self._pump(0.4)                                    # drain async noise
        self.send(cmd)
        self.expect([_PROMPT_RE], timeout=timeout)
        text = bytes(self.buf).decode("utf-8", "replace").replace("\r", "")
        # Strip ANSI/CSI escapes incl. bracketed-paste (ESC[?2004h/l) the shell emits,
        # so a MAC/value never carries a stray control sequence.
        text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]", "", text)
        lines = text.split("\n")
        start = 0
        for i, ln in enumerate(lines):
            if ln.rstrip().endswith(cmd):
                start = i + 1
                break
        end = len(lines)
        while end > start and (not lines[end - 1].strip()
                               or _PROMPT_RE.search(lines[end - 1].encode())
                               or re.search(r"[#$]\s*$", lines[end - 1])):
            end -= 1
        return "\n".join(lines[start:end]).strip("\n")


# ---------------------------------------------------------------------------
# Parsers
# ---------------------------------------------------------------------------
def parse_wpa_status(raw):
    """`wpa_cli status` key=value lines -> the fields we care about."""
    out = {}
    for ln in raw.split("\n"):
        if "=" in ln:
            k, _, v = ln.partition("=")
            out[k.strip()] = v.strip()
    return {
        "wpa_state": out.get("wpa_state", ""),
        "ssid": out.get("ssid", ""),
        "bssid": out.get("bssid", ""),
        "freq": out.get("freq", ""),
        "address": out.get("address", ""),
        "key_mgmt": out.get("key_mgmt", ""),
    }


def parse_proc_wireless(raw, ifc):
    """/proc/net/wireless -> RX signal level (dBm) for <ifc>, or None.
    Columns: iface: status link level noise ...  (level in dBm, may carry a '.')."""
    for ln in raw.split("\n"):
        ln = ln.strip()
        if ln.startswith(ifc + ":"):
            parts = ln.replace(ifc + ":", "").split()
            if len(parts) >= 3:
                try:
                    return int(float(parts[2].rstrip(".")))
                except ValueError:
                    return None
    return None


def parse_all_sta(raw):
    """`hostapd_cli all_sta` -> [{mac, signal, connected}]. Output is a MAC line
    followed by key=value lines, repeated per station. `flags` containing
    [AUTHORIZED] means the 4-way handshake completed (truly on the network)."""
    stations = []
    cur = None
    macre = re.compile(r"^([0-9a-fA-F]{2}(:[0-9a-fA-F]{2}){5})\s*$")
    for ln in raw.split("\n"):
        ln = ln.strip()
        m = macre.match(ln)
        if m:
            if cur:
                stations.append(cur)
            cur = {"mac": m.group(1).lower(), "signal": None, "authorized": False, "flags": ""}
        elif cur is not None and "=" in ln:
            k, _, v = ln.partition("=")
            k = k.strip(); v = v.strip()
            if k == "signal":
                try:
                    cur["signal"] = int(float(v.split()[0]))
                except (ValueError, IndexError):
                    pass
            elif k == "flags":
                cur["flags"] = v
                cur["authorized"] = "[AUTHORIZED]" in v
    if cur:
        stations.append(cur)
    return stations


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=0)
    ap.add_argument("--sock", default=None, help="qemu console UNIX socket (preferred)")
    ap.add_argument("--role", choices=["ap", "sta"], required=True)
    ap.add_argument("--ifc", default="wlan0")
    ap.add_argument("--user", default=DEF_USER)
    ap.add_argument("--password", default=DEF_PASS)
    a = ap.parse_args()
    if not a.sock and not a.port:
        print(json.dumps({"error": "need --sock or --port"}))
        return 2

    # Only a fixed whitelist of interface names, so --ifc can never smuggle a shell arg.
    if not re.match(r"^wlan[0-9](_[0-9]+)?$", a.ifc):
        print(json.dumps({"error": "bad ifc"}))
        return 2

    con = LinuxConsole(a.host, a.port, a.sock)
    if not con.connect():
        print(json.dumps({"error": "console connect failed (node down or console busy)"}))
        return 1
    try:
        if not con.login(a.user, a.password):
            print(json.dumps({"error": "could not reach a shell prompt (login failed or console busy)"}))
            return 1
        if a.role == "sta":
            st = parse_wpa_status(con.run("sudo wpa_cli -i %s status" % a.ifc))
            rssi = parse_proc_wireless(con.run("cat /proc/net/wireless"), a.ifc)
            st["rssi"] = rssi
            st["associated"] = (st["wpa_state"] == "COMPLETED")
            print(json.dumps(st, separators=(",", ":")))
        else:
            bssid = con.run("cat /sys/class/net/%s/address" % a.ifc).strip().lower()
            stations = parse_all_sta(con.run("sudo hostapd_cli -i %s all_sta" % a.ifc))
            print(json.dumps({"bssid": bssid, "stations": stations,
                              "assoc_count": sum(1 for s in stations if s["authorized"])},
                             separators=(",", ":")))
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
