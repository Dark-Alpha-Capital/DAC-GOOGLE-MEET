#!/usr/bin/env bash
# Ensure Local State has os_crypt.encrypted_key for Linux Chromium --password-store=basic.
# Without this, Chromium generates a new key on next launch and cannot decrypt existing Cookies
# (looks like "not signed in" even when SID rows exist on disk).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-${ROOT}/chrome-user-data}"
LOCAL_STATE="${PROFILE}/Local State"

if [[ ! -f "${LOCAL_STATE}" ]]; then
  echo "ERROR: missing ${LOCAL_STATE}"
  exit 1
fi

python3 - "${LOCAL_STATE}" <<'PY'
import base64, binascii, hashlib, json, subprocess, sys
from pathlib import Path

path = Path(sys.argv[1])
data = json.loads(path.read_text())
osc = data.setdefault("os_crypt", {})
if osc.get("encrypted_key"):
    print("os_crypt.encrypted_key already present")
    sys.exit(0)

def pkcs7(b: bytes, block: int = 16) -> bytes:
    pad = block - (len(b) % block)
    return b + bytes([pad]) * pad

kek = hashlib.pbkdf2_hmac("sha1", b"peanuts", b"saltysalt", 1, dklen=16)
# Cookies from --password-store=basic without a prior key use kek directly.
cookie_key = kek
open("/tmp/os_crypt_pt.bin", "wb").write(pkcs7(cookie_key))
subprocess.run(
    [
        "openssl", "enc", "-aes-128-cbc", "-e", "-nopad",
        "-K", binascii.hexlify(kek).decode(),
        "-iv", binascii.hexlify(b" " * 16).decode(),
        "-in", "/tmp/os_crypt_pt.bin",
        "-out", "/tmp/os_crypt_ct.bin",
    ],
    check=True,
)
blob = b"v10" + Path("/tmp/os_crypt_ct.bin").read_bytes()
osc["encrypted_key"] = base64.b64encode(blob).decode()
portal = osc.setdefault("portal", {})
portal["prev_init_success"] = True
path.write_text(json.dumps(data, separators=(",", ":")))
print("Wrote os_crypt.encrypted_key (peanuts / password-store=basic)")
PY
