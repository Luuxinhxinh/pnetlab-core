# -*- coding: utf-8 -*-
"""External Authentication Operations Module (RADIUS / LDAP).

Extracted from pnetlab-brokerd.py during Clean Architecture refactoring.
Handles external directory credential validation and admin settings.
"""

from __future__ import annotations

import json
import os
import re
import sys
from typing import Any, Dict, List, Tuple

BASE = "/opt/unetlab"
EXTAUTH_DIR = BASE + "/data/extauth"
EXTAUTH_CONFIG = EXTAUTH_DIR + "/config.json"
EXTAUTH_VENDOR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "vendor")
EXTAUTH_RADIUS_DICT = os.path.join(EXTAUTH_VENDOR, "pyrad", "dictionary.pnet")

RE_EXTAUTH_USER = re.compile(r"^[A-Za-z0-9@._\\-]{1,64}$")
RE_EXTAUTH_HOST = re.compile(r"^[A-Za-z0-9._-]{1,255}$")
RE_EXTAUTH_URI = re.compile(r"^ldaps?://[A-Za-z0-9._-]{1,255}(:[0-9]{1,5})?/?$")
RE_EXTAUTH_NASID = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
EXTAUTH_USER_ATTRS = {"uid", "sAMAccountName", "cn", "mail", "userPrincipalName"}
EXTAUTH_GROUP_ATTRS = {"memberOf", "member"}
EXTAUTH_MODES = {"radius", "ldap", "both"}


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


class Reject(Exception):
    pass


def v_int(args: Dict[str, Any], key: str) -> int:
    v = args.get(key)
    if isinstance(v, bool) or not (isinstance(v, int) or (isinstance(v, str) and v.isdigit())):
        raise Reject("bad arg %s" % key)
    n = int(v)
    if n < 0 or n > 2**31:
        raise Reject("bad arg %s" % key)
    return n


def v_enum(args: Dict[str, Any], key: str, allowed: Any) -> Any:
    v = args.get(key)
    if v not in allowed:
        raise Reject("bad arg %s" % key)
    return v


def v_re(args: Dict[str, Any], key: str, rx: re.Pattern) -> str:
    v = args.get(key)
    if not isinstance(v, str) or not rx.match(v):
        raise Reject("bad arg %s" % key)
    return v


def v_bool(args: Dict[str, Any], key: str) -> int:
    return 1 if args.get(key) in (1, "1", True, "true", "yes", "on") else 0


def _extauth_default_config() -> Dict[str, Any]:
    return {
        "enabled": False,
        "mode": "ldap",
        "fallback_local": False,
        "radius": {
            "primary_host": "",
            "primary_port": 1812,
            "secondary_host": "",
            "secondary_port": 1812,
            "secret": "",
            "timeout": 3,
            "nas_identifier": "pnetlab",
        },
        "ldap": {
            "uri": "",
            "starttls": False,
            "verify": True,
            "bind_dn": "",
            "bind_pw": "",
            "base_dn": "",
            "user_attr": "sAMAccountName",
            "group_attr": "memberOf",
            "timeout": 5,
        },
        "group_map": [],
        "default_role": None,
    }


def _extauth_load_config() -> Dict[str, Any]:
    cfg = None
    try:
        with open(EXTAUTH_CONFIG, "r", encoding="utf-8") as fh:
            cfg = json.load(fh)
    except (OSError, ValueError):
        cfg = None
    d = _extauth_default_config()
    if not isinstance(cfg, dict):
        return d
    for sect, defv in d.items():
        if isinstance(defv, dict):
            if not isinstance(cfg.get(sect), dict):
                cfg[sect] = defv
            else:
                for k, v in defv.items():
                    cfg[sect].setdefault(k, v)
        else:
            cfg.setdefault(sect, defv)
    return cfg


def _extauth_save_config(cfg: Dict[str, Any]) -> None:
    os.makedirs(EXTAUTH_DIR, exist_ok=True)
    os.chmod(EXTAUTH_DIR, 0o700)
    tmp = EXTAUTH_CONFIG + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as fh:
        json.dump(cfg, fh, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, EXTAUTH_CONFIG)


