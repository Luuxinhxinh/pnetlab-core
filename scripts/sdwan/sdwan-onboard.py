#!/usr/bin/env python3
# sdwan-onboard.py — self-contained Catalyst SD-WAN control-plane onboarder.
#
# This is PNetLab's stand-in for the "Layer B" of Cisco's open-source
# sdwan-lab-deployment-tool (catalyst_sdwan_lab, BSD-3-Clause). That tool drives
# vManage entirely through the heavyweight `catalystwan` SDK + `cisco-sdwan`
# (Sastre), neither of which is packageable on an airgapped Ubuntu appliance.
# So instead of vendoring those SDKs, this script speaks the SAME documented
# vManage REST flow directly with `requests`, and signs control-component
# certificates with `cryptography` instead of pyOpenSSL. Both deps are in apt
# (python3-requests / python3-cryptography), so the onboarder installs offline.
#
# It REUSES Cisco's bundled data verbatim (BSD-3, see scripts/sdwan/LICENSE):
#   data/certs/         signCA.{pem,key} + chainCA.pem (the enterprise Root CA)
#   data/serial_files/  serialFile-v{1,2}.viptela  (PnP allow-list for cEdges)
#   data/manager_configs/ Sastre backup of the controller_basic device template
#                         + its feature templates
#
# The whole system is internally consistent ONLY when the controllers' day-0
# (rendered by the build handler) carries the SAME org-name + Root CA + transport
# IPs this script targets. Defaults mirror Cisco's CML topology:
#   org-name  cml-sdwan-lab-tool       validator (vBond) transport  172.16.0.201
#   manager transport 172.16.0.1       controller (vSmart) transport 172.16.0.10X
#
# Onboarding stages (each reports progress to --progress as {state,pct,msg}):
#   wait -> settings -> onboard -> certs -> serial -> templates -> rediscover -> done
#
# Usage: sdwan-onboard.py --req <request.json> [--progress <job.json>] [--loglevel INFO]
# The request JSON is read once and the caller (worker.sh) shreds it; the admin
# password therefore never reaches argv.

import argparse
import datetime
import glob
import json
import os
import re
import socket
import sys
import time
import uuid
from os.path import abspath, dirname, exists, join

BASE_DIR = dirname(abspath(__file__))
DATA_DIR = join(BASE_DIR, "data")
CERTS_DIR = join(DATA_DIR, "certs")
SERIAL_DIR = join(DATA_DIR, "serial_files")
MANAGER_CONFIGS_DIR = join(DATA_DIR, "manager_configs")

# Cisco's bundled data is tied to this org-name + the bundled Root CA; overriding
# the org-name means the bundled serial file no longer matches (control onboarding
# still works, cEdge PnP via the bundled serial does not).
DEFAULT_ORG = "cml-sdwan-lab-tool"
DEFAULT_VALIDATOR_IP = "172.16.0.201"
DEFAULT_MANAGER_TP_IP = "172.16.0.1"

try:
    import requests
except Exception as e:  # pragma: no cover - import guard
    print("FATAL: python3-requests is required: %s" % e, file=sys.stderr)
    sys.exit(2)
try:
    import urllib3

    urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
except Exception:
    pass


# ---- progress reporting -----------------------------------------------------

class Progress:
    """Writes {state,pct,msg} to the job json the browser polls (same shape as
    html/import). Terminal states are 'done' and 'error'."""

    def __init__(self, path):
        self.path = path

    def _write(self, obj):
        if not self.path:
            return
        try:
            tmp = self.path + ".tmp"
            with open(tmp, "w") as f:
                json.dump(obj, f)
            os.replace(tmp, self.path)
            os.chmod(self.path, 0o666)
        except OSError:
            pass

    def update(self, state, pct, msg):
        msg = str(msg).replace('"', "")
        print("[%3d%%] %s" % (pct, msg), flush=True)
        self._write({"state": state, "pct": int(pct), "msg": msg})

    def done(self, msg, extra=None):
        obj = {"state": "done", "pct": 100, "msg": str(msg).replace('"', "")}
        if extra:
            obj.update(extra)
        self._write(obj)

    def error(self, msg):
        msg = str(msg).replace('"', "")
        print("ERROR: %s" % msg, file=sys.stderr, flush=True)
        self._write({"state": "error", "pct": 0, "msg": msg})


# ---- certificate signing (mirrors Cisco utils.create_cert, via cryptography) -

def sign_csr(ca_cert_pem, ca_key_pem, csr_pem):
    """Sign a device CSR with the bundled enterprise Root CA. Validity -1d..+2y,
    issuer = CA subject, subject/pubkey = CSR — same shape pyOpenSSL produced in
    Cisco's tool, no extensions copied."""
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization  # noqa: F401
    from cryptography.hazmat.primitives.serialization import load_pem_private_key

    ca_cert = x509.load_pem_x509_certificate(ca_cert_pem.encode())
    ca_key = load_pem_private_key(ca_key_pem.encode(), password=None)
    csr = x509.load_pem_x509_csr(csr_pem.encode())

    now = datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)
    builder = (
        x509.CertificateBuilder()
        .issuer_name(ca_cert.subject)
        .subject_name(csr.subject)
        .public_key(csr.public_key())
        .serial_number(uuid.uuid4().int)
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=2 * 365))
    )
    cert = builder.sign(private_key=ca_key, algorithm=hashes.SHA256())
    from cryptography.hazmat.primitives.serialization import Encoding

    return cert.public_bytes(Encoding.PEM).decode()


def load_ca():
    for n in ("signCA.pem", "signCA.key", "chainCA.pem"):
        if not exists(join(CERTS_DIR, n)):
            raise RuntimeError("bundled Root CA missing: %s" % n)
    with open(join(CERTS_DIR, "signCA.pem")) as f:
        ca_cert = f.read()
    with open(join(CERTS_DIR, "signCA.key")) as f:
        ca_key = f.read()
    with open(join(CERTS_DIR, "chainCA.pem")) as f:
        ca_chain = f.read()
    return ca_cert, ca_key, ca_chain


# ---- vManage REST client ----------------------------------------------------

