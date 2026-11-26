#!/usr/bin/env python3
"""Deploy this bridge to Cloudflare Workers using the account API."""

import json
import os
import re
import secrets
import stat
import sys
import urllib.error
import urllib.request
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
WORK = Path(os.environ.get("REALME_CAMERA_WORKDIR", PROJECT.parents[1]))
SECURE_DIR = Path.home() / ".config" / "realme-camera-bridge"
ACCESS_FILE = SECURE_DIR / "cloudflare-access.json"
OVERRIDES_FILE = SECURE_DIR / "cloudflare-overrides.json"
API_ROOT = "https://api.cloudflare.com/client/v4"


class DeployError(Exception):
    pass


def read_json(path):
    try:
        return json.loads(path.read_text())
    except FileNotFoundError as exc:
        raise DeployError(f"Required config file is missing: {path}") from exc
    except (OSError, json.JSONDecodeError) as exc:
        raise DeployError(f"Could not read config file: {path}") from exc


def require_private(path):
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError as exc:
        raise DeployError(f"Could not inspect permissions on: {path}") from exc
    if mode & 0o077:
        raise DeployError(f"Set {path} permissions to 600 before deploying.")


def runtime_secrets():
    oauth = read_json(WORK / "oauth-config.json")
    cameras = read_json(WORK / "camera-config.json")
    overrides = read_json(OVERRIDES_FILE)
    require_private(WORK / "oauth-config.json")
    require_private(WORK / "camera-config.json")
    require_private(WORK / "tuya-credentials")
    require_private(OVERRIDES_FILE)

    tuya_lines = (WORK / "tuya-credentials").read_text().splitlines()
    if len(tuya_lines) != 2 or not all(tuya_lines):
        raise DeployError("Tuya credentials file must contain exactly two non-empty lines.")
    tuya_access_id, tuya_access_secret = tuya_lines

    required_oauth = (
        "OAUTH_CLIENT_ID",
        "OAUTH_CLIENT_SECRET",
        "OAUTH_SIGNING_SECRET",
        "GOOGLE_HOME_PAIRING_PIN",
        "GOOGLE_HOME_ACCOUNT_ID",
    )
    if any(not isinstance(oauth.get(key), str) or not oauth[key] for key in required_oauth):
        raise DeployError("Google OAuth config is incomplete.")
    if not isinstance(cameras, dict) or not cameras:
        raise DeployError("Camera config is empty or invalid.")

    allowed_overrides = {
        key: value for key, value in overrides.items()
        if key == "GOOGLE_HOME_PAIRING_PIN"
    }
    values = {
        **oauth,
        **allowed_overrides,
        "CAMERAS_JSON": json.dumps(cameras, separators=(",", ":")),
        "TUYA_ACCESS_ID": tuya_access_id,
        "TUYA_ACCESS_SECRET": tuya_access_secret,
    }
    return [
        {"type": "secret_text", "name": name, "text": value}
        for name, value in sorted(values.items())
    ]


