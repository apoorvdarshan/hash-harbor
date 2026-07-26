const elements = {
  form: document.querySelector("#torrentForm"),
  source: document.querySelector("#sourceInput"),
  permission: document.querySelector("#permissionInput"),
  open: document.querySelector("#openButton"),
  stop: document.querySelector("#stopButton"),
  theme: document.querySelector("#themeButton"),
  error: document.querySelector("#formError"),
  empty: document.querySelector("#emptyState"),
  view: document.querySelector("#torrentView"),
  sessionStatus: document.querySelector("#sessionStatus"),
  torrentName: document.querySelector("#torrentName"),
  torrentHash: document.querySelector("#torrentHash"),
  percent: document.querySelector("#progressPercent"),
  progress: document.querySelector("#progressBar"),
  peers: document.querySelector("#peerCount"),
  speed: document.querySelector("#downloadSpeed"),
  downloaded: document.querySelector("#downloadedSize"),
  total: document.querySelector("#totalSize"),
  fileCount: document.querySelector("#fileCount"),
  notice: document.querySelector("#notice"),
  noticeTitle: document.querySelector("#noticeTitle"),
  noticeBody: document.querySelector("#noticeBody"),
  stage: document.querySelector("#mediaStage"),
  mediaTitle: document.querySelector("#mediaTitle"),
  mediaShell: document.querySelector("#mediaShell"),
  mediaMessage: document.querySelector("#mediaMessage"),
  closeMedia: document.querySelector("#closeMediaButton"),
  manifest: document.querySelector("#manifest"),
  manifestSummary: document.querySelector("#manifestSummary"),
  fileList: document.querySelector("#fileList"),
};

const state = {
  id: "",
  openedAt: 0,
  pollTimer: null,
  filesSignature: "",
};

const videoExtensions = new Set(["mp4", "m4v", "webm", "mov", "mkv", "avi"]);
const transcodeExtensions = new Set(["mkv", "avi"]);
const audioExtensions = new Set(["mp3", "m4a", "aac", "flac", "ogg", "wav"]);
const imageExtensions = new Set(["jpg", "jpeg", "png", "gif", "webp", "avif"]);
const appExtensions = new Set(["dmg", "pkg", "exe", "msi", "app", "apk", "deb", "rpm"]);
const archiveExtensions = new Set(["zip", "rar", "7z", "tar", "gz"]);

