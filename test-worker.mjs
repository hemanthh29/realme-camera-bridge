import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import worker from "./worker/index.js";

const root = new URL("../../../", import.meta.url);
const [credentials, cameras, oauth] = await Promise.all([
  readFile(new URL("../../tuya-credentials", import.meta.url), "utf8"),
  readFile(new URL("../../camera-config.json", import.meta.url), "utf8"),
  readFile(new URL("../../oauth-config.json", import.meta.url), "utf8"),
]);
const [client, tuyaSecret] = credentials.trim().split("\n");
const config = {
  ...JSON.parse(oauth),
  TUYA_ACCESS_ID: client,
  TUYA_ACCESS_SECRET: tuyaSecret,
  CAMERAS_JSON: cameras,
};
const redirectUri = "https://oauth-redirect.googleusercontent.com/r/test-project";
let requestedTuyaEndpoints = [];

globalThis.fetch = async (input, options) => {
  const url = new URL(input);
  requestedTuyaEndpoints.push(url.pathname);
  assert.equal(url.origin, "https://openapi.tuyain.com");
  if (url.pathname === "/v1.0/token") {
    return Response.json({ success: true, result: { access_token: "mock-tuya-token" } });
  }
  assert.match(url.pathname, /\/stream\/actions\/allocate$/);
  assert.equal(JSON.parse(options.body).type, "hls");
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
assert.equal(requestedTuyaEndpoints.length, 2);

const rejected = await worker.fetch(new Request("https://bridge.example/fulfillment", {
  method: "POST",
  body: "{}",
}), config);
assert.equal(rejected.status, 401);
console.log("OAuth pairing, camera sync, signed HLS allocation, and authorization checks passed.");
