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
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://oauth-redirect.googleusercontent.com https://oauth-redirect-sandbox.googleusercontent.com https://c2c-us.smartthings.com https://c2c-eu.smartthings.com https://c2c-ap.smartthings.com; base-uri 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
};
const AUTH_CODE_LIFETIME_SECONDS = 90;
const ACCESS_TOKEN_LIFETIME_SECONDS = 180 * 24 * 60 * 60;
const SMARTTHINGS_ACCESS_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
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
    if (url.pathname !== "/fulfillment" || request.method !== "POST") {
      return json({ error: "not_found" }, 404);
    }

    const identity = await verifyAccessToken(request, env);
    if (!identity) return json({ error: "unauthorized" }, 401);

    try {
      const body = await readJson(request);
      const response = await fulfill(body, env, identity);
      return json(response);
    } catch (error) {
      const status = error instanceof RequestSizeError ? 413 : 400;
      return json({ error: status === 413 ? "request_too_large" : "bad_request" }, status);
    }
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
  const fields = {
    client_id: params.get("client_id") || "",
    redirect_uri: params.get("redirect_uri") || "",
    state: params.get("state") || "",
    response_type: params.get("response_type") || "",
  };
  const platform = oauthPlatformForRedirect(fields.redirect_uri);
  const client = getOAuthClient(env, fields.client_id, platform);
  if (!validOAuthRequest(fields, client, platform)) {
    return new Response("Invalid account-linking request.", { status: 400 });
  }
  if (platform === "smartthings" && params.get("scope")) fields.scope = params.get("scope");

  if (request.method !== "POST") {
    return new Response(authorizePage(fields, platform), {
      headers: AUTH_PAGE_HEADERS,
    });
  }

  const submittedPin = params.get("pin") || "";
  const pairingLimiter = env.PAIRING_RATE_LIMITER;
  if (pairingLimiter) {
    const clientAddress = request.headers.get("CF-Connecting-IP") || "unknown";
    try {
      const key = platform === "smartthings" ? `smartthings:${clientAddress}` : clientAddress;
      const decision = await pairingLimiter.limit({ key });
      if (!decision.success) {
        return new Response("Too many pairing attempts. Please wait and try again.", {
          status: 429,
          headers: { "Cache-Control": "no-store", "Retry-After": "60" },
        });
      }
    } catch {
      return new Response("Pairing is temporarily unavailable.", {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      });
    }
  }
  const pairingPin = platform === "smartthings"
    ? (env.SMARTTHINGS_PAIRING_PIN || env.GOOGLE_HOME_PAIRING_PIN)
    : env.GOOGLE_HOME_PAIRING_PIN;
  if (!constantTimeEqual(submittedPin, pairingPin)) {
    return new Response(authorizePage(fields, platform, true), {
      status: 401,
      headers: AUTH_PAGE_HEADERS,
    });
  }

  const codePayload = {
    type: "authorization_code",
    sub: env.GOOGLE_HOME_ACCOUNT_ID,
    client_id: client.id,
    redirect_uri: fields.redirect_uri,
    exp: nowSeconds() + AUTH_CODE_LIFETIME_SECONDS,
    nonce: crypto.randomUUID(),
  };
  if (platform === "smartthings") codePayload.platform = "smartthings";
  const code = await signPayload(codePayload, env.OAUTH_SIGNING_SECRET);
  const callback = new URL(fields.redirect_uri);
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", fields.state);
  return Response.redirect(callback.toString(), 302);
}

function oauthPlatformForRedirect(redirectUri) {
  try {
    const callback = new URL(redirectUri);
    if (SMARTTHINGS_REDIRECT_URIS.has(callback.toString())) return "smartthings";
    if (callback.protocol === "https:" && !callback.username && !callback.password && !callback.hash &&
        GOOGLE_REDIRECT_HOSTS.has(callback.hostname) && callback.pathname.startsWith("/r/")) return "google";
    return null;
  } catch {
    return null;
  }
}