function escapeHTML(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function extensionOf(filename) {
  const parts = String(filename).split(".");
  return parts.length > 1 ? parts.pop().toLowerCase() : "";
}

function fileKind(filename) {
  const extension = extensionOf(filename);
  if (videoExtensions.has(extension)) return "video";
  if (audioExtensions.has(extension)) return "audio";
  if (imageExtensions.has(extension)) return "image";
  if (appExtensions.has(extension)) return "app";
  if (archiveExtensions.has(extension)) return "archive";
  return "file";
}

function formatBytes(bytes, decimals = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value.toFixed(unit === 0 ? 0 : decimals)} ${units[unit]}`;
}

function statusLabel(status) {
  const labels = {
    "finding metadata": "Finding metadata",
    "finding peers": "Finding peers",
    streaming: "Streaming",
    complete: "Download complete",
    ready: "Ready",
    error: "Error",
  };
  return labels[status] || status || "Working";
}

async function fetchJSON(url, options) {
  const response = await fetch(url, options);
  let body = {};
  try {
    body = await response.json();
  } catch {
    body = {};
  }
  if (!response.ok) {
    throw new Error(body.error || `Request failed with HTTP ${response.status}.`);
  }
  return body;
}

function setBusy(busy) {
  elements.open.disabled = busy || Boolean(state.id);
  elements.source.disabled = Boolean(state.id);
  elements.permission.disabled = Boolean(state.id);
  elements.open.querySelector("span").textContent = busy ? "Opening…" : state.id ? "Torrent open" : "Open torrent";
}

function showError(message) {
  elements.error.textContent = message || "";
}

function setNotice(title, body, visible = true) {
  elements.noticeTitle.textContent = title;
  elements.noticeBody.textContent = body;
  elements.notice.hidden = !visible;
}

function clearNotice() {
  elements.notice.hidden = true;
}

function renderFiles(files) {
  const signature = files.map((file) => `${file.index}:${file.downloaded}`).join("|");
  if (signature === state.filesSignature) return;
  state.filesSignature = signature;

  elements.fileList.innerHTML = files
    .map((file) => {
      const kind = fileKind(file.name);
      const extension = extensionOf(file.name) || kind;
      const progress = Math.max(0, Math.min(100, file.progress * 100));
      const playable = ["video", "audio", "image"].includes(kind);
      const streamButton = playable
        ? `<button class="play-action" type="button" data-play="${file.index}" data-name="${escapeHTML(file.name)}" data-kind="${kind}">Play</button>`
        : "";
      const downloadURL = `/api/torrents/${state.id}/files/${file.index}/download`;
      return `
        <article class="file-row">
          <span class="file-type">${escapeHTML(extension.slice(0, 4))}</span>
          <div class="file-name">
            <strong title="${escapeHTML(file.path)}">${escapeHTML(file.name)}</strong>
            <small>${escapeHTML(file.path)}</small>
          </div>
          <div class="file-progress">
            <div><i style="width:${progress.toFixed(2)}%"></i></div>
            <span>${progress.toFixed(0)}% · ${formatBytes(file.length)}</span>
          </div>
          <div class="file-actions">
            ${streamButton}
            <a href="${downloadURL}" download>Download</a>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderSession(session) {
  state.id = session.id;
  elements.empty.hidden = true;
  elements.view.hidden = false;
  elements.stop.hidden = false;
  setBusy(false);

  const percent = Math.max(0, Math.min(100, (session.progress || 0) * 100));
  elements.sessionStatus.textContent = statusLabel(session.status);
  elements.torrentName.textContent = session.name || "Reading metadata…";
  elements.torrentHash.textContent = session.id;
  elements.percent.textContent = `${percent.toFixed(percent > 0 && percent < 1 ? 1 : 0)}%`;
  elements.progress.style.width = `${percent}%`;
  elements.peers.textContent = String(session.peers || 0);
  elements.speed.textContent = `${formatBytes(session.downloadSpeed || 0)}/s`;
  elements.downloaded.textContent = formatBytes(session.downloaded || 0);
  elements.total.textContent = `of ${formatBytes(session.length || 0)}`;
  elements.fileCount.textContent = session.metadataReady ? String(session.files.length) : "—";

  if (session.error) {
    setNotice("Torrent error", session.error);
  } else if (!session.metadataReady && session.peers === 0 && Date.now() - state.openedAt > 12_000) {
    setNotice(
      "No metadata source yet",
      "Peer discovery is still running. A complete magnet with trackers and at least one reachable seeder will resolve faster.",
    );
  } else if (session.status === "finding peers" && session.peers === 0) {
    setNotice(
      "Waiting for file pieces",
      "The player or download is ready, but no connected peer currently has data to send. Discovery continues automatically.",
    );
  } else {
    clearNotice();
  }

  if (session.metadataReady) {
    elements.manifest.hidden = false;
    elements.manifestSummary.textContent = `${session.files.length} files · ${formatBytes(session.length)}`;
    renderFiles(session.files);
  } else {
    elements.manifest.hidden = true;
  }
}

async function pollSession() {
  if (!state.id) return;
  try {
    const session = await fetchJSON(`/api/torrents/${state.id}`);
    renderSession(session);
    showError("");
  } catch (error) {
    if (String(error.message).includes("not found")) {
      resetUI();
      showError("The previous torrent session ended. Open the magnet again.");
    } else {
      setNotice("Local service unavailable", error.message);
    }
  }
}

function startPolling() {
  window.clearInterval(state.pollTimer);
  state.pollTimer = window.setInterval(pollSession, 1_000);
}

function closeMedia() {
  const media = elements.mediaShell.querySelector("video, audio");
  if (media) {
    media.pause();
    media.removeAttribute("src");
    media.load();
  }
  elements.mediaShell.innerHTML = "";
  elements.mediaMessage.textContent = "";
  elements.stage.hidden = true;
}

function resetUI() {
  window.clearInterval(state.pollTimer);
  closeMedia();
  state.id = "";
  state.openedAt = 0;
  state.filesSignature = "";
  elements.empty.hidden = false;
  elements.view.hidden = true;
  elements.stop.hidden = true;
  elements.manifest.hidden = true;
  elements.fileList.innerHTML = "";
  setBusy(false);
}

function openMedia(index, name, kind) {
  closeMedia();
  const extension = extensionOf(name);
  const route = kind === "video" && transcodeExtensions.has(extension) ? "transcode" : "stream";
  const url = `/api/torrents/${state.id}/files/${index}/${route}`;
  elements.stage.hidden = false;
  elements.mediaTitle.textContent = name;
  elements.mediaMessage.textContent =
    route === "transcode"
      ? "Converting the container for browser playback while torrent pieces arrive…"
      : "Connecting to peers and buffering the first playable pieces…";

  let media;
  if (kind === "image") {
    media = document.createElement("img");
    media.alt = name;
    media.addEventListener("load", () => {
      elements.mediaMessage.textContent = "Image ready.";
    });
  } else {
    media = document.createElement(kind);
    media.controls = true;
    media.preload = "metadata";
    media.playsInline = true;
    media.addEventListener("waiting", () => {
      elements.mediaMessage.textContent = "Buffering—waiting for torrent pieces from a peer…";
    });
    media.addEventListener("canplay", () => {
      elements.mediaMessage.textContent = "Ready to play.";
    });
    media.addEventListener("playing", () => {
      elements.mediaMessage.textContent = "Playing. Native controls include seeking, volume, and fullscreen.";
    });
    media.addEventListener("stalled", () => {
      elements.mediaMessage.textContent = "The stream stalled because the next pieces have not arrived yet.";
    });
  }

  media.addEventListener("error", () => {
    const detail = media.error?.message || "The browser could not read this stream.";
    elements.mediaMessage.textContent = `${detail} Check peer count or download the original file instead.`;
  });
  media.src = url;
  elements.mediaShell.append(media);
  elements.stage.scrollIntoView({ behavior: "smooth", block: "nearest" });

  if (kind !== "image") {
    media.play().catch(() => {
      elements.mediaMessage.textContent = "Press play when enough torrent data has buffered.";
    });
  }
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.id) return;
  showError("");
  setBusy(true);

  try {
    const session = await fetchJSON("/api/torrents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        source: elements.source.value,
        permissionConfirmed: elements.permission.checked,
      }),
    });
    state.openedAt = Date.now();
    renderSession(session);
    startPolling();
  } catch (error) {
    showError(error.message);
  } finally {
    setBusy(false);
  }
});

