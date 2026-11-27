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
const SMARTTHINGS_CALLBACK_HOSTS = new Set([
  "c2c-us.smartthings.com",
  "c2c-eu.smartthings.com",
  "c2c-ap.smartthings.com",
]);
const SMARTTHINGS_CALLBACK_ERROR_ENUMS = new Set([
  "BAD-REQUEST",
  "INTEGRATION-DELETED",
  "INTEGRATION-OFFLINE",
  "INVALID-TOKEN",
  "INVALID-INTERACTION-TYPE",
  "UNSUPPORTED-GRANT-TYPE",
  "INVALID-CODE",
  "INVALID-CLIENT-SECRET",
  "INVALID-CLIENT",
  "TOKEN-EXPIRED",
]);
const SMARTTHINGS_CALLBACK_CACHE = new Map();
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
        console.info(JSON.stringify({
          source: "smartthings_sdp_probe",
          event: "smartthings_request",
          interactionType: body?.headers?.interactionType || null,
          requestIdSuffix: summarizeRequestId(body?.headers?.requestId),
          ...summarizeSmartThingsRequest(body),
        }));
        const result = await handleSmartThings(body, env);
        const response = result instanceof Response ? result : json(result);
        console.info(JSON.stringify({
          source: "smartthings_sdp_probe",
          event: "smartthings_response",
          interactionType: body?.headers?.interactionType || null,
          requestIdSuffix: summarizeRequestId(body?.headers?.requestId),
          httpStatus: response.status,
          ...summarizeSmartThingsResponse(result),
        }));
        return response;
      } catch (error) {
        const status = error instanceof RequestSizeError ? 413 : 400;
        console.info(JSON.stringify({
          source: "smartthings_sdp_probe",
          event: "smartthings_response",
          httpStatus: status,
          errorType: error instanceof RequestSizeError ? "request_too_large" : "bad_request",
        }));
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
  const integrationDeleted = interaction === "integrationDeleted";
  const responseType = {
    discoveryRequest: "discoveryResponse",
    stateRefreshRequest: "stateRefreshResponse",
    commandRequest: "commandResponse",
    grantCallbackAccess: "accessTokenResponse",
  }[interaction];
  if (requestHeaders.schema !== "st-schema" || requestHeaders.version !== "1.0" ||
      (!responseType && !integrationDeleted)) {
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

  if (integrationDeleted) {
    const key = await smartThingsCallbackKey(identity);
    SMARTTHINGS_CALLBACK_CACHE.delete(key);
    let deleted = false;
    try {
      if (env.SMARTTHINGS_CALLBACKS) {
        await env.SMARTTHINGS_CALLBACKS.delete(key);
        deleted = true;
      }
    } catch (error) {
      console.info(JSON.stringify({
        source: "smartthings_sdp_probe",
        event: "integration_deleted_cleanup",
        kvDeleteSucceeded: false,
        errorType: error?.name || "Error",
      }));
    }
    if (deleted) {
      console.info(JSON.stringify({
        source: "smartthings_sdp_probe",
        event: "integration_deleted_cleanup",
        kvDeleteSucceeded: true,
      }));
    }
    return new Response(null, { status: 204 });
  }

  if (interaction === "grantCallbackAccess") {
    return smartThingsGrantCallbackAccess(body, env, identity, responseHeaders);
  }

  const cameras = JSON.parse(env.CAMERAS_JSON);
  if (interaction === "discoveryRequest") {
    let requestGrantCallbackAccess = false;
    try {
      const callbackRecord = await getSmartThingsCallbackRecord(
        env,
        await smartThingsCallbackKey(identity),
      );
      requestGrantCallbackAccess = !callbackRecord;
    } catch (error) {
      requestGrantCallbackAccess = error?.message === "SmartThings callback token exchange failed";
    }
    return {
      headers: responseHeaders,
      ...(requestGrantCallbackAccess ? { requestGrantCallbackAccess: true } : {}),
      devices: Object.entries(cameras).map(([id, camera]) => ({
        externalDeviceId: id,
        deviceUniqueId: id,
        friendlyName: camera.name,
        manufacturerInfo: { manufacturerName: "realme", modelName: "360 Camera" },
        deviceHandlerType: "c2c-camera-webrtc-3",
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
      const states = [{
        component: "main",
        capability: "st.healthCheck",
        attribute: "healthStatus",
        value: online ? "online" : "offline",
      }];
      if (online && tuyaToken) {
        try {
          const config = await getTuyaWebRtcConfig(camera, tuyaToken, env);
          states.push(...webRtcCapabilityStates(config));
          const turnState = webRtcTurnInfoState(config);
          if (turnState) {
            states.push(turnState);
            console.info(JSON.stringify({
              source: "smartthings_sdp_probe",
              event: "turn_info_primed",
              sourceType: "state_refresh",
              urlScheme: new URL(turnState.value.turnUrl).protocol.replace(":", ""),
            }));
          }
        } catch {
          // The camera remains online even if its WebRTC settings are temporarily unavailable.
        }
      }
      const state = {
        externalDeviceId,
        states,
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
    let online;
    let tuyaToken;
    let webRtcConfig;
    const checkOnline = async () => {
      if (online !== undefined) return online;
      try {
        tuyaToken = tuyaToken || await getTuyaAccessToken(env);
        online = await getTuyaCameraOnline(camera, tuyaToken, env) === true;
      } catch {
        online = false;
      }
      return online;
    };
    const getWebRtcConfig = async () => {
      if (!webRtcConfig) {
        tuyaToken = tuyaToken || await getTuyaAccessToken(env);
        webRtcConfig = await getTuyaWebRtcConfig(camera, tuyaToken, env);
      }
      return webRtcConfig;
    };
    for (const command of device.commands || []) {
      if (command.component !== "main") {
        deviceError = [{ errorEnum: "CAPABILITY-NOT-SUPPORTED", detail: "This camera only supports WebRTC video streaming." }];
        continue;
      }
      if (command.capability === "st.refresh" && command.command === "refresh") {
        await checkOnline();
        if (online) {
          try {
            const config = await getWebRtcConfig();
            states.push(...webRtcCapabilityStates(config));
            const turnState = webRtcTurnInfoState(config);
            if (turnState) {
              states.push(turnState);
              console.info(JSON.stringify({
                source: "smartthings_sdp_probe",
                event: "turn_info_primed",
                sourceType: "device_refresh",
                urlScheme: new URL(turnState.value.turnUrl).protocol.replace(":", ""),
              }));
            }
          } catch {
            // Keep the online state independent from WebRTC signaling setup.
          }
        }
        continue;
      }
      if (command.capability !== "st.webrtc") {
        deviceError = [{ errorEnum: "CAPABILITY-NOT-SUPPORTED", detail: "This camera only supports WebRTC video streaming." }];
        continue;
      }
      if (command.command === "sdpOffer") {
        try {
          const args = Array.isArray(command.arguments) ? command.arguments : [];
          const streamId = args[0];
          const offer = typeof args[1] === "string" ? args[1] : args[1]?.sdp;
          if (typeof streamId !== "string" || !streamId || typeof offer !== "string" || !offer) {
            throw new Error("SmartThings sent an invalid WebRTC offer");
          }
          const pcmuOffer = addPcmuForTuya(offer);
          const tuyaOffer = addBundleForTuya(pcmuOffer.sdp);
          const offerSummary = summarizeSdp(offer);
          const iceServerSummary = summarizeIceServers(args[2]);
          const tvCompatibilityOffer = !offerSummary.hasBundle && !iceServerSummary.provided;
          console.info(JSON.stringify({
            source: "smartthings_sdp_probe",
            event: "offer_received",
            sdp: offerSummary,
            iceServers: iceServerSummary,
            tvCompatibilityOffer,
          }));
          if (pcmuOffer.pcmuAdded) {
            console.info(JSON.stringify({
              source: "smartthings_sdp_probe",
              event: "pcmu_added_for_tuya",
              reason: "offer_has_no_g711_codec",
              sdp: summarizeSdp(pcmuOffer.sdp),
            }));
          }
          if (tuyaOffer.bundleAdded) {
            console.info(JSON.stringify({
              source: "smartthings_sdp_probe",
              event: "bundle_added_for_tuya",
              reason: "offer_has_multiple_media_sections_without_bundle",
              sdp: summarizeSdp(tuyaOffer.sdp),
            }));
          }
          const config = await getWebRtcConfig();
          const turn = getTuyaTurnServer(config);
          let turnState;
          if (turn) {
            turnState = {
              component: "main",
              capability: "st.webrtc",
              attribute: "turnInfo",
              value: {
                id: streamId,
                turnUrl: turn.urls,
                userName: turn.username,
                passWord: turn.credential,
              },
            };
            const callbackResult = await sendSmartThingsStateCallback(
              env,
              identity,
              externalDeviceId,
              turnState,
            ).catch(() => ({ delivered: false, reason: "callback_exception" }));
            console.info(JSON.stringify({
              source: "smartthings_sdp_probe",
              event: "turn_info_callback_result",
              delivered: callbackResult.delivered,
              callbackRecordPresent: callbackResult.recordPresent ?? null,
              httpStatus: callbackResult.httpStatus ?? null,
              retriedAfter401: callbackResult.retriedAfter401 ?? false,
              reason: callbackResult.reason ?? null,
              urlScheme: /^([a-z0-9+.-]+):/i.exec(turn.urls)?.[1]?.toLowerCase() || null,
            }));
            if (callbackResult.delivered) await new Promise((resolve) => setTimeout(resolve, 200));
          }
          const sessionId = await smartThingsSessionId(streamId);
          const exchange = await tuyaWebRtcExchange(camera, config, tuyaToken, env, sessionId, "offer", {
            mode: "webrtc",
            sdp: tuyaOffer.sdp,
            stream_type: 1,
            auth: config.auth,
          }, "answer");
          const audioAdjustedAnswer = pcmuOffer.pcmuAdded
            ? rejectAddedAudioInAnswer(exchange.answer, offer)
            : exchange.answer;
          const h264Alignment = pcmuOffer.pcmuAdded
            ? alignH264ProfileToOffer(audioAdjustedAnswer, offer)
            : { sdp: audioAdjustedAnswer, changed: false };
          const answer = h264Alignment.sdp;
          const embeddedCandidates = tvCompatibilityOffer
            ? embedTuyaCandidatesInVideoSdp(answer, exchange.candidates)
            : { sdp: answer, addedCount: 0, targetMid: null, targetMLineIndex: null };
          const responseAnswer = embeddedCandidates.sdp;
          console.info(JSON.stringify({
            source: "smartthings_sdp_probe",
            event: "answer_received",
            sdp: summarizeSdp(responseAnswer),
            answerMessages: exchange.answerMessages.map(summarizeSdp),
            tuyaCandidateCount: exchange.candidates.length,
            tuyaCandidateTypes: exchange.candidates.map(summarizeIceCandidate),
          }));
          if (embeddedCandidates.addedCount) {
            console.info(JSON.stringify({
              source: "smartthings_sdp_probe",
              event: "candidates_embedded_for_tizen",
              candidateCount: embeddedCandidates.addedCount,
              candidateTypes: exchange.candidates.map(summarizeIceCandidate),
              sdpMid: embeddedCandidates.targetMid,
              sdpMLineIndex: embeddedCandidates.targetMLineIndex,
            }));
          }
          if (pcmuOffer.pcmuAdded && answer !== exchange.answer) {
            console.info(JSON.stringify({
              source: "smartthings_sdp_probe",
              event: "audio_rejected_for_tizen",
              sdp: summarizeSdp(answer),
            }));
          }
          if (h264Alignment.changed) {
            console.info(JSON.stringify({
              source: "smartthings_sdp_probe",
              event: "h264_profile_narrowed_for_tizen",
              from: h264Alignment.from,
              to: h264Alignment.to,
            }));
          }
          if (turnState) states.push(turnState);
          states.push({
            component: "main",
            capability: "st.webrtc",
            attribute: "sdpAnswer",
            value: { id: streamId, sdp: responseAnswer },
          });
          states.push(...deviceIceStates(exchange.candidates, streamId, responseAnswer));
          deviceError = undefined;
        } catch {
          deviceError = [{ errorEnum: "DEVICE-UNAVAILABLE", detail: "Tuya could not establish the WebRTC camera stream." }];
        }
      } else if (command.command === "clientIce") {
        try {
          const args = Array.isArray(command.arguments) ? command.arguments : [];
          const streamId = args[0];
          const ice = args[1];
          const candidate = typeof ice === "string" ? ice : ice?.candidate;
          if (typeof streamId !== "string" || !streamId || typeof candidate !== "string" || !candidate) {
            throw new Error("SmartThings sent an invalid ICE candidate");
          }
          const config = await getWebRtcConfig();
          const sessionId = await smartThingsSessionId(streamId);
          const hint = typeof ice === "object" && ice
            ? { sdpMid: ice.sdpMid, sdpMLineIndex: ice.sdpMLineIndex }
            : undefined;
          console.info(JSON.stringify({
            source: "smartthings_sdp_probe",
            event: "client_ice_received",
            candidate: summarizeIceCandidate(candidate),
            sdpMid: hint?.sdpMid || null,
            sdpMLineIndex: Number.isInteger(hint?.sdpMLineIndex) ? hint.sdpMLineIndex : null,
          }));
          const exchange = await tuyaWebRtcExchange(camera, config, tuyaToken, env, sessionId, "candidate", {
            mode: "webrtc",
            candidate: candidate.replace(/^a=/, "").trim(),
          }, "candidate");
          console.info(JSON.stringify({
            source: "smartthings_sdp_probe",
            event: "client_ice_exchange_completed",
            candidateTypes: exchange.candidates.map(summarizeIceCandidate),
          }));
          states.push(...deviceIceStates(exchange.candidates, streamId, undefined, hint));
          deviceError = undefined;
        } catch {
          deviceError = [{ errorEnum: "DEVICE-UNAVAILABLE", detail: "Tuya could not exchange WebRTC ICE candidates." }];
        }
      } else if (command.command === "requestTurnInfo") {
        try {
          const config = await getWebRtcConfig();
          const turn = getTuyaTurnServer(config);
          console.info(JSON.stringify({
            source: "smartthings_sdp_probe",
            event: "turn_info_requested",
            turnAvailable: Boolean(turn),
            urlScheme: turn ? new URL(turn.urls).protocol.replace(":", "") : null,
            streamIdProvided: typeof command.arguments?.[0] === "string" && Boolean(command.arguments[0]),
          }));
          if (turn) {
            states.push({
              component: "main",
              capability: "st.webrtc",
              attribute: "turnInfo",
              value: {
                id: command.arguments?.[0] || crypto.randomUUID(),
                turnUrl: turn.urls,
                userName: turn.username,
                passWord: turn.credential,
              },
            });
          }
          deviceError = undefined;
        } catch {
          deviceError = [{ errorEnum: "DEVICE-UNAVAILABLE", detail: "Tuya could not provide WebRTC relay details." }];
        }
      } else if (command.command === "end") {
        try {
          const streamId = command.arguments?.[0];
          if (typeof streamId === "string" && streamId) {
            const config = await getWebRtcConfig();
            const sessionId = await smartThingsSessionId(streamId);
            await tuyaWebRtcExchange(camera, config, tuyaToken, env, sessionId, "disconnect", {
              mode: "webrtc",
            }, null);
            states.push({
              component: "main",
              capability: "st.webrtc",
              attribute: "sdpAnswer",
              value: { id: streamId, sdp: "" },
            });
          }
          deviceError = undefined;
        } catch {
          deviceError = [{ errorEnum: "DEVICE-UNAVAILABLE", detail: "Tuya could not stop the WebRTC camera stream." }];
        }
      } else {
        deviceError = [{ errorEnum: "CAPABILITY-NOT-SUPPORTED", detail: "Camera command is not supported." }];
      }
    }
    online = await checkOnline();
    states.push({
      component: "main",
      capability: "st.healthCheck",
      attribute: "healthStatus",
      value: online ? "online" : "offline",
    });
    if (!online) {
      deviceError = [{ errorEnum: "DEVICE-OFFLINE", detail: "Camera is offline in Tuya." }];
    }
    return {
      externalDeviceId,
      ...(states.length ? { states } : {}),
      ...(deviceError ? { deviceError } : {}),
    };
  }));
  return { headers: responseHeaders, deviceState };
}

async function smartThingsGrantCallbackAccess(body, env, identity, responseHeaders) {
  const callbackAuthentication = body?.callbackAuthentication || {};
  const callbackUrls = body?.callbackUrls || {};
  let stage = "validate_grant";
  try {
    if (callbackAuthentication.grantType !== "authorization_code" ||
        typeof callbackAuthentication.code !== "string" || !callbackAuthentication.code) {
      throw Object.assign(new Error("invalid_grant"), { safeReason: "grant_fields_invalid" });
    }
    if (typeof callbackAuthentication.clientId !== "string" || !callbackAuthentication.clientId) {
      throw Object.assign(new Error("client_id_missing"), { safeReason: "client_id_missing" });
    }
    if (!env.SMARTTHINGS_CALLBACK_CLIENT_ID || !env.SMARTTHINGS_CALLBACK_CLIENT_SECRET) {
      throw Object.assign(new Error("callback_credentials_missing"), { safeReason: "callback_credentials_missing" });
    }
    if (callbackAuthentication.clientId !== env.SMARTTHINGS_CALLBACK_CLIENT_ID) {
      throw Object.assign(new Error("client_id_mismatch"), { safeReason: "client_id_mismatch" });
    }
    if (!env.SMARTTHINGS_CALLBACKS) {
      throw Object.assign(new Error("callback_storage_unavailable"), { safeReason: "kv_binding_missing" });
    }

    stage = "validate_callback_urls";
    const oauthTokenUrl = validateSmartThingsCallbackUrl(callbackUrls.oauthToken).toString();
    const stateCallbackUrl = validateSmartThingsCallbackUrl(callbackUrls.stateCallback).toString();

    stage = "callback_token_exchange";
    const tokens = await requestSmartThingsCallbackToken(
      oauthTokenUrl,
      {
        grantType: "authorization_code",
        code: callbackAuthentication.code,
        clientId: callbackAuthentication.clientId,
      },
      env,
    );
    const record = {
      oauthTokenUrl,
      stateCallbackUrl,
      clientId: callbackAuthentication.clientId,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
    };
    stage = "persist_callback_record";
    const key = await smartThingsCallbackKey(identity);
    await env.SMARTTHINGS_CALLBACKS.put(key, JSON.stringify(record));
    SMARTTHINGS_CALLBACK_CACHE.set(key, record);
    console.info(JSON.stringify({
      source: "smartthings_sdp_probe",
      event: "callback_grant_stored",
      recordStored: true,
      expiresIn: tokens.expiresIn,
      clientIdMatchesConfigured: callbackAuthentication.clientId === env.SMARTTHINGS_CALLBACK_CLIENT_ID,
    }));
    return {
      headers: responseHeaders,
      callbackAuthentication: {
        tokenType: "Bearer",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresIn: tokens.expiresIn,
      },
    };
  } catch (error) {
    const callbackDiagnostics = error?.safeDiagnostics || {};
    const safeReason = error?.safeReason || (stage === "callback_token_exchange"
      ? "token_exchange_request_failed"
      : stage === "validate_callback_urls" ? "callback_url_invalid" : "callback_grant_failed");
    console.info(JSON.stringify({
      source: "smartthings_sdp_probe",
      event: "callback_grant_failed",
      stage,
      reason: safeReason,
      errorType: error?.name || "Error",
      oauthTokenHost: safeCallbackHost(callbackUrls.oauthToken),
      stateCallbackHost: safeCallbackHost(callbackUrls.stateCallback),
      clientIdMatchesConfigured: callbackAuthentication.clientId === env.SMARTTHINGS_CALLBACK_CLIENT_ID,
      ...callbackDiagnostics,
    }));
    return {
      headers: responseHeaders,
      globalError: { errorEnum: "INTERNAL-ERROR", detail: "SmartThings callback authorization failed." },
    };
  }
}

async function smartThingsCallbackKey(identity) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return `smartthings:${hex(new Uint8Array(digest)).slice(0, 32)}`;
}

function validateSmartThingsCallbackUrl(value) {
  if (typeof value !== "string" || !value) throw new Error("Missing SmartThings callback URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || !SMARTTHINGS_CALLBACK_HOSTS.has(url.hostname) ||
      url.port || url.username || url.password || url.hash) {
    throw new Error("Invalid SmartThings callback URL");
  }
  return url;
}

function safeCallbackHost(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && SMARTTHINGS_CALLBACK_HOSTS.has(url.hostname)
      ? url.hostname
      : "invalid";
  } catch {
    return "invalid";
  }
}

function safeSmartThingsCallbackErrorEnum(value) {
  return typeof value === "string" && SMARTTHINGS_CALLBACK_ERROR_ENUMS.has(value)
    ? value
    : null;
}

async function requestSmartThingsCallbackToken(oauthTokenUrl, grant, env) {
  const callbackAuthentication = {
    grantType: grant.grantType,
    clientId: grant.clientId || env.SMARTTHINGS_CALLBACK_CLIENT_ID,
    clientSecret: env.SMARTTHINGS_CALLBACK_CLIENT_SECRET,
  };
  if (grant.grantType === "authorization_code") callbackAuthentication.code = grant.code;
  else if (grant.grantType === "refresh_token") callbackAuthentication.refreshToken = grant.refreshToken;
  else throw new Error("Unsupported SmartThings callback grant type");

  const requestId = crypto.randomUUID();
  const response = await fetch(oauthTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      headers: {
        schema: "st-schema",
        version: "1.0",
        interactionType: "accessTokenRequest",
        requestId,
      },
      callbackAuthentication,
    }),
    signal: AbortSignal.timeout(4500),
  });
  const payload = await response.json().catch(() => null);
  const tokens = payload?.callbackAuthentication;
  const requestIdMatches = payload?.headers?.requestId === requestId;
  if (!response.ok || payload?.headers?.interactionType !== "accessTokenResponse" ||
      tokens?.tokenType !== "Bearer" || typeof tokens.accessToken !== "string" || !tokens.accessToken ||
      typeof tokens.refreshToken !== "string" || !tokens.refreshToken ||
      !Number.isFinite(tokens.expiresIn) || tokens.expiresIn <= 0) {
    const error = new Error("SmartThings callback token exchange failed");
    error.safeReason = "token_exchange_response_invalid";
    error.safeDiagnostics = {
      tokenExchangeHttpStatus: response.status,
      tokenExchangeInteractionType: payload?.headers?.interactionType || null,
      tokenExchangeRequestIdMatches: requestIdMatches,
      tokenExchangeErrorEnum: safeSmartThingsCallbackErrorEnum(payload?.globalError?.errorEnum),
      tokenTypeBearer: tokens?.tokenType === "Bearer",
      accessTokenPresent: typeof tokens?.accessToken === "string" && Boolean(tokens.accessToken),
      refreshTokenPresent: typeof tokens?.refreshToken === "string" && Boolean(tokens.refreshToken),
      expiresInValid: Number.isFinite(tokens?.expiresIn) && tokens.expiresIn > 0,
    };
    throw error;
  }
  console.info(JSON.stringify({
    source: "smartthings_sdp_probe",
    event: "callback_token_exchange_response",
    httpStatus: response.status,
    interactionType: payload?.headers?.interactionType || null,
    requestIdMatches,
    tokenTypeBearer: tokens.tokenType === "Bearer",
    accessTokenPresent: Boolean(tokens.accessToken),
    refreshTokenPresent: Boolean(tokens.refreshToken),
    expiresInValid: Number.isFinite(tokens.expiresIn) && tokens.expiresIn > 0,
  }));
  return tokens;
}

