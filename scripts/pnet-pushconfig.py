#!/usr/bin/env python3
# pnet-pushconfig — drive a freshly-booted node's serial console like a human and
# PASTE a day-0 configuration into it, then (optionally) save it. Invoked by
# pnetlab-brokerd's node_config_push verb (root); never called by the web tier.
#
# Why this exists: the engine's startup-config IMPORT delivers the config but the
# device still runs its first-boot UNATTENDED — IOS broadcasts TFTP autoinstall
# (network-confg / cisconet.cfg / <host>-confg) and waits the full multi-minute
# timeout, and IOL sits at the "initial configuration dialog". A human answers the
# console instantly. This driver does the same: it aborts autoinstall / the setup
# dialog, logs in, pastes the config in conf-t, and `write memory` (so NVRAM holds
# a valid startup-config and every later boot is clean + fast). Mirrors the proven
# console handling in pnet-showcmd.py (Console) and sdwan/sdwan-onboard.py
# (EdgeConsole.get_to_exec): minimal telnet, expect/send, no external deps.
#
# The config text is read from STDIN (kept off the process table). Output is one
# JSON line: {"ok":bool,"saved":bool,"prompt":str,"errors":[...],"log":"..."}.

import argparse
import json
import os
import re
import socket
import sys
import time

_PROMPT_RE = re.compile(rb"[\r\n][A-Za-z0-9][\w.\-]*(\([\w\-]+\))?[#>]\s*$")
_CONF_PROMPT_RE = re.compile(rb"\(config[\w\-]*\)#\s*$")
_USER_RE = re.compile(rb"[Uu]sername:\s*$")
_PASS_RE = re.compile(rb"[Pp]assword:\s*$")

DEF_USERS = ["cisco", "admin"]
DEF_PASS = ["cisco", "admin", "C1sco12345", "pnet"]


