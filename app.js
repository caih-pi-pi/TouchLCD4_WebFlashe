import { ESPLoader, Transport } from "esptool-js";
import SparkMD5 from "spark-md5";
import { SerialSession, probePlayer, uploadVideo, delay } from "./serial.js";
import { prepareVideo, loadAvi, waitEvent, DEFAULT_VIDEO_BUDGET } from "./video.js";
import { PORT_FILTERS, candidatePorts, portKey, portLabel } from "./ports.js";

const $ = (id) => document.getElementById(id);
const firmware = __EMBEDDED_FIRMWARE__;
const supported = Boolean(window.isSecureContext && navigator.serial);
const state = {
  ports: [], port: null, session: null, info: null, source: null,
  url: null, prepared: null, busy: "", controller: null,
  selectedPort: null, portResults: new Map(), autoSuppressed: false,
};
let discovery;
let autoTimer;
let autoPending = false;
let portScanVersion = 0;
function savedPreference(key, fallback = "") {
  try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}
function savePreference(key, value) {
  try { localStorage.setItem(key, value); } catch {}
}
let rememberedPort = savedPreference("touchlcd4.verifiedUsb");
const logLines = [];
const video = $("preview");
const aviPreview = $("aviPreview");
const conversionHint = "默认取前 30 秒，转换预算最高 5 MB。";

