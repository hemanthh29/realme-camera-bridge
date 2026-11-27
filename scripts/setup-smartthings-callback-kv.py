#!/usr/bin/env python3
"""Create and bind the private KV namespace used for SmartThings callback tokens."""

import json
import re
import stat
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path


PROJECT = Path(__file__).resolve().parents[1]
ACCESS_FILE = Path.home() / ".config" / "realme-camera-bridge" / "cloudflare-kv-access.json"
DEPLOY_ACCESS_FILE = Path.home() / ".config" / "realme-camera-bridge" / "cloudflare-access.json"
CONFIG_FILE = PROJECT / "wrangler.jsonc"
API_ROOT = "https://api.cloudflare.com/client/v4"
NAMESPACE_TITLE = "realme-camera-bridge-smartthings-callbacks"
BINDING_NAME = "SMARTTHINGS_CALLBACKS"


class SetupError(Exception):
    pass


def read_json(path):
    try:
        return json.loads(path.read_text())
    except (OSError, json.JSONDecodeError) as exc:
        raise SetupError(f"Could not read configuration file: {path}") from exc


def require_private(path):
    try:
        mode = stat.S_IMODE(path.stat().st_mode)
    except OSError as exc:
        raise SetupError(f"Could not inspect permissions on: {path}") from exc
    if mode & 0o077:
        raise SetupError(f"Set {path} permissions to 600 before continuing.")


def api_request(method, path, token, body=None):
    headers = {"Authorization": f"Bearer {token}"}
    data = None
    if body is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(body).encode()
    request = urllib.request.Request(API_ROOT + path, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.loads(response.read())
    except urllib.error.HTTPError as exc:
        raise SetupError(f"Cloudflare KV API request failed with HTTP {exc.code}.") from exc
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as exc:
        raise SetupError(f"Cloudflare KV API request failed ({type(exc).__name__}).") from exc
    if result.get("success") is not True:
        raise SetupError("Cloudflare rejected the KV namespace request.")
    return result.get("result")


def main():
    require_private(ACCESS_FILE)
    access = read_json(ACCESS_FILE)
    deploy_access = read_json(DEPLOY_ACCESS_FILE)
    account_id = access.get("account_id", "")
    api_token = access.get("api_token", "")
    if account_id != deploy_access.get("account_id") or not re.fullmatch(r"[a-fA-F0-9]{32}", account_id):
        raise SetupError("The KV token must target the same Cloudflare account as the deployment token.")
    if not isinstance(api_token, str) or len(api_token) < 20:
        raise SetupError("The KV access file needs a valid api_token.")

    config = read_json(CONFIG_FILE)
    namespaces = config.get("kv_namespaces", [])
    existing_binding = next((item for item in namespaces if item.get("binding") == BINDING_NAME), None)
    if existing_binding:
        namespace_id = existing_binding.get("id")
    else:
        account = "/accounts/" + account_id
        query = urllib.parse.urlencode({"per_page": 100})
        found = api_request("GET", account + "/storage/kv/namespaces?" + query, api_token)
        namespace = next((item for item in found if item.get("title") == NAMESPACE_TITLE), None)
        if namespace is None:
            namespace = api_request(
                "POST",
                account + "/storage/kv/namespaces",
                api_token,
                {"title": NAMESPACE_TITLE},
            )
        namespace_id = namespace.get("id")
        if not isinstance(namespace_id, str) or not namespace_id:
            raise SetupError("Cloudflare did not return a KV namespace ID.")
        config["kv_namespaces"] = namespaces + [{"binding": BINDING_NAME, "id": namespace_id}]
        CONFIG_FILE.write_text(json.dumps(config, indent=2) + "\n")

    if not isinstance(namespace_id, str) or not namespace_id:
        raise SetupError("The configured SmartThings KV namespace is invalid.")
    print("SmartThings callback KV namespace is configured for the Worker.")


if __name__ == "__main__":
    try:
        main()
    except SetupError as exc:
        print(str(exc), file=sys.stderr)
        sys.exit(1)
