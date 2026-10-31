#!/usr/bin/env python3
"""Probe a managed WeChat process for the V2 image AES key.

The probe captures only 16-byte AES candidates and validates them against
already-present V2 .dat files. Keys, paths, and media bytes stay in memory;
the command output contains only status and format information. Optional
callers can receive the verified key over a dedicated file descriptor so it
does not appear in logs or standard output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import threading
import time
from typing import Any

import frida
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes


JS = r"""
const accountDir = __ACCOUNT_DIR__;
const seen = {};
const datSamples = [];

function findExport(name) {
  try {
    if (typeof Module.findExportByName === 'function') {
      return Module.findExportByName(null, name);
    }
  } catch (e) {}
  try {
    if (typeof Module.getGlobalExportByName === 'function') {
      return Module.getGlobalExportByName(name);
    }
  } catch (e) {}
  return null;
}

function readBytes(path, maxBytes) {
  try {
    const file = new File(path, 'rb');
    const bytes = file.readBytes(maxBytes);
    file.close();
    if (bytes === null) return null;
    return { bytes: Array.from(new Uint8Array(bytes)), size: bytes.byteLength };
  } catch (e) {}
  try {
    const data = ObjC.classes.NSData.dataWithContentsOfFile_(path);
    if (!data) return null;
    const size = data.length();
    const bytes = data.bytes().readByteArray(Math.min(size, maxBytes));
    return bytes === null ? null : { bytes: Array.from(new Uint8Array(bytes)), size };
  } catch (e) {}
  return null;
}

function isV2(bytes) {
  return bytes.length >= 15 &&
    bytes[0] === 0x07 && bytes[1] === 0x08 && bytes[2] === 0x56 &&
    bytes[3] === 0x32 && bytes[4] === 0x08 && bytes[5] === 0x07;
}

function collectDatSamples() {
  try {
    const manager = ObjC.classes.NSFileManager.defaultManager();
    const enumerator = manager.enumeratorAtPath_(accountDir);
    let visited = 0;
    while (visited < 4000 && datSamples.length < 8) {
      const item = enumerator.nextObject();
      if (item === null) break;
      const relative = item.toString();
      if (!relative.endsWith('.dat') || !relative.includes('msg/attach/')) continue;
      visited += 1;
      const fullPath = accountDir + '/' + relative;
      const sample = readBytes(fullPath, 96);
      if (!sample || !isV2(sample.bytes)) continue;
      datSamples.push({ path: fullPath, bytes: sample.bytes, size: sample.size });
    }
    send({ type: 'datSamples', samples: datSamples, visited });
  } catch (e) {
    send({ type: 'probeError', error: String(e) });
  }
}

function emitKey(bytes, source) {
  if (!bytes || bytes.length !== 16) return;
  let hex = '';
  for (let i = 0; i < 16; i++) hex += bytes[i].toString(16).padStart(2, '0');
  if (seen[hex]) return;
  seen[hex] = 1;
  send({ type: 'imageKey', key: hex, source });
}

function hookAes(name) {
  const fn = findExport(name);
  if (!fn) return;
  const withMode = name === 'CCCryptorCreateWithMode';
  const keyIdx = withMode ? 5 : 3;
  const lenIdx = withMode ? 6 : 4;
  const algIdx = withMode ? 2 : 1;
  Interceptor.attach(fn, {
    onEnter(args) {
      try {
        if (args[algIdx].toInt32() !== 0 || args[lenIdx].toInt32() !== 16) return;
        emitKey(new Uint8Array(args[keyIdx].readByteArray(16)), name);
      } catch (e) {}
    }
  });
}