async function getSmartThingsCallbackRecord(env, key, forceRefresh = false) {
  if (!env.SMARTTHINGS_CALLBACKS) throw new Error("SmartThings callback storage is unavailable");
  let record = SMARTTHINGS_CALLBACK_CACHE.get(key);
  if (!record) {
    record = await env.SMARTTHINGS_CALLBACKS.get(key, "json");
    if (record) SMARTTHINGS_CALLBACK_CACHE.set(key, record);
  }
  if (!record) return null;
  if (!forceRefresh && record.expiresAt > Date.now() + 60_000) return record;

  const tokens = await requestSmartThingsCallbackToken(
    validateSmartThingsCallbackUrl(record.oauthTokenUrl).toString(),
    {
      grantType: "refresh_token",
      refreshToken: record.refreshToken,
      clientId: record.clientId,
    },
    env,
  );
  record = {
    ...record,
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: Date.now() + tokens.expiresIn * 1000,
  };
  await env.SMARTTHINGS_CALLBACKS.put(key, JSON.stringify(record));
  SMARTTHINGS_CALLBACK_CACHE.set(key, record);
  return record;
}

async function sendSmartThingsStateCallback(env, identity, externalDeviceId, state) {
  const key = await smartThingsCallbackKey(identity);
  let record;
  try {
    record = await getSmartThingsCallbackRecord(env, key);
  } catch {
    return { delivered: false, recordPresent: null, reason: "callback_record_error" };
  }
  if (!record) {
    return { delivered: false, recordPresent: false, reason: "callback_record_missing" };
  }
  const send = (callbackRecord) => fetch(
    validateSmartThingsCallbackUrl(callbackRecord.stateCallbackUrl).toString(),
    {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        headers: {
          schema: "st-schema",
          version: "1.0",
          interactionType: "stateCallback",
          requestId: crypto.randomUUID(),
        },
        authentication: { tokenType: "Bearer", token: callbackRecord.accessToken },
        deviceState: [{ externalDeviceId, states: [{ ...state, timestamp: Date.now(), stateChange: "Y", visibility: { displayed: false } }] }],
      }),
      signal: AbortSignal.timeout(3000),
    },
  );
  let response;
  try {
    response = await send(record);
  } catch {
    return { delivered: false, recordPresent: true, reason: "callback_request_error" };
  }
  let retriedAfter401 = false;
  if (response.status === 401) {
    retriedAfter401 = true;
    try {
      record = await getSmartThingsCallbackRecord(env, key, true);
      if (!record) {
        return {
          delivered: false,
          recordPresent: false,
          httpStatus: 401,
          retriedAfter401,
          reason: "callback_record_missing_after_refresh",
        };
      }
      response = await send(record);
    } catch {
      return {
        delivered: false,
        recordPresent: true,
        httpStatus: 401,
        retriedAfter401,
        reason: "callback_refresh_or_retry_error",
      };
    }
  }
  return {
    delivered: response.ok,
    recordPresent: true,
    httpStatus: response.status,
    retriedAfter401,
    reason: response.ok ? null : "callback_http_error",
  };
}

