# Hash Harbor showcase

This folder is the standalone marketing and documentation site for Hash Harbor.
It is static, self-contained, and separate from the embedded local app in the
parent `web/` directory.

## Preview locally

From the repository root:

```bash
npm run showcase
```

Open <http://localhost:4173>.

Use a different port when needed:

```bash
HASH_HARBOR_SHOWCASE_PORT=8080 npm run showcase
```

## Cloudflare Pages

Production: <https://hash-harbor.apoorvdarshan.com>

The Cloudflare Pages project `hash-harbor` is connected directly to
`apoorvdarshan/hash-harbor` on GitHub:

- Production branch: `main`
- Build command: none
- Build output directory: `web/showcase`
- Build watch include path: `web/showcase/*`
- Preview deployments: enabled for non-production branches

Cloudflare automatically deploys commits that change this directory. Commits
that only change files outside `web/showcase/` are skipped. No GitHub Actions
workflow, repository secret, server function, or torrent backend is required.
The published page explains and links to the local `npx hash-harbor`
application; torrent transfers still run on each user’s computer.

## Assets

The screenshots in `assets/` are copies of the masters in
`marketing/screenshots/`. The streaming screenshot uses the official WebTorrent
Sintel test torrent.

Sintel © Blender Foundation | durian.blender.org — CC BY 3.0.