class Manager:
    """Minimal vManage REST client: cookie login + XSRF token, then the handful
    of /dataservice calls the onboarding flow needs."""

    def __init__(self, ip, port, user, password):
        self.base = "https://%s:%d" % (ip, int(port))
        self.user = user
        self.password = password
        self.s = requests.Session()
        self.s.verify = False
        self.token = None

    def login(self):
        r = self.s.post(
            self.base + "/j_security_check",
            data={"j_username": self.user, "j_password": self.password},
            timeout=30,
            allow_redirects=False,
        )
        # vManage returns 200 with an HTML login page body on failure, empty on success
        if r.status_code != 200 or ("<html" in r.text.lower()):
            raise RuntimeError("login rejected")
        t = self.s.get(self.base + "/dataservice/client/token", timeout=30)
        if t.status_code == 200 and t.text and "<html" not in t.text.lower():
            self.token = t.text.strip()
            self.s.headers.update({"X-XSRF-TOKEN": self.token})
        return True

    def _token_header(self, extra=None):
        # vManage requires the XSRF token on EVERY mutating request, including
        # body-less POSTs (cert distribution, rediscovery).
        h = {}
        if self.token:
            h["X-XSRF-TOKEN"] = self.token
        if extra:
            h.update(extra)
        return h

    def get(self, path, **kw):
        return self.s.get(self.base + "/dataservice" + path, timeout=60, **kw)

    def post(self, path, json_body=None, data=None, content_type=None, **kw):
        headers = self._token_header()
        if content_type:
            headers["Content-Type"] = content_type
        return self.s.post(
            self.base + "/dataservice" + path,
            headers=headers or None,
            json=json_body,
            data=data,
            timeout=120,
            **kw
        )

    def put(self, path, json_body):
        return self.s.put(
            self.base + "/dataservice" + path,
            headers=self._token_header(),
            json=json_body,
            timeout=120,
        )

    def wait_task(self, task_id, log, timeout=600):
        """Poll /device/action/status/<id> until terminal."""
        deadline = time.time() + timeout
        while time.time() < deadline:
            r = self.get("/device/action/status/" + task_id)
            if r.status_code == 200:
                body = r.json()
                summary = body.get("summary", {}) or {}
                status = str(summary.get("status", "")).lower()
                data = body.get("data", []) or []
                statuses = [str(d.get("status", "")).lower() for d in data]
                if status in ("done", "failure", "success") and all(
                    s in ("success", "failure", "skipped", "") for s in statuses
                ):
                    if any(s == "failure" for s in statuses):
                        log("  task %s reported a failure" % task_id)
                    return True
            time.sleep(5)
        log("  task %s did not complete within %ds" % (task_id, timeout))
        return False


# ---- onboarding stages ------------------------------------------------------

def stage_settings(mgr, org, ca_chain, validator_ip, log):
    """Org-name, vBond, enterprise Root CA, signing mode, data stream, CloudX —
    mirrors Cisco utils.configure_manager_basic_settings."""
    # org-name (only if unset, like Cisco)
    cur = mgr.get("/settings/configuration/organization")
    org_set = False
    try:
        data = cur.json().get("data", [])
        org_set = bool(data and data[0].get("org"))
    except Exception:
        pass
    if not org_set:
        mgr.put("/settings/configuration/organization", {"org": org})
    else:
        log("  org-name already set")
    # vBond reachable at the validator transport IP (no DNS dependency)
    mgr.put("/settings/configuration/device", {"domainIp": validator_ip, "port": "12346"})
    mgr.put("/settings/configuration/vedgecloud", {"certificateauthority": "vmanage"})
    mgr.post("/settings/configuration/certificate", json_body={"certificateSigning": "enterprise"})
    mgr.put(
        "/settings/configuration/certificate/enterpriserootca",
        {"enterpriseRootCA": ca_chain},
    )
    mgr.put(
        "/settings/configuration/vmanagedatastream",
        {"enable": True, "ipType": "systemIp", "serverHostName": "systemIp", "vpn": 0},
    )
    mgr.put("/settings/configuration/cloudx", {"mode": "on"})


def _controllers(mgr):
    r = mgr.get("/system/device/controllers")
    if r.status_code != 200:
        return []
    return r.json().get("data", []) or []


def stage_onboard(mgr, control_components, manager_password, log):
    """Add validator + controllers (mirrors utils.onboard_control_components).
    control_components = {ip: 'validator'|'controller'}."""
    existing_ips = set()
    for d in _controllers(mgr):
        if d.get("deviceIP"):
            existing_ips.add(d.get("deviceIP"))
        if d.get("device-ip"):
            existing_ips.add(d.get("device-ip"))
    for ip, role in control_components.items():
        if ip in existing_ips:
            log("  %s %s already onboarded" % (role, ip))
            continue
        personality = "vbond" if role == "validator" else "vsmart"
        ok = False
        for pw in ("admin", manager_password):
            payload = {
                "deviceIP": ip,
                "username": "admin",
                "password": pw,
                "personality": personality,
                "generateCSR": False,
            }
            r = mgr.post("/system/device", json_body=payload)
            if r.status_code in (200, 201):
                ok = True
                break
        if not ok:
            raise RuntimeError(
                "could not add %s %s (check admin password on the node)" % (role, ip)
            )


def stage_certs(mgr, ca_cert, ca_key, log):
    """Generate a CSR for each control component lacking a cert, sign it with the
    bundled CA, install it, then distribute (mirrors utils.sign_certificate +
    send_to_controllers/send_to_vbond)."""
    signed = 0
    for dev in _controllers(mgr):
        dtype = dev.get("deviceType") or dev.get("device-type")
        serial = dev.get("serialNumber") or dev.get("serial-number") or ""
        dev_ip = dev.get("deviceIP") or dev.get("device-ip")
        if dtype not in ("vmanage", "vsmart", "vbond"):
            continue
        if serial and serial != "No certificate installed":
            continue
        if not dev_ip:
            continue
        r = mgr.post("/certificate/generate/csr", json_body={"deviceIP": dev_ip})
        if r.status_code != 200:
            log("  CSR generation failed for %s" % dev_ip)
            continue
        try:
            csr = r.json()["data"][0]["deviceCSR"]
        except Exception:
            log("  no CSR returned for %s" % dev_ip)
            continue
        cert = sign_csr(ca_cert, ca_key, csr)
        # vManage wants the raw PEM as the body with Content-Type application/json
        # (catalystwan's session default). text/plain -> 415; JSON-wrapping corrupts
        # the PEM ("failed to decrypt common name"). Confirmed on the .203 live run.
        ins = mgr.post(
            "/certificate/install/signedCert",
            data=cert,
            content_type="application/json",
        )
        if ins.status_code != 200:
            log("  cert install failed for %s" % dev_ip)
            continue
        try:
            task_id = ins.json().get("id")
            if task_id:
                mgr.wait_task(task_id, log)
        except Exception:
            pass
        signed += 1
    # push the new certs / serial state to the fabric
    mgr.post("/certificate/vedge/list?action=push")
    mgr.post("/certificate/vsmart/list")
    return signed


