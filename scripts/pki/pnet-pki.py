#!/usr/bin/env python3
# pnet-pki.py — Lab PKI engine for PNetLab (CA + cert issuance).
#
# Invoked AS ROOT by pnetlab-brokerd's `pki` verb (never by www-data directly):
#   argv[1] = action, JSON payload on stdin, ONE JSON object on stdout, exit 0.
# Output is always {"ok": bool, ...}; hard errors are {"ok": false, "error": "..."}
# (still exit 0 so the broker relays the line). All crypto via the `cryptography`
# library (already an apt dep + used by sdwan-onboard.py) — no openssl shell-out,
# fully airgapped.
#
# Store: /opt/unetlab/data/pki/ (override with $PNET_PKI_DIR for local testing).
#   index.json              { "cas": { "<ca_id>": {meta} } }
#   <ca_id>/ca.json         CA metadata + issued-cert index + revocations
#   <ca_id>/root.crt/.key   root CA (key 0600); chain.pem; crl.pem
#   <ca_id>/issuing.crt/.key (two-tier only — the CA that actually signs leaves)
#   <ca_id>/certs/<cert_id>.crt/.key
#
# CA private keys are mode 0600, root-owned; www-data never reads the store —
# all artifacts are returned through the broker on explicit request.

import datetime
import ipaddress
import json
import os
import re
import sys
import uuid

from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID, ObjectIdentifier
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, ec
from cryptography.hazmat.primitives.serialization import (
    Encoding, PrivateFormat, NoEncryption, BestAvailableEncryption,
    load_pem_private_key, pkcs12,
)

STORE = os.environ.get("PNET_PKI_DIR", "/opt/unetlab/data/pki")
INDEX = os.path.join(STORE, "index.json")

RE_ID = re.compile(r"^[0-9a-f]{12}$")          # server-generated ids only
KEY_TYPES = {"rsa2048", "rsa4096", "ec256", "ec384"}
MAX_DAYS = 366 * 30                            # ~30 years ceiling
IPSEC_IKE_EKU = ObjectIdentifier("1.3.6.1.5.5.7.3.17")   # id-kp-ipsecIKE

# Leaf profiles: intent -> (key usages, extended key usages, want CN-in-SAN).
# The GUI presents these by friendly name; the X.509 detail lives here so the
# user never edits EKU/keyUsage by hand.
PROFILES = {
    "server":        {"label": "TLS Server",        "eku": ["serverAuth"],
                      "ku": ["digital_signature", "key_encipherment"], "cn_san": True},
    "client":        {"label": "TLS Client",        "eku": ["clientAuth"],
                      "ku": ["digital_signature"], "cn_san": False},
    "server_client": {"label": "Server + Client",   "eku": ["serverAuth", "clientAuth"],
                      "ku": ["digital_signature", "key_encipherment"], "cn_san": True},
    "radius_eap":    {"label": "RADIUS / EAP Server", "eku": ["serverAuth", "clientAuth"],
                      "ku": ["digital_signature", "key_encipherment"], "cn_san": True},
    "ipsec":         {"label": "IPsec / IKEv2",     "eku": ["serverAuth", "clientAuth", "ipsec_ike"],
                      "ku": ["digital_signature", "key_encipherment"], "cn_san": True},
    "https":         {"label": "Web / HTTPS",       "eku": ["serverAuth"],
                      "ku": ["digital_signature", "key_encipherment"], "cn_san": True},
    "device":        {"label": "Device Identity",   "eku": ["clientAuth"],
                      "ku": ["digital_signature"], "cn_san": False},
}

EKU_OID = {
    "serverAuth": ExtendedKeyUsageOID.SERVER_AUTH,
    "clientAuth": ExtendedKeyUsageOID.CLIENT_AUTH,
    "ipsec_ike": IPSEC_IKE_EKU,
}


# ---- helpers ---------------------------------------------------------------

class PkiError(Exception):
    pass


def now():
    return datetime.datetime.now(datetime.timezone.utc).replace(tzinfo=None)


