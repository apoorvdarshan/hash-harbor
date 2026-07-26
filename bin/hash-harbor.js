#!/usr/bin/env node

import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform, arch } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const REPOSITORY = "apoorvdarshan/hash-harbor";
const DEFAULT_PORT = 3210;
const SERVICE_LABEL = "com.apoorvdarshan.hash-harbor";
const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const packageInfo = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));

function fail(message) {
  console.error(`Hash Harbor: ${message}`);
  process.exitCode = 1;
}

function configDirectory() {
  if (process.env.HASH_HARBOR_CONFIG_DIR) {
    return resolve(process.env.HASH_HARBOR_CONFIG_DIR);
  }
  if (platform() === "darwin") {
    return join(homedir(), "Library", "Application Support", "Hash Harbor");
  }
  if (platform() === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "Hash Harbor");
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "Hash Harbor");
}

function configPath() {
  return join(configDirectory(), "config.json");
}

function readConfig() {
  try {
    const config = JSON.parse(readFileSync(configPath(), "utf8"));
    validatePort(config.port);
    return config;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`could not read ${configPath()}: ${error.message}`);
    }
    return { port: DEFAULT_PORT };
  }
}

function writeConfig(config) {
  validatePort(config.port);
  const target = configPath();
  mkdirSync(dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, target);
}

function validatePort(port) {
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error("port must be an integer between 1024 and 65535");
  }
}

function releasePlatform() {
  const platforms = { darwin: "darwin", linux: "linux", win32: "windows" };
  const architectures = { x64: "amd64", arm64: "arm64" };
  const targetPlatform = platforms[platform()];
  const targetArchitecture = architectures[arch()];
  if (!targetPlatform || !targetArchitecture) {
    throw new Error(`unsupported platform: ${platform()}-${arch()}`);
  }
  return { targetPlatform, targetArchitecture };
}

function assetName() {
  const { targetPlatform, targetArchitecture } = releasePlatform();
  const suffix = targetPlatform === "windows" ? ".exe" : "";
  return `hash-harbor-${targetPlatform}-${targetArchitecture}${suffix}`;
}

function installedBinaryPath() {
  if (process.env.HASH_HARBOR_BINARY) {
    return resolve(process.env.HASH_HARBOR_BINARY);
  }
  const suffix = platform() === "win32" ? ".exe" : "";
  return join(
    configDirectory(),
    "bin",
    packageInfo.version,
    `hash-harbor${suffix}`,
  );
}

async function fetchResponse(url) {
  const response = await fetch(url, {
    headers: { "User-Agent": `hash-harbor-npx/${packageInfo.version}` },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`download failed (${response.status}) from ${url}`);
  }
  return response;
}

async function downloadFile(url, target) {
  const response = await fetchResponse(url);
  if (!response.body) throw new Error(`download returned no data from ${url}`);
  await finished(Readable.fromWeb(response.body).pipe(createWriteStream(target, { mode: 0o700 })));
}

async function ensureBinary() {
  const target = installedBinaryPath();
  if (existsSync(target)) return target;
  if (packageInfo.version === "0.0.0-development") {
    throw new Error(
      "this development package has no release binary; set HASH_HARBOR_BINARY to a local Go build",
    );
  }

  mkdirSync(dirname(target), { recursive: true });
  const asset = assetName();
  const releaseRoot =
    `https://github.com/${REPOSITORY}/releases/download/v${packageInfo.version}`;
  const temporary = `${target}.${process.pid}.download`;
  try {
    await downloadFile(`${releaseRoot}/${asset}`, temporary);
    const checksums = await (await fetchResponse(`${releaseRoot}/checksums.txt`)).text();
    const checksumLine = checksums
      .split(/\r?\n/)
      .find((line) => line.trim().endsWith(`  ${asset}`));
    if (!checksumLine) throw new Error(`release checksum is missing for ${asset}`);
    const expected = checksumLine.trim().split(/\s+/)[0].toLowerCase();
    const actual = createHash("sha256").update(readFileSync(temporary)).digest("hex");
    if (actual !== expected) throw new Error(`checksum verification failed for ${asset}`);
    chmodSync(temporary, 0o755);
    renameSync(temporary, target);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
  return target;
}

function localURL(port) {
  return `http://localhost:${port}`;
}

async function health(port, timeout = 1200) {
  try {
    const response = await fetch(`${localURL(port)}/health`, {
      signal: AbortSignal.timeout(timeout),
      headers: { "User-Agent": `hash-harbor-npx/${packageInfo.version}` },
    });
    if (!response.ok) return null;
    const body = await response.json();
    return body.product === "hash-harbor" ? body : null;
  } catch {
    return null;
  }
}

async function portAvailable(port) {
  return new Promise((resolvePromise) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolvePromise(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolvePromise(true));
    });
  });
}