def _extauth_redacted(cfg: Dict[str, Any]) -> Dict[str, Any]:
    r = dict(cfg.get("radius", {}))
    l = dict(cfg.get("ldap", {}))
    r_secret = r.pop("secret", "")
    l_pw = l.pop("bind_pw", "")
    r["secret_set"] = bool(r_secret)
    l["bind_pw_set"] = bool(l_pw)
    return {
        "enabled": bool(cfg.get("enabled")),
        "mode": cfg.get("mode", "ldap"),
        "fallback_local": bool(cfg.get("fallback_local")),
        "radius": r,
        "ldap": l,
        "group_map": cfg.get("group_map", []),
        "default_role": cfg.get("default_role"),
    }


def _extauth_role_forbidden(role: Any) -> bool:
    return str(role).strip().lower() in ("admin", "0")


def _extauth_radius_verify(cfg: Dict[str, Any], username: str, password: str) -> Tuple[Any, List[str]]:
    rcfg = cfg.get("radius", {})
    secret = rcfg.get("secret", "")
    if not rcfg.get("primary_host") or not secret:
        log("extauth: radius not configured")
        return None, []
    if EXTAUTH_VENDOR not in sys.path:
        sys.path.insert(0, EXTAUTH_VENDOR)
    try:
        from pyrad.client import Client, Timeout
        from pyrad.dictionary import Dictionary
        from pyrad import packet as radpacket
    except Exception as e:
        log("extauth: vendored pyrad unavailable: %r" % e)
        return None, []
    try:
        rdict = Dictionary(EXTAUTH_RADIUS_DICT)
    except Exception as e:
        log("extauth: radius dictionary unreadable: %r" % e)
        return None, []
    timeout = min(max(int(rcfg.get("timeout", 3) or 3), 1), 10)
    servers = [(rcfg.get("primary_host"), int(rcfg.get("primary_port", 1812) or 1812))]
    if rcfg.get("secondary_host"):
        servers.append((rcfg.get("secondary_host"), int(rcfg.get("secondary_port", 1812) or 1812)))
    for host, port in servers:
        srv = Client(
            server=host,
            authport=port,
            secret=secret.encode("utf-8", "surrogateescape"),
            dict=rdict,
            retries=2,
            timeout=timeout,
            enforce_ma=True,
        )
        req = srv.CreateAuthPacket(code=radpacket.AccessRequest, User_Name=username)
        req["User-Password"] = req.PwCrypt(password)
        nasid = rcfg.get("nas_identifier") or "pnetlab"
        req["NAS-Identifier"] = nasid
        try:
            reply = srv.SendPacket(req)
        except Timeout:
            log("extauth: radius %s:%d timeout" % (host, port))
            continue
        except OSError as e:
            log("extauth: radius %s:%d socket error: %r" % (host, port, e))
            continue
        finally:
            try:
                srv._CloseSocket()
            except Exception:
                pass
        try:
            ma_ok = (
                reply.message_authenticator is not None
                and reply.verify_message_authenticator(original_authenticator=req.authenticator)
            )
        except Exception:
            ma_ok = False
        if not ma_ok:
            log("extauth: radius %s:%d reply without valid Message-Authenticator DROPPED" % (host, port))
            continue
        if reply.code == radpacket.AccessAccept:
            groups: List[str] = []
            for attr in ("Filter-Id", "Class"):
                try:
                    vals = reply[attr]
                except KeyError:
                    vals = []
                for v in vals:
                    if isinstance(v, bytes):
                        v = v.decode("utf-8", "replace")
                    v = str(v).strip()
                    if v:
                        groups.append(v)
            return True, groups
        return False, []
    return None, []