function collectImageCodes() {
  const codes = {};
  try {
    const manager = ObjC.classes.NSFileManager.defaultManager();
    const home = manager.homeDirectoryForCurrentUser().path().toString();
    const directories = [
      home + '/Documents/app_data/net/kvcomm',
      home + '/Documents/app_data/ilink/kvcomm',
      home + '/Documents/app_data/roam/ilink/kvcomm',
      home + '/Documents/xwechat/net/kvcomm',
      home + '/Library/Application Support/com.tencent.xinWeChat/xwechat/net/kvcomm',
      home + '/Library/Application Support/com.tencent.xinWeChat/net/kvcomm'
    ];
    for (const directory of directories) {
      let entries = null;
      try { entries = manager.contentsOfDirectoryAtPath_error_(directory, NULL); } catch (e) {}
      if (entries === null) continue;
      for (let index = 0; index < entries.count(); index++) {
        const name = entries.objectAtIndex_(index).toString();
        const match = /^key_(\d+)_/.exec(name);
        if (!match) continue;
        const code = Number(match[1]);
        if (Number.isSafeInteger(code) && code >= 0 && code <= 0xffffffff) codes[String(code)] = 1;
      }
    }
  } catch (e) {}
  return Object.keys(codes).map(Number);
}

['CCCrypt', 'CCCryptorCreate', 'CCCryptorCreateWithMode'].forEach(hookAes);

const md5 = findExport('CC_MD5');
if (md5) {
  Interceptor.attach(md5, {
    onEnter(args) { this.out = args[2]; },
    onLeave() {
      try { emitKey(new Uint8Array(this.out.readByteArray(16)), 'CC_MD5'); }
      catch (e) {}
    }
  });
}

recv(function (message) {
  if (message && message.type === 'readFull' && typeof message.path === 'string') {
    const sample = readBytes(message.path, 4 * 1024 * 1024);
    if (sample) send({ type: 'datFull', path: message.path, bytes: sample.bytes, size: sample.size });
  }
});

