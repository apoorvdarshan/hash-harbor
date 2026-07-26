import WebTorrent from "webtorrent/dist/webtorrent.min.js";

const WEBRTC_TRACKERS = [
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.btorrent.xyz",
];

const LEGAL_DEMO =
  "magnet:?xt=urn:btih:08ada5a7a6183aae1e09d831df6748d566095a10&dn=Sintel&tr=wss%3A%2F%2Ftracker.openwebtorrent.com&tr=wss%3A%2F%2Ftracker.btorrent.xyz&ws=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2F&xs=https%3A%2F%2Fwebtorrent.io%2Ftorrents%2Fsintel.torrent";

const elements = {
  form: document.querySelector("#torrentForm"),
  source: document.querySelector("#sourceInput"),
  permission: document.querySelector("#permissionInput"),
  open: document.querySelector("#openButton"),
  stop: document.querySelector("#stopButton"),
  theme: document.querySelector("#themeButton"),
  folder: document.querySelector("#folderButton"),
  demo: document.querySelector("#demoButton"),
  storage: document.querySelector("#storageStatus"),
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
  client: null,
  torrent: null,
  directory: null,
  engineReady: false,
  openedAt: 0,
  updateTimer: null,
  filesSignature: "",
  activeFile: null,
  activeAction: "",
  downloadIndexes: new Set(),
  lastNoPeersAt: 0,
};

const playableVideoExtensions = new Set(["mp4", "m4v", "webm", "mov"]);
const videoExtensions = new Set([...playableVideoExtensions, "mkv", "avi"]);
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

function isPlayable(filename) {
  const extension = extensionOf(filename);
  return (
    playableVideoExtensions.has(extension) ||
    audioExtensions.has(extension) ||
    imageExtensions.has(extension)
  );
}