def new_id():
    return uuid.uuid4().hex[:12]


def clean_text(v, maxlen=64):
    """Subject component: printable, no control chars, length-capped."""
    if v is None:
        return ""
    v = "".join(c for c in str(v) if 32 <= ord(c) < 127).strip()
    return v[:maxlen]


def gen_key(key_type):
    if key_type == "rsa2048":
        return rsa.generate_private_key(public_exponent=65537, key_size=2048)
    if key_type == "rsa4096":
        return rsa.generate_private_key(public_exponent=65537, key_size=4096)
    if key_type == "ec256":
        return ec.generate_private_key(ec.SECP256R1())
    if key_type == "ec384":
        return ec.generate_private_key(ec.SECP384R1())
    raise PkiError("bad key_type")


def sig_hash(key):
    # EC P-384 pairs with SHA-384; everything else SHA-256.
    if isinstance(key, ec.EllipticCurvePrivateKey) and key.curve.name == "secp384r1":
        return hashes.SHA384()
    return hashes.SHA256()


def build_name(cn, o="", ou="", c=""):
    attrs = [x509.NameAttribute(NameOID.COMMON_NAME, clean_text(cn) or "PNetLab")]
    if o:
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATION_NAME, clean_text(o)))
    if ou:
        attrs.append(x509.NameAttribute(NameOID.ORGANIZATIONAL_UNIT_NAME, clean_text(ou)))
    if c:
        cc = clean_text(c, 2).upper()
        if len(cc) == 2 and cc.isalpha():
            attrs.append(x509.NameAttribute(NameOID.COUNTRY_NAME, cc))
    return x509.Name(attrs)


def san_entry(s):
    """Classify a SAN string -> the right GeneralName (IP / email / DNS)."""
    s = clean_text(s, 253)
    if not s:
        return None
    try:
        return x509.IPAddress(ipaddress.ip_address(s))
    except ValueError:
        pass
    if "@" in s:
        return x509.RFC822Name(s)
    return x509.DNSName(s)


def san_list(cn, sans, add_cn):
    names, seen = [], set()
    src = list(sans or [])
    if add_cn and cn:
        src.insert(0, cn)
    for s in src:
        e = san_entry(s)
        if e is not None and str(e) not in seen:
            seen.add(str(e))
            names.append(e)
    return names


def key_usage(names):
    flags = dict(digital_signature=False, content_commitment=False,
                 key_encipherment=False, data_encipherment=False,
                 key_agreement=False, key_cert_sign=False, crl_sign=False,
                 encipher_only=False, decipher_only=False)
    for n in names:
        flags[n] = True
    return x509.KeyUsage(**flags)


def serialize_key(key):
    return key.private_bytes(Encoding.PEM, PrivateFormat.PKCS8,
                             NoEncryption()).decode()


def write_secret(path, data):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(data)


def write_text(path, data):
    with open(path, "w") as f:
        f.write(data)


def read_file(path):
    with open(path) as f:
        return f.read()


def load_index():
    try:
        return json.loads(read_file(INDEX))
    except (OSError, ValueError):
        return {"cas": {}}


def save_index(idx):
    os.makedirs(STORE, exist_ok=True)
    write_text(INDEX, json.dumps(idx, indent=2))


def ca_dir(ca_id):
    if not RE_ID.match(ca_id or ""):
        raise PkiError("bad ca_id")
    d = os.path.join(STORE, ca_id)
    if not os.path.isdir(d):
        raise PkiError("no such CA")
    return d


def load_ca_meta(ca_id):
    return json.loads(read_file(os.path.join(ca_dir(ca_id), "ca.json")))


def save_ca_meta(ca_id, meta):
    write_text(os.path.join(STORE, ca_id, "ca.json"), json.dumps(meta, indent=2))