function webRtcCapabilityStates(config) {
  const stun = getTuyaIceServers(config).find((server) => server.urls.startsWith("stun:"));
  return [
    {
      component: "main",
      capability: "st.webrtc",
      attribute: "audioOnly",
      value: false,
    },
    {
      component: "main",
      capability: "st.webrtc",
      attribute: "standbyMode",
      value: false,
    },
    {
      component: "main",
      capability: "st.webrtc",
      attribute: "supportedFeatures",
      value: {
        audio: "recvonly",
        video: "recvonly",
        bundle: true,
        order: "audio/video",
        supportTrickleICE: true,
        turnSource: "camera",
      },
    },
    {
      component: "main",
      capability: "st.webrtc",
      attribute: "talkback",
      value: false,
    },
    ...(stun ? [{
      component: "main",
      capability: "st.webrtc",
      attribute: "stunUrl",
      value: stun.urls,
    }] : []),
    {
      component: "main",
      capability: "st.motionSensor",
      attribute: "motion",
      value: "inactive",
    },
  ];
}

function webRtcTurnInfoState(config, id = crypto.randomUUID()) {
  const turn = getTuyaTurnServer(config);
  if (!turn) return null;
  return {
    component: "main",
    capability: "st.webrtc",
    attribute: "turnInfo",
    value: {
      id,
      turnUrl: turn.urls,
      userName: turn.username,
      passWord: turn.credential,
    },
  };
}