def stage_serial(mgr, serial_path, log):
    """Upload the WAN-edge serial (PnP allow-list) — mirrors
    upload_wan_edge_list / POST /system/device/fileupload (multipart)."""
    if not serial_path or not exists(serial_path):
        log("  no serial file — skipping cEdge allow-list")
        return False
    with open(serial_path, "rb") as fh:
        files = {"file": (os.path.basename(serial_path), fh)}
        data = {"validity": "valid", "upload": "true"}
        # multipart: do NOT send the json content-type header
        r = mgr.s.post(
            mgr.base + "/dataservice/system/device/fileupload",
            headers={"X-XSRF-TOKEN": mgr.token} if mgr.token else None,
            files=files,
            data=data,
            timeout=120,
        )
    if r.status_code not in (200, 201):
        log("  serial upload returned %d" % r.status_code)
        return False
    return True


# ---- classic template restore (controller_basic + feature closure) ----------

# Read-only/server-managed fields stripped before re-POSTing a template.
_FT_STRIP = (
    "templateId", "@rid", "createdOn", "createdBy", "lastUpdatedOn",
    "lastUpdatedBy", "devicesAttached", "attachedMastersCount", "rid", "lastUpdate",
)
_DT_STRIP = ("templateId", "@rid", "lastUpdatedOn", "lastUpdatedBy", "createdOn",
             "createdBy", "rid", "devicesAttached", "attachedMastersCount")


def _cfg_dir(config_version):
    return join(MANAGER_CONFIGS_DIR, "v%d_ipv4" % config_version)


def _load_feature_index(cfgdir):
    """Map feature-template templateId -> cleaned create payload, from the Sastre
    feature_templates/*.json backup."""
    idx = {}
    for fp in glob.glob(join(cfgdir, "feature_templates", "*.json")):
        try:
            d = json.load(open(fp))
        except Exception:
            continue
        tid = d.get("templateId")
        if not tid:
            continue
        payload = {k: v for k, v in d.items() if k not in _FT_STRIP}
        idx[tid] = payload
    return idx


def stage_templates(mgr, config_version, log):
    """Push the controller_basic device template + its feature-template closure,
    then attach it to any vSmart without a template. Best-effort: the control
    plane still federates if this fails. Edge config-groups (v2) are out of scope."""
    cfgdir = _cfg_dir(config_version)
    dt_path = join(cfgdir, "device_templates", "template", "controller_basic.json")
    if not exists(dt_path):
        log("  controller_basic template not bundled for v%d — skipping" % config_version)
        return False
    device_tmpl = json.load(open(dt_path))
    feat_idx = _load_feature_index(cfgdir)

    # existing feature templates by name -> id, so we reuse rather than duplicate
    existing = {}
    r = mgr.get("/template/feature")
    if r.status_code == 200:
        for ft in r.json().get("data", []) or []:
            existing[ft.get("templateName")] = ft.get("templateId")

    id_map = {}
    for g in device_tmpl.get("generalTemplates", []):
        old_id = g.get("templateId")
        if not old_id or old_id in id_map:
            continue
        payload = feat_idx.get(old_id)
        if payload is None:
            log("  feature template %s missing from bundle" % old_id)
            continue
        name = payload.get("templateName")
        if name in existing:
            id_map[old_id] = existing[name]
            continue
        resp = mgr.post("/template/feature", json_body=payload)
        if resp.status_code == 200:
            try:
                id_map[old_id] = resp.json().get("templateId")
            except Exception:
                pass
        else:
            log("  feature template '%s' POST -> %d" % (name, resp.status_code))

    # remap generalTemplates onto the new feature ids
    new_general = []
    for g in device_tmpl.get("generalTemplates", []):
        ng = dict(g)
        if g.get("templateId") in id_map:
            ng["templateId"] = id_map[g["templateId"]]
        # nested subTemplates (rare for controller_basic) remapped too
        subs = g.get("subTemplates")
        if isinstance(subs, list):
            ng["subTemplates"] = [
                dict(s, templateId=id_map.get(s.get("templateId"), s.get("templateId")))
                for s in subs
            ]
        new_general.append(ng)

    dt_name = device_tmpl.get("templateName", "controller_basic")
    # already present?
    dt_id = None
    rd = mgr.get("/template/device")
    if rd.status_code == 200:
        for dt in rd.json().get("data", []) or []:
            if dt.get("templateName") == dt_name:
                dt_id = dt.get("templateId")
    if dt_id is None:
        dt_payload = {k: v for k, v in device_tmpl.items() if k not in _DT_STRIP}
        dt_payload["generalTemplates"] = new_general
        dt_payload.setdefault("configType", "template")
        dt_payload.setdefault("factoryDefault", False)
        cr = mgr.post("/template/device/feature", json_body=dt_payload)
        if cr.status_code == 200:
            try:
                dt_id = cr.json().get("templateId")
            except Exception:
                pass
        else:
            log("  controller_basic device template POST -> %d" % cr.status_code)
            return False

    return _attach_controllers(mgr, dt_id, log)


def _attach_controllers(mgr, template_id, log):
    """Attach controller_basic to every vSmart that has no template yet
    (mirrors utils.attach_basic_controller_template)."""
    if not template_id:
        return False
    new_ctrls = {}
    for dev in _controllers(mgr):
        dtype = dev.get("deviceType") or dev.get("device-type")
        if dtype != "vsmart":
            continue
        if dev.get("template"):
            continue
        dev_ip = dev.get("deviceIP") or dev.get("device-ip") or ""
        last = dev_ip.split(".")[-1] if "." in dev_ip else dev_ip.split(":")[-1]
        new_ctrls[dev.get("uuid")] = last
    if not new_ctrls:
        log("  no unmanaged vSmart to attach")
        return True
    devices = []
    for dev_uuid, oct4 in new_ctrls.items():
        devices.append({
            "csv-status": "complete",
            "csv-deviceId": dev_uuid,
            "csv-deviceIP": "100.0.0.%s" % oct4,
            "csv-host-name": "Controller%s" % oct4[-2:],
            "//system/host-name": "Controller%s" % oct4[-2:],
            "//system/system-ip": "100.0.0.%s" % oct4,
            "//system/site-id": "100",
            "csv-templateId": template_id,
            "/0/eth1/interface/ip/address": "172.16.0.%s/24" % oct4,
        })
    attach = {
        "deviceTemplateList": [{
            "templateId": template_id,
            "device": devices,
            "isEdited": False,
            "isMasterEdited": False,
        }]
    }
    r = mgr.post("/template/device/config/attachfeature", json_body=attach)
    if r.status_code != 200:
        log("  attachfeature -> %d" % r.status_code)
        return False
    try:
        task_id = r.json().get("id")
        if task_id:
            mgr.wait_task(task_id, log)
    except Exception:
        pass
    return True


