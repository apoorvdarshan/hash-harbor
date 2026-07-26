export const WEBRTC_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
];

export function normalizeSource(value) {
  let source = String(value || "").trim();
  if (!source) throw new Error("Paste a magnet link or BitTorrent v1 info hash.");
  if (/^[a-f0-9]{40}$/i.test(source)) {
    source = `magnet:?xt=urn:btih:${source.toLowerCase()}`;
  } else if (/^[a-z2-7]{32}$/i.test(source)) {
    source = `magnet:?xt=urn:btih:${source.toUpperCase()}`;
  }
  if (!source.toLowerCase().startsWith("magnet:?")) {
    throw new Error("Browser-only mode accepts a magnet link or BitTorrent v1 info hash.");
  }

  source = `magnet:?${source.slice(source.indexOf("?") + 1)}`;
  source = source.replace(/([?&]xt=)urn%3Abtih%3A/gi, "$1urn:btih:");
  const magnet = new URL(source);
  const hasInfoHash = magnet.searchParams
    .getAll("xt")
    .some((identifier) =>
      /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(identifier),
    );
  if (!hasInfoHash) {
    throw new Error("This magnet does not contain a valid BitTorrent v1 info hash.");
  }

  const hasWebRTCTracker = magnet.searchParams
    .getAll("tr")
    .some((tracker) => tracker.toLowerCase().startsWith("wss://"));
  if (!hasWebRTCTracker) {
    const separator = source.endsWith("?") || source.endsWith("&") ? "" : "&";
    source +=
      separator +
      WEBRTC_TRACKERS.map((tracker) => `tr=${encodeURIComponent(tracker)}`).join("&");
  }
  return source;
}