function getTuyaIceServers(config) {
  const tokens = config?.p2p_config?.ices;
  if (!Array.isArray(tokens)) return [];
  return tokens.flatMap((token) => {
    const urls = Array.isArray(token?.urls) ? token.urls : [token?.urls];
    return urls.filter((url) => typeof url === "string" && /^(stun|turn|turns):/i.test(url)).map((url) => ({
      urls: url,
      username: token.username,
      credential: token.credential,
      ttl: token.ttl,
    }));
  });
}

function getTuyaTurnServer(config) {
  return getTuyaIceServers(config).find((server) => server.urls.startsWith("turn:") && server.username && server.credential);
}

function embedTuyaCandidatesInVideoSdp(sdp, candidates) {
  const parsed = parseMediaSections(sdp);
  const video = parsed.sections.find((section) => section.kind === "video" && section.port !== "0");
  if (!video || !Array.isArray(candidates)) {
    return { sdp, addedCount: 0, targetMid: video?.mid || null, targetMLineIndex: video?.index ?? null };
  }

  const sectionEnd = parsed.sections[video.index + 1]?.lineIndex ?? parsed.lines.length;
  const sectionLines = parsed.lines.slice(video.lineIndex + 1, sectionEnd);
  const existingCandidates = new Set(sectionLines.filter((line) => /^a=candidate:/i.test(line)));
  const candidateLines = [...new Set(candidates.map((candidate) => {
    const value = typeof candidate === "string" ? candidate : candidate?.candidate;
    if (typeof value !== "string") return null;
    const line = value.trim().replace(/^a=/i, "").replace(/\r?\n$/, "");
    return /^candidate:\S+/i.test(line) ? `a=${line}` : null;
  }).filter(Boolean))].filter((line) => !existingCandidates.has(line));
  if (!candidateLines.length) {
    return { sdp, addedCount: 0, targetMid: video.mid || null, targetMLineIndex: video.index };
  }

  const endMarkerIndex = parsed.lines.findIndex((line, index) =>
    index > video.lineIndex && index < sectionEnd && /^a=end-of-candidates$/i.test(line));
  const insertAt = endMarkerIndex >= 0 ? endMarkerIndex : sectionEnd;
  parsed.lines.splice(insertAt, 0, ...candidateLines);
  if (endMarkerIndex < 0) parsed.lines.splice(insertAt + candidateLines.length, 0, "a=end-of-candidates");
  return {
    sdp: parsed.lines.join("\r\n"),
    addedCount: candidateLines.length,
    targetMid: video.mid || null,
    targetMLineIndex: video.index,
  };
}