collectDatSamples();
send({ type: 'imageCodes', values: collectImageCodes() });
send({ type: 'ready', sampleCount: datSamples.length });
"""


def image_format(data: bytes) -> str | None:
    if data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg"
    if data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png"
    if data.startswith(b"GIF87a") or data.startswith(b"GIF89a"):
        return "image/gif"
    if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
        return "image/webp"
    return None


def decrypt_block(key: bytes, block: bytes) -> bytes | None:
    try:
        decryptor = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
        return decryptor.update(block) + decryptor.finalize()
    except Exception:
        return None


def decrypt_full(key: bytes, data: bytes) -> tuple[str, int, int] | None:
    if len(data) < 31 or data[:6] != b"\x07\x08V2\x08\x07":
        return None
    aes_size = int.from_bytes(data[6:10], "little")
    xor_size = int.from_bytes(data[10:14], "little")
    padded = (aes_size // 16 + 1) * 16
    body = data[15:]
    if padded > len(body) or xor_size > len(body) - padded:
        return None
    aes_data = body[:padded]
    try:
        decryptor = Cipher(algorithms.AES(key), modes.ECB()).decryptor()
        plain = decryptor.update(aes_data) + decryptor.finalize()
    except Exception:
        return None
    if not plain:
        return None
    pad = plain[-1]
    if pad < 1 or pad > 16 or pad > len(plain) or plain[-pad:] != bytes([pad]) * pad:
        return None
    plain = plain[:-pad]
    raw_end = len(body) - xor_size
    raw = body[padded:raw_end]
    tail = body[raw_end:]
    for xor in range(256):
        output = plain + raw + bytes(value ^ xor for value in tail)
        mime = image_format(output)
        if mime:
            return mime, len(output), xor
    return None


def normalize_account_id(account_id: str) -> str:
    raw = account_id.strip()
    if raw.startswith("wxid_"):
        return f"wxid_{raw[5:].split('_', 1)[0]}"
    return raw


def derive_image_keys(codes: list[int], account_id: str) -> list[bytes]:
    keys: list[bytes] = []
    seen: set[bytes] = set()
    for code in codes:
        if not isinstance(code, int) or code < 0 or code > 0xFFFFFFFF:
            continue
        for wxid in {normalize_account_id(account_id), account_id.strip()}:
            if not wxid:
                continue
            key = hashlib.md5(f"{code}{wxid}".encode()).hexdigest()[:16].encode("ascii")
            if key not in seen:
                seen.add(key)
                keys.append(key)
    return keys


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--pid", type=int, required=True)
    parser.add_argument("--account-dir", required=True)
    parser.add_argument("--timeout", type=float, default=180.0)
    parser.add_argument(
        "--key-fd",
        type=int,
        help="Write the verified key only to this caller-owned file descriptor."
    )
    args = parser.parse_args()

    ready = threading.Event()
    finished = threading.Event()
    samples: list[dict[str, Any]] = []
    keys: list[bytes] = []
    image_codes: list[int] = []
    full_samples: dict[str, list[int]] = {}
    error: str | None = None
    result: dict[str, Any] | None = None
    script = None
    session = None

    def on_message(message: dict[str, Any], _data: Any) -> None:
        nonlocal error, result
        if message.get("type") != "send":
            return
        payload = message.get("payload") or {}
        kind = payload.get("type")
        if kind == "datSamples":
            samples.extend(payload.get("samples") or [])
        elif kind == "imageKey":
            try:
                keys.append(bytes.fromhex(payload["key"]))
            except Exception:
                pass
        elif kind == "imageCodes":
            values = payload.get("values")
            if isinstance(values, list):
                image_codes.extend(value for value in values if isinstance(value, int))
        elif kind == "datFull":
            path = payload.get("path")
            values = payload.get("bytes")
            if isinstance(path, str) and isinstance(values, list):
                full_samples[path] = values
        elif kind == "probeError":
            error = str(payload.get("error") or "probe error")
            finished.set()
        elif kind == "ready":
            ready.set()

    try:
        session = frida.get_local_device().attach(args.pid)
        source = JS.replace("__ACCOUNT_DIR__", json.dumps(args.account_dir))
        script = session.create_script(source)
        script.on("message", on_message)
        script.load()
        if not ready.wait(10):
            print(json.dumps({"status": "error", "error": "hook_not_ready"}), flush=True)
            return 2
        print(json.dumps({"status": "ready", "samples": len(samples)}), flush=True)
        keys.extend(derive_image_keys(
            image_codes,
            os.path.basename(os.path.normpath(args.account_dir))
        ))
        deadline = time.monotonic() + max(5.0, args.timeout)
        while time.monotonic() < deadline and not finished.is_set():
            for sample in samples:
                raw = sample.get("bytes") or []
                if len(raw) < 31:
                    continue
                block = bytes(raw[15:31])
                for key in list(keys):
                    plain = decrypt_block(key, block)
                    if not plain or not image_format(plain):
                        continue
                    path = sample.get("path")
                    if isinstance(path, str) and path not in full_samples:
                        script.post({"type": "readFull", "path": path})
                    full = full_samples.get(path or "")
                    if full is not None:
                        decoded = decrypt_full(key, bytes(full))
                        if decoded:
                            if args.key_fd is not None:
                                os.write(
                                    args.key_fd,
                                    json.dumps({
                                        "aesKey": key.decode("ascii"),
                                        "xorKey": decoded[2]
                                    }).encode("utf-8")
                                )
                            result = {
                                "status": "matched",
                                "mimeType": decoded[0],
                                "size": decoded[1],
                            }
                            finished.set()
                            break
                if result:
                    break
            if not result:
                time.sleep(0.1)
        if result:
            print(json.dumps(result), flush=True)
            return 0
        if error:
            print(json.dumps({"status": "error", "error": error}), flush=True)
            return 2
        print(json.dumps({"status": "timeout", "keys": len(keys), "samples": len(samples)}), flush=True)
        return 3
    finally:
        if script is not None:
            try:
                script.unload()
            except Exception:
                pass
        if session is not None:
            try:
                session.detach()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
