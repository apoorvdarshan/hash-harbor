import { defineConfig } from "vite";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const serviceWorkerPath = fileURLToPath(
  new URL("./node_modules/webtorrent/dist/sw.min.js", import.meta.url),
);

export default defineConfig({
  root: "web",
  plugins: [
    {
      name: "webtorrent-service-worker",
      configureServer(server) {
        server.middlewares.use("/sw.min.js", (_request, response) => {
          response.setHeader("Content-Type", "text/javascript; charset=utf-8");
          response.setHeader("Cache-Control", "no-store");
          response.end(readFileSync(serviceWorkerPath));
        });
      },
      generateBundle() {
        this.emitFile({
          type: "asset",
          fileName: "sw.min.js",
          source: readFileSync(serviceWorkerPath),
        });
      },
    },
  ],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
  },
  server: {
    strictPort: true,
  },
  preview: {
    strictPort: true,
  },
});