function getOAuthClient(env, clientId, platform) {
  if (platform === "google" && clientId && clientId === env.OAUTH_CLIENT_ID) {
    return { id: env.OAUTH_CLIENT_ID, secret: env.OAUTH_CLIENT_SECRET, platform: "google" };
  }
  if (platform === "smartthings" && clientId && clientId === env.SMARTTHINGS_CLIENT_ID) {
    return { id: env.SMARTTHINGS_CLIENT_ID, secret: env.SMARTTHINGS_CLIENT_SECRET, platform: "smartthings" };
  }
  return null;
}

function validOAuthRequest({ client_id: clientId, redirect_uri: redirectUri, state, response_type: responseType }, client, platform) {
  if (!client || responseType !== "code" || !state || state.length > 1024 ||
      !oauthPlatformForRedirect(redirectUri) || oauthPlatformForRedirect(redirectUri) !== platform) return false;
  return client.platform === platform;
}

function authorizePage(fields, platform, error = false) {
  const hidden = Object.entries(fields)
    .map(([key, value]) => `<input type="hidden" name="${key}" value="${escapeHtml(value)}">`)
    .join("");
  const alert = error ? '<p role="alert">That pairing code did not match. Try again.</p>' : "";
  const title = platform === "smartthings" ? "Link Realme cameras to SmartThings" : "Link Realme cameras";
  const prompt = platform === "smartthings"
    ? "SmartThings is requesting access to your Realme cameras. Enter your pairing code and authorize this connection."
    : "Enter the one-time pairing code provided by your camera owner to link this Google Home test.";
  const button = platform === "smartthings" ? "Authorize SmartThings" : "Link cameras";
  return `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
body{font:16px system-ui,sans-serif;max-width:28rem;margin:10vh auto;padding:0 1.25rem;color:#17202a}
main{border:1px solid #d6dce2;border-radius:16px;padding:1.5rem}
label,input,button{display:block;width:100%;box-sizing:border-box}
input{margin:.5rem 0 1rem;padding:.8rem;border:1px solid #9aa4ad;border-radius:8px;font:inherit}
button{padding:.8rem;border:0;border-radius:8px;background:#1666d8;color:white;font:inherit;font-weight:600}
p{line-height:1.5}p[role=alert]{color:#a52222}
</style>
<main><h1>${title}</h1>
<p>${prompt}</p>
${alert}<form method="post" action="/oauth/authorize">${hidden}
<label for="pin">Pairing code</label><input id="pin" name="pin" type="password" autocomplete="one-time-code" required>
<button type="submit">${button}</button></form></main></html>`;
}

