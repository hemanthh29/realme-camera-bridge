const TUYA_ORIGIN = "https://openapi.tuyain.com";
const GOOGLE_REDIRECT_HOSTS = new Set([
  "oauth-redirect.googleusercontent.com",
  "oauth-redirect-sandbox.googleusercontent.com",
]);
const SMARTTHINGS_REDIRECT_URIS = new Set([
  "https://c2c-us.smartthings.com/oauth/callback",
  "https://c2c-eu.smartthings.com/oauth/callback",
  "https://c2c-ap.smartthings.com/oauth/callback",
]);
const MAX_REQUEST_BYTES = 64 * 1024;
const AUTH_PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const AUTH_CODE_LIFETIME_SECONDS = 90;
const ACCESS_TOKEN_LIFETIME_SECONDS = 180 * 24 * 60 * 60;
const REFRESH_TOKEN_LIFETIME_SECONDS = 5 * 365 * 24 * 60 * 60;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health" && request.method === "GET") {
      return json({ status: "ok" });
    }
    if (url.pathname === "/oauth/authorize") {
      return authorize(request, url, env);
    }
    if (url.pathname === "/oauth/token" && request.method === "POST") {
      return token(request, env);
    }
    if (url.pathname === "/fulfillment" && request.method === "POST") {
      const identity = await verifyAccessToken(request.headers.get("Authorization") || "", env, env.OAUTH_CLIENT_ID);
      if (!identity) return json({ error: "unauthorized" }, 401);
      try {
        const body = await readJson(request);
        return json(await fulfill(body, env, identity));
      } catch (error) {
        const status = error instanceof RequestSizeError ? 413 : 400;
        return json({ error: status === 413 ? "request_too_large" : "bad_request" }, status);
      }
    }
    if (url.pathname === "/smartthings" && request.method === "POST") {
      try {
        const body = await readJson(request);
        const result = await handleSmartThings(body, env);
        return result instanceof Response ? result : json(result);
      } catch (error) {
        const status = error instanceof RequestSizeError ? 413 : 400;
        return json({ error: status === 413 ? "request_too_large" : "bad_request" }, status);
      }
    }
    return json({ error: "not_found" }, 404);
  },
};