function deviceIceStates(candidates, streamId, sdp, hint) {
  const target = getDeviceIceTarget(sdp, hint);
  return candidates.map((candidate) => ({
    component: "main",
    capability: "st.webrtc",
    attribute: "deviceIce",
    value: {
      id: streamId || crypto.randomUUID(),
      ice: {
        candidate,
        sdpMid: target.sdpMid,
        sdpMLineIndex: target.sdpMLineIndex,
      },
    },
    stateChange: "Y",
  }));
}

function summarizeRequestId(value) {
  return typeof value === "string" && value ? value.slice(-8) : null;
}

function summarizeSmartThingsRequest(body) {
  const devices = Array.isArray(body?.devices) ? body.devices : [];
  const commands = devices.flatMap((device) =>
    (Array.isArray(device?.commands) ? device.commands : []).map((command) =>
      `${command?.capability || "unknown"}.${command?.command || "unknown"}`));
  return { deviceCount: devices.length, commands };
}

function summarizeSmartThingsResponse(response) {
  if (!response || typeof response !== "object" || response instanceof Response) {
    return { responseInteractionType: null, globalError: null, deviceCount: 0, devices: [] };
  }
  const deviceState = Array.isArray(response.deviceState) ? response.deviceState : [];
  return {
    responseInteractionType: response.headers?.interactionType || null,
    globalError: response.globalError?.errorEnum || null,
    deviceCount: deviceState.length,
    devices: deviceState.map((device) => {
      const states = Array.isArray(device?.states) ? device.states : [];
      const sdp = states.find((state) => state.capability === "st.webrtc" &&
        state.attribute === "sdpAnswer")?.value?.sdp;
      const deviceIce = states.filter((state) => state.capability === "st.webrtc" &&
        state.attribute === "deviceIce");
      const turnInfo = states.find((state) => state.capability === "st.webrtc" &&
        state.attribute === "turnInfo")?.value;
      const turnUrl = typeof turnInfo?.turnUrl === "string" ? turnInfo.turnUrl : "";
      return {
        stateAttributes: states.map((state) => `${state.capability}.${state.attribute}`),
        sdpAnswer: typeof sdp === "string" ? summarizeSdp(sdp) : null,
        deviceIceCount: deviceIce.length,
        deviceIceCandidateTypes: [...new Set(deviceIce.map((state) =>
          summarizeIceCandidate(state.value?.ice?.candidate).type))],
        deviceIceTargets: [...new Set(deviceIce.map((state) =>
          `${state.value?.ice?.sdpMid ?? "?"}/${state.value?.ice?.sdpMLineIndex ?? "?"}`))],
        turnInfoPresent: Boolean(turnInfo),
        turnUrlScheme: /^([a-z0-9+.-]+):/i.exec(turnUrl)?.[1]?.toLowerCase() || null,
        deviceErrors: (Array.isArray(device?.deviceError) ? device.deviceError : [])
          .map((error) => error.errorEnum || "unknown"),
      };
    }),
  };
}

function summarizeSdp(sdp) {
  const lines = sdp.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const sections = [];
  const candidates = lines.filter((line) => line.startsWith("a=candidate:")).map((line) => {
    const fields = line.replace(/^a=/, "").split(/\s+/);
    return {
      type: /\btyp\s+(host|srflx|prflx|relay)\b/i.exec(line)?.[1]?.toLowerCase() || "unknown",
      protocol: ["udp", "tcp"].includes(fields[2]?.toLowerCase()) ? fields[2].toLowerCase() : "unknown",
    };
  });
  let current;
  for (const line of lines) {
    if (line.startsWith("m=")) {
      const fields = line.slice(2).split(/\s+/);
      current = {
        kind: fields[0] || "unknown",
        port: fields[1] || "",
        mid: null,
        rejected: fields[1] === "0",
        protocol: fields[2] || "unknown",
        codecs: [],
        h264Profiles: [],
        h264PacketizationModes: [],
        direction: "default",
        rtcpMux: false,
        hasIceCredentials: false,
        hasFingerprint: false,
        setup: null,
      };
      sections.push(current);
    } else if (current) {
      const mid = /^a=mid:(\S+)/i.exec(line)?.[1];
      if (mid) current.mid = mid;
      const codec = /^a=rtpmap:\d+\s+([^/\s]+)/i.exec(line)?.[1]?.toLowerCase();
      if (codec) current.codecs.push(codec);
      if (/^a=(sendrecv|sendonly|recvonly|inactive)$/i.test(line)) {
        current.direction = line.slice(2).toLowerCase();
      }
      if (line === "a=rtcp-mux") current.rtcpMux = true;
      if (line.startsWith("a=ice-ufrag:") || line.startsWith("a=ice-pwd:")) current.hasIceCredentials = true;
      if (line.startsWith("a=fingerprint:")) current.hasFingerprint = true;
      const setup = /^a=setup:(\S+)/i.exec(line)?.[1];
      if (setup) current.setup = setup.toLowerCase();
      if (/^a=fmtp:\d+\s+/i.test(line)) {
        const profile = /(?:^|;)\s*profile-level-id=([0-9a-f]+)/i.exec(line)?.[1]?.toLowerCase();
        const packetization = /(?:^|;)\s*packetization-mode=([0-2])/i.exec(line)?.[1];
        if (profile) current.h264Profiles.push(profile);
        if (packetization) current.h264PacketizationModes.push(packetization);
      }
    }
  }
  return {
    chars: sdp.length,
    hasBundle: lines.some((line) => line.startsWith("a=group:BUNDLE")),
    candidateTypes: [...new Set(candidates.map((candidate) => `${candidate.type}/${candidate.protocol}`))],
    sections: sections.map((section) => ({
      ...section,
      codecs: [...new Set(section.codecs)],
      h264Profiles: [...new Set(section.h264Profiles)],
      h264PacketizationModes: [...new Set(section.h264PacketizationModes)],
    })),
  };
}

