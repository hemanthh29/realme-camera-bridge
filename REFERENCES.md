# Sources and references

This page collects the consoles, official documentation, and investigation reports used for this project. Platform behavior and console URLs can change; prefer the current official documentation when implementing or debugging an integration.

## Developer consoles used

| Platform | Console | Used for |
| --- | --- | --- |
| Cloudflare | [Cloudflare Dashboard](https://dash.cloudflare.com/) | Workers & Pages, Worker deployments and logs, API tokens, and KV storage. |
| Google Home | [Google Home Developer Console](https://console.home.google.com/) | Cloud-to-cloud integration configuration and Test Suite. |
| SmartThings | [SmartThings Developer Center](https://console.smartthings.com/) | Schema Cloud Connector and Cloud Connected integration configuration. |
| Tuya | [Tuya IoT Developer Platform](https://platform.tuya.com/) | Project API access, device data, and WebRTC configuration. |
| Samsung | [Samsung Smart TV Developer](https://developer.samsung.com/smarttv/) | Tizen Studio and Samsung TV application debugging documentation. |
| Source control | [Private GitHub repository](https://github.com/hemanthh29/realme-camera-bridge) | Source, documentation, branches, and pull requests. |

## Google Home Cloud-to-cloud

- [Create a Cloud-to-cloud integration](https://developers.home.google.com/cloud-to-cloud/integration/create) — configure an integration and its cloud fulfillment URL.
- [Account linking](https://developers.home.google.com/cloud-to-cloud/primer/account-linking) and [OAuth 2.0 server](https://developers.home.google.com/cloud-to-cloud/project/authorization) — authorization-code flow requirements used by the shared authorization endpoints.
- [CameraStream trait](https://developers.home.google.com/cloud-to-cloud/traits/camerastream) — protocols and response fields for camera streaming.
- [Test a Cloud-to-cloud integration](https://developers.home.google.com/cloud-to-cloud/test) — run and inspect the Google Home Test Suite.
- [Google Home Developer Console overview](https://developers.home.google.com/cloud-to-cloud/release-notes) — current console role and changes.

## SmartThings Cloud Connected / Schema

- [Get started with Cloud Connected devices](https://developer.smartthings.com/docs/devices/cloud-connected/get-started) — overview of Cloud Connected integrations.
- [Create and register a Schema App](https://developer.smartthings.com/docs/devices/cloud-connected/schema-app) — webhook registration and Schema setup.
- [Interaction Types](https://developer.smartthings.com/docs/devices/cloud-connected/interaction-types) — request and response formats, including callback access.
- [WebRTC capability reference](https://developer.smartthings.com/docs/devices/capabilities/capabilities-reference) — `webrtc` attributes and commands such as `turnInfo`, `requestTurnInfo`, `sdpOffer`, and `clientIce`.
- [Cloud Connected device handler types](https://developer.smartthings.com/docs/devices/cloud-connected/device-handler-types) — supported SmartThings camera handler types.
- [Query and list device status](https://developer.smartthings.com/docs/service-integrations/query-and-list-devices) — SmartThings device capability status API.

## Cloudflare Workers

- [Workers documentation](https://developers.cloudflare.com/workers/) — Worker runtime and deployment platform.
- [Workers KV namespaces](https://developers.cloudflare.com/kv/concepts/kv-namespaces/) — namespace creation and bindings.
- [Create an API token](https://developers.cloudflare.com/fundamentals/api/get-started/create-token/) — scoped Cloudflare API tokens.
- [Real-time Worker logs](https://developers.cloudflare.com/workers/observability/logs/real-time-logs/) — dashboard logs and `wrangler tail`.
- [Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/) — CLI reference.

## Tuya camera signaling

- [Tuya WebRTC](https://developer.tuya.com/en/docs/iot/webrtc?id=Kacsd4x2hl0se) — device configuration and MQTT signaling flow used by the current SmartThings implementation.
- [Tuya RTSP allocation](https://developer.tuya.com/en/docs/iot/rtsp?id=Kacsdjcqllyql) — consulted during the earlier RTSP approach; the current SmartThings path uses WebRTC instead.

## Samsung TV and network diagnostics

- [Samsung TV Device setup](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/tv-device.html) — connect a TV to Tizen Studio for app development.
- [Samsung Web Inspector](https://developer.samsung.com/smarttv/develop/getting-started/using-sdk/web-inspector.html) — documented Web Inspector workflow for apps launched in debug mode.
- [Samsung application testing FAQ](https://developer.samsung.com/smarttv/develop/faq/application-testing.html) — includes limits on `sdb` system log retrieval.
- [Wireshark FAQ](https://www.wireshark.org/faq.html) — packet visibility on switched networks.

## Community reports relevant to the unresolved TV issue

- [Tizen 6.5 monitor viewer does not request TURN info](https://community.smartthings.com/t/tizen-6-5-monitor-camera-viewer-never-calls-webrtc-requestturninfo-turnsource-camera/311919) — a user report involving a different Samsung monitor and Aqara camera. It is a comparison, not an official Samsung diagnosis or a confirmed fix for this bridge.
- [Aqara G350 Matter camera streaming report](https://community.smartthings.com/t/matter-camera-ui-looks-very-basic-in-smartthings-app-generated-presentation-instead-of-matter-camera/308853?page=2) — community report of a camera-side WebRTC answer problem fixed by camera firmware; different device and issue.

The investigation and current limits are summarized in [ARCHITECTURE.md](ARCHITECTURE.md#known-issue-smartthings-tv-video-buffers). Community reports are not treated as platform specifications or proof of this project's root cause.
