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

## Cloudflare Pages (later)

When the site is ready to deploy, use:

- Framework preset: `None`
- Build command: leave empty
- Build output directory: `web/showcase`

The site does not need server functions, environment variables, or a torrent
backend. The published page explains and links to the local `npx hash-harbor`
application; torrent transfers still run on each user’s computer.

## Assets

The screenshots in `assets/` are copies of the masters in
`marketing/screenshots/`. The streaming screenshot uses the official WebTorrent
Sintel test torrent.

Sintel © Blender Foundation | durian.blender.org — CC BY 3.0.