# ---- cEdge console activation (2c-iii) --------------------------------------
#
# The cEdge day-0 boothook (rendered by api_sdwan.php sdwanRenderEdge) already brings
# the device up logged-in + configured: the boothook MUST be wrapped in
# config-transaction ... commit or this image silently drops it (that dropped,
# unwrapped form is what earlier looked like "the boothook is ignored"). The boothook
# creates the admin user and lays down transport + the SD-WAN system/tunnel config:
#
#   config-transaction
#     username admin privilege 15 secret 0 admin
#     system { organization-name, vbond <ip> port 12346, system-ip, site-id }
#     interface Gi1   { ip address <transport>; no shut }
#     interface Tunnel1 { ip unnumbered Gi1; tunnel source Gi1; tunnel mode sdwan }
#     sdwan/interface Gi1/tunnel-interface { encapsulation ipsec; color default }
#   commit
#
# The ONE step that cannot ride the day-0 is the per-device cloud activation, because
# its token is generated by vManage only after the serial file is uploaded. So this
# stage logs in over the console (admin/admin, set by the boothook), re-asserts the
# config defensively, and runs:
#
#   request platform software sdwan vedge_cloud activate
#       chassis-number <uuid> token <vManage-generated token>
#
# The token is the PER-DEVICE one-time token — the `serialNumber` field of
# /certificate/vedge/list (NOT the shared OTP baked into the day-0). With it the cloud
# edge's vdaemon forms a control connection to vBond, the CSR is signed by vManage
# (enterprise CA) and the edge reaches cert-installed + reachable, after which
# stage_edges() attaches the edge_basic config-group.
#
# Transport: a STATIC address on Gi1 (the build's per-edge inet_ip, on the same /24 as
# vBond) rather than DHCP, so the activator needs no DHCP server on the INET bridge.

# IOS-XE exec/config prompt — "<host>#" or "<host>(config...)#" or "<host>>".
_PROMPT_RE = re.compile(rb"[\r\n][A-Za-z0-9][\w.\-]*(\([\w\-]+\))?[#>]\s*$")
_USER_RE = re.compile(rb"[Uu]sername:\s*$")
_PASS_RE = re.compile(rb"[Pp]assword:\s*$")


class EdgeConsole:
    """Minimal, dependency-free serial-console driver for a PNetLab qemu node
    (telnet TCP server fronted by qemu_wrapper_telnet). Speaks just enough telnet
    to refuse option negotiation, then does expect/send line interaction. Console
    automation is fragile, so every step is best-effort + logged."""

    def __init__(self, host, port, log):
        self.host = host or "127.0.0.1"
        self.port = int(port)
        self.log = log
        self.sock = None
        self.buf = bytearray()

    def connect(self, attempts=60, delay=10):
        """The telnet server only listens once the node has started; retry."""
        for _ in range(attempts):
            try:
                self.sock = socket.create_connection((self.host, self.port), timeout=10)
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
        """Strip telnet IAC sequences, refusing every option (WILL->DONT, DO->WONT)
        and skipping subnegotiation. Returns the cleaned payload bytes."""
        out = bytearray()
        resp = bytearray()
        i, n = 0, len(data)
        while i < n:
            b = data[i]
            if b == 255:  # IAC
                if i + 1 >= n:
                    break
                cmd = data[i + 1]
                if cmd == 250:  # SB ... IAC SE
                    j = i + 2
                    while j + 1 < n and not (data[j] == 255 and data[j + 1] == 240):
                        j += 1
                    i = j + 2
                    continue
                if cmd in (251, 252, 253, 254):
                    if i + 2 >= n:
                        break
                    opt = data[i + 2]
                    if cmd == 251:      # WILL -> DONT
                        resp += bytes([255, 254, opt])
                    elif cmd == 253:    # DO   -> WONT
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

    def _pump(self, window=0.6):
        self.sock.settimeout(window)
        try:
            d = self.sock.recv(4096)
            if d:
                self.buf += self._strip_iac(d)
        except socket.timeout:
            pass
        except OSError:
            pass

    def expect(self, patterns, timeout=20):
        """Read until one of the compiled byte-regex patterns matches the tail of
        the buffer. Returns the matched index, or -1 on timeout."""
        end = time.time() + timeout
        while time.time() < end:
            self._pump()
            tail = bytes(self.buf[-4096:])
            for idx, p in enumerate(patterns):
                if p.search(tail):
                    return idx
        return -1

    def send(self, line=""):
        """Clear the buffer and send a line (CR-terminated)."""
        self.buf = bytearray()
        try:
            self.sock.sendall((line + "\r").encode())
        except OSError:
            pass

    def get_to_exec(self, passwords, timeout=1200):
        """Drive a freshly-booted (or already-up) console to a privileged-exec
        prompt: answer first-boot dialogs, log in (trying each password), enable.
        passwords[0] should be 'admin' (the c8000v default for this image)."""
        deadline = time.time() + timeout
        pw_idx = 0
        sent_user = False
        self.send("")  # wake the line
        while time.time() < deadline:
            idx = self.expect([
                re.compile(rb"initial configuration dialog"),        # 0
                re.compile(rb"terminate autoinstall"),               # 1
                re.compile(rb"Press RETURN to get started"),         # 2
                _USER_RE,                                            # 3
                _PASS_RE,                                            # 4
                re.compile(rb"(?i)enter new password"),              # 5
                re.compile(rb"(?i)login invalid|authentication failed"),  # 6
                _PROMPT_RE,                                          # 7
            ], timeout=25)
            if idx == 0:
                self.send("no")
            elif idx == 1:
                self.send("yes")
            elif idx == 2:
                self.send("")
            elif idx == 3:
                self.send("admin")
                sent_user = True
            elif idx == 4:
                self.send(passwords[min(pw_idx, len(passwords) - 1)])
            elif idx == 5:
                # forced first-login password change — set it to the current attempt
                newpw = passwords[min(pw_idx, len(passwords) - 1)]
                self.send(newpw)
                if self.expect([_PASS_RE, re.compile(rb"(?i)confirm")], timeout=10) >= 0:
                    self.send(newpw)
            elif idx == 6:
                pw_idx += 1
                if pw_idx >= len(passwords):
                    self.log("    console login rejected for all known passwords")
                    return False
                self.send("")
            elif idx == 7:
                return self._enter_enable(passwords)
            else:
                # nothing recognised; nudge and retry
                self.send("")
        return False

    def _enter_enable(self, passwords):
        """Ensure privileged exec + disable paging. admin (netadmin) usually lands
        already at priv-15 ('#'); only enable if we see an unprivileged '>'."""
        tail = bytes(self.buf[-80:])
        if tail.rstrip().endswith(b">"):
            self.send("enable")
            if self.expect([_PASS_RE, _PROMPT_RE], timeout=10) == 0:
                self.send(passwords[0])
                self.expect([_PROMPT_RE], timeout=10)
        self.send("terminal length 0")
        self.expect([_PROMPT_RE], timeout=10)
        return True

    def activate(self, chassis, token, timeout=180):
        """Run the cloud-edge activation exec command. Robust against the c8000v's
        async console log spam: timestamped syslog lines and %FACILITY-n- messages
        (e.g. %SMART_LIC ... 'not allowed') are stripped before judging success, and
        only a genuine command error fails it. Control-plane completion is verified
        separately via vManage (stage_edges)."""
        # drain any pending async output so it can't ride into the command line
        self._pump(2.0)
        self._pump(1.0)
        cmd = ("request platform software sdwan vedge_cloud activate "
               "chassis-number %s token %s" % (chassis, token))
        self.send(cmd)
        self.expect([_PROMPT_RE], timeout=timeout)
        real = []
        for ln in bytes(self.buf).decode(errors="replace").splitlines():
            s = ln.strip()
            if not s:
                continue
            if re.match(r"\*?\w{3}\s+\d+\s+\d", s):     # "*Jun 15 02:.." syslog stamp
                continue
            if re.search(r"%[A-Z0-9_]+-\d+-", s):        # "%SMART_LIC-6-.." facility tag
                continue
            real.append(s)
        blob = "\n".join(real)
        if re.search(r"(?i)%\s*invalid|incomplete command|unrecognized|"
                     r"\berror:|activation failed|not activated|cannot ", blob):
            self.log("    activate rejected: %s" % blob[-200:])
            return False
        return True

    def ensure_logged_in(self, passwords):
        """(Re)establish a privileged-exec session. The first vedge_cloud activate
        reloads the device, so between activate attempts the console may be at a boot
        dialog or login prompt again; this reconnects + re-logs-in as needed."""
        if self.sock is None and not self.connect():
            return False
        return self.get_to_exec(passwords, timeout=1200)

    def control_up(self):
        """True if a control connection to vManage/vSmart is in the 'up' state.
        Returns None if the console isn't at a usable prompt (e.g. mid-reload)."""
        self.send("show sdwan control connections")
        if self.expect([_PROMPT_RE], timeout=15) < 0:
            return None
        txt = bytes(self.buf).decode(errors="replace")
        return bool(re.search(r"(?im)^\s*(vmanage|vsmart)\s+\S+.*\bup\b", txt))


