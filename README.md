# Hash Harbor

Hash Harbor is a local-only torrent inspector, streamer, and downloader. Paste a
BitTorrent v1 magnet link or info hash, wait for metadata, and then play
supported media or download individual files.

## Run

Requirements:

- Go 1.25 or newer
- FFmpeg (optional, used for MKV/AVI browser playback)

```bash
go run .
```

Open <http://127.0.0.1:3000>.

Downloaded pieces are cached under `work/torrents/`. Torrent metadata is cached
under `work/metadata/`.

Torrent peers can see your public IP address. Use Hash Harbor only for content
you have permission to access and share.