function summarizeIceCandidate(candidate) {
  const value = typeof candidate === "string" ? candidate : "";
  const type = /\btyp\s+(host|srflx|prflx|relay)\b/i.exec(value)?.[1]?.toLowerCase() || "unknown";
  const protocol = /\bcandidate:\S+\s+\d+\s+(udp|tcp)\b/i.exec(value)?.[1]?.toLowerCase() || "unknown";
  return { type, protocol };
}

function hasActiveMediaSection(sdp) {
  return summarizeSdp(sdp).sections.some((section) =>
    !section.rejected && (section.kind === "audio" || section.kind === "video"));
}

function parseMediaSections(sdp) {
  const lines = sdp.split(/\r?\n/);
  const sections = [];
  let current;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line.startsWith("m=")) {
      const fields = line.slice(2).trim().split(/\s+/);
      current = {
        index: sections.length,
        lineIndex: index,
        kind: fields[0]?.toLowerCase() || "",
        port: fields[1]?.split("/", 1)[0] || "0",
        protocol: fields[2] || "",
        formats: fields.slice(3),
        mid: null,
      };
      sections.push(current);
    } else if (current) {
      const mid = /^a=mid:(\S+)/i.exec(line)?.[1];
      if (mid) current.mid = mid;
    }
  }
  return { lines, sections };
}

function addPcmuForTuya(sdp) {
  const parsed = parseMediaSections(sdp);
  const audio = parsed.sections.find((section) => section.kind === "audio");
  if (!audio || audio.port === "0") return { sdp, pcmuAdded: false };
  const end = parsed.sections[audio.index + 1]?.lineIndex ?? parsed.lines.length;
  const codecs = new Set();
  for (const line of parsed.lines.slice(audio.lineIndex + 1, end)) {
    const codec = /^a=rtpmap:\d+\s+([^/\s]+)/i.exec(line)?.[1]?.toLowerCase();
    if (codec) codecs.add(codec);
  }
  if (codecs.has("pcmu") || codecs.has("pcma") ||
      audio.formats.includes("0") || audio.formats.includes("8")) {
    return { sdp, pcmuAdded: false };
  }

  const fields = parsed.lines[audio.lineIndex].slice(2).trim().split(/\s+/);
  fields.push("0");
  parsed.lines[audio.lineIndex] = `m=${fields.join(" ")}`;
  const codecLineIndex = parsed.lines.findIndex((line, index) =>
    index > audio.lineIndex && index < end && /^a=rtpmap:/i.test(line));
  parsed.lines.splice(codecLineIndex < 0 ? end : codecLineIndex, 0, "a=rtpmap:0 PCMU/8000");
  return { sdp: parsed.lines.join("\r\n"), pcmuAdded: true };
}

function addBundleForTuya(sdp) {
  const parsed = parseMediaSections(sdp);
  const media = parsed.sections.filter((section) => section.port !== "0");
  if (media.length < 2 || parsed.lines.some((line) => line.startsWith("a=group:BUNDLE"))) {
    return { sdp, bundleAdded: false };
  }
  const mids = media.map((section) => section.mid);
  if (mids.some((mid) => typeof mid !== "string" || !mid)) {
    return { sdp, bundleAdded: false };
  }
  const firstMediaLine = parsed.sections[0]?.lineIndex;
  if (!Number.isInteger(firstMediaLine)) return { sdp, bundleAdded: false };
  parsed.lines.splice(firstMediaLine, 0, `a=group:BUNDLE ${mids.join(" ")}`);
  return { sdp: parsed.lines.join("\r\n"), bundleAdded: true };
}

function rejectAddedAudioInAnswer(answer, originalOffer) {
  const answerParts = parseMediaSections(answer);
  const answerAudio = answerParts.sections.find((section) => section.kind === "audio");
  const offerParts = parseMediaSections(originalOffer);
  const offerAudio = offerParts.sections.find((section) => section.kind === "audio");
  if (!answerAudio || !offerAudio) return answer;

  const end = answerParts.sections[answerAudio.index + 1]?.lineIndex ?? answerParts.lines.length;
  const offerFields = offerParts.lines[offerAudio.lineIndex].slice(2).trim().split(/\s+/);
  offerFields[1] = "0";
  const connection = answerParts.lines
    .slice(answerAudio.lineIndex + 1, end)
    .find((line) => line.startsWith("c="));
  const mid = offerAudio.mid || answerAudio.mid;
  const rejectedSection = [`m=${offerFields.join(" ")}`];
  if (connection) rejectedSection.push(connection);
  if (mid) rejectedSection.push(`a=mid:${mid}`);
  rejectedSection.push("a=inactive");
  answerParts.lines.splice(answerAudio.lineIndex, end - answerAudio.lineIndex, ...rejectedSection);

  const offerHasBundle = offerParts.lines.some((line) => line.startsWith("a=group:BUNDLE"));
  for (let index = answerParts.lines.length - 1; index >= 0; index--) {
    const line = answerParts.lines[index];
    if (!line.startsWith("a=group:BUNDLE")) continue;
    if (!offerHasBundle) {
      answerParts.lines.splice(index, 1);
      continue;
    }
    const mids = line.trim().split(/\s+/).slice(1).filter((value) => value !== mid);
    if (mids.length < 2) answerParts.lines.splice(index, 1);
    else answerParts.lines[index] = `a=group:BUNDLE ${mids.join(" ")}`;
  }
  return answerParts.lines.join("\r\n");
}