async function authorize(request, url, env) {
  let params;
  try {
    if (request.method === "POST") {
      const formText = await request.text();
      if (formText.length > MAX_REQUEST_BYTES) return new Response("Request too large.", { status: 413 });
      params = new URLSearchParams(formText);
    } else if (request.method === "GET") {
      params = url.searchParams;
    } else {
      return new Response("Method not allowed.", { status: 405 });
    }
  } catch {
    return new Response("Invalid authorization request.", { status: 400 });
  }

  const fields = Object.fromEntries(["client_id", "redirect_uri", "state", "response_type", "scope"]
    .map((key) => [key, params.get(key) || ""]));
  const client = getOAuthClient(env, fields.client_id);
  if (!validOAuthRequest(fields, client)) return new Response("Invalid account-linking request.", { status: 400 });

  if (request.method !== "POST") {
    return new Response(authorizePage(fields), {
      headers: AUTH_PAGE_HEADERS,
    });
  }

  const submittedPin = params.get("pin") || "";
  const pairingPin = client.platform === "smartthings"
    ? (env.SMARTTHINGS_PAIRING_PIN || env.GOOGLE_HOME_PAIRING_PIN)
    : env.GOOGLE_HOME_PAIRING_PIN;
  if (!constantTimeEqual(submittedPin, pairingPin)) {
    return new Response(authorizePage({ ...fields, error: true }), {
      status: 401,
      headers: AUTH_PAGE_HEADERS,
    });
  }

  const code = await signPayload({
    type: "authorization_code",
    sub: env.GOOGLE_HOME_ACCOUNT_ID,
    client_id: client.id,
    redirect_uri: fields.redirect_uri,
    exp: nowSeconds() + AUTH_CODE_LIFETIME_SECONDS,
    nonce: crypto.randomUUID(),
  }, env.OAUTH_SIGNING_SECRET);
  const callback = new URL(fields.redirect_uri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", fields.state);
  return Response.redirect(callback.toString(), 302);
}

function getOAuthClient(env, clientId) {
  if (clientId && clientId === env.OAUTH_CLIENT_ID) {
    return { id: env.OAUTH_CLIENT_ID, secret: env.OAUTH_CLIENT_SECRET, platform: "google" };
  }
  if (clientId && env.SMARTTHINGS_CLIENT_ID && clientId === env.SMARTTHINGS_CLIENT_ID) {
    return { id: env.SMARTTHINGS_CLIENT_ID, secret: env.SMARTTHINGS_CLIENT_SECRET, platform: "smartthings" };
  }
  return null;
}

function validOAuthRequest({ client_id: clientId, redirect_uri: redirectUri, state, response_type: responseType }, client) {
  if (!client || responseType !== "code" || !state || state.length > 1024) return false;
  try {
    const callback = new URL(redirectUri);
    if (callback.protocol !== "https:" || callback.username || callback.password || callback.hash) return false;
    if (client.platform === "google") {
      return GOOGLE_REDIRECT_HOSTS.has(callback.hostname) && callback.pathname.startsWith("/r/");
    }
    return SMARTTHINGS_REDIRECT_URIS.has(callback.toString());
  } catch {
    return false;
  }
}

function authorizePage({ client_id, redirect_uri, state, response_type, scope, error = false }) {
  const fields = { client_id, redirect_uri, state, response_type, ...(scope ? { scope } : {}) };
  const hidden = Object.entries(fields)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`)
    .join("");
  const alert = error ? '<p role="alert">That pairing code did not match. Try again.</p>' : "";
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Link Realme cameras</title>
<style>
body{font:16px system-ui,sans-serif;max-width:28rem;margin:10vh auto;padding:0 1.25rem;color:#17202a}
main{border:1px solid #d6dce2;border-radius:16px;padding:1.5rem}
label,input,button{display:block;width:100%;box-sizing:border-box}
input{margin:.5rem 0 1rem;padding:.8rem;border:1px solid #9aa4ad;border-radius:8px;font:inherit}
button{padding:.8rem;border:0;border-radius:8px;background:#1666d8;color:white;font:inherit;font-weight:600}
p{line-height:1.5}p[role=alert]{color:#a52222}
</style>
<main><h1>Link Realme cameras</h1>
<p>Enter the pairing code provided by your camera owner to link these cameras.</p>
${alert}<form method="post" action="/oauth/authorize">${hidden}
<label for="pin">Pairing code</label><input id="pin" name="pin" type="password" autocomplete="one-time-code" required>
<button type="submit">Link cameras</button></form></main></html>`;
}

async function token(request, env) {
  const client = parseBasicAuthorization(request.headers.get("Authorization"));
  const configuredClient = getOAuthClient(env, client?.id);
  if (!client || !configuredClient || !constantTimeEqual(client.secret, configuredClient.secret)) {
    return json({ error: "invalid_client" }, 401);
  }
  const formText = await request.text();
  if (formText.length > MAX_REQUEST_BYTES) return json({ error: "request_too_large" }, 413);
  const form = new URLSearchParams(formText);
  const grantType = form.get("grant_type");
  const subject = env.GOOGLE_HOME_ACCOUNT_ID;
  let payload;

  if (grantType === "authorization_code") {
    const code = await verifyPayload(form.get("code") || "", env.OAUTH_SIGNING_SECRET);
    if (!code || code.type !== "authorization_code" || code.exp < nowSeconds() ||
        code.sub !== subject || code.client_id !== client.id ||
        code.redirect_uri !== form.get("redirect_uri")) {
      return json({ error: "invalid_grant" }, 400);
    }
  } else if (grantType === "refresh_token") {
    const refresh = await verifyPayload(form.get("refresh_token") || "", env.OAUTH_SIGNING_SECRET);
    if (!refresh || refresh.type !== "refresh_token" || refresh.exp < nowSeconds() ||
        refresh.sub !== subject ||
        (refresh.client_id && refresh.client_id !== client.id) ||
        (!refresh.client_id && configuredClient.platform !== "google")) {
      return json({ error: "invalid_grant" }, 400);
    }
  } else {
    return json({ error: "unsupported_grant_type" }, 400);
  }

  const accessToken = await signPayload({
    type: "access_token",
    sub: subject,
    client_id: client.id,
    exp: nowSeconds() + ACCESS_TOKEN_LIFETIME_SECONDS,
  }, env.OAUTH_SIGNING_SECRET);
  const refreshToken = grantType === "refresh_token"
    ? form.get("refresh_token")
    : await signPayload({
      type: "refresh_token",
      sub: subject,
      client_id: client.id,
      exp: nowSeconds() + REFRESH_TOKEN_LIFETIME_SECONDS,
      nonce: crypto.randomUUID(),
    }, env.OAUTH_SIGNING_SECRET);

  return json({
    token_type: "Bearer",
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: ACCESS_TOKEN_LIFETIME_SECONDS,
  });
}

function parseBasicAuthorization(header) {
  if (!header?.startsWith("Basic ")) return null;
  try {
    const decoded = atob(header.slice(6));
    const separator = decoded.indexOf(":");
    if (separator < 1) return null;
    return { id: decoded.slice(0, separator), secret: decoded.slice(separator + 1) };
  } catch {
    return null;
  }
}

async function verifyAccessToken(value, env, expectedClientId) {
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(value || "");
  if (!match) return null;
  const payload = await verifyPayload(match[1], env.OAUTH_SIGNING_SECRET);
  if (!payload || payload.type !== "access_token" || payload.exp < nowSeconds() ||
      payload.sub !== env.GOOGLE_HOME_ACCOUNT_ID ||
      (payload.client_id !== expectedClientId &&
       !(expectedClientId === env.OAUTH_CLIENT_ID && payload.client_id === undefined))) return null;
  return payload.sub;
}

async function handleSmartThings(body, env) {
  const requestHeaders = body?.headers || {};
  const interaction = requestHeaders.interactionType;
  const requestId = requestHeaders.requestId || "";
  const responseType = {
    discoveryRequest: "discoveryResponse",
    stateRefreshRequest: "stateRefreshResponse",
    commandRequest: "commandResponse",
  }[interaction];
  if (requestHeaders.schema !== "st-schema" || requestHeaders.version !== "1.0" || !responseType) {
    return json({ error: "unsupported_interaction" }, 400);
  }
  const suppliedToken = body?.authentication?.tokenType === "Bearer"
    ? body.authentication.token
    : "";
  const identity = await verifyAccessToken("Bearer " + suppliedToken, env, env.SMARTTHINGS_CLIENT_ID);
  const responseHeaders = { schema: "st-schema", version: "1.0", interactionType: responseType, requestId };
  if (!identity) {
    return {
      headers: responseHeaders,
      globalError: { errorEnum: "INVALID-TOKEN", detail: "The account-link token is invalid or expired." },
    };
  }

  const cameras = JSON.parse(env.CAMERAS_JSON);
  if (interaction === "discoveryRequest") {
    return {
      headers: responseHeaders,
      devices: Object.entries(cameras).map(([id, camera]) => ({
        externalDeviceId: id,
        friendlyName: camera.name,
        manufacturerInfo: { manufacturerName: "realme", modelName: "360 Camera" },
        deviceHandlerType: env.SMARTTHINGS_DEVICE_PROFILE_ID || "c2c-camera-rtsp-3",
      })),
    };
  }

  if (interaction === "stateRefreshRequest") {
    const requested = Array.isArray(body.devices) ? body.devices : [];
    const ids = Object.keys(cameras);
    const tuyaToken = ids.length ? await getTuyaAccessToken(env) : "";
    const deviceState = await Promise.all(requested.map(async ({ externalDeviceId }) => {
      const camera = cameras[externalDeviceId];
      if (!camera) {
        return { externalDeviceId, deviceError: [{ errorEnum: "DEVICE-DELETED", detail: "Camera is not available." }] };
      }
      const states = [];
      try {
        const online = await getTuyaCameraOnline(camera, tuyaToken, env);
        if (env.SMARTTHINGS_DEVICE_PROFILE_ID && typeof online === "boolean") {
          states.push({
            component: "main",
            capability: "st.healthCheck",
            attribute: "healthStatus",
            value: online ? "online" : "offline",
          });
        }
        if (online === false) {
          return { externalDeviceId, states, deviceError: [{ errorEnum: "DEVICE-OFFLINE", detail: "Camera is offline in Tuya." }] };
        }
      } catch {
        if (env.SMARTTHINGS_DEVICE_PROFILE_ID) {
          states.push({
            component: "main",
            capability: "st.healthCheck",
            attribute: "healthStatus",
            value: "offline",
          });
        }
      }
      return { externalDeviceId, states };
    }));
    return { headers: responseHeaders, deviceState };
  }

  const deviceState = [];
  for (const device of Array.isArray(body.devices) ? body.devices : []) {
    const externalDeviceId = device.externalDeviceId;
    const camera = cameras[externalDeviceId];
    const states = [];
    let deviceError;
    if (!camera) {
      deviceError = [{ errorEnum: "DEVICE-DELETED", detail: "Camera is not available." }];
    } else {
      for (const command of device.commands || []) {
        if (command.capability !== "st.videoStream" || command.component !== "main") {
          deviceError = [{ errorEnum: "CAPABILITY-NOT-SUPPORTED", detail: "This camera only supports video streaming." }];
          continue;
        }
        if (command.command === "startStream") {
          try {
            const streamUrl = await allocateTuyaStream(camera, env, "rtsp");
            states.push({
              component: "main",
              capability: "st.videoStream",
              attribute: "stream",
              value: { InHomeURL: streamUrl, OutHomeURL: streamUrl },
            });
          } catch {
            deviceError = [{ errorEnum: "DEVICE-UNAVAILABLE", detail: "Tuya could not allocate a camera stream." }];
          }
        } else if (command.command === "stopStream") {
          states.push({
            component: "main",
            capability: "st.videoStream",
            attribute: "stream",
            value: { InHomeURL: "", OutHomeURL: "" },
          });
        } else {
          deviceError = [{ errorEnum: "CAPABILITY-NOT-SUPPORTED", detail: "Camera command is not supported." }];
        }
      }
    }
    deviceState.push({ externalDeviceId, ...(states.length ? { states } : {}), ...(deviceError ? { deviceError } : {}) });
  }
  return { headers: responseHeaders, deviceState };
}

async function fulfill(body, env, identity) {
  const intent = body?.inputs?.[0]?.intent;
  const payload = body?.inputs?.[0]?.payload || {};
  const cameras = JSON.parse(env.CAMERAS_JSON);
  const devices = Object.entries(cameras);

  if (intent === "action.devices.SYNC") {
    return { requestId: body.requestId, payload: { agentUserId: identity, devices: devices.map(([id, camera]) => ({
      id,
      type: "action.devices.types.CAMERA",
      traits: ["action.devices.traits.CameraStream"],
      name: { name: camera.name },
      willReportState: false,
      attributes: {
        cameraStreamSupportedProtocols: ["hls"],
        cameraStreamNeedAuthToken: false,
      },
    })) } };
  }

  if (intent === "action.devices.QUERY") {
    return { requestId: body.requestId, payload: { devices: Object.fromEntries(
      (payload.devices || []).map(({ id }) => [id, { online: Object.hasOwn(cameras, id) }]),
    ) } };
  }

  if (intent === "action.devices.DISCONNECT") return {};

  if (intent === "action.devices.EXECUTE") {
    const commands = [];
    for (const command of payload.commands || []) {
      for (const { id } of command.devices || []) {
        const response = { ids: [id], status: "ERROR", errorCode: "functionNotSupported" };
        const requestedStream = (command.execution || []).some((execution) =>
          execution.command === "action.devices.commands.GetCameraStream" &&
          execution.params?.SupportedStreamProtocols?.includes("hls"));
        if (!Object.hasOwn(cameras, id)) {
          response.errorCode = "deviceNotFound";
        } else if (requestedStream) {
          try {
            const stream = await allocateTuyaStream(cameras[id], env, "hls");
            response.status = "SUCCESS";
            response.states = {
              online: true,
              cameraStreamProtocol: "hls",
              cameraStreamAccessUrl: stream,
            };
            delete response.errorCode;
          } catch {
            response.errorCode = "resourceUnavailable";
          }
        }
        commands.push(response);
      }
    }
    return { requestId: body.requestId, payload: { commands } };
  }

  return { requestId: body.requestId, payload: { errorCode: "functionNotSupported" } };
}

async function allocateTuyaStream(camera, env, type) {
  const token = await getTuyaAccessToken(env);
  const deviceId = encodeURIComponent(camera.device_id);
  const base = camera.uid
    ? `/v1.0/users/${encodeURIComponent(camera.uid)}/devices/${deviceId}/stream/actions/allocate`
    : `/v1.0/devices/${deviceId}/stream/actions/allocate`;
  const result = await tuyaRequest("POST", base, { type }, token, env);
  const stream = new URL(result.url);
  if ((type === "hls" && (stream.protocol !== "https:" || stream.username || stream.password)) ||
      (type === "rtsp" && stream.protocol !== "rtsp:")) {
    throw new Error("Tuya returned an invalid stream URL");
  }
  return stream.toString();
}

async function getTuyaAccessToken(env) {
  const tokenData = await tuyaRequest("GET", "/v1.0/token?grant_type=1", null, "", env);
  return tokenData.access_token;
}

async function getTuyaCameraOnline(camera, token, env) {
  const deviceId = encodeURIComponent(camera.device_id);
  const detail = await tuyaRequest("GET", `/v1.0/iot-03/devices/${deviceId}`, null, token, env);
  return typeof detail.online === "boolean" ? detail.online : undefined;
}

async function tuyaRequest(method, path, data, accessToken, env) {
  const timestamp = String(Date.now());
  const body = data === null ? "" : JSON.stringify(data);
  const bodyHash = await sha256Hex(body);
  const stringToSign = [method, bodyHash, "", path].join("\n");
  const signInput = env.TUYA_ACCESS_ID + accessToken + timestamp + stringToSign;
  const signature = await hmacHex(env.TUYA_ACCESS_SECRET, signInput);
  const headers = {
    client_id: env.TUYA_ACCESS_ID,
    t: timestamp,
    sign: signature,
    sign_method: "HMAC-SHA256",
  };
  if (accessToken) headers.access_token = accessToken;
  if (data !== null) headers["Content-Type"] = "application/json";

  const response = await fetch(TUYA_ORIGIN + path, {
    method,
    headers,
    body: data === null ? undefined : body,
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error("Tuya API request failed");
  const result = await response.json();
  if (result.success !== true) throw new Error("Tuya API rejected the request");
  return result.result;
}

async function readJson(request) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > MAX_REQUEST_BYTES) throw new RequestSizeError();
  const text = await request.text();
  if (text.length > MAX_REQUEST_BYTES) throw new RequestSizeError();
  return JSON.parse(text);
}

class RequestSizeError extends Error {}

async function signPayload(payload, secret) {
  const encoded = base64url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacBytes(secret, encoded);
  return encoded + "." + base64url(signature);
}

async function verifyPayload(token, secret) {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra !== undefined) return null;
  const expected = base64url(await hmacBytes(secret, encoded));
  if (!constantTimeEqual(signature, expected)) return null;
  try {
    return JSON.parse(new TextDecoder().decode(unbase64url(encoded)));
  } catch {
    return null;
  }
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return hex(new Uint8Array(digest));
}

async function hmacBytes(secret, value) {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

async function hmacHex(secret, value) {
  return hex(await hmacBytes(secret, value));
}

function base64url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function unbase64url(value) {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/") + "=".repeat((4 - value.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function hex(bytes) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").toUpperCase();
}

function constantTimeEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}