def signer(ca_id):
    """Return (issuer_cert, issuer_key, chain_pem) = the CA that signs leaves
    (the issuing CA in a two-tier setup, else the root)."""
    d = ca_dir(ca_id)
    if os.path.exists(os.path.join(d, "issuing.crt")):
        cert = x509.load_pem_x509_certificate(read_file(os.path.join(d, "issuing.crt")).encode())
        key = load_pem_private_key(read_file(os.path.join(d, "issuing.key")).encode(), None)
    else:
        cert = x509.load_pem_x509_certificate(read_file(os.path.join(d, "root.crt")).encode())
        key = load_pem_private_key(read_file(os.path.join(d, "root.key")).encode(), None)
    chain = read_file(os.path.join(d, "chain.pem"))
    return cert, key, chain


def fingerprint(cert):
    return cert.fingerprint(hashes.SHA256()).hex()


# ---- CA cert construction --------------------------------------------------

def make_ca_cert(subject, issuer_name, pub_key, sign_key, days, path_length,
                 issuer_cert=None):
    ski = x509.SubjectKeyIdentifier.from_public_key(pub_key)
    b = (x509.CertificateBuilder()
         .subject_name(subject)
         .issuer_name(issuer_name)
         .public_key(pub_key)
         .serial_number(x509.random_serial_number())
         .not_valid_before(now() - datetime.timedelta(days=1))
         .not_valid_after(now() + datetime.timedelta(days=days))
         .add_extension(x509.BasicConstraints(ca=True, path_length=path_length), critical=True)
         .add_extension(key_usage(["key_cert_sign", "crl_sign", "digital_signature"]), critical=True)
         .add_extension(ski, critical=False))
    if issuer_cert is not None:
        aki = x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_cert.public_key())
    else:
        aki = x509.AuthorityKeyIdentifier.from_issuer_public_key(pub_key)
    b = b.add_extension(aki, critical=False)
    return b.sign(private_key=sign_key, algorithm=sig_hash(sign_key))


# ---- actions ---------------------------------------------------------------

def act_profiles(_p):
    return {"ok": True, "profiles": [{"id": k, "label": v["label"]}
                                     for k, v in PROFILES.items()],
            "key_types": sorted(KEY_TYPES)}


def act_ca_create(p):
    name = clean_text(p.get("name"))
    if not name:
        raise PkiError("name required")
    key_type = p.get("key_type", "rsa2048")
    if key_type not in KEY_TYPES:
        raise PkiError("bad key_type")
    days = int(p.get("days", 3650))
    if days < 1 or days > MAX_DAYS:
        raise PkiError("bad days")
    two_tier = bool(p.get("two_tier"))
    o, ou, c = p.get("org", ""), p.get("ou", ""), p.get("country", "")

    ca_id = new_id()
    d = os.path.join(STORE, ca_id)
    os.makedirs(os.path.join(d, "certs"), exist_ok=True)

    # Root CA (self-signed). path_length 1 if it will sign an issuing CA, else 0.
    root_key = gen_key(key_type)
    root_name = build_name(name + " Root CA", o, ou, c)
    root_cert = make_ca_cert(root_name, root_name, root_key.public_key(),
                             root_key, days, 1 if two_tier else 0)
    write_text(os.path.join(d, "root.crt"), root_cert.public_bytes(Encoding.PEM).decode())
    write_secret(os.path.join(d, "root.key"), serialize_key(root_key))

    chain_pem = root_cert.public_bytes(Encoding.PEM).decode()
    if two_tier:
        iss_key = gen_key(key_type)
        iss_name = build_name(name + " Issuing CA", o, ou, c)
        iss_cert = make_ca_cert(iss_name, root_name, iss_key.public_key(),
                                root_key, min(days, days), 0, issuer_cert=root_cert)
        write_text(os.path.join(d, "issuing.crt"), iss_cert.public_bytes(Encoding.PEM).decode())
        write_secret(os.path.join(d, "issuing.key"), serialize_key(iss_key))
        # chain leaf-presents: issuing then root
        chain_pem = (iss_cert.public_bytes(Encoding.PEM).decode()
                     + root_cert.public_bytes(Encoding.PEM).decode())
    write_text(os.path.join(d, "chain.pem"), chain_pem)

    meta = {"id": ca_id, "name": name, "org": o, "ou": ou, "country": c,
            "key_type": key_type, "two_tier": two_tier, "days": days,
            "created": now().isoformat() + "Z", "lab": clean_text(p.get("lab"), 64),
            "root_fp": fingerprint(root_cert), "certs": {}, "revoked": {},
            "crl_number": 0}
    save_ca_meta(ca_id, meta)
    idx = load_index()
    idx["cas"][ca_id] = {"id": ca_id, "name": name, "two_tier": two_tier,
                         "created": meta["created"]}
    save_index(idx)
    return {"ok": True, "ca": _ca_public(meta)}


