# Hash Harbor

Hash Harbor is a local-only torrent inspector, streamer, and downloader. Paste a
BitTorrent v1 magnet link or info hash, wait for metadata, and then play
supported media or download individual files. The native torrent engine runs on
your computer and binds only to localhost.

## Run with npx

After the first tagged release:

```bash
npx hash-harbor
```

The launcher downloads the matching checksum-verified native binary, starts it
at the saved address, and opens the browser. The default permanent address is
<http://localhost:3210>.

Install the macOS start-at-login service once to keep that bookmark available
after restarts:

```bash
npx hash-harbor install-service
```

Useful commands:

```bash
npx hash-harbor status
npx hash-harbor open
npx hash-harbor config --port 3210
npx hash-harbor start-service
npx hash-harbor stop-service
npx hash-harbor uninstall-service
```

The port can also be changed from the settings panel in the web interface. Hash
Harbor validates the new port, saves it, restarts its HTTP listener, and
redirects the browser. It never silently switches to another port, so bookmarks
remain predictable.

Configuration, service logs, and torrent data live under
`~/Library/Application Support/Hash Harbor/` on macOS. Uninstalling the service
keeps downloads and settings.

## Run from source

Requirements:

- Go 1.25 or newer
- FFmpeg (optional, used for MKV/AVI browser playback)

```bash
go run .
```

Open <http://localhost:3210>.

For local launcher development, build the engine and point the npm CLI at it:

```bash
go build -o dist/hash-harbor-dev .
HASH_HARBOR_BINARY="$PWD/dist/hash-harbor-dev" node bin/hash-harbor.js
```

## Automated releases

Nothing publishes from ordinary branch pushes. A semantic version tag triggers
the release workflow:

```bash
git tag v0.1.0
git push origin v0.1.0
```

The workflow runs Go and Node tests, builds native binaries for macOS, Linux,
and Windows on Intel and ARM, creates SHA-256 checksums, publishes a GitHub
Release, changes the npm package version to match the tag, and publishes
`hash-harbor` to npm. GitHub Actions requires the `NPM_TOKEN` repository secret.
The repository must be public before the first tag so npm users can download the
GitHub Release binaries without a GitHub login.

Torrent peers can see your public IP address. Use Hash Harbor only for content
you have permission to access and share.