function formatBytes(bytes, decimals = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value.toFixed(unit === 0 ? 0 : decimals)} ${units[unit]}`;
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

function setBusy(busy) {
  const active = Boolean(state.torrent);
  elements.open.disabled = busy || active || !state.engineReady;
  elements.source.disabled = active;
  elements.permission.disabled = active;
  elements.folder.disabled = active || !("showDirectoryPicker" in window);
  elements.demo.disabled = active;
  elements.open.querySelector("span").textContent = busy
    ? "Opening…"
    : active
      ? "Torrent open"
      : "Open torrent";
}

function normalizeSource(value) {
  let source = String(value || "").trim();
  if (!source) throw new Error("Paste a magnet link or BitTorrent v1 info hash.");
  if (/^[a-f0-9]{40}$/i.test(source) || /^[a-z2-7]{32}$/i.test(source)) {
    source = `magnet:?xt=urn:btih:${source}`;
  }
  if (!source.toLowerCase().startsWith("magnet:?")) {
    throw new Error("Browser-only mode accepts a magnet link or BitTorrent v1 info hash.");
  }

  const magnet = new URL(source);
  const hasInfoHash = magnet.searchParams
    .getAll("xt")
    .some((value) => /^urn:btih:(?:[a-f0-9]{40}|[a-z2-7]{32})$/i.test(value));
  if (!hasInfoHash) {
    throw new Error("This magnet does not contain a valid BitTorrent v1 info hash.");
  }

  const hasWebRTCTracker = magnet.searchParams
    .getAll("tr")
    .some((tracker) => tracker.toLowerCase().startsWith("wss://"));
  if (!hasWebRTCTracker) {
    WEBRTC_TRACKERS.forEach((tracker) => magnet.searchParams.append("tr", tracker));
  }
  return magnet.toString();
}

function torrentStatus(torrent) {
  if (!torrent.metadata || !torrent.files.length) return "Finding metadata";
  if (torrent.progress >= 1) return "Complete";
  if (state.activeAction) return state.activeAction;
  return "Ready in browser";
}

function renderFiles(files) {
  const signature = files
    .map((file, index) => `${index}:${Math.round(file.downloaded)}:${state.downloadIndexes.has(index)}`)
    .join("|");
  if (signature === state.filesSignature) return;
  state.filesSignature = signature;

  elements.fileList.innerHTML = files
    .map((file, index) => {
      const kind = fileKind(file.name);
      const extension = extensionOf(file.name) || kind;
      const progress = Math.max(0, Math.min(100, file.progress * 100));
      const playButton = isPlayable(file.name)
        ? `<button class="play-action" type="button" data-play="${index}">Play</button>`
        : "";
      const unsupportedVideo =
        kind === "video" && !isPlayable(file.name)
          ? `<small>Browser cannot transcode this container</small>`
          : "";
      const saving = state.downloadIndexes.has(index);

      return `
        <article class="file-row">
          <span class="file-type">${escapeHTML(extension.slice(0, 4))}</span>
          <div class="file-name">
            <strong title="${escapeHTML(file.path)}">${escapeHTML(file.name)}</strong>
            <small>${escapeHTML(file.path)}</small>
            ${unsupportedVideo}
          </div>
          <div class="file-progress">
            <div><i style="width:${progress.toFixed(2)}%"></i></div>
            <span>${progress.toFixed(0)}% · ${formatBytes(file.length)}</span>
          </div>
          <div class="file-actions">
            ${playButton}
            <button type="button" data-save="${index}" ${saving ? "disabled" : ""}>
              ${saving ? "Saving…" : state.directory ? "Download" : "Save file"}
            </button>
          </div>
        </article>
      `;
    })
    .join("");
}

function renderTorrent() {
  const torrent = state.torrent;
  if (!torrent || torrent.destroyed) return;

  elements.empty.hidden = true;
  elements.view.hidden = false;
  elements.stop.hidden = false;
  setBusy(false);

  const metadataReady = Boolean(torrent.metadata && torrent.files.length);
  const progress = Math.max(0, Math.min(100, (torrent.progress || 0) * 100));
  elements.sessionStatus.textContent = torrentStatus(torrent);
  elements.torrentName.textContent = torrent.name || "Reading metadata…";
  elements.torrentHash.textContent = torrent.infoHash || "Parsing magnet…";
  elements.percent.textContent = `${progress.toFixed(progress > 0 && progress < 1 ? 1 : 0)}%`;
  elements.progress.style.width = `${progress}%`;
  elements.peers.textContent = String(torrent.numPeers || 0);
  elements.speed.textContent = `${formatBytes(torrent.downloadSpeed || 0)}/s`;
  elements.downloaded.textContent = formatBytes(torrent.downloaded || 0);
  elements.total.textContent = `of ${formatBytes(torrent.length || 0)}`;
  elements.fileCount.textContent = metadataReady ? String(torrent.files.length) : "—";

  if (
    !metadataReady &&
    torrent.numPeers === 0 &&
    Date.now() - state.openedAt > 12_000
  ) {
    setNotice(
      "No browser-compatible metadata source",
      "Discovery is still running, but this magnet may only have ordinary BitTorrent peers. Browser mode needs a WebRTC peer or an xs/webseed URL.",
    );
  } else if (
    state.activeAction &&
    torrent.numPeers === 0 &&
    torrent.downloadSpeed === 0 &&
    Date.now() - state.lastNoPeersAt < 35_000
  ) {
    setNotice(
      "Waiting for browser peers",
      "No WebRTC peer or webseed is sending the requested pieces. Ordinary DHT, UDP, and TCP peers are invisible to this page.",
    );
  } else {
    clearNotice();
  }

  if (metadataReady) {
    elements.manifest.hidden = false;
    elements.manifestSummary.textContent = `${torrent.files.length} files · ${formatBytes(torrent.length)}`;
    renderFiles(torrent.files);
  }
}

function startUpdates() {
  window.clearInterval(state.updateTimer);
  state.updateTimer = window.setInterval(renderTorrent, 500);
}

function closeMedia() {
  const media = elements.mediaShell.querySelector("video, audio");
  if (media) {
    media.pause();
    media.removeAttribute("src");
    media.load();
  }
  if (state.activeFile && !state.downloadIndexes.has(state.activeFile.index)) {
    state.activeFile.file.deselect();
  }
  state.activeFile = null;
  state.activeAction = "";
  elements.mediaShell.innerHTML = "";
  elements.mediaMessage.textContent = "";
  elements.stage.hidden = true;
}

function resetUI() {
  window.clearInterval(state.updateTimer);
  closeMedia();
  state.torrent = null;
  state.openedAt = 0;
  state.filesSignature = "";
  state.downloadIndexes.clear();
  elements.empty.hidden = false;
  elements.view.hidden = true;
  elements.stop.hidden = true;
  elements.manifest.hidden = true;
  elements.fileList.innerHTML = "";
  setBusy(false);
}

function openMedia(index) {
  const file = state.torrent?.files[index];
  if (!file) return;
  const kind = fileKind(file.name);
  if (!isPlayable(file.name)) {
    setNotice(
      "Browser codec unavailable",
      "This format needs native FFmpeg conversion. Download the file or use Hash Harbor’s local helper.",
    );
    return;
  }

  closeMedia();
  file.select(20);
  state.activeFile = { index, file };
  state.activeAction = "Streaming in browser";
  elements.stage.hidden = false;
  elements.mediaTitle.textContent = file.name;
  elements.mediaMessage.textContent = "Requesting the first playable pieces through WebTorrent…";

  const media = document.createElement(kind === "image" ? "img" : kind);
  if (kind === "image") {
    media.alt = file.name;
    media.addEventListener("load", () => {
      elements.mediaMessage.textContent = "Image ready from browser-local torrent storage.";
    });
  } else {
    media.controls = true;
    media.preload = "metadata";
    media.playsInline = true;
    media.addEventListener("waiting", () => {
      elements.mediaMessage.textContent = "Buffering WebTorrent pieces…";
    });
    media.addEventListener("canplay", () => {
      elements.mediaMessage.textContent = "Ready to play.";
    });
    media.addEventListener("playing", () => {
      elements.mediaMessage.textContent =
        "Playing entirely in this tab. Native controls include seeking, volume, and fullscreen.";
    });
    media.addEventListener("stalled", () => {
      elements.mediaMessage.textContent = "Waiting for the next pieces from a browser-compatible source…";
    });
  }
  media.addEventListener("error", () => {
    elements.mediaMessage.textContent =
      "The browser could not decode or receive this stream. Check the peer count or save the original file.";
  });

  elements.mediaShell.append(media);
  file.streamTo(media);
  elements.stage.scrollIntoView({ behavior: "smooth", block: "nearest" });

  if (kind !== "image") {
    media.play().catch(() => {
      elements.mediaMessage.textContent = "Press play when enough data has buffered.";
    });
  }
  renderTorrent();
}

async function saveToChosenFile(file, index) {
  const handle = await window.showSaveFilePicker({ suggestedName: file.name });
  const writable = await handle.createWritable();
  state.downloadIndexes.add(index);
  state.activeAction = "Saving to disk";
  file.select(30);
  renderTorrent();
  try {
    await file.stream().pipeTo(writable);
    setNotice("File saved", `${file.name} was written directly to the folder you selected.`);
  } catch (error) {
    await writable.abort().catch(() => {});
    throw error;
  } finally {
    state.downloadIndexes.delete(index);
    file.deselect();
    state.activeAction = "";
    state.filesSignature = "";
    renderTorrent();
  }
}

async function saveWithBlob(file, index) {
  if (file.length > 512 * 1024 * 1024) {
    throw new Error("This file is too large for the browser’s memory fallback. Choose a download folder first.");
  }
  state.downloadIndexes.add(index);
  state.activeAction = "Preparing browser download";
  file.select(30);
  renderTorrent();
  try {
    const blob = await file.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = file.name;
    anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    setNotice("Download ready", `${file.name} was passed to your browser’s download manager.`);
  } finally {
    state.downloadIndexes.delete(index);
    file.deselect();
    state.activeAction = "";
    state.filesSignature = "";
    renderTorrent();
  }
}

async function saveFile(index) {
  const file = state.torrent?.files[index];
  if (!file || state.downloadIndexes.has(index)) return;
  showError("");

  try {
    if (state.directory) {
      state.downloadIndexes.add(index);
      state.activeAction = "Downloading to chosen folder";
      file.select(30);
      setNotice(
        "Downloading locally",
        `${file.name} is being written into “${state.directory.name}”. Keep this tab open until it reaches 100%.`,
      );
      const finish = () => {
        state.downloadIndexes.delete(index);
        state.activeAction = "";
        state.filesSignature = "";
        setNotice("File saved", `${file.name} is complete in “${state.directory.name}”.`);
        renderTorrent();
      };
      if (file.done) finish();
      else file.once("done", finish);
      renderTorrent();
      return;
    }

    if ("showSaveFilePicker" in window) {
      await saveToChosenFile(file, index);
    } else {
      await saveWithBlob(file, index);
    }
  } catch (error) {
    if (error.name !== "AbortError") showError(error.message);
    state.downloadIndexes.delete(index);
    state.activeAction = "";
    state.filesSignature = "";
    renderTorrent();
  }
}

function attachTorrentEvents(torrent) {
  torrent.on("metadata", renderTorrent);
  torrent.on("ready", () => {
    torrent.files.forEach((file) => file.deselect());
    state.filesSignature = "";
    renderTorrent();
  });
  torrent.on("download", renderTorrent);
  torrent.on("wire", renderTorrent);
  torrent.on("noPeers", () => {
    state.lastNoPeersAt = Date.now();
    renderTorrent();
  });
  torrent.on("warning", (warning) => {
    console.warn("[Hash Harbor torrent warning]", warning);
  });
  torrent.on("error", (error) => {
    showError(error.message);
    setNotice("Torrent error", error.message);
    setBusy(false);
  });
}

async function openTorrent(sourceValue) {
  if (!state.engineReady) throw new Error("The browser engine is still starting.");
  const source = normalizeSource(sourceValue);
  const options = {
    announce: WEBRTC_TRACKERS,
    deselect: true,
    destroyStoreOnDestroy: false,
  };
  if (state.directory) options.rootDir = state.directory;

  const torrent = state.client.add(source, options);
  state.torrent = torrent;
  state.openedAt = Date.now();
  state.lastNoPeersAt = Date.now();
  attachTorrentEvents(torrent);
  startUpdates();
  renderTorrent();
}

async function stopTorrent() {
  const torrent = state.torrent;
  if (!torrent) return;
  elements.stop.disabled = true;
  elements.stop.textContent = "Stopping…";
  closeMedia();
  await new Promise((resolve) => torrent.destroy({ destroyStore: false }, resolve));
  resetUI();
  elements.source.select();
  elements.stop.disabled = false;
  elements.stop.textContent = "Stop session";
  setNotice(
    "Session stopped",
    "Downloaded pieces remain in browser storage or your selected folder.",
    false,
  );
}

elements.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (state.torrent) return;
  showError("");
  setBusy(true);
  try {
    await openTorrent(elements.source.value);
  } catch (error) {
    showError(error.message);
    if (state.torrent && !state.torrent.destroyed) {
      state.torrent.destroy({ destroyStore: false });
      state.torrent = null;
    }
  } finally {
    setBusy(false);
  }
});

elements.folder.addEventListener("click", async () => {
  showError("");
  try {
    const directory = await window.showDirectoryPicker({
      id: "hash-harbor-downloads",
      mode: "readwrite",
    });
    const permission = await directory.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") throw new Error("Write access to that folder was not granted.");
    state.directory = directory;
    elements.storage.textContent = `Folder: ${directory.name}`;
  } catch (error) {
    if (error.name !== "AbortError") showError(error.message);
  }
});

elements.demo.addEventListener("click", () => {
  elements.source.value = LEGAL_DEMO;
  elements.permission.checked = true;
  showError("");
  elements.source.focus();
});

elements.stop.addEventListener("click", () => {
  stopTorrent().catch((error) => showError(error.message));
});

elements.fileList.addEventListener("click", (event) => {
  const playButton = event.target.closest("[data-play]");
  if (playButton) {
    openMedia(Number(playButton.dataset.play));
    return;
  }
  const saveButton = event.target.closest("[data-save]");
  if (saveButton) saveFile(Number(saveButton.dataset.save));
});

elements.closeMedia.addEventListener("click", closeMedia);

elements.theme.addEventListener("click", () => {
  const current = document.documentElement.dataset.theme || "system";
  const next = current === "system" ? "dark" : current === "dark" ? "light" : "system";
  if (next === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  localStorage.setItem("hash-harbor-theme", next);
  elements.theme.title = `Theme: ${next}`;
});

async function initialize() {
  const savedTheme = localStorage.getItem("hash-harbor-theme") || "system";
  if (savedTheme !== "system") document.documentElement.dataset.theme = savedTheme;
  elements.theme.title = `Theme: ${savedTheme}`;

  const hasOPFS = Boolean(navigator.storage?.getDirectory);
  const hasFolderPicker = "showDirectoryPicker" in window;
  elements.storage.textContent = hasOPFS
    ? "Browser storage ready"
    : "Memory storage only";
  elements.folder.disabled = !hasFolderPicker;
  if (!hasFolderPicker) {
    elements.folder.title = "This browser does not support direct folder access.";
  }

  try {
    if (!("serviceWorker" in navigator)) {
      throw new Error("This browser does not support the service worker required for streaming.");
    }
    await navigator.serviceWorker.register("/sw.min.js", { scope: "/" });
    const registration = await navigator.serviceWorker.ready;
    state.client = new WebTorrent();
    state.client.on("error", (error) => {
      showError(error.message);
      setNotice("Browser engine error", error.message);
    });
    state.client.createServer({ controller: registration });
    state.engineReady = true;
    setBusy(false);
  } catch (error) {
    showError(`Browser engine could not start: ${error.message}`);
    elements.storage.textContent = "Engine unavailable";
  }
}

setBusy(true);
initialize();