async function token(request, env) {
  const form = new URLSearchParams(await request.text());
  const clientCredentials = parseBasicAuthorization(request.headers.get("Authorization")) || {
    id: form.get("client_id") || "",
    secret: form.get("client_secret") || "",
  };
  const grantType = form.get("grant_type");
  const subject = env.GOOGLE_HOME_ACCOUNT_ID;
  let platform = "google";
  let payload;

  if (grantType === "authorization_code") {
    const code = await verifyPayload(form.get("code") || "", env.OAUTH_SIGNING_SECRET);
    platform = oauthPlatformForRedirect(code?.redirect_uri || form.get("redirect_uri") || "") || "google";
    const client = getOAuthClient(env, clientCredentials.id, platform);
    if (!client || !constantTimeEqual(clientCredentials.secret, client.secret)) {
      return json({ error: "invalid_client" }, 401);
    }
    if (!code || code.type !== "authorization_code" || code.exp < nowSeconds() ||
        code.sub !== subject || code.client_id !== client.id ||
        code.redirect_uri !== form.get("redirect_uri") ||
        (platform === "smartthings" && code.platform !== "smartthings") ||
        (platform === "google" && code.platform && code.platform !== "google")) {
      return json({ error: "invalid_grant" }, 400);
    }
  } else if (grantType === "refresh_token") {
    const refresh = await verifyPayload(form.get("refresh_token") || "", env.OAUTH_SIGNING_SECRET);
    platform = refresh?.platform === "smartthings" ? "smartthings" : "google";
    const client = getOAuthClient(env, clientCredentials.id, platform);
    if (!client || !constantTimeEqual(clientCredentials.secret, client.secret)) {
      return json({ error: "invalid_client" }, 401);
    }
    if (!refresh || refresh.type !== "refresh_token" || refresh.exp < nowSeconds() ||
        refresh.sub !== subject ||
        (refresh.client_id && refresh.client_id !== client.id) ||
        (platform === "smartthings" && refresh.client_id !== client.id)) {
      return json({ error: "invalid_grant" }, 400);
    }
  } else {
    return json({ error: "unsupported_grant_type" }, 400);
  }

  const expiresIn = platform === "smartthings"
    ? SMARTTHINGS_ACCESS_TOKEN_LIFETIME_SECONDS
    : ACCESS_TOKEN_LIFETIME_SECONDS;
  const accessTokenPayload = {
    type: "access_token",
    sub: subject,
    exp: nowSeconds() + expiresIn,
  };
  if (platform === "smartthings") {
    accessTokenPayload.platform = "smartthings";
    accessTokenPayload.client_id = clientCredentials.id;
  }
  const accessToken = await signPayload(accessTokenPayload, env.OAUTH_SIGNING_SECRET);
  const refreshToken = grantType === "refresh_token"
    ? form.get("refresh_token")
    : await signPayload({
      ...(platform === "smartthings"
        ? { platform: "smartthings", client_id: clientCredentials.id }
        : {}),
      type: "refresh_token",
      sub: subject,
      exp: nowSeconds() + REFRESH_TOKEN_LIFETIME_SECONDS,
      nonce: crypto.randomUUID(),
    }, env.OAUTH_SIGNING_SECRET);

  return json({
    token_type: "Bearer",
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
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

async function verifyAccessToken(request, env) {
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(request.headers.get("Authorization") || "");
  if (!match) return null;
  const payload = await verifyPayload(match[1], env.OAUTH_SIGNING_SECRET);
  if (!payload || payload.type !== "access_token" || payload.exp < nowSeconds() ||
      payload.sub !== env.GOOGLE_HOME_ACCOUNT_ID) return null;
  return payload.sub;
}

async function verifySmartThingsAccessToken(value, env) {
  const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(value || "");
  if (!match) return null;
  const payload = await verifyPayload(match[1], env.OAUTH_SIGNING_SECRET);
  if (!payload || payload.type !== "access_token" || payload.platform !== "smartthings" ||
      payload.client_id !== env.SMARTTHINGS_CLIENT_ID || payload.exp < nowSeconds() ||
      payload.sub !== env.GOOGLE_HOME_ACCOUNT_ID) return null;
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
  const identity = await verifySmartThingsAccessToken("Bearer " + suppliedToken, env);
  const responseHeaders = {
    schema: "st-schema",
    version: "1.0",
    interactionType: responseType,
    requestId,
  };
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
        deviceUniqueId: id,
        friendlyName: camera.name,
        manufacturerInfo: { manufacturerName: "realme", modelName: "360 Camera" },
        deviceHandlerType: "c2c-camera-rtsp-3",
      })),
    };
  }

  if (interaction === "stateRefreshRequest") {
    const requested = Array.isArray(body.devices) ? body.devices : [];
    const hasConfiguredDevice = requested.some(({ externalDeviceId }) => Object.hasOwn(cameras, externalDeviceId));
    const tuyaToken = hasConfiguredDevice ? await getTuyaAccessToken(env).catch(() => "") : "";
    const deviceState = await Promise.all(requested.map(async ({ externalDeviceId }) => {
      const camera = cameras[externalDeviceId];
      if (!camera) {
        return {
          externalDeviceId,
          deviceError: [{ errorEnum: "DEVICE-DELETED", detail: "Camera is not available." }],
        };
      }
      let online = false;
      if (tuyaToken) {
        try {
          online = await getTuyaCameraOnline(camera, tuyaToken, env) === true;
        } catch {
          online = false;
        }
      }
      const state = {
        externalDeviceId,
        states: [{
          component: "main",
          capability: "st.healthCheck",
          attribute: "healthStatus",
          value: online ? "online" : "offline",
        }],
      };
      if (!online) {
        state.deviceError = [{ errorEnum: "DEVICE-OFFLINE", detail: "Camera is offline in Tuya." }];
      }
      return state;
    }));
    return { headers: responseHeaders, deviceState };
  }

  const deviceState = await Promise.all((Array.isArray(body.devices) ? body.devices : []).map(async (device) => {
    const externalDeviceId = device.externalDeviceId;
    const camera = cameras[externalDeviceId];
    if (!camera) {
      return {
        externalDeviceId,
        deviceError: [{ errorEnum: "DEVICE-DELETED", detail: "Camera is not available." }],
      };
    }

    const states = [];
    let deviceError;
    for (const command of device.commands || []) {
      if (command.component !== "main" || command.capability !== "st.videoStream") {
        deviceError = [{ errorEnum: "CAPABILITY-NOT-SUPPORTED", detail: "This camera only supports video streaming." }];
        continue;
      }
      if (command.command === "startStream") {
        try {
          const streamUrl = await allocateRtsp(camera, env);
          states.push({
            component: "main",
            capability: "st.videoStream",
            attribute: "stream",
            value: { InHomeURL: streamUrl, OutHomeURL: streamUrl },
          });
          deviceError = undefined;
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
        deviceError = undefined;
      } else {
        deviceError = [{ errorEnum: "CAPABILITY-NOT-SUPPORTED", detail: "Camera command is not supported." }];
      }
    }
    return {
      externalDeviceId,
      ...(states.length ? { states } : {}),
      ...(deviceError ? { deviceError } : {}),
    };
  }));
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
            const stream = await allocateHls(cameras[id], env);
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

async function allocateHls(camera, env) {
  const tokenData = await tuyaRequest("GET", "/v1.0/token?grant_type=1", null, "", env);
  const token = tokenData.access_token;
  const deviceId = encodeURIComponent(camera.device_id);
  const base = camera.uid
    ? `/v1.0/users/${encodeURIComponent(camera.uid)}/devices/${deviceId}/stream/actions/allocate`
    : `/v1.0/devices/${deviceId}/stream/actions/allocate`;
  const result = await tuyaRequest("POST", base, { type: "hls" }, token, env);
  const stream = new URL(result.url);
  if (stream.protocol !== "https:" || stream.username || stream.password) {
    throw new Error("Tuya returned an invalid stream URL");
  }
  return stream.toString();
}

async function allocateRtsp(camera, env) {
  const token = await getTuyaAccessToken(env);
  const deviceId = encodeURIComponent(camera.device_id);
  const base = camera.uid
    ? `/v1.0/users/${encodeURIComponent(camera.uid)}/devices/${deviceId}/stream/actions/allocate`
    : `/v1.0/devices/${deviceId}/stream/actions/allocate`;
  const result = await tuyaRequest("POST", base, { type: "rtsp" }, token, env);
  const stream = new URL(result.url);
  if (!["rtsp:", "rtsps:"].includes(stream.protocol) || !stream.hostname) {
    throw new Error("Tuya returned an invalid RTSP stream URL");
  }
  return stream.toString();
}

async function getTuyaAccessToken(env) {
  const result = await tuyaRequest("GET", "/v1.0/token?grant_type=1", null, "", env);
  if (typeof result?.access_token !== "string" || !result.access_token) {
    throw new Error("Tuya did not return an access token");
  }
  return result.access_token;
}

async function getTuyaCameraOnline(camera, accessToken, env) {
  const deviceId = encodeURIComponent(camera.device_id);
  const detail = await tuyaRequest("GET", `/v1.0/iot-03/devices/${deviceId}`, null, accessToken, env);
  return typeof detail?.online === "boolean" ? detail.online : undefined;
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
  return hex(new Uint8Array(digest)).toLowerCase();
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
