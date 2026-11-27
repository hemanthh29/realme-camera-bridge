import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Test private helpers from the single-file Worker without changing its runtime exports.
const worker = await readFile(new URL("./worker/index.js", import.meta.url), "utf8");
const source = worker + "\nexport { embedTuyaCandidatesInVideoSdp, summarizeSdp };";
const { embedTuyaCandidatesInVideoSdp, summarizeSdp } = await import(
  "data:text/javascript;base64," + Buffer.from(source).toString("base64")
);

const crlf = "\r\n";
const media = [
  "v=0", "o=- 1 1 IN IP4 127.0.0.1", "s=-", "t=0 0",
  "m=audio 0 UDP/TLS/RTP/SAVPF 111", "c=IN IP4 0.0.0.0", "a=mid:0", "a=inactive",
  "m=video 9 UDP/TLS/RTP/SAVPF 96", "c=IN IP4 0.0.0.0", "a=mid:1", "a=sendonly",
  "a=rtpmap:96 H264/90000",
];
const host = "candidate:1 1 UDP 2113937151 192.168.23.4 49152 typ host";
const relay = "candidate:2 1 udp 1677734911 203.0.113.5 51234 typ relay raddr 192.168.23.4 rport 49152";
const end = "a=end-of-candidates";

for (const [name, separator, suffix] of [
  ["CRLF", crlf, crlf],
  ["LF", "\n", "\n"],
  ["missing final newline", crlf, ""],
]) {
  test(`embedding candidates in the last video section of a ${name} answer`, () => {
    const answer = media.join(separator) + suffix;
    const result = embedTuyaCandidatesInVideoSdp(answer, ["a=" + host + crlf, relay, host]);
    assert.equal(result.targetMid, "1");
    assert.equal(result.targetMLineIndex, 1);
    assert.equal(result.addedCount, 2);
    assert.equal(result.sdp, [...media, "a=" + host, "a=" + relay, end, ""].join(crlf));
  });
}

test("inserting before the video end marker preserves the next media section", () => {
  const data = ["m=application 9 UDP/DTLS/SCTP webrtc-datachannel", "a=mid:2", "a=sctp-port:5000"];
  const answer = [...media, "a=" + host, end, ...data, ""].join(crlf);
  const result = embedTuyaCandidatesInVideoSdp(answer, [host, relay]);
  assert.equal(result.addedCount, 1);
  assert.equal(result.sdp, [...media, "a=" + host, "a=" + relay, end, ...data, ""].join(crlf));
});

test("a candidate can only add a single SDP field", () => {
  const answer = media.join(crlf) + crlf;
  const result = embedTuyaCandidatesInVideoSdp(answer, [host + crlf + "a=inactive", relay]);
  assert.equal(result.sdp, [...media, "a=" + relay, end, ""].join(crlf));
});

test("candidate diagnostics report the endpoint and redact local addresses", () => {
  const mdns = "candidate:3 1 UDP 2113937151 camera.local 49154 typ host";
  const answer = [...media, "a=" + host, "a=" + mdns, "a=" + relay, end, ""].join(crlf);
  const summary = summarizeSdp(answer);
  assert.deepEqual(summary.candidateEndpoints, [
    { type: "host", protocol: "udp", address: "private", port: 49152 },
    { type: "host", protocol: "udp", address: "mdns", port: 49154 },
    { type: "relay", protocol: "udp", address: "203.0.113.5", port: 51234 },
  ]);
  assert.doesNotMatch(JSON.stringify(summary), /192\.168\.23\.4|camera\.local/);
  assert.equal(summary.hasBlankLines, false);
  assert.equal(summary.endsWithCrlf, true);
  const malformed = summarizeSdp([...media, "", "a=" + host, end].join(crlf));
  assert.equal(malformed.hasBlankLines, true);
  assert.equal(malformed.endsWithCrlf, false);
});
