export const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function abortIfRequested(signal) {
  if (signal?.aborted) throw new DOMException("操作已取消", "AbortError");
}

function deviceError(line) {
  const error = new Error(line);
  error.deviceError = true;
  return error;
}

export class SerialSession {
  constructor(port, onLine = () => {}) {
    this.port = port;
    this.onLine = onLine;
    this.lines = [];
    this.waiters = [];
    this.closing = false;
    this.failure = null;
  }

  async open() {
    await this.port.open({ baudRate: 115200, bufferSize: 65536 });
    try {
      await this.port.setSignals({ dataTerminalReady: false, requestToSend: false });
      this.reader = this.port.readable.getReader();
      this.writer = this.port.writable.getWriter();
      this.readTask = this.readLoop();
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async readLoop() {
    const decoder = new TextDecoder();
    let partial = "";
    try {
      while (!this.closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        partial += decoder.decode(value, { stream: true });
        const lines = partial.split("\n");
        partial = lines.pop();
        if (partial.length > 16384) partial = "";
        for (const raw of lines) this.deliverLine(raw.trim());
      }
      if (!this.closing) throw new Error("设备已断开连接");
    } catch (error) {
      this.failure = error;
      for (const waiter of [...this.waiters]) waiter.reject(error);
    } finally {
      this.reader.releaseLock();
      this.reader = null;
    }
  }

  deliverLine(line) {
    if (!line) return;
    this.onLine(line);
    const waiter = this.waiters.find((item) =>
      item.predicate(line) || (item.rejectErrors && line.startsWith("ERROR")));
    if (waiter) {
      if (line.startsWith("ERROR") && waiter.rejectErrors) waiter.reject(deviceError(line));
      else waiter.resolve(line);
    } else {
      this.lines.push(line);
      if (this.lines.length > 150) this.lines.shift();
    }
  }

  waitFor(predicate, { timeout = 15000, signal, rejectErrors = true } = {}) {
    abortIfRequested(signal);
    if (this.failure) return Promise.reject(this.failure);
    const index = this.lines.findIndex((line) =>
      predicate(line) || (rejectErrors && line.startsWith("ERROR")));
    if (index >= 0) {
      const [line] = this.lines.splice(index, 1);
      return line.startsWith("ERROR") && rejectErrors
        ? Promise.reject(deviceError(line)) : Promise.resolve(line);
    }
    return new Promise((resolve, reject) => {
      const finish = (callback, result) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", cancel);
        this.waiters = this.waiters.filter((item) => item !== waiter);
        callback(result);
      };
      const cancel = () => finish(reject, new DOMException("操作已取消", "AbortError"));
      const waiter = {
        predicate, rejectErrors,
        resolve: (line) => finish(resolve, line),
        reject: (error) => finish(reject, error),
      };
      const timer = setTimeout(() => {
        const error = new Error("等待设备响应超时，请检查 USB 连接");
        error.name = "TimeoutError";
        waiter.reject(error);
      }, timeout);
      signal?.addEventListener("abort", cancel, { once: true });
      this.waiters.push(waiter);
    });
  }

  async write(data) {
    if (!this.writer || this.failure) throw this.failure || new Error("串口尚未连接");
    await this.writer.write(typeof data === "string" ? new TextEncoder().encode(data) : data);
  }

  async command(text, predicate, options) {
    this.lines.length = 0;
    await this.write(text + "\n");
    return this.waitFor(predicate, options);
  }

  async close() {
    this.closing = true;
    for (const waiter of [...this.waiters]) waiter.reject(new Error("串口已关闭"));
    try { await this.reader?.cancel(); } catch {}
    await this.readTask;
    this.writer?.releaseLock();
    this.writer = null;
    try { await this.port.close(); } catch {}
  }
}

export async function probePlayer(session, { attempts = 3, timeout = 2500, legacyTimeout = 3000, signal } = {}) {
  let line;
  for (let attempt = 0; attempt < attempts; attempt++) {
    abortIfRequested(signal);
    try {
      line = await session.command("INFO",
        (text) => text.startsWith("{") || text.startsWith("ERROR"),
        { timeout, signal, rejectErrors: false });
      break;
    } catch (error) {
      if (error.name !== "TimeoutError" || attempt === attempts - 1) throw error;
      await delay(200);
    }
  }
  if (line.startsWith("{")) {
    const info = JSON.parse(line);
    if (info.protocol !== 2 || info.board !== "ESP32-S3-Touch-LCD-4" ||
        info.chip !== "ESP32-S3" || info.revision !== 4 ||
        info.width !== 480 || info.height !== 480 || info.fps !== 15 ||
        info.orientation !== 180) {
      throw new Error("播放器型号或协议不匹配，请安装本工具附带的微雪 V4 固件");
    }
    return info;
  }
  const status = await session.command("STATUS", (text) => text.startsWith("STATUS "), { timeout: legacyTimeout, signal });
  const fields = Object.fromEntries([...status.matchAll(/(\w+)=(\d+)/g)]
    .map((match) => [match[1], Number(match[2])]));
  if (fields.revision !== 4) throw new Error("当前设备未运行配套的微雪 V4 播放器");
  return {
    protocol: 1, board: "ESP32-S3-Touch-LCD-4", chip: "ESP32-S3", revision: 4,
    width: 480, height: 480, fps: 15, orientation: 180,
    display: Boolean(fields.display), storage: Boolean(fields.storage),
    video_bytes: fields.video_bytes,
    upload_max: Math.max(0, Math.min(3 * 1024 * 1024, 0xCF0000 - fields.video_bytes - 1024 * 1024)),
    max_frame_bytes: 256 * 1024,
  };
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xEDB88320 : 0);
  return value >>> 0;
});