def _drive_edge_activation(edge, token, passwords, log, attempts=4):
    """Activate one cEdge over its console, retrying because the first activation
    reloads the device (after which it transiently reverts to the day-0 OTP and is
    rejected SERNTPRES) — a second activation on the settled device sticks. Each
    attempt re-logs-in (the reload drops us back to the login prompt) and waits for
    the vManage control connection to come up before declaring success."""
    name = edge.get("host_name") or edge.get("uuid")
    cons = EdgeConsole(edge.get("console_host"), edge["console_port"], log)
    try:
        if not cons.connect():
            log("  %s: console %s:%s unreachable — skipping" % (name, cons.host, cons.port))
            return False
        for attempt in range(1, attempts + 1):
            if not cons.ensure_logged_in(passwords):
                log("  %s: could not reach exec prompt (attempt %d)" % (name, attempt))
                continue
            cons.activate(edge["uuid"], token)
            log("  %s: vedge_cloud activate issued (attempt %d)" % (name, attempt))
            # poll for the control connection; the reload (if any) drops the prompt,
            # so re-login on the way and keep checking for ~2 min per attempt.
            deadline = time.time() + 130
            while time.time() < deadline:
                time.sleep(15)
                up = cons.control_up()
                if up is None:
                    # console not at a prompt -> device reloading; re-login
                    cons.get_to_exec(passwords, timeout=300)
                    continue
                if up:
                    log("  %s: control connection to vManage UP" % name)
                    return True
            log("  %s: no control connection yet — re-activating" % name)
        log("  %s: control connection did not come up after %d attempts" % (name, attempts))
        return False
    finally:
        cons.close()


def fetch_edge_tokens(mgr, uuids, log):
    """Map each chassis UUID -> its vManage-generated activation token.
    Primary source: /certificate/vedge/list serialNumber (populated once the serial
    file is uploaded). Fallback: the per-device bootstrap config's otp field."""
    want = set(u for u in uuids if u)
    tokens = {}
    r = mgr.get("/certificate/vedge/list")
    if r.status_code == 200:
        for d in r.json().get("data", []) or []:
            u = d.get("uuid")
            if u in want:
                tok = d.get("serialNumber")
                if tok and tok != "No certificate installed":
                    tokens[u] = tok
    for u in want - set(tokens):
        try:
            b = mgr.get("/system/device/bootstrap/device/%s?configtype=cloudinit" % u)
            if b.status_code == 200:
                bs = (b.json().get("bootstrapConfig", "") or "")
                m = re.search(r"otp\s*[:=]\s*(\S+)", bs)
                if m:
                    tokens[u] = m.group(1)
        except Exception:
            pass
    return tokens


