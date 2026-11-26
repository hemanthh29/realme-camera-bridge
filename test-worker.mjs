import assert from "node:assert/strict";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import worker from "./worker/index.js";

const root = new URL("../../../", import.meta.url);
const [credentials, cameras, oauth, smartthingsOauth] = await Promise.all([
  readFile(new URL("../../tuya-credentials", import.meta.url), "utf8"),
  readFile(new URL("../../camera-config.json", import.meta.url), "utf8"),
  readFile(new URL("../../oauth-config.json", import.meta.url), "utf8"),
  readFile(`${homedir()}/.config/realme-camera-bridge/smartthings-oauth.json`, "utf8"),
]);
const [client, tuyaSecret] = credentials.trim().split("\n");
const config = {
  ...JSON.parse(oauth),
  ...JSON.parse(smartthingsOauth),
  SMARTTHINGS_PAIRING_PIN: "st-test-pin",
  TUYA_ACCESS_ID: client,
  TUYA_ACCESS_SECRET: tuyaSecret,
  CAMERAS_JSON: cameras,
};
const redirectUri = "https://oauth-redirect.googleusercontent.com/r/test-project";
let requestedTuyaEndpoints = [];
let allocatedStreamTypes = [];

globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  requestedTuyaEndpoints.push(url.pathname);
  assert.equal(url.origin, "https://openapi.tuyain.com");
  if (url.pathname === "/v1.0/token") {
    return Response.json({ success: true, result: { access_token: "mock-tuya-token" } });
  }
  if (url.pathname.startsWith("/v1.0/iot-03/devices/")) {
    return Response.json({ success: true, result: { online: true } });
  }
  assert.match(url.pathname, /\/stream\/actions\/allocate$/);
  const streamType = JSON.parse(options.body).type;
  allocatedStreamTypes.push(streamType);
  if (streamType === "rtsp") {
    return Response.json({ success: true, result: {
      url: "rtsps://user:password@video.example:443/live?signInfo=mock",
    } });
  }
  assert.equal(streamType, "hls");
  return Response.json({ success: true, result: {
    url: "https://video.example/stream.m3u8?signInfo=mock",
  } });
};

const start = new URL("https://bridge.example/oauth/authorize");
start.search = new URLSearchParams({
  client_id: config.OAUTH_CLIENT_ID,
  redirect_uri: redirectUri,
  response_type: "code",
  state: "google-home-state",
});
const login = await worker.fetch(new Request(start), config);
assert.equal(login.status, 200);
assert.match(await login.text(), /Pairing code/);

const form = new URLSearchParams({
  client_id: config.OAUTH_CLIENT_ID,
  redirect_uri: redirectUri,
  response_type: "code",
  state: "google-home-state",
  pin: config.GOOGLE_HOME_PAIRING_PIN,
});
const authorized = await worker.fetch(new Request("https://bridge.example/oauth/authorize", {
  method: "POST",
  body: form,
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
}), config);
assert.equal(authorized.status, 302);
const callback = new URL(authorized.headers.get("Location"));
assert.equal(callback.origin + callback.pathname, redirectUri);
assert.equal(callback.searchParams.get("state"), "google-home-state");

const basic = btoa(config.OAUTH_CLIENT_ID + ":" + config.OAUTH_CLIENT_SECRET);
const tokenForm = new URLSearchParams({
  grant_type: "authorization_code",
  code: callback.searchParams.get("code"),
  redirect_uri: redirectUri,
});
const tokenResponse = await worker.fetch(new Request("https://bridge.example/oauth/token", {
  method: "POST",
  body: tokenForm,
  headers: {
    "Content-Type": "application/x-www-form-urlencoded",
    Authorization: "Basic " + basic,
  },
}), config);
assert.equal(tokenResponse.status, 200);
const token = await tokenResponse.json();

const googleRefreshForm = new URLSearchParams({
  client_id: config.OAUTH_CLIENT_ID,
  client_secret: config.OAUTH_CLIENT_SECRET,
  grant_type: "refresh_token",
  refresh_token: token.refresh_token,
});
const googleRefreshResponse = await worker.fetch(new Request("https://bridge.example/oauth/token", {
  method: "POST",
  body: googleRefreshForm,
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
}), config);
assert.equal(googleRefreshResponse.status, 200);

const sync = await worker.fetch(new Request("https://bridge.example/fulfillment", {
  method: "POST",
  body: JSON.stringify({
    requestId: "sync",
    inputs: [{ intent: "action.devices.SYNC", payload: {} }],
  }),
  headers: { Authorization: "Bearer " + token.access_token },
}), config);
assert.equal(sync.status, 200);
const devices = (await sync.json()).payload.devices;
assert.equal(devices.length, Object.keys(JSON.parse(cameras)).length);
assert.equal(devices[0].attributes.cameraStreamSupportedProtocols[0], "hls");

const execute = await worker.fetch(new Request("https://bridge.example/fulfillment", {
  method: "POST",
  body: JSON.stringify({
    requestId: "stream",
    inputs: [{ intent: "action.devices.EXECUTE", payload: { commands: [{
      devices: [{ id: devices[0].id }],
      execution: [{
        command: "action.devices.commands.GetCameraStream",
        params: { StreamToChromecast: false, SupportedStreamProtocols: ["hls"] },
      }],
    }] } }],
  }),
  headers: { Authorization: "Bearer " + token.access_token },
}), config);
const result = (await execute.json()).payload.commands[0];
assert.equal(result.status, "SUCCESS");
assert.equal(result.states.cameraStreamProtocol, "hls");
assert.equal(new URL(result.states.cameraStreamAccessUrl).protocol, "https:");

