import assert from "node:assert/strict";
import test from "node:test";
import parseTorrent from "parse-torrent";

import { normalizeSource, WEBRTC_TRACKERS } from "../web/torrent-source.js";

const UPPERCASE_HASH = "28EBD2BCA487E1EA0AC95E8BEA5BB44FFF2CAC42";

test("normalizes an uppercase v1 hash without encoding the xt URN", async () => {
  const source = normalizeSource(UPPERCASE_HASH);

  assert.match(source, /^magnet:\?xt=urn:btih:28ebd2bc/);
  assert.doesNotMatch(source, /xt=urn%3A/i);
  for (const tracker of WEBRTC_TRACKERS) {
    assert.ok(new URL(source).searchParams.getAll("tr").includes(tracker));
  }

  const parsed = await parseTorrent(source);
  assert.equal(parsed.infoHash, UPPERCASE_HASH.toLowerCase());
});

test("does not rewrite a magnet that already has a WebRTC tracker", () => {
  const source =
    `magnet:?xt=urn:btih:${UPPERCASE_HASH}` +
    "&tr=wss%3A%2F%2Ftracker.example";

  assert.equal(normalizeSource(source), source);
});

test("rejects a magnet without a BitTorrent v1 info hash", () => {
  assert.throws(
    () => normalizeSource("magnet:?dn=missing-hash"),
    /does not contain a valid BitTorrent v1 info hash/,
  );
});