def _extauth_ldap_conn(ldap: Any, lcfg: Dict[str, Any]) -> Any:
    uri = lcfg.get("uri", "")
    timeout = min(max(int(lcfg.get("timeout", 5) or 5), 1), 30)
    conn = ldap.initialize(uri)
    conn.set_option(ldap.OPT_PROTOCOL_VERSION, 3)
    conn.set_option(ldap.OPT_REFERRALS, 0)
    conn.set_option(ldap.OPT_NETWORK_TIMEOUT, timeout)
    conn.set_option(ldap.OPT_TIMEOUT, timeout)
    starttls = bool(lcfg.get("starttls"))
    if uri.startswith("ldaps://") or starttls:
        if lcfg.get("verify", True):
            conn.set_option(ldap.OPT_X_TLS_REQUIRE_CERT, ldap.OPT_X_TLS_DEMAND)
        else:
            conn.set_option(ldap.OPT_X_TLS_REQUIRE_CERT, ldap.OPT_X_TLS_NEVER)
            log("extauth: WARNING ldap TLS certificate verification DISABLED (explicit opt-in)")
        conn.set_option(ldap.OPT_X_TLS_NEWCTX, 0)
    elif uri.startswith("ldap://"):
        log("extauth: WARNING plaintext ldap:// bind in use (explicit opt-in, no transport encryption)")
    if starttls and uri.startswith("ldap://"):
        conn.start_tls_s()
    return conn


def _extauth_ldap_verify(cfg: Dict[str, Any], username: str, password: str) -> Tuple[Any, List[str]]:
    if not isinstance(password, str) or password.strip() == "":
        return False, []
    lcfg = cfg.get("ldap", {})
    if not lcfg.get("uri") or not lcfg.get("base_dn"):
        log("extauth: ldap not configured")
        return None, []
    try:
        import ldap
        import ldap.filter
    except Exception as e:
        log("extauth: python3-ldap not installed: %r" % e)
        return None, []
    user_attr = lcfg.get("user_attr", "sAMAccountName")
    group_attr = lcfg.get("group_attr", "memberOf")
    if user_attr not in EXTAUTH_USER_ATTRS or group_attr not in EXTAUTH_GROUP_ATTRS:
        log("extauth: ldap attrs invalid")
        return None, []
    try:
        conn = _extauth_ldap_conn(ldap, lcfg)
        conn.simple_bind_s(lcfg.get("bind_dn", ""), lcfg.get("bind_pw", ""))
    except ldap.INVALID_CREDENTIALS:
        log("extauth: ldap SERVICE bind rejected — check bind_dn/bind_pw")
        return None, []
    except ldap.LDAPError as e:
        log("extauth: ldap unreachable (service bind): %s" % type(e).__name__)
        return None, []
    try:
        flt = "(%s=%s)" % (user_attr, ldap.filter.escape_filter_chars(username))
        res = conn.search_s(lcfg.get("base_dn", ""), ldap.SCOPE_SUBTREE, flt, [group_attr])
    except ldap.LDAPError as e:
        log("extauth: ldap search failed: %s" % type(e).__name__)
        try:
            conn.unbind_s()
        except Exception:
            pass
        return None, []
    entries = [(dn, at) for dn, at in res if dn]
    if len(entries) != 1:
        log("extauth: ldap user=%s -> %d matches (denied)" % (username, len(entries)))
        try:
            conn.unbind_s()
        except Exception:
            pass
        return False, []
    user_dn, attrs = entries[0]
    groups: List[str] = []
    if group_attr == "memberOf":
        for v in attrs.get("memberOf", []) or []:
            groups.append(v.decode("utf-8", "replace") if isinstance(v, bytes) else str(v))
    else:
        try:
            gflt = "(member=%s)" % ldap.filter.escape_filter_chars(user_dn)
            gres = conn.search_s(lcfg.get("base_dn", ""), ldap.SCOPE_SUBTREE, gflt, ["cn"])
            for gdn, _gat in gres:
                if gdn:
                    groups.append(gdn)
        except ldap.LDAPError:
            pass
    try:
        conn.unbind_s()
    except Exception:
        pass
    try:
        conn2 = _extauth_ldap_conn(ldap, lcfg)
        conn2.simple_bind_s(user_dn, password)
        conn2.unbind_s()
    except ldap.INVALID_CREDENTIALS:
        return False, []
    except ldap.UNWILLING_TO_PERFORM:
        return False, []
    except ldap.LDAPError as e:
        log("extauth: ldap unreachable (user bind): %s" % type(e).__name__)
        return None, []
    return True, groups


