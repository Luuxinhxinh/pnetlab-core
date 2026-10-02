#!/usr/bin/env python3
# pnet-showcmd — run ONE read-only `show` command on a node's serial console and
# return its output (optionally parsed). Invoked by pnetlab-brokerd's node_show
# verb (root); never called directly by the web tier. Read-only by contract: the
# broker validates the command against ^show ...$, and this script refuses
# anything that is not a `show`, so the console driver can never push config.
#
# Backs the BGP best-path waterfall (Protocol Inspector sibling):
#   --mode bgp-table   : `show ip bgp`         -> {raw, prefixes, picker}
#   --mode bgp-detail  : `show ip bgp <prefix>`-> {raw, detail, waterfall, decision}
#   --mode raw         : any show              -> {raw}
#
# The console is the qemu_wrapper_telnet TCP server; the driver speaks just enough
# telnet to refuse option negotiation, then does expect/send (the same minimal
# approach as sdwan/sdwan-onboard.py's EdgeConsole, trimmed for a single read).
#
# LIMITATION: a node's serial console typically accepts ONE client. If the lab
# user has the web console open on this node, this read may conflict; the caller
# surfaces that as a transient error. We never send `exit` (that would log out the
# shared line) — we set `terminal length 0`, read, and disconnect.

import argparse
import json
import os
import re
import socket
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import pnet_bgpparse                                   # noqa: E402

_PROMPT_RE = re.compile(rb"[\r\n][A-Za-z0-9][\w.\-]*(\([\w\-]+\))?[#>]\s*$")
# A parenthesised sub-mode before '#' means the line is parked in a config mode
# (e.g. R1(config-if)#). There an exec command like `show ...`/`terminal length`
# is rejected ("% Invalid input") unless prefixed with `do`. We never change the
# user's mode (no `end`/`exit` — the console is shared); we just `do` our reads.
_CONFIG_PROMPT_RE = re.compile(rb"\([\w.\-]+\)#[\s\x00]*$")
_USER_RE = re.compile(rb"[Uu]sername:\s*$")
_PASS_RE = re.compile(rb"[Pp]assword:\s*$")

DEF_USERS = ["cisco", "admin"]
DEF_PASS = ["cisco", "admin", "C1sco12345", "pnet"]