function log(text) {
  const line = String(text).trim();
  if (!line) return;
  logLines.push(`[${new Date().toLocaleTimeString("zh-CN", { hour12: false })}] ${line}`);
  if (logLines.length > 160) logLines.shift();
  $("log").textContent = logLines.join("\n");
  $("log").scrollTop = $("log").scrollHeight;
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

function progress(fraction, label) {
  $("progress").value = Math.max(0, Math.min(1, fraction));
  $("progressLabel").textContent = `${Math.round(fraction * 100)}%`;
  $("stageLabel").textContent = label;
}

function showError(error) {
  const text = error?.message || String(error);
  $("errorMessage").textContent = text;
  $("errorMessage").hidden = false;
  log(text);
}

function clearError() {
  $("errorMessage").hidden = true;
  $("errorMessage").textContent = "";
}

function settings() {
  return { start: Number($("startInput").value), duration: Number($("durationInput").value),
    quality: Number($("qualityInput").value) };
}

function refreshControls() {
  const busy = Boolean(state.busy);
  const connected = isConnected();
  const player = connected && state.info?.display && state.info?.storage;
  for (const id of ["connectButton", "scanButton", "manualPortButton", "portSelect"]) {
    $(id).disabled = !supported || busy || connected;
  }
  $("connectButton").hidden = Boolean(state.port) && state.portResults.get(state.port) !== "unavailable";
  $("disconnectButton").disabled = busy || !state.port;
  $("disconnectButton").hidden = !state.port;
  $("autoConnectInput").disabled = !supported;
  $("connectButton").textContent = state.selectedPort ? "连接所选设备" : "智能连接";
  $("installButton").disabled = !firmware || !supported || busy || !state.port;
  $("videoInput").disabled = busy;
  $("chooseVideoButton").disabled = busy;
  $("preview").controls = !busy;
  for (const id of ["startInput", "durationInput", "qualityInput"]) $(id).disabled = busy;
  $("prepareButton").disabled = busy || !state.source;
  $("uploadButton").disabled = busy || !state.source || !player;
  $("downloadButton").disabled = busy || !state.prepared;
  $("cancelButton").disabled = !["prepare", "upload"].includes(state.busy);
  $("cancelButton").hidden = $("cancelButton").disabled;
  $("connectionDot").className = `status-dot ${busy ? "busy" : connected ? "connected" : ""}`;
}

function isConnected() {
  const { session } = state;
  return Boolean(session && !session.failure && !session.closing);
}

function showConnection(title, details, hint = "") {
  $("deviceStatus").textContent = title;
  $("deviceDetails").textContent = details;
  $("portHint").textContent = hint;
}

function showDevice() {
  if (!state.info) return;
  const info = state.info;
  const capacity = info.protocol === 2 ? `可上传 ${formatBytes(info.upload_max)}` : "旧版播放器";
  showConnection(info.display && info.storage ? "播放器已连接" : "设备需要初始化",
    `微雪 V${info.revision} · 480×480 · ${capacity}`);
}

function renderPorts() {
  const select = $("portSelect");
  select.replaceChildren(new Option("智能匹配配套播放器", ""));
  state.ports.forEach((port, index) => {
    select.add(new Option(portLabel(port, index, state.portResults.get(port)), String(index)));
  });
  const selected = state.ports.indexOf(state.selectedPort || state.port);
  select.value = selected < 0 ? "" : String(selected);
}

async function scanPorts() {
  if (!supported) return;
  const version = ++portScanVersion;
  const ports = await navigator.serial.getPorts();
  if (version !== portScanVersion) return;
  state.ports = ports.filter((port) => port.connected !== false);
  if (state.selectedPort && !state.ports.includes(state.selectedPort)) state.selectedPort = null;
  for (const port of state.portResults.keys()) {
    if (!state.ports.includes(port)) state.portResults.delete(port);
  }
  renderPorts();
}

function serialLog(line) {
  if (!line.startsWith("ACK ") && !line.startsWith("PLAY_STATS") &&
      !line.startsWith("TIMING ") && !line.startsWith("{")) log(line);
}

async function inspectPort(port, options) {
  const session = new SerialSession(port);
  try {
    await session.open();
    const info = await probePlayer(session, options);
    if (session.failure) throw session.failure;
    state.portResults.set(port, "verified");
    return { port, session, info };
  } catch (error) {
    if (error.name !== "AbortError") {
      state.portResults.set(port, session.writer ? "unmatched" : "unavailable");
    }
    await session.close();
    throw error;
  }
}

function usePlayer({ port, session, info }) {
  Object.assign(state, { port, session, info });
  session.onLine = serialLog;
  rememberedPort = portKey(port);
  if (rememberedPort) savePreference("touchlcd4.verifiedUsb", rememberedPort);
  clearError();
  showDevice();
  log(`已识别 ${info.board}，协议 ${info.protocol}`);
}

async function openPlayer() {
  const port = state.port;
  try {
    const player = await inspectPort(port);
    // Unplugging while the handshake is in flight clears the chosen port.
    if (state.port === port) usePlayer(player);
    else await player.session.close();
  } catch (error) {
    if (state.port !== port) return;
    if (state.portResults.get(port) === "unavailable") throw error;
    showConnection("串口已选择，待安装播放器", "确认板卡为微雪 V4 后，可安装播放器固件。");
    log(error.message);
  }
}

async function closePlayer() {
  const session = state.session;
  state.session = state.info = null;
  await session?.close();
}

function canAutoDetect() {
  return supported && $("autoConnectInput").checked && !state.autoSuppressed && !state.selectedPort;
}

function scheduleAutoDetect(milliseconds = 600) {
  if (!canAutoDetect()) return;
  autoPending = true;
  clearTimeout(autoTimer);
  autoTimer = setTimeout(() => {
    if (state.busy) return; // The operation's finally block resumes discovery.
    autoPending = false;
    connectDevice("auto").catch(showError);
  }, milliseconds);
}

function resumeAutoDetect() {
  if (autoPending) scheduleAutoDetect(300);
}

async function discoverPlayer(candidates, signal) {
  const matches = [];
  try {
    for (const [index, port] of candidates.entries()) {
      if (signal.aborted) return;
      const number = state.ports.indexOf(port) + 1;
      $("deviceDetails").textContent = `正在验证设备 ${number}…`;
      progress(0, `检测串口 ${index + 1} / ${candidates.length}`);
      try {
        matches.push(await inspectPort(port, { attempts: 2, timeout: 1200, legacyTimeout: 1500, signal }));
      } catch (error) {
        if (error.name !== "AbortError") log(`设备 ${number}：${error.message}`);
      }
    }
    if (signal.aborted) return;
    const ready = matches.filter(({ session }) => !session.failure && !session.closing);
    if (ready.length === 1) {
      usePlayer(ready[0]);
      progress(0, "已智能连接配套播放器");
      return;
    }
    const options = $("portOptions");
    if (options) options.open = true;
    if (ready.length) {
      showConnection(`检测到 ${ready.length} 台播放器`, "请在串口列表中指定一台。",
        "如果 USB 标识相同，可只保留目标设备连接。");
      progress(0, "请选择目标串口");
      return;
    }
    showConnection("未检测到配套播放器", "可手动选择开发板或重新检测。");
    progress(0, "等待连接设备");
  } finally {
    for (const match of matches) {
      if (match.session !== state.session) await match.session.close();
    }
  }
}

async function connectDevice(mode = "smart") {
  const automatic = mode === "auto";
  if (state.busy || isConnected() || (automatic && !canAutoDetect())) return;
  if (!automatic) {
    clearError();
    state.autoSuppressed = false;
  }
  state.busy = "connect";
  refreshControls();
  try {
    // Keep requestPort in the click's activation, before getPorts or any await.
    let chosen = mode === "smart" ? state.selectedPort : null;
    if (mode === "manual") chosen = await navigator.serial.requestPort({});
    if (mode === "smart" && !chosen && !candidatePorts(state.ports, { remembered: rememberedPort }).length) {
      chosen = await navigator.serial.requestPort({ filters: PORT_FILTERS });
    }
    await closePlayer();
    state.port = state.selectedPort = chosen;
    if (chosen) {
      showConnection("正在识别播放器", "正在验证所选设备…");
      progress(0, "正在识别播放器…");
      await openPlayer();
      if (state.port === chosen) progress(0, state.info ? "设备已就绪" : "请先安装播放器固件");
      return;
    }
    const controller = new AbortController();
    discovery = { controller, automatic };
    await scanPorts();
    if (controller.signal.aborted) return;
    const candidates = candidatePorts(state.ports, { automatic, remembered: rememberedPort });
    if (!candidates.length) {
      showConnection("等待授权开发板", "首次使用时，点击“智能连接”授权串口。");
      return;
    }
    showConnection("正在智能检测设备", "正在验证配套播放器…");
    await discoverPlayer(candidates, controller.signal);
  } catch (error) {
    if (error.name === "NotFoundError") progress(0, "已取消串口选择");
    else {
      showConnection("连接失败", "请检查 USB 连接和串口占用情况。");
      showError(error);
    }
  } finally {
    discovery = null;
    await scanPorts().catch(renderPorts);
    state.busy = "";
    refreshControls();
    resumeAutoDetect();
  }
}

async function disconnectDevice({ intentional = false } = {}) {
  if (intentional) {
    state.autoSuppressed = true;
    autoPending = false;
    clearTimeout(autoTimer);
  }
  state.port = state.selectedPort = null;
  await closePlayer();
  showConnection("等待连接设备", intentional ? "已断开，可点击“智能连接”恢复。" : "请通过 USB 连接开发板。");
  renderPorts();
  refreshControls();
}

async function runAction(kind, action) {
  if (state.busy) return;
  state.busy = kind;
  state.controller = new AbortController();
  clearError();
  refreshControls();
  let wakeLock;
  try {
    wakeLock = await navigator.wakeLock?.request("screen").catch(() => null);
    await action(state.controller.signal);
  } catch (error) {
    if (error.name === "AbortError") {
      progress(0, "操作已取消");
      log("操作已取消");
    } else {
      showError(error);
      $("stageLabel").textContent = "操作未完成，请查看提示";
      if (kind === "flash" && !state.info) {
        $("deviceStatus").textContent = "播放器尚未就绪";
        $("deviceDetails").textContent = "请重新连接或再次安装配套固件。";
      }
    }
    if (state.session?.failure || state.session?.closing) await disconnectDevice();
  } finally {
    await wakeLock?.release().catch(() => {});
    state.busy = "";
    state.controller = null;
    refreshControls();
    resumeAutoDetect();
  }
}

async function selectVideo(file) {
  if (!file || state.busy) return;
  await runAction("load", async () => {
    state.prepared = null;
    state.source = null;
    video.pause();
    video.removeAttribute("src");
    aviPreview.removeAttribute("src");
    video.hidden = true;
    aviPreview.hidden = true;
    $("emptyPreview").hidden = false;
    $("sourceInfo").textContent = "正在读取视频…";
    $("conversionInfo").textContent = conversionHint;
    if (state.url) URL.revokeObjectURL(state.url);
    state.url = null;
    try {
      if (/\.avi$/i.test(file.name)) {
        if (file.size > 512 * 1024 * 1024) throw new Error("AVI 文件超过 512 MB，请先裁成短片");
        state.source = await loadAvi(file);
        state.url = URL.createObjectURL(new Blob([state.source.frames[0]], { type: "image/jpeg" }));
        aviPreview.src = state.url;
        aviPreview.hidden = false;
      } else {
        state.url = URL.createObjectURL(file);
        const ready = waitEvent(video, "loadeddata");
        video.src = state.url;
        video.load();
        await ready;
        if (video.videoWidth !== 480 || video.videoHeight !== 480) {
          throw new Error(`输入是 ${video.videoWidth}×${video.videoHeight}，请选择 480×480 视频`);
        }
        if (!Number.isFinite(video.duration) || video.duration <= 0) throw new Error("视频时长无效");
        state.source = { kind: "video", duration: video.duration };
        video.hidden = false;
      }
    } catch (error) {
      video.removeAttribute("src");
      video.load();
      if (state.url) URL.revokeObjectURL(state.url);
      state.url = null;
      state.source = null;
      $("sourceInfo").textContent = "请选择 480 × 480 视频";
      throw error;
    }
    $("emptyPreview").hidden = true;
    const { duration } = state.source;
    $("startInput").value = "0";
    $("durationInput").value = String(Math.min(30, Number(duration.toFixed(2)) || duration));
    $("durationInput").max = String(duration);
    $("sourceInfo").textContent = `${file.name} · ${duration.toFixed(1)} 秒`;
    progress(0, "视频已载入");
    log(`载入视频 ${file.name}，${duration.toFixed(2)} 秒`);
  });
}

async function convert(signal) {
  const budget = Math.min(DEFAULT_VIDEO_BUDGET, state.info?.upload_max ?? DEFAULT_VIDEO_BUDGET);
  if (state.prepared && state.prepared.total <= budget) return state.prepared;
  progress(0, "正在准备视频…");
  state.prepared = null;
  if (budget <= 0) throw new Error("设备可用空间不足");
  const prepared = await prepareVideo(state.source, video, {
    ...settings(), budget, signal,
    onProgress: (fraction, total, count, totalCount) => {
      progress(fraction, `转换画面 ${count} / ${totalCount}`);
      $("conversionInfo").textContent = `已转换 ${count} 帧，${formatBytes(total)} / ${formatBytes(budget)} 预算`;
    },
  });
  state.prepared = prepared;
  $("conversionInfo").textContent =
    `${prepared.frameCount} 帧 · ${prepared.duration.toFixed(1)} 秒 · ${formatBytes(prepared.total)}`;
  progress(1, "视频已准备好");
  log(`转换完成，${prepared.frameCount} 帧，${formatBytes(prepared.total)}`);
  return prepared;
}

function base64Bytes(base64) {
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function loadFirmware() {
  const files = [];
  for (const file of firmware.files) {
    const compressed = base64Bytes(file.gzip);
    const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
    const data = new Uint8Array(await new Response(stream).arrayBuffer());
    const checksum = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
      .map((byte) => byte.toString(16).padStart(2, "0")).join("");
    if (checksum !== file.sha256 || data.length !== file.size) {
      throw new Error("网页内置固件校验失败，请重新获取 HTML 文件");
    }
    files.push({ address: file.address, data });
  }
  return files;
}

async function installFirmware() {
  if (!firmware) throw new Error("请使用带播放器固件的离线版");
  if (!state.port) throw new Error("请先选择串口");
  await runAction("flash", async () => {
    progress(0, "正在校验内置固件…");
    const files = await loadFirmware();
    await closePlayer();
    $("deviceStatus").textContent = "正在烧录播放器";
    $("deviceDetails").textContent = "请保持 USB 连接，完成后将自动检测播放器。";
    const transport = new Transport(state.port, false);
    const terminal = {
      clean() {}, writeLine: (text) => log(text), write: (text) => log(text),
    };
    const loader = new ESPLoader({
      transport, baudrate: 921600, romBaudrate: 115200, terminal, debugLogging: false,
    });
    try {
      progress(0, "正在检测芯片，请保持 USB 连接…");
      await loader.main();
      const chip = loader.chip.CHIP_NAME;
      const flashSize = await loader.detectFlashSize();
      if (chip !== "ESP32-S3" || flashSize !== "16MB") {
        throw new Error(`检测到 ${chip} / ${flashSize || "未知容量"}。本固件适用微雪 ESP32-S3-Touch-LCD-4 V4 / 16 MB`);
      }
      log(`ROM 检测确认 ${chip}，Flash ${flashSize}`);
      $("deviceDetails").textContent = `${chip} · ${flashSize} Flash · 正在安装微雪 V4 播放器`;
      await loader.writeFlash({
        fileArray: files, flashMode: "keep", flashFreq: "keep", flashSize: "16MB",
        eraseAll: false, compress: true,
        calculateMD5Hash: (image) => SparkMD5.ArrayBuffer.hash(
          image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength)),
        reportProgress: (fileIndex, written, total) => {
          progress((fileIndex + written / total) / files.length,
            `烧录并校验固件 ${fileIndex + 1} / ${files.length}`);
        },
      });
    } finally {
      try {
        await transport.setDTR(false);
        await transport.setRTS(true);
        await delay(100);
        await transport.setRTS(false);
      } catch {}
      await transport.disconnect().catch(() => {});
    }
    await delay(1600);
    const authorized = await navigator.serial.getPorts();
    if (!authorized.includes(state.port)) {
      const key = portKey(state.port);
      const matching = authorized.filter((port) => key && key === portKey(port));
      if (matching.length === 1) state.port = state.selectedPort = matching[0];
    }
    await openPlayer();
    await scanPorts().catch(renderPorts);
    if (!state.info?.display || !state.info?.storage || state.info.protocol !== 2) {
      throw new Error("固件已写入，但播放器尚未就绪。请检查是否为微雪 V4 并重新连接");
    }
    progress(1, "播放器安装成功，可以上传视频");
    log("固件安装完成，显示与 Flash 文件系统已就绪");
  });
}

$("progress").max = 1;
$("autoConnectInput").checked = savedPreference("touchlcd4.autoConnect", "true") !== "false";
$("connectButton").addEventListener("click", () => connectDevice());
$("manualPortButton").addEventListener("click", () => connectDevice("manual"));
$("disconnectButton").addEventListener("click", () => disconnectDevice({ intentional: true }).catch(showError));
$("scanButton").addEventListener("click", () => connectDevice("rescan"));
$("portSelect").addEventListener("change", () => {
  state.selectedPort = state.ports[$("portSelect").value] ?? null;
  state.port = state.info = null;
  state.autoSuppressed = false;
  if (state.selectedPort) showConnection("已指定串口", "点击“连接所选设备”继续。");
  else showConnection("智能匹配模式", "点击“智能连接”检测已授权设备。");
  refreshControls();
});
$("autoConnectInput").addEventListener("change", () => {
  const { checked } = $("autoConnectInput");
  savePreference("touchlcd4.autoConnect", String(checked));
  if (checked) {
    state.autoSuppressed = false;
    scheduleAutoDetect(0);
    return;
  }
  autoPending = false;
  clearTimeout(autoTimer);
  if (discovery?.automatic && !isConnected()) {
    discovery.controller.abort();
    showConnection("已暂停自动检测", "可点击“智能连接”手动检测。");
    progress(0, "自动连接已关闭");
  }
});
if (firmware) {
  $("installButton").addEventListener("click", () => installFirmware().catch(showError));
} else {
  $("installButton").hidden = true;
  $("firmwareHint").textContent = "此构建可上传视频。首次安装播放器请使用带固件的离线版。";
}
$("chooseVideoButton").addEventListener("click", () => $("videoInput").click());
$("videoInput").addEventListener("change", ({ target }) => {
  const file = target.files[0];
  target.value = "";
  selectVideo(file);
});
$("prepareButton").addEventListener("click", () => runAction("prepare", convert));
$("uploadButton").addEventListener("click", () => runAction("upload", async (signal) => {
  const prepared = await convert(signal);
  progress(0, "正在上传视频…");
  const result = await uploadVideo(state.session, prepared.frames, {
    signal, onProgress: (fraction, sent, total) => {
      progress(fraction, `上传 ${formatBytes(sent)} / ${formatBytes(total)}`);
    },
  });
  state.info = await probePlayer(state.session);
  showDevice();
  progress(1, "上传成功，开发板已开始循环播放");
  log(`上传完成，CRC32 ${result.checksum}，开发板已开始播放`);
}));
$("cancelButton").addEventListener("click", () => {
  state.controller?.abort();
  $("cancelButton").disabled = true;
  $("stageLabel").textContent = state.busy === "upload" ? "正在取消，等待开发板恢复原视频…" : "正在取消…";
});
$("downloadButton").addEventListener("click", () => {
  if (!state.prepared) return;
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob(state.prepared.frames, { type: "video/x-motion-jpeg" }));
  link.download = "hologram_480_15fps_rotated.mjpeg";
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 1000);
});
for (const id of ["startInput", "durationInput", "qualityInput"]) {
  $(id).addEventListener("input", () => {
    state.prepared = null;
    $("conversionInfo").textContent = conversionHint;
    $("qualityValue").textContent = `${Math.round(Number($("qualityInput").value) * 100)}%`;
    refreshControls();
  });
}
const dropArea = document.querySelector(".preview-frame");
dropArea.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (!state.busy) dropArea.classList.add("dragover");
});
dropArea.addEventListener("dragleave", () => dropArea.classList.remove("dragover"));
dropArea.addEventListener("drop", (event) => {
  event.preventDefault();
  dropArea.classList.remove("dragover");
  selectVideo(event.dataTransfer.files[0]);
});
if (!supported) {
  $("browserWarning").hidden = false;
  $("browserWarning").textContent =
    "请使用桌面版 Chrome 或 Edge 打开此 HTML。通过其他设备访问时，需要 HTTPS 或本机 localhost 才能使用串口。";
} else {
  const updatePorts = async (event) => {
    if (state.busy === "flash") return;
    // A new or removed port changes which match can be treated as unique.
    if (discovery && !isConnected()) {
      discovery.controller.abort();
      if (!discovery.automatic && !canAutoDetect()) {
        showConnection("USB 设备已变化", "可点击“智能连接”重新检测。");
        progress(0, "等待重新检测");
      }
    }
    if (event.type === "disconnect" && state.port && (event.port || event.target) === state.port) {
      state.controller?.abort();
      await disconnectDevice();
      showError(new Error("USB 连接已断开，请重新插入设备"));
    }
    await scanPorts();
    refreshControls();
    scheduleAutoDetect(800);
  };
  for (const type of ["connect", "disconnect"]) {
    navigator.serial.addEventListener(type, (event) => updatePorts(event).catch(showError));
  }
}
scanPorts().then(() => scheduleAutoDetect(0)).catch(showError);
refreshControls();
