# Realme Camera Bridge

This Cloudflare Worker connects Tuya-backed Realme cameras to Google Home and SmartThings. It asks Tuya for a short-lived stream URL when a platform requests live video; it does not keep a camera session running on a home computer.

## Endpoints

- `GET /health` returns a minimal availability response.
- `/oauth/authorize` and `/oauth/token` provide account linking for Google Home and SmartThings.
- `POST /fulfillment` handles Google Home camera discovery and HLS stream requests.
- `POST /smartthings` handles SmartThings Schema discovery, refresh, and RTSP stream commands.

## Runtime secrets

Configure these values in the Site's runtime environment:

- `TUYA_ACCESS_ID`, `TUYA_ACCESS_SECRET`, `CAMERAS_JSON`
- `OAUTH_CLIENT_ID`, `OAUTH_CLIENT_SECRET`, `OAUTH_SIGNING_SECRET`
- `GOOGLE_HOME_PAIRING_PIN`, `GOOGLE_HOME_ACCOUNT_ID`
- `SMARTTHINGS_CLIENT_ID`, `SMARTTHINGS_CLIENT_SECRET`
- Optional: `SMARTTHINGS_PAIRING_PIN` to use a different pairing code for SmartThings.

The SmartThings authorization server must allow the regional callbacks documented by SmartThings: US, EU, and APAC. Its Schema webhook URL is this Site's `/smartthings` endpoint. Google Home's fulfillment URL is this Site's `/fulfillment` endpoint.

## Known limitation

Tuya reports whether motion detection is enabled, but the status API queried here does not report a reliable current motion event. The SmartThings camera profile includes a motion capability, so the bridge does not invent active/inactive motion state.

Both Google Home and SmartThings must be able to reach the webhook and OAuth URLs from their cloud services. An owner-only Site prevents those callbacks. Making the endpoint public exposes the service URL and pairing form to the internet; stream allocation still requires platform OAuth credentials and a signed account token.

## Build and package

The deterministic build copies `worker/index.js` and the hosting manifest into `dist/`:

```sh
bash scripts/build.sh
node scripts/validate-artifact.mjs
```

Edit `worker/index.js`, not the generated file under `dist/`.