async function waitForHealth(port, timeout = 15_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await health(port, 500);
    if (result) return result;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 180));
  }
  throw new Error(`local service did not become ready on port ${port}`);
}

function openBrowser(url) {
  if (process.env.HASH_HARBOR_NO_OPEN === "1") return;
  const commands = {
    darwin: ["open", [url]],
    win32: ["cmd", ["/d", "/s", "/c", "start", "", url]],
    linux: ["xdg-open", [url]],
  };
  const [command, args] = commands[platform()] || commands.linux;
  const opener = spawn(command, args, { detached: true, stdio: "ignore" });
  opener.unref();
}

async function runForeground() {
  const config = readConfig();
  const existing = await health(config.port);
  if (existing) {
    console.log(`Hash Harbor is already running at ${localURL(config.port)}`);
    openBrowser(localURL(config.port));
    return;
  }
  if (!(await portAvailable(config.port))) {
    throw new Error(
      `localhost:${config.port} belongs to another application; choose a permanent port with ` +
        "`npx hash-harbor config --port <port>`",
    );
  }

  const binary = await ensureBinary();
  const child = spawn(binary, [], {
    env: { ...process.env, HASH_HARBOR_CONFIG_DIR: configDirectory() },
    stdio: "inherit",
  });
  const forward = (signal) => {
    if (!child.killed) child.kill(signal);
  };
  process.once("SIGINT", forward);
  process.once("SIGTERM", forward);

  const exited = new Promise((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code && code !== 0) reject(new Error(`local engine exited with code ${code}`));
      else if (signal && !["SIGINT", "SIGTERM"].includes(signal)) {
        reject(new Error(`local engine exited after ${signal}`));
      }
    });
  });
  await Promise.race([waitForHealth(config.port), exited]);
  console.log(`Opening ${localURL(config.port)}`);
  openBrowser(localURL(config.port));
  await new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      process.removeListener("SIGINT", forward);
      process.removeListener("SIGTERM", forward);
      if (code && code !== 0) reject(new Error(`local engine exited with code ${code}`));
      else resolvePromise();
    });
  });
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function launchAgentPath() {
  return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function launchDomain() {
  if (!process.getuid) throw new Error("could not determine the current macOS user");
  return `gui/${process.getuid()}`;
}

function runLaunchctl(args, { ignoreFailure = false, quiet = false } = {}) {
  const result = spawnSync("launchctl", args, {
    encoding: "utf8",
    stdio: quiet ? "ignore" : ["ignore", "pipe", "pipe"],
  });
  if (!ignoreFailure && result.status !== 0) {
    throw new Error((result.stderr || result.stdout || "launchctl failed").trim());
  }
  return result;
}

async function waitForServiceUnload(timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (serviceLoaded() && Date.now() < deadline) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
  }
  if (serviceLoaded()) throw new Error("the previous background service did not finish stopping");
}