def _extauth_verify_core(cfg: Dict[str, Any], username: str, password: str, pref: str | None = None) -> Dict[str, Any]:
    mode = cfg.get("mode", "ldap")
    if mode == "both":
        order = ["radius", "ldap"]
        if pref in order:
            order.remove(pref)
            order.insert(0, pref)
    else:
        order = [mode]
    for proto in order:
        if proto == "radius":
            ok, groups = _extauth_radius_verify(cfg, username, password)
        else:
            ok, groups = _extauth_ldap_verify(cfg, username, password)
        if ok is True:
            log("extauth: verify user=%s source=%s result=accept" % (username, proto))
            return {"ok": True, "groups": groups, "source": proto}
        if ok is False:
            log("extauth: verify user=%s source=%s result=denied" % (username, proto))
            return {"ok": False, "reason": "denied"}
        log("extauth: verify user=%s source=%s result=unreachable" % (username, proto))
    return {"ok": False, "reason": "unreachable"}


def verb_extauth_settings_read(args: Dict[str, Any]) -> Tuple[int, List[str], str]:
    return 0, [json.dumps(_extauth_redacted(_extauth_load_config()))], ""


def verb_extauth_settings_write(args: Dict[str, Any]) -> Tuple[int, List[str], str]:
    cfg = _extauth_load_config()
    if "enabled" in args:
        cfg["enabled"] = bool(v_bool(args, "enabled"))
    if "fallback_local" in args:
        cfg["fallback_local"] = bool(v_bool(args, "fallback_local"))
    if "mode" in args:
        cfg["mode"] = v_enum(args, "mode", EXTAUTH_MODES)
    if "default_role" in args:
        dr = args.get("default_role")
        if dr in (None, ""):
            cfg["default_role"] = None
        else:
            if not isinstance(dr, str) or len(dr) > 64:
                raise Reject("bad arg default_role")
            if _extauth_role_forbidden(dr):
                raise Reject("default_role may not be the built-in admin role")
            cfg["default_role"] = dr
    if "radius" in args:
        rin = args.get("radius")
        if not isinstance(rin, dict):
            raise Reject("bad arg radius")
        r = cfg["radius"]
        for hk in ("primary_host", "secondary_host"):
            if hk in rin:
                hv = rin.get(hk)
                if hv in (None, ""):
                    r[hk] = ""
                elif isinstance(hv, str) and RE_EXTAUTH_HOST.match(hv):
                    r[hk] = hv
                else:
                    raise Reject("bad arg radius.%s" % hk)
        for pk in ("primary_port", "secondary_port"):
            if pk in rin:
                pv = v_int(rin, pk)
                if pv < 1 or pv > 65535:
                    raise Reject("radius.%s out of range" % pk)
                r[pk] = pv
        if "timeout" in rin:
            tv = v_int(rin, "timeout")
            if tv < 1 or tv > 10:
                raise Reject("radius.timeout out of range (1..10)")
            r["timeout"] = tv
        if "nas_identifier" in rin:
            nv = rin.get("nas_identifier")
            if not isinstance(nv, str) or not RE_EXTAUTH_NASID.match(nv):
                raise Reject("bad arg radius.nas_identifier")
            r["nas_identifier"] = nv
        if rin.get("secret"):
            sv = rin.get("secret")
            if not isinstance(sv, str) or len(sv) > 128:
                raise Reject("bad arg radius.secret")
            r["secret"] = sv
        if rin.get("clear_secret"):
            r["secret"] = ""
    if "ldap" in args:
        lin = args.get("ldap")
        if not isinstance(lin, dict):
            raise Reject("bad arg ldap")
        l = cfg["ldap"]
        if "uri" in lin:
            uv = lin.get("uri")
            if uv in (None, ""):
                l["uri"] = ""
            elif isinstance(uv, str) and RE_EXTAUTH_URI.match(uv):
                l["uri"] = uv.rstrip("/")
            else:
                raise Reject("bad arg ldap.uri (ldap://host[:port] or ldaps://host[:port])")
        for bk in ("starttls", "verify"):
            if bk in lin:
                l[bk] = bool(v_bool(lin, bk))
        for dk in ("bind_dn", "base_dn"):
            if dk in lin:
                dv = lin.get(dk)
                if not isinstance(dv, str) or len(dv) > 512 or "\x00" in dv:
                    raise Reject("bad arg ldap.%s" % dk)
                l[dk] = dv
        if "user_attr" in lin:
            l["user_attr"] = v_enum(lin, "user_attr", EXTAUTH_USER_ATTRS)
        if "group_attr" in lin:
            l["group_attr"] = v_enum(lin, "group_attr", EXTAUTH_GROUP_ATTRS)
        if "timeout" in lin:
            tv = v_int(lin, "timeout")
            if tv < 1 or tv > 30:
                raise Reject("ldap.timeout out of range (1..30)")
            l["timeout"] = tv
        if lin.get("bind_pw"):
            pv = lin.get("bind_pw")
            if not isinstance(pv, str) or len(pv) > 128:
                raise Reject("bad arg ldap.bind_pw")
            l["bind_pw"] = pv
        if lin.get("clear_bind_pw"):
            l["bind_pw"] = ""
    if "group_map" in args:
        gin = args.get("group_map")
        if not isinstance(gin, list) or len(gin) > 64:
            raise Reject("bad arg group_map (list, max 64)")
        gmap = []
        for ent in gin:
            if not isinstance(ent, dict):
                raise Reject("bad group_map entry")
            grp = ent.get("group")
            role = ent.get("role")
            if not isinstance(grp, str) or not grp.strip() or len(grp) > 256:
                raise Reject("bad group_map group")
            if not isinstance(role, str) or not role.strip() or len(role) > 64:
                raise Reject("bad group_map role")
            if _extauth_role_forbidden(role):
                raise Reject("group_map may not map to the built-in admin role")
            prio = v_int(ent, "prio") if "prio" in ent else 100
            if prio > 100000:
                raise Reject("group_map prio out of range")
            gmap.append({"group": grp.strip(), "role": role.strip(), "prio": prio})
        gmap.sort(key=lambda e: e["prio"])
        cfg["group_map"] = gmap
    _extauth_save_config(cfg)
    return 0, [json.dumps(_extauth_redacted(cfg))], ""