function alignH264ProfileToOffer(answer, offer) {
  const answerParts = parseMediaSections(answer);
  const offerParts = parseMediaSections(offer);
  const answerVideo = answerParts.sections.find((section) => section.kind === "video" && section.port !== "0");
  const offerVideo = offerParts.sections.find((section) => section.kind === "video" && section.port !== "0");
  if (!answerVideo || !offerVideo) return { sdp: answer, changed: false };
  const findH264 = (parsed, section) => {
    const end = parsed.sections[section.index + 1]?.lineIndex ?? parsed.lines.length;
    const lines = parsed.lines.slice(section.lineIndex + 1, end);
    for (const line of lines) {
      const match = /^a=rtpmap:(\d+)\s+H264\/90000\b/i.exec(line);
      if (!match) continue;
      const payload = match[1];
      const fmtpIndex = lines.findIndex((item) => new RegExp(`^a=fmtp:${payload}\\s+`, "i").test(item));
      if (fmtpIndex < 0) continue;
      const profile = /(?:^|;)\s*profile-level-id=([0-9a-f]{6})\b/i.exec(lines[fmtpIndex])?.[1]?.toLowerCase();
      const packetization = /(?:^|;)\s*packetization-mode=(\d+)/i.exec(lines[fmtpIndex])?.[1] || "0";
      if (profile) return { payload, lineIndex: section.lineIndex + 1 + fmtpIndex, profile, packetization };
    }
    return null;
  };
  const answerH264 = findH264(answerParts, answerVideo);
  const offerH264 = findH264(offerParts, offerVideo);
  if (!answerH264 || !offerH264 || answerH264.profile === offerH264.profile ||
      answerH264.packetization !== offerH264.packetization ||
      answerH264.profile.slice(0, 2) !== offerH264.profile.slice(0, 2) ||
      answerH264.profile.slice(4, 6) !== offerH264.profile.slice(4, 6)) {
    return { sdp: answer, changed: false };
  }
  answerParts.lines[answerH264.lineIndex] = answerParts.lines[answerH264.lineIndex].replace(
    /(profile-level-id\s*=\s*)[0-9a-f]{6}/i,
    (_match, prefix) => `${prefix}${offerH264.profile}`,
  );
  return {
    sdp: answerParts.lines.join("\r\n"),
    changed: true,
    from: answerH264.profile,
    to: offerH264.profile,
  };
}

function getDeviceIceTarget(sdp, hint) {
  if (hint && typeof hint.sdpMid === "string" && Number.isInteger(hint.sdpMLineIndex)) {
    return { sdpMid: hint.sdpMid, sdpMLineIndex: hint.sdpMLineIndex };
  }
  if (typeof sdp === "string" && sdp) {
    const parsed = parseMediaSections(sdp);
    const active = parsed.sections.filter((section) => section.port !== "0");
    const bundle = parsed.lines.find((line) => line.startsWith("a=group:BUNDLE"))
      ?.trim().split(/\s+/).slice(1) || [];
    const target = active.find((section) => section.mid && bundle.includes(section.mid)) ||
      active.find((section) => section.kind === "video") || active[0];
    if (target) {
      return {
        sdpMid: target.mid || String(target.index),
        sdpMLineIndex: target.index,
      };
    }
  }
  return { sdpMid: "0", sdpMLineIndex: 0 };
}

function summarizeIceServers(iceServers) {
  if (!iceServers || typeof iceServers !== "object") return { provided: false };
  const urls = Array.isArray(iceServers.urls) ? iceServers.urls : [];
  return {
    provided: true,
    urlSchemes: [...new Set(urls.filter((url) => typeof url === "string").map((url) => url.split(":", 1)[0].toLowerCase()))],
    hasUsername: typeof iceServers.username === "string" && Boolean(iceServers.username),
    hasPassword: typeof iceServers.password === "string" && Boolean(iceServers.password),
  };
}

async function smartThingsSessionId(streamId) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(streamId));
  return hex(new Uint8Array(digest)).slice(0, 32).toLowerCase();
}

async function tuyaWebRtcExchange(camera, webRtcConfig, tuyaToken, env, sessionId, type, message, expectedType) {
  const uid = await getTuyaCameraUid(camera, tuyaToken, env);
  const mqttConfig = await tuyaRequest("POST", "/v1.0/open-hub/access/config", {
    uid,
    link_id: "rme360",
    link_type: "mqtt",
    topics: "ipc",
  }, tuyaToken, env);
  const broker = parseTuyaMqttUrl(mqttConfig.url);
  const sourceTopic = mqttConfig.source_topic?.ipc;
  const sinkTemplate = mqttConfig.sink_topic?.ipc;
  const mqttUserId = typeof sourceTopic === "string" ? sourceTopic.split("/").filter(Boolean).at(-1) : "";
  const publishTopic = typeof sinkTemplate === "string"
    ? sinkTemplate.replace("moto_id", webRtcConfig.moto_id).replace("{device_id}", camera.device_id)
    : "";
  if (!uid || !mqttUserId || !publishTopic || !mqttConfig.client_id || !mqttConfig.username || !mqttConfig.password) {
    throw new Error("Tuya did not return complete MQTT signaling details");
  }

  const { connect } = await import("cloudflare:sockets");
  const socket = connect({ hostname: broker.hostname, port: broker.port }, {
    secureTransport: broker.secure ? "on" : "off",
  });
  await socket.opened;
  const writer = socket.writable.getWriter();
  const reader = new MqttPacketReader(socket.readable.getReader());
  const matching = [];
  let packetId = 1;
  const receivePublish = async (packet) => {
    const mqttMessage = decodeMqttPublish(packet);
    if (mqttMessage?.qos === 1) {
      await writer.write(mqttPacket(0x40, new Uint8Array([mqttMessage.packetId >> 8, mqttMessage.packetId & 0xff])));
    }
    if (!mqttMessage) return;
    let frame;
    try {
      frame = JSON.parse(mqttMessage.payload);
    } catch {
      return;
    }
    if (frame?.protocol !== 302 || frame?.data?.header?.sessionid !== sessionId) return;
    const data = frame.data;
    if (data.header.to && data.header.to !== mqttUserId) return;
    if (data.header.type === "answer" && typeof data.msg?.sdp === "string") {
      matching.push({ type: "answer", value: data.msg.sdp });
    } else if (data.header.type === "candidate" && typeof data.msg?.candidate === "string") {
      matching.push({ type: "candidate", value: normalizeTuyaCandidate(data.msg.candidate) });
    } else if (data.header.type === "disconnect") {
      matching.push({ type: "disconnect" });
    }
  };
  const readUntil = async (typeToFind, idToFind, timeoutMs) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const packet = await reader.readPacket(deadline - Date.now());
      if (packet.type === 3) {
        await receivePublish(packet);
        continue;
      }
      if (packet.type === typeToFind && (idToFind === undefined || mqttPacketId(packet) === idToFind)) {
        return packet;
      }
    }
    throw new Error("Tuya MQTT signaling timed out");
  };
  try {
    const connectPayload = concatBytes(
      mqttString("MQTT"),
      new Uint8Array([4, 0xc2, 0, 60]),
      mqttString(mqttConfig.client_id),
      mqttString(mqttConfig.username),
      mqttString(mqttConfig.password),
    );
    await writer.write(mqttPacket(0x10, connectPayload));
    const connack = await readUntil(2, undefined, 6000);
    if (connack.payload.length < 2 || connack.payload[1] !== 0) throw new Error("Tuya MQTT rejected the connection");

    const subscriptionId = packetId++;
    await writer.write(mqttPacket(0x82, concatBytes(
      new Uint8Array([subscriptionId >> 8, subscriptionId & 0xff]),
      mqttString(sourceTopic),
      new Uint8Array([1]),
    )));
    await readUntil(9, subscriptionId, 5000);

    const envelope = {
      protocol: 302,
      pv: "2.2",
      t: Math.floor(Date.now() / 1000),
      data: {
        header: {
          type,
          from: mqttUserId,
          to: camera.device_id,
          sub_dev_id: "",
          sessionid: sessionId,
          moto_id: webRtcConfig.moto_id,
        },
        msg: message,
      },
    };
    const publishId = packetId++;
    const publishPayload = concatBytes(
      mqttString(publishTopic),
      new Uint8Array([publishId >> 8, publishId & 0xff]),
      new TextEncoder().encode(JSON.stringify(envelope)),
    );
    await writer.write(mqttPacket(0x32, publishPayload));
    await readUntil(4, publishId, 5000);

    let answer;
    if (expectedType === "answer") {
      const answerDeadline = Date.now() + 5500;
      let lastMessageAt = Date.now();
      while (Date.now() < answerDeadline) {
        const timeout = Math.max(1, answer ? Math.min(900, answerDeadline - Date.now()) : answerDeadline - Date.now());
        let packet;
        try {
          packet = await reader.readPacket(timeout);
        } catch (error) {
          if (answer && /timed out/i.test(String(error?.message || error))) break;
          throw error;
        }
        if (packet.type === 3) {
          const before = matching.length;
          await receivePublish(packet);
          if (matching.length > before) lastMessageAt = Date.now();
          const answers = matching.filter((entry) => entry.type === "answer");
          const mediaAnswer = answers.findLast((entry) => hasActiveMediaSection(entry.value));
          if (mediaAnswer) {
            answer = mediaAnswer.value;
          } else if (!answer && answers.length) {
            answer = answers.at(-1).value;
          }
        }
        if (answer && Date.now() - lastMessageAt >= 750) break;
      }
      if (!answer) throw new Error("The camera did not answer the WebRTC offer");
    } else if (expectedType === "candidate") {
      const candidateDeadline = Date.now() + 1200;
      while (Date.now() < candidateDeadline) {
        try {
          const packet = await reader.readPacket(candidateDeadline - Date.now());
          if (packet.type === 3) await receivePublish(packet);
        } catch (error) {
          if (/timed out/i.test(String(error?.message || error))) break;
          throw error;
        }
      }
    }
    return {
      answer,
      answerMessages: matching.filter((entry) => entry.type === "answer").map((entry) => entry.value),
      candidates: matching.filter((entry) => entry.type === "candidate").map((entry) => entry.value).filter(Boolean),
    };
  } finally {
    try {
      await writer.write(mqttPacket(0xe0, new Uint8Array(0)));
    } catch {
      // The broker may already have closed the socket.
    }
    try {
      await socket.close();
    } catch {
      // Closing is best effort after the signaling exchange.
    }
  }
}