def activate_edges(mgr, edges, org, validator_ip, manager_password, log):
    """Drive each cEdge's console: log in and run the per-device cloud activation so
    it joins the fabric. The day-0 boothook has already applied the login + transport
    + SD-WAN config, so the console only needs to issue the activate. Returns the count
    of edges for which the activate command was issued without an obvious error."""
    targets = [e for e in edges if e.get("console_port") and e.get("uuid")]
    if not targets:
        log("  no cEdge console ports supplied — skipping console activation")
        return 0
    tokens = fetch_edge_tokens(mgr, [e["uuid"] for e in targets], log)
    # The WAN-edge serial/token list MUST be distributed to the controllers before the
    # edges activate, or vBond rejects the presented token with SERNTPRES. The serial
    # upload (stage_serial) populates vManage; this push syncs it to vBond/vSmart.
    try:
        mgr.post("/certificate/vedge/list?action=push")
        mgr.post("/certificate/vsmart/list")
    except Exception as e:
        log("  serial push to controllers failed (continuing): %s" % e)
    passwords = ["admin"]
    if manager_password and manager_password != "admin":
        passwords.append(manager_password)
    activated = 0
    for e in targets:
        name = e.get("host_name") or e.get("uuid")
        token = tokens.get(e["uuid"])
        if not token:
            log("  %s: no vManage token for chassis %s — skipping" % (name, e["uuid"]))
            continue
        try:
            if _drive_edge_activation(e, token, passwords, log):
                activated += 1
        except Exception as ex:
            log("  %s: console drive failed: %s" % (name, ex))
    return activated


# ---- cEdge (c8000v) onboarding + edge_basic config-group (v2) ---------------

def _vedges(mgr):
    r = mgr.get("/system/device/vedges")
    if r.status_code != 200:
        return []
    return r.json().get("data", []) or []


def _vedge_ready(dev):
    """A WAN edge is onboarded when its cert is installed and it is reachable.
    Field names vary across releases, so check the known aliases."""
    reach = (dev.get("reachability") or "").lower() == "reachable"
    cert = ""
    for k in ("vedgeCertificateState", "certInstallStatus", "cert_install_status"):
        if dev.get(k):
            cert = str(dev.get(k)).lower()
            break
    cert_ok = ("installed" in cert) or ("certinstalled" in cert)
    return reach and cert_ok


def wait_for_wan_edge_onboarding(mgr, uuids, log, timeout=2400):
    """Poll the WAN-edge inventory until every assigned chassis UUID is
    cert-installed + reachable (mirrors Cisco utils.wait_for_wan_edge_onboaring)."""
    want = set(uuids)
    deadline = time.time() + timeout
    done = set()
    while want - done and time.time() < deadline:
        by_uuid = {d.get("uuid"): d for d in _vedges(mgr)}
        for u in list(want - done):
            d = by_uuid.get(u)
            if d and _vedge_ready(d):
                done.add(u)
        if want - done:
            time.sleep(30)
    return done


def stage_edges(mgr, edges, log):
    """Associate + deploy the edge_basic config-group to the onboarded c8000v
    cEdges (mirrors Cisco add.py v2 path). edges = [{uuid,host_name,system_ip,
    site_id,inet_ip,mpls_ip,lan_ip,lan_net}]. Best-effort; needs edge_basic to
    already exist on vManage (its v2 restore is the separate 2c-ii step)."""
    if not edges:
        return
    uuids = [e["uuid"] for e in edges if e.get("uuid")]
    if not uuids:
        return

    log("  waiting for %d cEdge(s) to onboard..." % len(uuids))
    ready = wait_for_wan_edge_onboarding(mgr, uuids, log)
    if not ready:
        log("  no cEdge reached cert-installed+reachable — skipping config-group")
        return
    edges = [e for e in edges if e["uuid"] in ready]

    # locate edge_basic config-group
    cg_id = None
    r = mgr.get("/v1/config-group")
    if r.status_code == 200:
        for cg in (r.json() if isinstance(r.json(), list) else r.json().get("data", []) or []):
            if cg.get("name") == "edge_basic":
                cg_id = cg.get("id")
                break
    if not cg_id:
        log("  edge_basic config-group not found — restore it first (2c-ii); "
            "cEdges are onboarded but unconfigured")
        return

    # 1) associate the devices with the config-group
    assoc = {"devices": [{"id": e["uuid"]} for e in edges]}
    a = mgr.put("/v1/config-group/%s/device/associate" % cg_id, assoc)
    if a.status_code not in (200, 201):
        log("  config-group associate -> %d" % a.status_code)
        return

    # 2) fill per-device variables (INET kept on the control /24 = e['inet_ip'])
    devs_vars = []
    for e in edges:
        site = e.get("site_id")
        try:
            site = int(site)
        except (TypeError, ValueError):
            pass
        devs_vars.append({
            "device-id": e["uuid"],
            "variables": [
                {"name": "system_ip", "value": e.get("system_ip")},
                {"name": "host_name", "value": e.get("host_name")},
                {"name": "site_id", "value": site},
                {"name": "pseudo_commit_timer", "value": 300},
                {"name": "ipv6_strict_control", "value": False},
                {"name": "aaa_password", "value": "admin"},
                {"name": "vpn0_gi1_inet_ip", "value": e.get("inet_ip")},
                {"name": "vpn0_gi2_mpls_ip", "value": e.get("mpls_ip")},
                {"name": "vpn1_gi3_lan_ip", "value": e.get("lan_ip")},
                {"name": "vpn1_gi3_dhcp_network", "value": e.get("lan_net")},
                {"name": "vpn1_gi3_dhcp_address_exclude", "value": [e.get("lan_ip")]},
                {"name": "vpn1_gi3_dhcp_default_gateway", "value": e.get("lan_ip")},
            ],
        })
    v = mgr.put(
        "/v1/config-group/%s/device/variables" % cg_id,
        {"solution": "sdwan", "devices": devs_vars},
    )
    if v.status_code not in (200, 201):
        log("  config-group variables -> %d" % v.status_code)
        return

    # 3) deploy
    d = mgr.post("/v1/config-group/%s/device/deploy" % cg_id, json_body=assoc)
    if d.status_code not in (200, 201):
        log("  config-group deploy -> %d" % d.status_code)
        return
    try:
        task_id = d.json().get("parentTaskId") or d.json().get("id")
        if task_id:
            mgr.wait_task(task_id, log, timeout=1200)
    except Exception:
        pass
    log("  edge_basic deployed to %d cEdge(s)" % len(edges))


# ---- edge_basic config-group restore (2c-ii) --------------------------------
#
# Faithful reimplementation of Cisco Sastre's v2 config-group restore for the
# bundled edge_basic config-group. A config-group references feature-profiles
# (cli/system/service/transport); each profile holds a tree of parcels. We:
#   1) create each feature-profile (POST /v1/feature-profile/sdwan/<type>)
#   2) walk its associatedProfileParcels -> subparcels recursively, POSTing each
#      parcel's payload to the path resolved from the parcelType + the chain of
#      parent ids (Sastre's profile_parcel_coro). Some nested parcels are
#      *references* (e.g. dhcp-server under an interface) — for those we POST
#      {parcelId:<already-created id>} instead of creating a new parcel.
#   3) create the config-group referencing the new profile ids.
# Best-effort + idempotent (reuse by name); needs a live vManage to fully prove.