def verb_extauth_verify(args: Dict[str, Any]) -> Tuple[int, List[str], str]:
    username = v_re(args, "username", RE_EXTAUTH_USER)
    password = args.get("password")
    if not isinstance(password, str) or len(password) > 128:
        raise Reject("bad arg password")
    if password.strip() == "":
        log("extauth: verify user=%s result=denied (empty password)" % username)
        return 0, [json.dumps({"ok": False, "reason": "denied"})], ""
    pref = v_enum(args, "proto", {"radius", "ldap"}) if args.get("proto") else None
    cfg = _extauth_load_config()
    if not cfg.get("enabled"):
        return 0, [json.dumps({"ok": False, "reason": "denied"})], ""
    return 0, [json.dumps(_extauth_verify_core(cfg, username, password, pref))], ""


def verb_extauth_test(args: Dict[str, Any]) -> Tuple[int, List[str], str]:
    proto = v_enum(args, "proto", {"radius", "ldap"})
    username = v_re(args, "username", RE_EXTAUTH_USER)
    password = args.get("password")
    if not isinstance(password, str) or len(password) > 128:
        raise Reject("bad arg password")
    if password.strip() == "":
        return 0, [json.dumps({"ok": False, "reason": "denied", "detail": "empty password is always rejected"})], ""
    cfg = _extauth_load_config()
    if proto == "radius":
        ok, groups = _extauth_radius_verify(cfg, username, password)
    else:
        ok, groups = _extauth_ldap_verify(cfg, username, password)
    if ok is True:
        res = {"ok": True, "groups": groups, "source": proto, "detail": "authenticated; %d group value(s) returned" % len(groups)}
    elif ok is False:
        res = {"ok": False, "reason": "denied", "detail": "the directory rejected the credentials"}
    else:
        res = {
            "ok": False,
            "reason": "unreachable",
            "detail": "no authentic reply from the %s server(s) — check host/port/secret and the broker journal" % proto,
        }
    log("extauth: test proto=%s user=%s result=%s" % (proto, username, "accept" if ok is True else res["reason"]))
    return 0, [json.dumps(res)], ""


VERBS = {
    "extauth_settings_read": verb_extauth_settings_read,
    "extauth_settings_write": verb_extauth_settings_write,
    "extauth_verify": verb_extauth_verify,
    "extauth_test": verb_extauth_test,
}