def cloudflare_request(method, path, token, body=None, content_type="application/json"):
    headers = {"Authorization": f"Bearer {token}"}
    data = body
    if body is not None:
        headers["Content-Type"] = content_type
    request = urllib.request.Request(API_ROOT + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        code = exc.code
        try:
            payload = json.loads(exc.read())
            codes = [str(item.get("code")) for item in payload.get("errors", []) if item.get("code")]
        except Exception:
            codes = []
        suffix = f" (Cloudflare error {', '.join(codes)})" if codes else ""
        raise DeployError(f"Cloudflare API request failed with HTTP {code}{suffix}.") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise DeployError(f"Could not complete Cloudflare API request ({type(exc).__name__}).") from exc
    if result.get("success") is not True:
        codes = [str(item.get("code")) for item in result.get("errors", []) if item.get("code")]
        suffix = f" (Cloudflare error {', '.join(codes)})" if codes else ""
        raise DeployError("Cloudflare API rejected the request" + suffix + ".")
    return result.get("result") or {}


def multipart(metadata, module):
    boundary = "----realme-camera-bridge-" + secrets.token_hex(18)
    chunks = []
    chunks.append(
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="metadata"\r\n'
        "Content-Type: application/json\r\n\r\n"
        + json.dumps(metadata, separators=(",", ":"))
        + "\r\n"
    )
    chunks.append(
        f"--{boundary}\r\n"
        'Content-Disposition: form-data; name="index.js"; filename="index.js"\r\n'
        "Content-Type: application/javascript+module\r\n\r\n"
    )
    data = ("".join(chunks)).encode() + module + f"\r\n--{boundary}--\r\n".encode()
    return data, f"multipart/form-data; boundary={boundary}"


def main():
    if not ACCESS_FILE.exists():
        raise DeployError(
            f"Create {ACCESS_FILE} with account_id and api_token, then set its permissions to 600."
        )
    require_private(ACCESS_FILE)
    access = read_json(ACCESS_FILE)
    account_id = access.get("account_id", "")
    api_token = access.get("api_token", "")
    if (not isinstance(account_id, str) or not re.fullmatch(r"[a-fA-F0-9]{32}", account_id)
            or not isinstance(api_token, str) or len(api_token) < 20):
        raise DeployError("Cloudflare access config needs a valid account_id and API token.")

    runtime = runtime_secrets()
    config = read_json(PROJECT / "wrangler.jsonc")
    worker_name = config.get("name", "")
    compatibility_date = config.get("compatibility_date", "")
    main_path = config.get("main", "")
    if (not isinstance(worker_name, str) or not re.fullmatch(r"[a-zA-Z0-9-]{1,63}", worker_name)
            or config.get("workers_dev") is not True
            or not isinstance(compatibility_date, str)
            or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", compatibility_date)
            or not isinstance(main_path, str)):
        raise DeployError("Cloudflare Worker configuration is incomplete or invalid.")

    account = "/accounts/" + account_id
    subdomain_result = cloudflare_request("GET", account + "/workers/subdomain", api_token)
    subdomain = subdomain_result.get("subdomain")
    if not isinstance(subdomain, str) or not re.fullmatch(r"[a-z0-9-]+", subdomain):
        raise DeployError("Set up the account's workers.dev subdomain in Cloudflare, then run this again.")

    metadata = {
        "main_module": "index.js",
        "compatibility_date": compatibility_date,
        "bindings": runtime + [
            {"type": "ratelimit", **item}
            for item in config.get("ratelimits", [])
        ],
    }
    module_path = PROJECT / main_path.removeprefix("./")
    body, content_type = multipart(metadata, module_path.read_bytes())
    cloudflare_request(
        "PUT",
        account + "/workers/scripts/" + worker_name,
        api_token,
        body,
        content_type,
    )
    cloudflare_request(
        "POST",
        account + "/workers/scripts/" + worker_name + "/subdomain",
        api_token,
        json.dumps({"enabled": True, "previews_enabled": False}).encode(),
    )

    url = f"https://{worker_name}.{subdomain}.workers.dev"
    try:
        health_request = urllib.request.Request(
            url + "/health",
            headers={
                "Accept": "application/json",
                "User-Agent": "realme-camera-bridge-deployer/1.0",
            },
        )
        with urllib.request.urlopen(health_request, timeout=20) as response:
            health = json.loads(response.read())
    except Exception as exc:
        raise DeployError(f"Worker deployed, but its health endpoint did not respond ({type(exc).__name__}).") from exc
    if health.get("status") != "ok":
        raise DeployError("Worker deployed, but its health endpoint returned an unexpected response.")
    print("Cloudflare Worker deployed and health endpoint responded.")
    print("Worker URL:", url)


if __name__ == "__main__":
    try:
        main()
    except DeployError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