def _ca_public(meta):
    return {k: meta[k] for k in ("id", "name", "org", "ou", "country",
                                 "key_type", "two_tier", "days", "created",
                                 "lab", "root_fp")}


def act_list(_p):
    idx = load_index()
    out = []
    for ca_id in idx.get("cas", {}):
        try:
            m = load_ca_meta(ca_id)
        except (OSError, ValueError, PkiError):
            continue
        certs = []
        for cid, ci in m.get("certs", {}).items():
            certs.append({"id": cid, "cn": ci.get("cn"), "profile": ci.get("profile"),
                          "created": ci.get("created"), "fp": ci.get("fp"),
                          "revoked": cid in m.get("revoked", {})})
        out.append({"ca": _ca_public(m), "certs": certs})
    return {"ok": True, "cas": out}


def _issue_common(ca_id, subject_cert, profile, cn, key_pem):
    """Persist a freshly built leaf cert + key, update the CA index."""
    m = load_ca_meta(ca_id)
    cid = new_id()
    d = os.path.join(STORE, ca_id, "certs")
    write_text(os.path.join(d, cid + ".crt"),
               subject_cert.public_bytes(Encoding.PEM).decode())
    if key_pem is not None:
        write_secret(os.path.join(d, cid + ".key"), key_pem)
    m["certs"][cid] = {"id": cid, "cn": cn, "profile": profile,
                       "serial": str(subject_cert.serial_number),
                       "fp": fingerprint(subject_cert),
                       "has_key": key_pem is not None,
                       "created": now().isoformat() + "Z"}
    save_ca_meta(ca_id, m)
    return cid


def _leaf_builder(subject, issuer_cert, pub_key, days, profile_def, sans):
    b = (x509.CertificateBuilder()
         .subject_name(subject)
         .issuer_name(issuer_cert.subject)
         .public_key(pub_key)
         .serial_number(x509.random_serial_number())
         .not_valid_before(now() - datetime.timedelta(days=1))
         .not_valid_after(now() + datetime.timedelta(days=days))
         .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
         .add_extension(key_usage(profile_def["ku"]), critical=True)
         .add_extension(x509.ExtendedKeyUsage([EKU_OID[e] for e in profile_def["eku"]]), critical=False)
         .add_extension(x509.SubjectKeyIdentifier.from_public_key(pub_key), critical=False)
         .add_extension(
             x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_cert.public_key()),
             critical=False))
    if sans:
        b = b.add_extension(x509.SubjectAlternativeName(sans), critical=False)
    return b


def act_issue(p):
    ca_id = p.get("ca_id")
    profile = p.get("profile")
    if profile not in PROFILES:
        raise PkiError("bad profile")
    pdef = PROFILES[profile]
    cn = clean_text(p.get("cn"))
    if not cn:
        raise PkiError("cn required")
    key_type = p.get("key_type", "rsa2048")
    if key_type not in KEY_TYPES:
        raise PkiError("bad key_type")
    days = int(p.get("days", 825))
    if days < 1 or days > MAX_DAYS:
        raise PkiError("bad days")
    issuer_cert, issuer_key, chain = signer(ca_id)
    sans = san_list(cn, p.get("sans"), pdef["cn_san"])

    leaf_key = gen_key(key_type)
    subject = build_name(cn, p.get("org", ""), p.get("ou", ""), p.get("country", ""))
    cert = _leaf_builder(subject, issuer_cert, leaf_key.public_key(),
                         days, pdef, sans).sign(
        private_key=issuer_key, algorithm=sig_hash(issuer_key))
    key_pem = serialize_key(leaf_key)
    cid = _issue_common(ca_id, cert, profile, cn, key_pem)
    return {"ok": True, "cert_id": cid, "ca_id": ca_id,
            "cert": cert.public_bytes(Encoding.PEM).decode(),
            "key": key_pem, "chain": chain, "fp": fingerprint(cert)}