async function getTuyaCameraUid(camera, accessToken, env) {
  if (typeof camera.tuya_uid === "string" && camera.tuya_uid) return camera.tuya_uid;
  if (typeof camera.uid === "string" && camera.uid) return camera.uid;
  const deviceId = encodeURIComponent(camera.device_id);
  const result = await tuyaRequest("GET", `/v1.0/devices/${deviceId}`, null, accessToken, env);
  if (typeof result?.uid !== "string" || !result.uid) throw new Error("Tuya device has no linked user id");
  return result.uid;
}

async function getTuyaWebRtcConfig(camera, accessToken, env) {
  const deviceId = encodeURIComponent(camera.device_id);
  const result = await tuyaRequest("GET", `/v1.0/devices/${deviceId}/webrtc-configs`, null, accessToken, env);
  const motoId = result?.moto_id || result?.p2p_config?.moto_id;
  const auth = result?.auth || result?.p2p_config?.auth;
  if (result?.supports_webrtc !== true || typeof motoId !== "string" || !motoId ||
      typeof auth !== "string" || !auth || !Array.isArray(result?.p2p_config?.ices)) {
    throw new Error("Tuya did not return complete WebRTC camera settings");
  }
  return { ...result, moto_id: motoId, auth };
}

function parseTuyaMqttUrl(value) {
  const url = new URL(value);
  if (!["ssl:", "mqtts:", "mqtt:", "tcp:"].includes(url.protocol) || !url.hostname) {
    throw new Error("Tuya returned an unsupported MQTT address");
  }
  return {
    hostname: url.hostname,
    port: Number(url.port) || (url.protocol === "ssl:" || url.protocol === "mqtts:" ? 8883 : 1883),
    secure: url.protocol === "ssl:" || url.protocol === "mqtts:",
  };
}

function normalizeTuyaCandidate(candidate) {
  return candidate.replace(/^a=/, "").trim().replace(/\r?\n$/, "");
}

class MqttPacketReader {
  constructor(reader) {
    this.reader = reader;
    this.buffer = new Uint8Array(0);
  }

  async readPacket(timeoutMs) {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    while (Date.now() < deadline) {
      const packet = this.takePacket();
      if (packet) return packet;
      const pending = this.reader.read();
      let timer;
      let result;
      try {
        result = await Promise.race([
          pending,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("MQTT packet timed out")), Math.max(1, deadline - Date.now()));
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
      if (result.done) throw new Error("Tuya MQTT connection closed");
      this.buffer = concatBytes(this.buffer, result.value);
    }
    throw new Error("MQTT packet timed out");
  }

  takePacket() {
    if (this.buffer.length < 2) return null;
    let multiplier = 1;
    let remainingLength = 0;
    let offset = 1;
    let digit;
    let count = 0;
    do {
      if (offset >= this.buffer.length || count++ > 3) return null;
      digit = this.buffer[offset++];
      remainingLength += (digit & 0x7f) * multiplier;
      multiplier *= 128;
    } while (digit & 0x80);
    if (this.buffer.length < offset + remainingLength) return null;
    const packet = {
      header: this.buffer[0],
      type: this.buffer[0] >> 4,
      flags: this.buffer[0] & 0x0f,
      payload: this.buffer.slice(offset, offset + remainingLength),
    };
    this.buffer = this.buffer.slice(offset + remainingLength);
    return packet;
  }
}

function mqttPacket(header, payload) {
  return concatBytes(new Uint8Array([header]), mqttRemainingLength(payload.length), payload);
}

function mqttRemainingLength(length) {
  const encoded = [];
  do {
    let digit = length % 128;
    length = Math.floor(length / 128);
    if (length > 0) digit |= 0x80;
    encoded.push(digit);
  } while (length > 0);
  return new Uint8Array(encoded);
}

function mqttString(value) {
  const bytes = new TextEncoder().encode(value);
  return concatBytes(new Uint8Array([bytes.length >> 8, bytes.length & 0xff]), bytes);
}

function concatBytes(...arrays) {
  const size = arrays.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(size);
  let offset = 0;
  for (const part of arrays) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function mqttPacketId(packet) {
  return packet.payload.length >= 2 ? (packet.payload[0] << 8) | packet.payload[1] : undefined;
}

function decodeMqttPublish(packet) {
  const payload = packet.payload;
  if (payload.length < 2) return null;
  const topicLength = (payload[0] << 8) | payload[1];
  const qos = (packet.flags >> 1) & 0x03;
  const packetIdOffset = 2 + topicLength;
  if (payload.length < packetIdOffset + (qos > 0 ? 2 : 0)) return null;
  const packetId = qos > 0 ? (payload[packetIdOffset] << 8) | payload[packetIdOffset + 1] : 0;
  const bodyOffset = packetIdOffset + (qos > 0 ? 2 : 0);
  return {
    qos,
    packetId,
    payload: new TextDecoder().decode(payload.slice(bodyOffset)),
  };
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