class Console:
    def __init__(self, host, port):
        self.host, self.port = host or "127.0.0.1", int(port)
        self.sock = None
        self.buf = bytearray()
        self.config_mode = False        # line parked in a config sub-mode -> `do`

    def connect(self, attempts=4, delay=1.0):
        for _ in range(attempts):
            try:
                self.sock = socket.create_connection((self.host, self.port),
                                                     timeout=6)
                self.sock.settimeout(1.0)
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
            if b == 255:                               # IAC
                if i + 1 >= n:
                    break
                cmd = data[i + 1]
                if cmd == 250:                         # SB ... IAC SE
                    j = i + 2
                    while j + 1 < n and not (data[j] == 255 and
                                             data[j + 1] == 240):
                        j += 1
                    i = j + 2
                    continue
                if cmd in (251, 252, 253, 254):
                    if i + 2 >= n:
                        break
                    opt = data[i + 2]
                    if cmd == 251:                     # WILL -> DONT
                        resp += bytes([255, 254, opt])
                    elif cmd == 253:                   # DO   -> WONT
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
            self.sock.sendall((line + "\r").encode())
        except OSError:
            pass

    def to_exec(self, users, passwords, timeout=40):
        """Drive an already-running console to a privileged prompt with paging off.
        Tolerates: already at a prompt, a login prompt, or a quiet line."""
        deadline = time.time() + timeout
        self.send("")                                  # wake the line
        sent_user = False
        while time.time() < deadline:
            idx = self.expect([_USER_RE, _PASS_RE, _PROMPT_RE,
                               re.compile(rb"(?i)login invalid|"
                                          rb"authentication failed")],
                              timeout=8)
            if idx == 0:
                self.send(users[0] if users else "cisco")
                sent_user = True
            elif idx == 1:
                self.send(passwords[0] if passwords else "cisco")
            elif idx == 2:
                return self._enter_enable(passwords)
            elif idx == 3:
                return False                           # creds rejected
            else:
                self.send("")                          # nudge
        return False

    def _enter_enable(self, passwords):
        tail = bytes(self.buf[-80:]).rstrip()
        if tail.endswith(b">"):
            self.send("enable")
            if self.expect([_PASS_RE, _PROMPT_RE], timeout=8) == 0:
                self.send(passwords[0] if passwords else "cisco")
                self.expect([_PROMPT_RE], timeout=8)
        # If the user left the line in a config sub-mode, `do` our exec commands
        # rather than dropping them out of config (which would disrupt their work).
        self.config_mode = bool(_CONFIG_PROMPT_RE.search(bytes(self.buf[-160:])))
        self.send(("do " if self.config_mode else "") + "terminal length 0")
        self.expect([_PROMPT_RE], timeout=8)
        return True

    def run_show(self, cmd, timeout=40, drain=1.0):
        """Send a show command, capture until the prompt returns, and strip the
        echoed command line and the trailing prompt. In a config sub-mode the
        command is sent as `do <cmd>` so IOS/IOS-XE accepts it; the echoed
        `do <cmd>` line still ends with <cmd>, so the existing strip logic holds.
        `drain` = how long to soak up async console noise before sending — the
        first read in a session wants the full soak, but with paging off the line
        is quiet afterwards, so later reads in the SAME session pass a small drain
        (the big win when batching a node's reads through one login)."""
        self._pump(drain)                              # drain async noise
        self.send(("do " if self.config_mode else "") + cmd)
        self.expect([_PROMPT_RE], timeout=timeout)
        text = bytes(self.buf).decode("utf-8", "replace").replace("\r", "")
        lines = text.split("\n")
        # drop everything up to and including the echoed command
        start = 0
        for i, ln in enumerate(lines):
            if ln.strip().endswith(cmd):
                start = i + 1
                break
        # drop the trailing prompt line(s)
        end = len(lines)
        while end > start and (not lines[end - 1].strip()
                               or re.search(r"[#>]\s*$", lines[end - 1])):
            end -= 1
        return "\n".join(lines[start:end]).strip("\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--cmd")
    ap.add_argument("--cmds")     # JSON list -> run all in ONE login session (raw)
    ap.add_argument("--mode", default="raw",
                    choices=["raw", "bgp-table", "bgp-detail"])
    ap.add_argument("--users", default=",".join(DEF_USERS))
    ap.add_argument("--passwords", default=",".join(DEF_PASS))
    a = ap.parse_args()

    # Multi-command mode: connect + log in ONCE and run every show in the same
    # session. The Topology-Overlay gather batches a node's cdp/spanning-tree/
    # etherchannel reads through here, so we pay the (dominant) telnet login cost
    # once per node instead of once per command — the big speed-up on large labs.
    if a.cmds is not None:
        try:
            cmds = json.loads(a.cmds)
            if not isinstance(cmds, list):
                raise ValueError()
        except Exception:
            print(json.dumps({"error": "bad --cmds json"}))
            return 2
        cmds = [c for c in cmds if isinstance(c, str)]
        for c in cmds:
            if not c.strip().lower().startswith("show "):
                print(json.dumps({"error": "refused: not a show command"}))
                return 2
        con = Console(a.host, a.port)
        if not con.connect():
            print(json.dumps({"error": "console connect failed (node down or "
                                       "console busy)"}))
            return 1
        results = {}
        try:
            if not con.to_exec([u for u in a.users.split(",") if u],
                               [p for p in a.passwords.split(",") if p]):
                print(json.dumps({"error": "could not reach an exec prompt "
                                           "(login failed or console busy)"}))
                return 1
            for i, c in enumerate(cmds):
                try:
                    # full async-noise soak only before the first read; the line is
                    # quiet afterwards (paging off), so later reads drain briefly.
                    results[c] = {"raw": con.run_show(c, drain=(0.8 if i == 0 else 0.2))}
                except Exception as e:                          # noqa: BLE001
                    results[c] = {"raw": "", "error": str(e)}
        finally:
            con.close()
        print(json.dumps({"results": results}, separators=(",", ":")))
        return 0

    if not a.cmd:
        print(json.dumps({"error": "need --cmd or --cmds"}))
        return 2
    if not a.cmd.strip().lower().startswith("show "):
        print(json.dumps({"error": "refused: not a show command"}))
        return 2

    con = Console(a.host, a.port)
    if not con.connect():
        print(json.dumps({"error": "console connect failed (node down or "
                                   "console busy)"}))
        return 1
    try:
        if not con.to_exec([u for u in a.users.split(",") if u],
                           [p for p in a.passwords.split(",") if p]):
            print(json.dumps({"error": "could not reach an exec prompt "
                                       "(login failed or console busy)"}))
            return 1
        raw = con.run_show(a.cmd)
    finally:
        con.close()

    res = {"raw": raw}
    if a.mode == "bgp-table":
        parsed = pnet_bgpparse.parse(raw)
        res["prefixes"] = parsed.get("prefixes", [])
        res["picker"] = pnet_bgpparse.picker_rows(parsed)
        if parsed.get("error"):
            res["error"] = parsed["error"]
    elif a.mode == "bgp-detail":
        detail = pnet_bgpparse.parse_detail(raw)
        wf = pnet_bgpparse.waterfall_paths(detail)
        res["detail"] = detail
        res["waterfall"] = wf
        res["decision"] = pnet_bgpparse.decide(wf)
        if detail.get("error"):
            res["error"] = detail["error"]
    print(json.dumps(res, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
