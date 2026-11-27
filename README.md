# Realme Camera Bridge

This Cloudflare Worker connects Tuya-backed Realme cameras to Google Home and SmartThings. Google Home requests HLS streams; SmartThings uses WebRTC signaling, with media carried over Tuya's peer-to-peer path or TURN relay. It does not keep a camera feed running on a home computer.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the deployed components, OAuth and stream flows, runtime configuration, and current limitations.

## Current status

Google Home and SmartThings on mobile are reported working. SmartThings live video on the Samsung BU8000 TV still buffers. Its root cause is **unknown**; successful Worker responses do not prove that the TV completed ICE negotiation or rendered video. See [the investigation notes](ARCHITECTURE.md#known-issue-smartthings-tv-video-buffers) and [CONTRIBUTING.md](CONTRIBUTING.md) for the evidence and next diagnostic steps.

## Repository map

- `worker/index.js` — Cloudflare Worker source; edit this file.
- `wrangler.jsonc` — Worker name, compatibility date, rate limit, and KV binding.
- `scripts/` — build, artifact validation, KV setup, and owner-only deployment helpers.
- `ARCHITECTURE.md` — system design and current TV streaming investigation.
- `CONTRIBUTING.md` — local workflow, safe log collection, and issue report checklist.
- `dist/` — generated build output; do not edit or commit it.

## Endpoints

- `GET /health` returns a minimal availability response.
- `/oauth/authorize` and `/oauth/token` provide Google Home account linking.
- `POST /fulfillment` handles Google Home camera discovery, status queries, and HLS stream requests.
- `POST /smartthings` handles SmartThings Schema discovery, state refresh, and WebRTC signaling commands.

## Deployment

Deployment is for the repo owner or an authorized operator. Follow the private configuration checklist in [CONTRIBUTING.md](CONTRIBUTING.md) before running `python3 scripts/deploy-cloudflare.py`. The script uploads the Worker and its secret bindings, enables its `workers.dev` URL, and checks `/health`.

The script reads Google OAuth settings from `oauth-config.json`, camera data from `camera-config.json`, and Tuya credentials from `tuya-credentials` in the workspace config directory. By default, that is the adjacent `work/` directory in this checkout layout; set `REALME_CAMERA_WORKDIR` to use another location. SmartThings OAuth client credentials and optional per-platform pairing-code overrides are stored in `~/.config/realme-camera-bridge/`. Cloudflare access is stored there as well. Keep these files private and set permissions to `600`.

The Google Home fulfillment URL is the Worker URL plus `/fulfillment`. SmartThings Schema's webhook URL is the Worker URL plus `/smartthings`. Both platforms use `/oauth/authorize` and `/oauth/token`; the authorization redirect URI selects the platform.

## Build

The deterministic build copies `worker/index.js` and the hosting manifest into `dist/`:

```sh
bash scripts/build.sh
node scripts/validate-artifact.mjs
```

Edit `worker/index.js`, not the generated file under `dist/`.

## Contributing

Start with [CONTRIBUTING.md](CONTRIBUTING.md). It explains the safe local checks and what evidence is needed to investigate the unresolved TV issue.