export function crc32(bytes, previous = 0) {
  let crc = (previous ^ 0xFFFFFFFF) >>> 0;
  for (const byte of bytes) crc = (crc >>> 8) ^ crcTable[(crc ^ byte) & 255];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

export async function uploadVideo(session, frames, { signal, onProgress = () => {} } = {}) {
  const info = await probePlayer(session);
  if (!info.display || !info.storage) throw new Error("显示或 Flash 文件系统未就绪，请先安装播放器固件");
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  if (!total || total > info.upload_max) {
    throw new Error("视频超过当前可用存储空间，请缩短片段或降低 JPEG 质量");
  }
  let checksum = 0;
  for (const frame of frames) checksum = crc32(frame, checksum);
  const hex = checksum.toString(16).padStart(8, "0");
  abortIfRequested(signal);
  let started = false;
  try {
    started = true;
    await session.command(`UPLOAD ${total} ${hex}`, (line) => line === "READY", { signal });
    let sent = 0;
    let frameIndex = 0;
    let frameOffset = 0;
    while (sent < total) {
      abortIfRequested(signal);
      const block = new Uint8Array(Math.min(4096, total - sent));
      let filled = 0;
      while (filled < block.length) {
        const frame = frames[frameIndex];
        const count = Math.min(block.length - filled, frame.length - frameOffset);
        block.set(frame.subarray(frameOffset, frameOffset + count), filled);
        filled += count;
        frameOffset += count;
        if (frameOffset === frame.length) { frameIndex++; frameOffset = 0; }
      }
      if (info.protocol === 1) {
        // Older players have a 256-byte USB receive queue.
        for (let offset = 0; offset < block.length; offset += 128) {
          abortIfRequested(signal);
          await session.write(block.subarray(offset, offset + 128));
          await delay(3);
        }
      } else {
        await session.write(block);
      }
      sent += block.length;
      const acknowledgement = await session.waitFor((line) => line.startsWith("ACK "), { signal });
      if (acknowledgement !== `ACK ${sent}`) throw new Error("设备收到的字节数不符，请重新上传");
      onProgress(sent / total, sent, total);
    }
    const result = await session.waitFor((line) => line.startsWith("UPLOADED "), { signal });
    if (result.toLowerCase() !== `uploaded ${total} ${hex}`) throw new Error("视频 CRC32 校验失败");
    await session.waitFor((line) => line.startsWith("PLAY "), { timeout: 20000, signal });
    return { total, checksum: hex };
  } catch (error) {
    if (started && !error.deviceError) {
      // Firmware receives raw bytes here. Wait for its timeout recovery before
      // sending another text command, which would otherwise become video data.
      const recovered = await session.waitFor((line) => line.startsWith("PLAY "), {
        timeout: 14000, rejectErrors: false,
      }).then(() => true).catch(() => false);
      if (!recovered) await session.close();
    }
    throw error;
  }
}