class Console:
    def __init__(self, host, port):
        self.host, self.port = host or "127.0.0.1", int(port)
        self.sock = None
        self.buf = bytearray()
        self.log = []

    def note(self, m):
        self.log.append(m)

    def connect(self, attempts=30, delay=2.0):
        # A booting node's console server may not be listening yet — retry.
        for _ in range(attempts):
            try:
                self.sock = socket.create_connection((self.host, self.port), timeout=6)
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
                    elif cmd == 253:                       # DO -> WONT
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

    def get_to_exec(self, users, passwords, timeout=420):
        """Drive a freshly-booted (or already-up) console to a privileged-exec
        prompt: abort autoinstall, answer the setup dialog 'no', press RETURN, log
        in (trying each password), enable, paging off. Long timeout: a vIOS first
        boot can take a few minutes to even print a prompt."""
        deadline = time.time() + timeout
        pw_idx = 0
        self.send("")                                      # wake the line
        while time.time() < deadline:
            idx = self.expect([
                re.compile(rb"initial configuration dialog"),          # 0 -> no
                re.compile(rb"terminate autoinstall"),                 # 1 -> yes
                re.compile(rb"Press RETURN to get started"),           # 2 -> CR
                _USER_RE,                                              # 3
                _PASS_RE,                                              # 4
                re.compile(rb"(?i)enter new password"),                # 5
                re.compile(rb"(?i)login invalid|authentication failed"),  # 6
                _PROMPT_RE,                                            # 7
            ], timeout=25)
            if idx == 0:
                self.note("answered setup dialog: no"); self.send("no")
            elif idx == 1:
                self.note("aborted autoinstall"); self.send("yes")
            elif idx == 2:
                self.send("")
            elif idx == 3:
                self.send(users[0] if users else "cisco")
            elif idx == 4:
                self.send(passwords[min(pw_idx, len(passwords) - 1)] if passwords else "cisco")
            elif idx == 5:
                newpw = passwords[min(pw_idx, len(passwords) - 1)] if passwords else "cisco"
                self.send(newpw)
                if self.expect([_PASS_RE, re.compile(rb"(?i)confirm")], timeout=10) >= 0:
                    self.send(newpw)
            elif idx == 6:
                pw_idx += 1
                if pw_idx >= len(passwords):
                    self.note("login rejected for all known passwords")
                    return False
                self.send("")
            elif idx == 7:
                return self._enter_enable(passwords)
            else:
                self.send("")                              # nudge a quiet line
        self.note("timed out waiting for a console prompt")
        return False

    def _enter_enable(self, passwords):
        tail = bytes(self.buf[-80:]).rstrip()
        if tail.endswith(b">"):
            self.send("enable")
            if self.expect([_PASS_RE, _PROMPT_RE], timeout=10) == 0:
                self.send(passwords[0] if passwords else "cisco")
                self.expect([_PROMPT_RE], timeout=10)
        self.send("terminal length 0")
        self.expect([_PROMPT_RE], timeout=10)
        return True

    def push_config(self, config_text):
        """Paste the config in configuration mode. Lines are sent paced (a short
        drain after each) so a fast console paste does not overrun the line. The
        device's own '% Invalid input' lines (if any) are collected and returned."""
        errors = []
        self._pump(1.0)                                    # drain boot noise
        self.send("configure terminal")
        if self.expect([_CONF_PROMPT_RE], timeout=12) < 0:
            # some images print 'Enter configuration commands' first — retry once
            self.send("")
            if self.expect([_CONF_PROMPT_RE, _PROMPT_RE], timeout=8) < 0:
                self.note("could not enter config mode")
                return False, errors
        for raw in config_text.replace("\r", "").split("\n"):
            line = raw.rstrip()
            if line == "" or line.lstrip().startswith("!"):
                continue
            if line.strip() in ("end", "exit"):           # we close out ourselves
                continue
            self.send(line)
            self._pump(0.12)                               # pace + soak echo/errors
            tail = bytes(self.buf).decode("utf-8", "replace")
            if "% Invalid input" in tail or "% Incomplete command" in tail or \
               "% Ambiguous command" in tail:
                errors.append(line + "  ->  " + tail.strip().splitlines()[-1][:120])
        self.send("end")
        self.expect([_PROMPT_RE], timeout=12)
        return True, errors

    def save(self):
        """write memory (copy running-config startup-config) so NVRAM holds a real
        startup-config — clean, fast boots thereafter."""
        self._pump(0.5)
        self.send("write memory")
        # 'Building configuration...' then '[OK]' (or a 'Destination filename' prompt)
        idx = self.expect([re.compile(rb"\[OK\]"),
                           re.compile(rb"Destination filename"),
                           _PROMPT_RE], timeout=40)
        if idx == 1:
            self.send("")                                  # accept default filename
            self.expect([re.compile(rb"\[OK\]"), _PROMPT_RE], timeout=40)
        self.expect([_PROMPT_RE], timeout=10)
        return True

    def cur_prompt(self):
        m = re.search(rb"([A-Za-z0-9][\w.\-]*)[#>]\s*$", bytes(self.buf[-80:]))
        return m.group(1).decode() if m else ""


def main():
    ap = argparse.ArgumentParser(description="paste a day-0 config into a node console")
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--save", action="store_true", help="write memory after pasting")
    ap.add_argument("--users", default=",".join(DEF_USERS))
    ap.add_argument("--passwords", default=",".join(DEF_PASS))
    ap.add_argument("--boot-timeout", type=int, default=420)
    a = ap.parse_args()

    config_text = sys.stdin.read()
    if not config_text.strip():
        print(json.dumps({"ok": False, "errors": ["empty config"]}))
        return 2

    con = Console(a.host, a.port)
    if not con.connect():
        print(json.dumps({"ok": False, "errors": ["console connect failed "
              "(node not running, or console busy — close the web console)"]}))
        return 1
    try:
        if not con.get_to_exec([u for u in a.users.split(",") if u],
                               [p for p in a.passwords.split(",") if p],
                               timeout=a.boot_timeout):
            print(json.dumps({"ok": False, "prompt": con.cur_prompt(),
                              "errors": ["could not reach an exec prompt"],
                              "log": " | ".join(con.log)}))
            return 1
        ok, errors = con.push_config(config_text)
        saved = False
        if ok and a.save:
            saved = con.save()
        print(json.dumps({"ok": bool(ok), "saved": bool(saved),
                          "prompt": con.cur_prompt(), "errors": errors,
                          "log": " | ".join(con.log)}, separators=(",", ":")))
        return 0 if ok else 1
    finally:
        con.close()


if __name__ == "__main__":
    sys.exit(main())