const smartthingsRedirect = "https://c2c-us.smartthings.com/oauth/callback";
const smartthingsStart = new URL("https://bridge.example/oauth/authorize");
smartthingsStart.search = new URLSearchParams({
  client_id: config.SMARTTHINGS_CLIENT_ID,
  redirect_uri: smartthingsRedirect,
  response_type: "code",
  scope: "r:devices:*",
  state: "smartthings-state",
});
const smartthingsLogin = await worker.fetch(new Request(smartthingsStart), config);
assert.equal(smartthingsLogin.status, 200);
assert.match(await smartthingsLogin.text(), /SmartThings is requesting access/);

const smartthingsForm = new URLSearchParams({
  client_id: config.SMARTTHINGS_CLIENT_ID,
  redirect_uri: smartthingsRedirect,
  response_type: "code",
  scope: "r:devices:*",
  state: "smartthings-state",
  pin: config.SMARTTHINGS_PAIRING_PIN,
});
const smartthingsAuthorized = await worker.fetch(new Request("https://bridge.example/oauth/authorize", {
  method: "POST",
  body: smartthingsForm,
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
}), config);
assert.equal(smartthingsAuthorized.status, 302);
const smartthingsCallback = new URL(smartthingsAuthorized.headers.get("Location"));
assert.equal(smartthingsCallback.origin + smartthingsCallback.pathname, smartthingsRedirect);
assert.equal(smartthingsCallback.searchParams.get("state"), "smartthings-state");

const smartthingsTokenForm = new URLSearchParams({
  client_id: config.SMARTTHINGS_CLIENT_ID,
  client_secret: config.SMARTTHINGS_CLIENT_SECRET,
  grant_type: "authorization_code",
  code: smartthingsCallback.searchParams.get("code"),
  redirect_uri: smartthingsRedirect,
});
const smartthingsTokenResponse = await worker.fetch(new Request("https://bridge.example/oauth/token", {
  method: "POST",
  body: smartthingsTokenForm,
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
}), config);
assert.equal(smartthingsTokenResponse.status, 200);
let smartthingsToken = await smartthingsTokenResponse.json();

const smartthingsRefreshForm = new URLSearchParams({
  client_id: config.SMARTTHINGS_CLIENT_ID,
  client_secret: config.SMARTTHINGS_CLIENT_SECRET,
  grant_type: "refresh_token",
  refresh_token: smartthingsToken.refresh_token,
});
const smartthingsRefreshResponse = await worker.fetch(new Request("https://bridge.example/oauth/token", {
  method: "POST",
  body: smartthingsRefreshForm,
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
}), config);
assert.equal(smartthingsRefreshResponse.status, 200);
smartthingsToken = await smartthingsRefreshResponse.json();

const smartthingsRequest = (interactionType, details = {}) => new Request("https://bridge.example/smartthings", {
  method: "POST",
  body: JSON.stringify({
    headers: { schema: "st-schema", version: "1.0", interactionType, requestId: `test-${interactionType}` },
    authentication: { tokenType: "Bearer", token: smartthingsToken.access_token },
    ...details,
  }),
});
const discovery = await worker.fetch(smartthingsRequest("discoveryRequest"), config);
assert.equal(discovery.status, 200);
const smartthingsDevices = await discovery.json();
assert.equal(smartthingsDevices.headers.interactionType, "discoveryResponse");
assert.equal(smartthingsDevices.devices.length, devices.length);
assert.equal(smartthingsDevices.devices[0].deviceHandlerType, "c2c-camera-rtsp-3");

const refresh = await worker.fetch(smartthingsRequest("stateRefreshRequest", {
  devices: [{ externalDeviceId: smartthingsDevices.devices[0].externalDeviceId }],
}), config);
assert.equal(refresh.status, 200);
const refreshBody = await refresh.json();
assert.equal(refreshBody.headers.interactionType, "stateRefreshResponse");
assert.equal(refreshBody.deviceState[0].states[0].value, "online");

const command = await worker.fetch(smartthingsRequest("commandRequest", {
  devices: [{
    externalDeviceId: smartthingsDevices.devices[0].externalDeviceId,
    commands: [{ component: "main", capability: "st.videoStream", command: "startStream", arguments: [] }],
  }],
}), config);
assert.equal(command.status, 200);
const commandBody = await command.json();
assert.equal(commandBody.headers.interactionType, "commandResponse");
const smartthingsStream = commandBody.deviceState[0].states[0].value.InHomeURL;
assert.equal(new URL(smartthingsStream).protocol, "rtsps:");
assert.equal(allocatedStreamTypes.includes("rtsp"), true);
assert.equal(allocatedStreamTypes.includes("hls"), true);
assert.ok(requestedTuyaEndpoints.length >= 6);

const rejected = await worker.fetch(new Request("https://bridge.example/fulfillment", {
  method: "POST",
  body: "{}",
}), config);
assert.equal(rejected.status, 401);
console.log("Google HLS and SmartThings RTSP OAuth, discovery, state refresh, and stream commands passed.");