# Explicit nested-parcel paths for service/transport (Sastre path maps). %s slots
# are filled in order by the element-id chain (profileId, then parent parcel ids).
_SERVICE_PATHS = {
    "dhcp-server": "v1/feature-profile/sdwan/service/%s/dhcp-server",
    "lan/vpn": "v1/feature-profile/sdwan/service/%s/lan/vpn",
    "lan/vpn/interface/ethernet":
        "v1/feature-profile/sdwan/service/%s/lan/vpn/%s/interface/ethernet",
}
_SERVICE_REFS = {
    # (parcelType, parentParcelType) -> reference path
    ("dhcp-server", "lan/vpn/interface/ethernet"):
        "v1/feature-profile/sdwan/service/%s/lan/vpn/%s/interface/ethernet/%s/dhcp-server",
}
_TRANSPORT_PATHS = {
    "wan/vpn": "v1/feature-profile/sdwan/transport/%s/wan/vpn",
    "wan/vpn/interface/ethernet":
        "v1/feature-profile/sdwan/transport/%s/wan/vpn/%s/interface/ethernet",
}
# parcel types that other parcels reference (must be created before the reference)
_REFERENCED_TYPES = {"service": {"dhcp-server"}}


def _resolve_parcel_path(profile_type, parcel_type, parent_type):
    """Return (path_template, is_reference) or (None, False) if unsupported."""
    if profile_type in ("system", "cli", "other"):
        return "v1/feature-profile/sdwan/%s/%%s/%s" % (profile_type, parcel_type), False
    if profile_type == "service":
        ref = _SERVICE_REFS.get((parcel_type, parent_type))
        if ref:
            return ref, True
        if parcel_type in _SERVICE_PATHS:
            return _SERVICE_PATHS[parcel_type], False
    if profile_type == "transport":
        if parcel_type in _TRANSPORT_PATHS:
            return _TRANSPORT_PATHS[parcel_type], False
    return None, False


def _remap_ids(payload, id_map):
    """Replace any old parcel ids with their new ids throughout the payload
    (Sastre update_ids equivalent — operate on the JSON text)."""
    if not id_map:
        return payload
    s = json.dumps(payload)
    for old, new in id_map.items():
        if old and new:
            s = s.replace(old, new)
    return json.loads(s)


def _restore_parcel(mgr, profile_type, parcel, element_ids, parent_type, id_map, log):
    ptype = parcel.get("parcelType")
    tmpl, is_ref = _resolve_parcel_path(profile_type, ptype, parent_type)
    if tmpl is None:
        log("    unsupported parcel type %s — skipping" % ptype)
        return
    url = "/" + (tmpl % tuple(element_ids))
    if is_ref:
        old = parcel.get("parcelId")
        new = id_map.get(old)
        if not new:
            log("    reference %s has no created target — skipping" % ptype)
            return
        mgr.post(url, json_body={"parcelId": new})
        return
    payload = _remap_ids(parcel.get("payload") or {}, id_map)
    r = mgr.post(url, json_body=payload)
    if r.status_code not in (200, 201):
        log("    parcel %s POST -> %d" % (ptype, r.status_code))
        return
    try:
        new_id = r.json().get("parcelId") or r.json().get("id")
    except Exception:
        new_id = None
    if not new_id:
        return
    id_map[parcel.get("parcelId")] = new_id
    new_ids = element_ids + [new_id]
    # referenced sub-parcels first, so a later reference can resolve its id
    refset = _REFERENCED_TYPES.get(profile_type, set())
    subs = sorted(parcel.get("subparcels") or [],
                  key=lambda p: 0 if p.get("parcelType") in refset else 1)
    for sp in subs:
        _restore_parcel(mgr, profile_type, sp, new_ids, ptype, id_map, log)


def restore_feature_profile(mgr, profile, id_map, log):
    """Create a feature profile + its parcel tree; returns the new profile id."""
    ptype = profile.get("profileType")
    pname = profile.get("profileName")
    # reuse an existing profile of the same name (idempotent)
    existing = mgr.get("/v1/feature-profile/sdwan/%s" % ptype)
    if existing.status_code == 200:
        try:
            rows = existing.json()
            rows = rows if isinstance(rows, list) else rows.get("data", []) or []
            for p in rows:
                if p.get("profileName") == pname:
                    log("  feature-profile %s exists — reusing" % pname)
                    return p.get("profileId") or p.get("id")
        except Exception:
            pass
    r = mgr.post("/v1/feature-profile/sdwan/%s" % ptype,
                 json_body={"name": pname, "description": profile.get("description", "")})
    if r.status_code not in (200, 201):
        log("  feature-profile %s POST -> %d" % (pname, r.status_code))
        return None
    try:
        pid = r.json().get("id") or r.json().get("profileId")
    except Exception:
        pid = None
    if not pid:
        return None
    refset = _REFERENCED_TYPES.get(ptype, set())
    roots = sorted(profile.get("associatedProfileParcels") or [],
                   key=lambda p: 0 if p.get("parcelType") in refset else 1)
    for root in roots:
        _restore_parcel(mgr, ptype, root, [pid], None, id_map, log)
    return pid


def ensure_edge_config_group(mgr, cfgdir, log):
    """Restore the edge_basic config-group (+ feature-profiles) if absent.
    Returns the config-group id, or None."""
    cg_path = join(cfgdir, "config_groups", "group", "edge_basic.json")
    if not exists(cg_path):
        log("  edge_basic config-group not bundled — skipping restore")
        return None
    # already present?
    r = mgr.get("/v1/config-group")
    if r.status_code == 200:
        rows = r.json() if isinstance(r.json(), list) else r.json().get("data", []) or []
        for cg in rows:
            if cg.get("name") == "edge_basic":
                log("  edge_basic config-group already present")
                return cg.get("id")

    cg = json.load(open(cg_path))
    # restore each referenced feature-profile, mapping name -> new id
    prof_by_name = {}
    id_map = {}
    for prof_ref in cg.get("profiles", []):
        ptype = prof_ref.get("type")
        pname = prof_ref.get("name")
        pf = join(cfgdir, "feature_profiles", "sdwan", ptype, pname + ".json")
        if not exists(pf):
            log("  feature-profile file missing: %s/%s" % (ptype, pname))
            continue
        new_pid = restore_feature_profile(mgr, json.load(open(pf)), id_map, log)
        if new_pid:
            prof_by_name[pname] = new_pid

    profiles = [{"id": prof_by_name[p["name"]]}
                for p in cg.get("profiles", []) if p.get("name") in prof_by_name]
    if not profiles:
        log("  no feature-profiles restored — cannot create config-group")
        return None
    cr = mgr.post("/v1/config-group", json_body={
        "name": cg.get("name", "edge_basic"),
        "description": cg.get("description", ""),
        "solution": cg.get("solution", "sdwan"),
        "profiles": profiles,
    })
    if cr.status_code not in (200, 201):
        log("  config-group create -> %d" % cr.status_code)
        return None
    try:
        cg_id = cr.json().get("id") or cr.json().get("configGroupId")
    except Exception:
        cg_id = None
    log("  edge_basic config-group restored (%d profiles)" % len(profiles))
    return cg_id