def act_sign_csr(p):
    ca_id = p.get("ca_id")
    profile = p.get("profile")
    if profile not in PROFILES:
        raise PkiError("bad profile")
    pdef = PROFILES[profile]
    days = int(p.get("days", 825))
    if days < 1 or days > MAX_DAYS:
        raise PkiError("bad days")
    csr_pem = p.get("csr") or ""
    try:
        csr = x509.load_pem_x509_csr(csr_pem.encode())
    except Exception:
        raise PkiError("invalid CSR")
    if not csr.is_signature_valid:
        raise PkiError("CSR signature invalid")
    issuer_cert, issuer_key, chain = signer(ca_id)
    # CN from the CSR subject (for the index); SANs: prefer the CSR's own, else
    # synthesize from CN per profile.
    try:
        cn = csr.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value
    except IndexError:
        cn = ""
    sans = []
    try:
        ext = csr.extensions.get_extension_for_class(x509.SubjectAlternativeName)
        sans = list(ext.value)
    except x509.ExtensionNotFound:
        sans = san_list(cn, [], pdef["cn_san"])
    cert = _leaf_builder(csr.subject, issuer_cert, csr.public_key(),
                         days, pdef, sans).sign(
        private_key=issuer_key, algorithm=sig_hash(issuer_key))
    cid = _issue_common(ca_id, cert, profile, clean_text(cn), None)
    return {"ok": True, "cert_id": cid, "ca_id": ca_id,
            "cert": cert.public_bytes(Encoding.PEM).decode(),
            "chain": chain, "fp": fingerprint(cert)}


def act_export(p):
    """Return one artifact for download. fmt = cert|key|chain|fullchain|ca|p12|der."""
    ca_id = p.get("ca_id")
    fmt = p.get("format", "cert")
    d = ca_dir(ca_id)
    if fmt == "ca":
        return {"ok": True, "filename": "ca-chain.pem", "ctype": "application/x-pem-file",
                "data": read_file(os.path.join(d, "chain.pem"))}
    cid = p.get("cert_id")
    if not RE_ID.match(cid or ""):
        raise PkiError("bad cert_id")
    crt_path = os.path.join(d, "certs", cid + ".crt")
    key_path = os.path.join(d, "certs", cid + ".key")
    if not os.path.exists(crt_path):
        raise PkiError("no such cert")
    cert_pem = read_file(crt_path)
    chain_pem = read_file(os.path.join(d, "chain.pem"))
    cert = x509.load_pem_x509_certificate(cert_pem.encode())
    if fmt == "cert":
        return {"ok": True, "filename": cid + ".crt", "ctype": "application/x-pem-file",
                "data": cert_pem}
    if fmt == "key":
        if not os.path.exists(key_path):
            raise PkiError("no key for this cert (CSR-signed)")
        return {"ok": True, "filename": cid + ".key", "ctype": "application/x-pem-file",
                "data": read_file(key_path), "secret": True}
    if fmt == "chain":
        return {"ok": True, "filename": cid + "-chain.pem", "ctype": "application/x-pem-file",
                "data": chain_pem}
    if fmt == "fullchain":
        return {"ok": True, "filename": cid + "-fullchain.pem", "ctype": "application/x-pem-file",
                "data": cert_pem + chain_pem}
    if fmt == "der":
        import base64
        return {"ok": True, "filename": cid + ".cer", "ctype": "application/pkix-cert",
                "data_b64": base64.b64encode(cert.public_bytes(Encoding.DER)).decode(),
                "binary": True}
    if fmt == "p12":
        if not os.path.exists(key_path):
            raise PkiError("no key for this cert (CSR-signed)")
        import base64
        key = load_pem_private_key(read_file(key_path).encode(), None)
        chain_certs = [c for c in _split_pem_certs(chain_pem)]
        passwd = p.get("p12_pass") or ""
        enc = BestAvailableEncryption(passwd.encode()) if passwd else NoEncryption()
        blob = pkcs12.serialize_key_and_certificates(
            name=cid.encode(), key=key, cert=cert,
            cas=chain_certs or None, encryption_algorithm=enc)
        return {"ok": True, "filename": cid + ".p12", "ctype": "application/x-pkcs12",
                "data_b64": base64.b64encode(blob).decode(), "binary": True, "secret": True}
    raise PkiError("bad format")