elements.stop.addEventListener("click", async () => {
  if (!state.id) return;
  const currentID = state.id;
  elements.stop.disabled = true;
  elements.stop.textContent = "Stopping…";
  try {
    await fetchJSON(`/api/torrents/${currentID}`, { method: "DELETE" });
    resetUI();
    elements.source.select();
  } catch (error) {
    showError(error.message);
  } finally {
    elements.stop.disabled = false;
    elements.stop.textContent = "Stop & clear";
  }
});

elements.fileList.addEventListener("click", (event) => {
  const button = event.target.closest("[data-play]");
  if (!button) return;
  openMedia(Number(button.dataset.play), button.dataset.name, button.dataset.kind);
});

elements.closeMedia.addEventListener("click", closeMedia);

elements.theme.addEventListener("click", () => {
  const current = document.documentElement.dataset.theme || "system";
  const next = current === "system" ? "dark" : current === "dark" ? "light" : "system";
  if (next === "system") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = next;
  }
  localStorage.setItem("hash-harbor-theme", next);
  elements.theme.title = `Theme: ${next}`;
});

async function initialize() {
  const savedTheme = localStorage.getItem("hash-harbor-theme") || "system";
  if (savedTheme !== "system") document.documentElement.dataset.theme = savedTheme;
  elements.theme.title = `Theme: ${savedTheme}`;

  try {
    const body = await fetchJSON("/api/torrents");
    const session = body.torrents?.[0];
    if (session) {
      state.openedAt = Date.now();
      renderSession(session);
      startPolling();
    }
  } catch (error) {
    showError(`Hash Harbor could not reach its local service: ${error.message}`);
  }
}

initialize();