# ---- main -------------------------------------------------------------------

def get_lab_parameters(software_version):
    """serial_file_version, config_version (mirrors Cisco get_sdwan_lab_parameters)."""
    try:
        major = int(software_version.split(".")[0])
        minor = int(software_version.split(".")[1])
    except Exception:
        return 2, 2
    if major <= 19 or (major == 20 and minor < 4):
        # unsupported, but don't hard-fail onboarding; use the modern set
        return 2, 2
    if major == 20 and minor in (4, 5, 6, 7, 8, 9, 10, 11):
        return 1, 1
    return 2, 2


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--req", required=True, help="request JSON path")
    ap.add_argument("--progress", default="", help="job status JSON path")
    ap.add_argument("--loglevel", default="INFO")
    args = ap.parse_args()

    prog = Progress(args.progress)

    def log(msg):
        print(msg, flush=True)

    try:
        with open(args.req) as f:
            req = json.load(f)
    except Exception as e:
        prog.error("cannot read request: %s" % e)
        return 1

    manager_ip = req.get("manager_ip")
    manager_port = int(req.get("manager_port", 443) or 443)
    manager_user = req.get("manager_user", "admin")
    manager_password = req.get("manager_password", "")
    org = req.get("org_name") or DEFAULT_ORG
    # validators: accept a list (validator_ips) or a single validator_ip (back-compat)
    validator_ips = req.get("validator_ips")
    if not validator_ips:
        validator_ips = [req.get("validator_ip") or DEFAULT_VALIDATOR_IP]
    validator_ip = validator_ips[0]  # the vBond the Manager/Controllers point at
    controller_ips = req.get("controller_ips") or ["172.16.0.101"]
    edges = req.get("edges") or []
    software_version = str(req.get("software_version", "") or "")
    do_templates = bool(req.get("do_templates", True))
    ip_type = req.get("ip_type", "v4")  # noqa: F841 (v4-only for now)

    if not manager_ip or not manager_password:
        prog.error("manager_ip and manager_password are required")
        return 1
    if manager_password == "admin":
        prog.error("change the SD-WAN Manager admin password before onboarding")
        return 1

    serial_version, config_version = get_lab_parameters(software_version)
    serial_path = req.get("serial_file") or join(
        SERIAL_DIR, "serialFile-v%d.viptela" % serial_version
    )

    begin = datetime.datetime.now()
    try:
        ca_cert, ca_key, ca_chain = load_ca()
    except Exception as e:
        prog.error(str(e))
        return 1

    mgr = Manager(manager_ip, manager_port, manager_user, manager_password)

    # 1) wait for the Manager REST API
    prog.update("running", 5, "Waiting for SD-WAN Manager API...")
    deadline = time.time() + 3600
    while True:
        try:
            if mgr.login():
                break
        except Exception:
            pass
        if time.time() > deadline:
            prog.error("SD-WAN Manager API did not come up within 60 minutes")
            return 1
        time.sleep(20)
    prog.update("running", 25, "SD-WAN Manager login OK")

    try:
        # 2) basic settings
        prog.update("running", 30, "Configuring org-name / Root CA / vBond...")
        stage_settings(mgr, org, ca_chain, validator_ip, log)

        # 3) onboard control components
        prog.update("running", 45, "Onboarding validator + controllers...")
        components = {}
        for ip in validator_ips:
            components[ip] = "validator"
        for ip in controller_ips:
            components[ip] = "controller"
        stage_onboard(mgr, components, manager_password, log)

        # 4) certificates
        prog.update("running", 60, "Signing control-component certificates...")
        signed = stage_certs(mgr, ca_cert, ca_key, log)
        log("  signed %d certificate(s)" % signed)

        # 5) serial file
        prog.update("running", 80, "Uploading WAN-edge serial file...")
        stage_serial(mgr, serial_path, log)

        # 6) templates (best-effort): controller_basic (all versions) + the
        #    edge_basic config-group restore for v2 when cEdges are present.
        if do_templates:
            prog.update("running", 88, "Creating controller device template...")
            try:
                stage_templates(mgr, config_version, log)
            except Exception as e:
                log("  template stage skipped: %s" % e)
            if edges and config_version == 2:
                prog.update("running", 89, "Restoring edge_basic config-group...")
                try:
                    ensure_edge_config_group(mgr, _cfg_dir(config_version), log)
                except Exception as e:
                    log("  edge config-group restore skipped: %s" % e)

        # 7) cEdge onboarding: drive each console to push the controller-mode config
        #    + run the per-device cloud activation (the c8000v image ignores the
        #    day-0 boothook, so this is the only hands-free delivery path), then
        #    wait for cert-installed+reachable and attach the edge_basic config-group.
        if edges:
            prog.update("running", 90, "Activating cEdges over console...")
            try:
                n = activate_edges(mgr, edges, org, validator_ip, manager_password, log)
                log("  issued cloud activation on %d cEdge(s)" % n)
            except Exception as e:
                log("  edge activation skipped: %s" % e)
            prog.update("running", 92, "Waiting for cEdges + config-group...")
            try:
                stage_edges(mgr, edges, log)
            except Exception as e:
                log("  edge stage skipped: %s" % e)

        # 8) rediscovery
        prog.update("running", 95, "Triggering device rediscovery...")
        try:
            mgr.post("/device/action/rediscoverall")
        except Exception:
            pass

    except Exception as e:
        prog.error(str(e))
        return 1
    finally:
        try:
            mgr.s.close()
        except Exception:
            pass

    took = datetime.datetime.now() - begin
    prog.done("SD-WAN control plane onboarded (%s)" % str(took).split(".")[0])
    return 0


if __name__ == "__main__":
    sys.exit(main())