async function installService() {
  if (platform() !== "darwin") {
    throw new Error("start-at-login installation currently supports macOS only");
  }
  const config = readConfig();
  const existing = await health(config.port);
  const loaded = serviceLoaded();
  if (existing && !loaded) {
    throw new Error(
      "a foreground Hash Harbor session is using the saved port; stop it with Ctrl+C, then install the service",
    );
  }
  if (!existing && !(await portAvailable(config.port))) {
    throw new Error(
      `localhost:${config.port} belongs to another application; choose a permanent port first`,
    );
  }
  const binary = await ensureBinary();
  const configRoot = configDirectory();
  const logs = join(configRoot, "logs");
  mkdirSync(logs, { recursive: true });
  mkdirSync(dirname(launchAgentPath()), { recursive: true });
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(binary)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HASH_HARBOR_CONFIG_DIR</key>
    <string>${xmlEscape(configRoot)}</string>
    <key>HASH_HARBOR_SERVICE</key>
    <string>1</string>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(join(logs, "service.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(join(logs, "service-error.log"))}</string>
</dict>
</plist>
`;
  const temporary = `${launchAgentPath()}.${process.pid}.tmp`;
  writeFileSync(temporary, plist, { mode: 0o600 });
  renameSync(temporary, launchAgentPath());

  const serviceTarget = `${launchDomain()}/${SERVICE_LABEL}`;
  runLaunchctl(["bootout", serviceTarget], { ignoreFailure: true, quiet: true });
  await waitForServiceUnload();
  try {
    runLaunchctl(["bootstrap", launchDomain(), launchAgentPath()]);
  } catch (firstError) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    try {
      runLaunchctl(["bootstrap", launchDomain(), launchAgentPath()]);
    } catch {
      throw firstError;
    }
  }
  runLaunchctl(["kickstart", "-k", serviceTarget]);
  await waitForHealth(config.port);
  console.log(`Installed start-at-login service at ${localURL(config.port)}`);
  openBrowser(localURL(config.port));
}

function serviceLoaded() {
  if (platform() !== "darwin") return false;
  return runLaunchctl(["print", `${launchDomain()}/${SERVICE_LABEL}`], {
    ignoreFailure: true,
    quiet: true,
  }).status === 0;
}

async function startService() {
  if (platform() !== "darwin") throw new Error("background service currently supports macOS only");
  if (!existsSync(launchAgentPath())) {
    throw new Error("service is not installed; run `npx hash-harbor install-service`");
  }
  const serviceTarget = `${launchDomain()}/${SERVICE_LABEL}`;
  if (!serviceLoaded()) runLaunchctl(["bootstrap", launchDomain(), launchAgentPath()]);
  runLaunchctl(["kickstart", "-k", serviceTarget]);
  const config = readConfig();
  await waitForHealth(config.port);
  console.log(`Hash Harbor is running at ${localURL(config.port)}`);
}

function stopService() {
  if (platform() !== "darwin") throw new Error("background service currently supports macOS only");
  runLaunchctl(["bootout", `${launchDomain()}/${SERVICE_LABEL}`], {
    ignoreFailure: true,
  });
  console.log("Hash Harbor background service stopped.");
}

function uninstallService() {
  if (platform() !== "darwin") throw new Error("background service currently supports macOS only");
  stopService();
  if (existsSync(launchAgentPath())) unlinkSync(launchAgentPath());
  console.log("Start-at-login service removed. Downloads and settings were kept.");
}

async function showStatus() {
  const config = readConfig();
  const result = await health(config.port);
  console.log(`Address: ${localURL(config.port)}`);
  console.log(`Engine: ${result ? `running (${result.version})` : "stopped"}`);
  if (platform() === "darwin") {
    console.log(`Start at login: ${serviceLoaded() ? "installed and loaded" : "not loaded"}`);
  }
}

async function setPort(rawPort) {
  const port = Number(rawPort);
  validatePort(port);
  const config = readConfig();
  const current = await health(config.port);
  if (current) {
    const response = await fetch(`${localURL(config.port)}/api/settings`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Hash-Harbor": "1",
      },
      body: JSON.stringify({ port }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || `settings request failed (${response.status})`);
    if (result.restarting) await waitForHealth(port);
  } else {
    if (!(await portAvailable(port))) {
      throw new Error(`localhost:${port} is already in use`);
    }
    writeConfig({ port });
  }
  console.log(`Permanent address: ${localURL(port)}`);
}

function help() {
  console.log(`Hash Harbor ${packageInfo.version}

Usage:
  npx hash-harbor                         Start locally and open the browser
  npx hash-harbor status                  Show the saved address and engine state
  npx hash-harbor open                    Open the running local service
  npx hash-harbor config --port 3210      Save a permanent localhost port
  npx hash-harbor install-service         Start automatically after macOS login
  npx hash-harbor start-service           Load the installed background service
  npx hash-harbor stop-service            Stop the background service
  npx hash-harbor uninstall-service       Remove start-at-login (keeps data)
  npx hash-harbor --version               Print the launcher version
`);
}

async function main() {
  const [command = "run", ...args] = process.argv.slice(2);
  switch (command) {
    case "run":
    case "start":
      await runForeground();
      break;
    case "status":
      await showStatus();
      break;
    case "open": {
      const config = readConfig();
      if (!(await health(config.port))) throw new Error("local service is not running");
      openBrowser(localURL(config.port));
      break;
    }
    case "config": {
      const index = args.indexOf("--port");
      if (index === -1 || !args[index + 1]) {
        throw new Error("usage: npx hash-harbor config --port <1024-65535>");
      }
      await setPort(args[index + 1]);
      break;
    }
    case "install-service":
      await installService();
      break;
    case "start-service":
      await startService();
      break;
    case "stop-service":
      stopService();
      break;
    case "uninstall-service":
      uninstallService();
      break;
    case "--version":
    case "-v":
      console.log(packageInfo.version);
      break;
    case "--help":
    case "-h":
    case "help":
      help();
      break;
    default:
      throw new Error(`unknown command “${command}”; run with --help`);
  }
}

main().catch((error) => fail(error.message));
