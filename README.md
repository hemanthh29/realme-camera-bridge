# Realme Camera Bridge

This Cloudflare Worker connects Tuya-backed Realme cameras to Google Home and SmartThings. Google Home requests HLS streams; SmartThings uses WebRTC signaling, with media carried over Tuya's peer-to-peer path or TURN relay. It does not keep a camera feed running on a home computer.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the deployed components, OAuth and stream flows, runtime configuration, and current limitations.
See [REFERENCES.md](REFERENCES.md) for the Cloudflare, Google Home, SmartThings, Tuya, Samsung, and network documentation used by the project.

## Current working status

| Platform and screen | Stream path | Status |
| --- | --- | --- |
| Google Home mobile app | Tuya HLS | Working. HLS can have more live delay because the player waits for media segments and buffers ahead. The delay for this camera has not been measured. |
| Google Home on a TV | Tuya HLS | Unknown; not tested. |
| SmartThings mobile app | Tuya WebRTC | Working. The user reported no noticeable ongoing delay in a successful mobile session; latency has not been formally measured. Connection setup and network relays can still delay the first frame. |
| SmartThings on Samsung BU8000 (Tizen 6.5) | Tuya WebRTC | Still buffers when opened. Root cause is unknown. |

See [streaming behavior and future work](ARCHITECTURE.md#streaming-behavior-and-future-work) and the [TV investigation notes](ARCHITECTURE.md#known-issue-smartthings-tv-video-buffers). These results apply to the tested realme 360 camera; compatibility with other models is unverified.

## Tested camera and compatibility

The tested camera is the **realme 360 camera**, a Tuya-backed camera that pairs with the **Smart Life** app. The owner's Smart Life account is linked to a Tuya IoT cloud project so the project can access the account's authorized devices through Tuya APIs. In the Tuya Developer Platform, this is done under the project's **Devices** tab with **Link Tuya App Account**; the account owner scans the QR code in Smart Life and approves the link. The camera is paired to Smart Life first, then made available to the cloud project through that account link. It is not uploaded as source code or created as a product in this repository.

This bridge has been tested with the realme 360 camera only. Other Tuya-backed or Powered by Tuya cameras **may** work if they can be linked to the Smart Life account and their Tuya cloud project exposes the camera status and streaming APIs this bridge needs: HLS allocation for Google Home and WebRTC configuration/signaling for SmartThings. Tuya branding alone does not guarantee compatibility; support for other camera models, app regions, and firmware is unverified. See [Tuya's device-linking guide](https://developer.tuya.com/en/docs/iot/link-devices?id=Ka471nu1sfmkl).

## Repository map

- `worker/index.js` — Cloudflare Worker source; edit this file.
- `wrangler.jsonc` — Worker name, compatibility date, rate limit, and KV binding.
- `scripts/` — build, artifact validation, KV setup, and owner-only deployment helpers.
- `ARCHITECTURE.md` — system design and current TV streaming investigation.
- `CONTRIBUTING.md` — local workflow, safe log collection, and issue report checklist.
- `REFERENCES.md` — consoles, official platform documentation, and related community reports.
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
