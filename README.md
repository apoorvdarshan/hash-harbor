# Hash Harbor

Hash Harbor is a static, browser-only torrent inspector, streamer, and
downloader. Paste a BitTorrent v1 magnet link or info hash, wait for metadata,
and then play supported media or save individual files. WebTorrent runs inside
the tab; the hosted page does not relay or store torrent data.

## Browser-only development

Requirements:

- Node.js 20.19 or newer (or Node.js 22.12+)
- A browser with service workers and WebRTC

```bash
npm install
npm run dev
```

Open <http://127.0.0.1:3000>.

`npm run build` creates a deployable static site in `dist/`. The page stores
pieces in the browser's origin-private file system by default. In browsers that
support the File System Access API, **Choose download folder** lets Hash Harbor
write directly to a folder selected by the user.

Browser-only WebTorrent can connect to WebRTC peers and CORS-enabled webseeds.
It cannot connect to ordinary BitTorrent DHT, UDP, or TCP peers, so some magnets
that work in desktop clients will not work in a browser.

## Optional native fallback

The original Go helper remains available for local native BitTorrent support:

```bash
go run .
```

It caches torrent data under `work/` and can use FFmpeg for browser-incompatible
video containers.

Torrent peers can see your public IP address. Use Hash Harbor only for content
you have permission to access and share.