def _split_pem_certs(pem):
    out, cur = [], []
    for line in pem.splitlines(keepends=True):
        cur.append(line)
        if "END CERTIFICATE" in line:
            try:
                out.append(x509.load_pem_x509_certificate("".join(cur).encode()))
            except Exception:
                pass
            cur = []
    return out


def act_revoke(p):
    ca_id = p.get("ca_id")
    cid = p.get("cert_id")
    m = load_ca_meta(ca_id)
    if cid not in m.get("certs", {}):
        raise PkiError("no such cert")
    serial = int(m["certs"][cid]["serial"])
    m.setdefault("revoked", {})[cid] = {"serial": str(serial),
                                        "at": now().isoformat() + "Z"}
    save_ca_meta(ca_id, m)
    _regen_crl(ca_id, m)
    return {"ok": True, "revoked": cid}


def _regen_crl(ca_id, m):
    issuer_cert, issuer_key, _ = signer(ca_id)
    b = (x509.CertificateRevocationListBuilder()
         .issuer_name(issuer_cert.subject)
         .last_update(now() - datetime.timedelta(minutes=1))
         .next_update(now() + datetime.timedelta(days=30)))
    for rid, ri in m.get("revoked", {}).items():
        rc = (x509.RevokedCertificateBuilder()
              .serial_number(int(ri["serial"]))
              .revocation_date(now())
              .build())
        b = b.add_revoked_certificate(rc)
    crl = b.sign(private_key=issuer_key, algorithm=sig_hash(issuer_key))
    write_text(os.path.join(STORE, ca_id, "crl.pem"),
               crl.public_bytes(Encoding.PEM).decode())


def act_crl(p):
    ca_id = p.get("ca_id")
    d = ca_dir(ca_id)
    path = os.path.join(d, "crl.pem")
    if not os.path.exists(path):
        _regen_crl(ca_id, load_ca_meta(ca_id))
    return {"ok": True, "filename": "crl.pem", "ctype": "application/x-pem-file",
            "data": read_file(path)}


def act_delete_ca(p):
    import shutil
    ca_id = p.get("ca_id")
    d = ca_dir(ca_id)
    shutil.rmtree(d, ignore_errors=True)
    idx = load_index()
    idx.get("cas", {}).pop(ca_id, None)
    save_index(idx)
    return {"ok": True, "deleted": ca_id}


ACTIONS = {
    "profiles": act_profiles,
    "ca_create": act_ca_create,
    "list": act_list,
    "issue": act_issue,
    "sign_csr": act_sign_csr,
    "export": act_export,
    "revoke": act_revoke,
    "crl": act_crl,
    "delete_ca": act_delete_ca,
}


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        payload = json.load(sys.stdin) if not sys.stdin.isatty() else {}
    except ValueError:
        payload = {}
    fn = ACTIONS.get(action)
    if fn is None:
        print(json.dumps({"ok": False, "error": "bad action"}))
        return
    try:
        os.makedirs(STORE, exist_ok=True)
        result = fn(payload if isinstance(payload, dict) else {})
    except PkiError as e:
        result = {"ok": False, "error": str(e)}
    except Exception as e:
        result = {"ok": False, "error": "pki engine error: %s" % e}
    print(json.dumps(result))


if __name__ == "__main__":
    main()
