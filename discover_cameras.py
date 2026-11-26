import hashlib, hmac, json, os, secrets, time, urllib.request, urllib.parse
from pathlib import Path
project = Path(__file__).resolve().parent
work = Path(os.environ.get('REALME_CAMERA_WORKDIR', project.parents[1]))
client, secret = (work/'tuya-credentials').read_text().splitlines()
token = ''
api = 'https://openapi.tuyain.com'

def request(method, path, data=None):
    body = json.dumps(data, separators=(',', ':')).encode() if data is not None else b''
    timestamp = str(time.time_ns() // 1_000_000)
    canonical = '\n'.join((method, hashlib.sha256(body).hexdigest(), '', path))
    signature = hmac.new(secret.encode(), (client + token + timestamp + canonical).encode(), 'sha256').hexdigest().upper()
    headers = {'client_id': client, 't': timestamp, 'sign': signature, 'sign_method': 'HMAC-SHA256'}
    if token:
        headers['access_token'] = token
    if data is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(api+path, data=body if data is not None else None, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=12) as response:
        result = json.load(response)
    if not result.get('success'):
        raise RuntimeError('Tuya API rejected device query')
    return result.get('result')

token = request('GET', '/v1.0/token?grant_type=1')['access_token']
data = request('GET', '/v2.0/cloud/thing/device?page_size=20')
if isinstance(data, dict):
    data = next((data[k] for k in ('list', 'devices', 'data') if isinstance(data.get(k), list)), [])
cameras = []
for device in data:
    if device.get('category') != 'sp' and 'realme' not in device.get('product_name', '').lower():
        continue
    device_id = device.get('id') or device.get('device_id')
    uid = device.get('uid')
    if not uid:
        detail = request('GET', '/v1.0/iot-03/devices/' + urllib.parse.quote(device_id, safe=''))
        uid = detail.get('uid')
    cameras.append({'device_id': device_id, 'uid': uid, 'name': f'Realme Camera {len(cameras)+1}'})
if not cameras:
    raise SystemExit('No realme cameras returned')
(work/'camera-config.json').write_text(json.dumps({str(i+1): camera for i, camera in enumerate(cameras)}))
(work/'camera-config.json').chmod(0o600)
oauth = {
    'OAUTH_CLIENT_ID': secrets.token_urlsafe(24),
    'OAUTH_CLIENT_SECRET': secrets.token_urlsafe(36),
    'OAUTH_SIGNING_SECRET': secrets.token_hex(32),
    'GOOGLE_HOME_PAIRING_PIN': ''.join(str(secrets.randbelow(10)) for _ in range(8)),
    'GOOGLE_HOME_ACCOUNT_ID': 'realme-home-' + secrets.token_hex(12),
}
(work/'oauth-config.json').write_text(json.dumps(oauth))
(work/'oauth-config.json').chmod(0o600)
print(f'Prepared {len(cameras)} cameras and OAuth configuration.')
