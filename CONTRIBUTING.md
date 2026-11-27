# Contributing

Thanks for helping with the Realme Camera Bridge. The main unresolved task is SmartThings live video on the Samsung BU8000 TV. Read the [current issue and evidence](ARCHITECTURE.md#known-issue-smartthings-tv-video-buffers) before changing the WebRTC path.

## Project map

| Path | Purpose |
| --- | --- |
| `worker/index.js` | Cloudflare Worker source for Google Home and SmartThings. |
| `wrangler.jsonc` | Worker metadata, rate limiting, and the callback-token KV binding. |
| `scripts/build.sh` | Copies source and hosting metadata into generated `dist/`. |
| `scripts/validate-artifact.mjs` | Checks that the generated module parses and its hosting manifest is valid JSON. |
| `scripts/setup-smartthings-callback-kv.py` | Creates/configures the private SmartThings callback-token KV namespace for an account. |
| `scripts/deploy-cloudflare.py` | Uploads the Worker and private runtime bindings to Cloudflare. |
| `ARCHITECTURE.md` | Runtime flow, platform behavior, and current known issue. |
| `test-worker.mjs` | Legacy RTSP-era test harness; it does not validate the current SmartThings WebRTC implementation. |
| `REFERENCES.md` | Platform consoles, official documentation, and related community reports. |

Edit `worker/index.js`, not generated files in `dist/`.

## Local development

The current source has no npm dependencies. From the repository root, build and validate the static artifact with:

```sh
npm run build
npm run validate
```

These commands do **not** contact Google, SmartThings, Tuya, Cloudflare, or a TV. The validation checks packaging and module syntax only; it is not an end-to-end stream test.

`test-worker.mjs` still expects the old SmartThings RTSP handler and reads private local credentials. Do not treat it as a test of the current WebRTC behavior. Migrating it to mock the current SmartThings WebRTC and Tuya MQTT flow is a useful first code contribution; do not put real credentials into test fixtures.

Yes: contributors should make commits on a separate feature branch, not directly on `main`. Push that branch and open a pull request targeting `main`; the maintainer reviews and merges it. This repo is private, so contributors need access to the repository. The workflow below documents the convention; GitHub branch protection is a separate repository setting.

Start from an up-to-date `main`, create a branch, edit the source or docs, run the safe checks, then push the branch and open a pull request:

```sh
git switch main
git pull --ff-only
git switch -c fix/short-description
# make the change
git diff --check
npm run build
npm run validate
git status --short
git add README.md  # replace with the reviewed file paths you changed
git diff --cached
git commit -m "Describe the change"
git push -u origin fix/short-description
```

Open a pull request from `fix/short-description` to `main`. Review the diff before committing. Do not include `dist/`, local credentials, or generated Python cache files.

## Private configuration and deployment

Most contributors only need the local build commands above. Deploying requires the Cloudflare API token and private runtime configuration listed below. Never commit or paste credentials into pull requests, logs, issue comments, or chat.

The deploy helper reads these private files:

| File | Contents |
| --- | --- |
| `$REALME_CAMERA_WORKDIR/oauth-config.json` | Google OAuth client values, signing secret, pairing PIN, and account ID. |
| `$REALME_CAMERA_WORKDIR/camera-config.json` | Camera labels and Tuya device identifiers; optional Tuya account UID. |
| `$REALME_CAMERA_WORKDIR/tuya-credentials` | Tuya access ID on line 1 and secret on line 2. |
| `~/.config/realme-camera-bridge/smartthings-oauth.json` | SmartThings Schema OAuth client ID and secret. |
| `~/.config/realme-camera-bridge/smartthings-callback-oauth.json` | SmartThings callback OAuth client ID and secret. |
| `~/.config/realme-camera-bridge/cloudflare-overrides.json` | Optional pairing-code overrides; use `{}` when none are configured. |
| `~/.config/realme-camera-bridge/cloudflare-access.json` | Cloudflare account ID and deploy API token. |

The default work directory is the adjacent `work/` directory for this checkout layout. Set `REALME_CAMERA_WORKDIR` to the directory containing the three workspace files when using another layout. Set each private file to mode `600`.

To provision callback-token storage for a separate Cloudflare account, `scripts/setup-smartthings-callback-kv.py` also reads `~/.config/realme-camera-bridge/cloudflare-kv-access.json` (`account_id` and `api_token`). Use an account-scoped token with the needed Workers KV permissions. The script updates `wrangler.jsonc`; review the namespace ID before deploying. Do not point a personal fork at the production account or namespace.

To configure callback storage and deploy the Worker:

```sh
python3 scripts/setup-smartthings-callback-kv.py
python3 scripts/deploy-cloudflare.py
```

The deploy helper reads the source from this checkout and checks `/health`. A GitHub push does not deploy the Worker. Before deploying, confirm the Cloudflare credentials target the intended account and Worker; deployment updates the live service.

## Investigating the TV buffering issue

The Worker can report what it sent to SmartThings and Tuya. It cannot report whether the built-in TV viewer accepted the SDP, completed ICE/DTLS, received media, or rendered frames. A successful HTTP response or state callback is not proof of playback. The root cause remains unknown.

Samsung's documented Web Inspector flow launches an app in debug mode from Tizen Studio, and Samsung's TV testing FAQ says `sdb` system-log retrieval is unsupported. Do not assume either tool can attach to the preinstalled SmartThings viewer or expose its private WebRTC state. See Samsung's [Web Inspector guide](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/web-inspector.html) and [application testing FAQ](https://developer.samsung.com/smarttv/develop/faq/application-testing.html).

For one controlled TV attempt:

1. Record the TV model, Tizen/firmware version, connection type (Ethernet or Wi-Fi), and which router/access point it uses. Record the camera label, not its real device ID.
2. Note the local time and timezone. From the repo directory, start `npx wrangler tail realme-camera-bridge` (or use the Worker's live logs in the Cloudflare dashboard). This requires access to the correct Cloudflare account. Then open the camera on the TV once and let it buffer for about 30 seconds. Avoid repeated taps that can trigger pairing/rate limits. See [Cloudflare real-time logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/).
3. Save the correlated `smartthings_sdp_probe` events for that attempt. Useful event names include `turn_info_primed`, `offer_received`, `turn_info_callback_result`, `answer_received`, `candidates_embedded_for_tizen`, `client_ice_received`, `client_ice_exchange_completed`, `turn_info_requested`, and `smartthings_response`.
4. If possible, capture the TV's UDP traffic at the router/AP or a mirrored switch port. A laptop merely connected to the same switched network normally cannot see the TV's unicast traffic. Alternatively, traffic can be captured if the laptop is deliberately placed in the TV's network path. Do not use ARP spoofing for this investigation.
5. Compare the packet times and destinations with the Worker events. No observed TURN traffic suggests the TV may not be using the relay path; traffic without successful replies suggests a connectivity problem; successful ICE-related traffic still does not prove that video decoded. Report the actual observation without presenting it as a root cause.

Example capture filter, to run **on the router or another capture point that sees the TV's traffic** (replace the example IP):

```sh
sudo tcpdump -ni any 'host 192.0.2.10'
```

If the capture laptop is not the router, mirrored port, or traffic gateway, this command will generally capture only traffic visible to that laptop. See the [Wireshark FAQ on capturing switched traffic](https://www.wireshark.org/faq.html).

The Worker log summaries intentionally omit raw SDP, candidate IPs, and TURN usernames/passwords. Keep it that way. Do not upload raw packet captures or full SmartThings callback payloads; they can contain network identifiers or short-lived credentials. Share only the relevant sanitized event lines and a summary of packet direction, protocol, and whether replies were seen.

## Reporting an issue

Include:

- TV model, Tizen version, and firmware version.
- Camera model/label and whether its stream works in SmartThings mobile at the same time.
- TV and camera network paths (wired/Wi-Fi, router/access point, extender, band if known).
- Timestamp and timezone for one TV attempt.
- Relevant sanitized Worker event lines and any `deviceError` value.
- Whether router-side capture showed UDP/TURN traffic and whether replies arrived.
- Any code/config changes made immediately before the behavior changed.

Do not include OAuth/PAT/API tokens, pairing codes, camera serials or cloud IDs, TURN credentials, MQTT topics, full SDP, or raw packet captures. Redact public IPs unless they are essential to a private, access-controlled investigation.

## Change guidelines

- Keep changes focused and explain the evidence they address.
- Preserve the working Google Home HLS path unless a change is specifically needed there and tested independently.
- For SmartThings changes, compare a TV attempt with a working phone attempt when possible.
- State what was verified, what was not verified, and whether the change was only built, deployed, or observed playing on the TV.
- Never describe the Tizen hypothesis as confirmed until client-side or network evidence supports it.

For the platform consoles and documentation used to implement and investigate this project, see [REFERENCES.md](REFERENCES.md).
