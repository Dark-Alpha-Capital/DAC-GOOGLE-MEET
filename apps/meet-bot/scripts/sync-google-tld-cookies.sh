#!/usr/bin/env bash
# Google login from India often sets SID on .google.co.in only.
# Meet/myaccount use .google.com — CF containers won't send .co.in cookies there.
# Clone decryptable auth cookies onto .google.com (same values, re-keyed host hash).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PROFILE="${1:-${ROOT}/chrome-user-data}"
COOKIES="${PROFILE}/Default/Cookies"
if [[ ! -f "${COOKIES}" ]]; then
  COOKIES="${PROFILE}/Default/Network/Cookies"
fi
if [[ ! -f "${COOKIES}" ]]; then
  echo "ERROR: no Cookies DB under ${PROFILE}"
  exit 1
fi

python3 - "${COOKIES}" <<'PY'
import binascii, hashlib, sqlite3, subprocess, sys
from pathlib import Path

path = Path(sys.argv[1])
NAMES = {
    "SID", "SSID", "HSID", "APISID", "SAPISID",
    "__Secure-1PSID", "__Secure-3PSID",
    "__Secure-1PSIDTS", "__Secure-3PSIDTS",
}

def kek() -> bytes:
    return hashlib.pbkdf2_hmac("sha1", b"peanuts", b"saltysalt", 1, dklen=16)

def unpad(b: bytes) -> bytes:
    pad = b[-1]
    return b[:-pad] if 1 <= pad <= 16 else b

def pkcs7(b: bytes, block: int = 16) -> bytes:
    pad = block - (len(b) % block)
    return b + bytes([pad]) * pad

def aes_crypt(data: bytes, encrypt: bool) -> bytes:
    open("/tmp/chrome_crypt.bin", "wb").write(data if encrypt else data)
    if encrypt:
        open("/tmp/chrome_crypt.bin", "wb").write(pkcs7(data))
    args = [
        "openssl", "enc", "-aes-128-cbc",
        "-e" if encrypt else "-d", "-nopad",
        "-K", binascii.hexlify(kek()).decode(),
        "-iv", binascii.hexlify(b" " * 16).decode(),
        "-in", "/tmp/chrome_crypt.bin",
    ]
    return subprocess.run(args, capture_output=True, check=True).stdout

def decrypt_cookie(enc: bytes, host: str) -> bytes:
    assert enc[:3] == b"v10"
    plain = unpad(aes_crypt(enc[3:], encrypt=False))
    h = hashlib.sha256(host.encode()).digest()
    return plain[32:] if plain.startswith(h) else plain

def encrypt_cookie(value: bytes, host: str) -> bytes:
    h = hashlib.sha256(host.encode()).digest()
    return b"v10" + aes_crypt(h + value, encrypt=True)

conn = sqlite3.connect(str(path))
conn.row_factory = sqlite3.Row
cols = [r[1] for r in conn.execute("PRAGMA table_info(cookies)")]
src = conn.execute(
    f"SELECT * FROM cookies WHERE host_key = '.google.co.in' AND name IN ({','.join('?' * len(NAMES))})",
    tuple(NAMES),
).fetchall()
existing = {
    (r["name"], r["host_key"])
    for r in conn.execute(
        "SELECT name, host_key FROM cookies WHERE host_key IN ('.google.com', '.google.co.in')"
    )
}
cloned = 0
for row in src:
    if (row["name"], ".google.com") in existing:
        continue
    try:
        value = decrypt_cookie(row["encrypted_value"], ".google.co.in")
    except Exception as e:
        print(f"skip {row['name']}: {e}")
        continue
    data = {c: row[c] for c in cols}
    data["host_key"] = ".google.com"
    data["encrypted_value"] = encrypt_cookie(value, ".google.com")
    data["value"] = ""
    conn.execute(
        f"INSERT INTO cookies ({','.join(cols)}) VALUES ({','.join('?' for _ in cols)})",
        [data[c] for c in cols],
    )
    cloned += 1
    print(f"cloned {row['name']} → .google.com")
conn.commit()
sid_com = conn.execute(
    "SELECT COUNT(*) FROM cookies WHERE host_key = '.google.com' AND name = 'SID'"
).fetchone()[0]
conn.close()
if sid_com < 1:
    print("ERROR: still no SID on .google.com — sign in via https://www.google.com/ncr then myaccount.google.com")
    sys.exit(1)
print(f"OK: SID on .google.com present (cloned {cloned} this run)")
PY
