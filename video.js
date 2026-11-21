import { abortIfRequested } from "./serial.js";

export const OUTPUT_FPS = 15;
export const MAX_FRAME_BYTES = 256 * 1024;
export const DEFAULT_VIDEO_BUDGET = 5 * 1024 * 1024;

export function jpegInfo(bytes) {
  if (bytes[0] !== 0xFF || bytes[1] !== 0xD8) throw new Error("JPEG 文件头无效");
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset++] !== 0xFF) continue;
    while (bytes[offset] === 0xFF) offset++;
    const marker = bytes[offset++];
    if (marker === 0xD9 || marker === 0xDA) break;
    if (marker === 0x01 || (marker >= 0xD0 && marker <= 0xD8)) continue;
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) throw new Error("JPEG 数据不完整");
    if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
      if (length < 8) throw new Error("JPEG 尺寸信息无效");
      return { baseline: marker === 0xC0, height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        width: (bytes[offset + 5] << 8) | bytes[offset + 6] };
    }
    offset += length;
  }
  throw new Error("无法读取 JPEG 尺寸");
}

function fourcc(view, offset) {
  return String.fromCharCode(...new Uint8Array(view.buffer, offset, 4));
}

export async function loadAvi(file) {
  const buffer = await file.arrayBuffer();
  const view = new DataView(buffer);
  if (buffer.byteLength < 12 || fourcc(view, 0) !== "RIFF" || fourcc(view, 8) !== "AVI ") {
    throw new Error("这不是有效的 AVI 文件");
  }
  const frames = [];
  let info = null;
  function visit(begin, end, inMovie = false) {
    for (let offset = begin; offset + 8 <= end;) {
      const id = fourcc(view, offset);
      const length = view.getUint32(offset + 4, true);
      const start = offset + 8;
      const stop = start + length;
      if (stop > end || stop > buffer.byteLength) throw new Error("AVI 数据不完整");
      if (id === "avih" && length >= 40) {
        info = { fps: 1000000 / view.getUint32(start, true),
          width: view.getUint32(start + 32, true), height: view.getUint32(start + 36, true) };
      } else if (id === "LIST" && length >= 4) {
        visit(start + 4, stop, inMovie || fourcc(view, start) === "movi");
      } else if (inMovie && /^\d\d(?:dc|db)$/.test(id) && length > 0) {
        const frame = new Uint8Array(buffer, start, length);
        jpegInfo(frame);
        frames.push(frame);
      }
      offset = stop + (length & 1);
    }
  }
  visit(12, Math.min(buffer.byteLength, view.getUint32(4, true) + 8));
  if (!info || !Number.isFinite(info.fps) || info.fps <= 0 || !frames.length) {
    throw new Error("仅支持包含 MJPEG 图像帧的 AVI 视频");
  }
  if (info.width !== 480 || info.height !== 480) throw new Error("请选择 480×480 的视频");
  return { kind: "avi", ...info, duration: frames.length / info.fps, frames };
}

export function waitEvent(element, eventName, { timeout = 15000, signal } = {}) {
  abortIfRequested(signal);
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      clearTimeout(timer);
      element.removeEventListener(eventName, success);
      element.removeEventListener("error", failure);
      signal?.removeEventListener("abort", cancel);
      callback(value);
    };
    const success = () => finish(resolve);
    const failure = () => finish(reject, new Error("浏览器无法解码此视频，请使用 H.264 MP4、WebM 或 MJPEG AVI"));
    const cancel = () => finish(reject, new DOMException("操作已取消", "AbortError"));
    const timer = setTimeout(() => finish(reject, new Error("读取视频画面超时")), timeout);
    element.addEventListener(eventName, success, { once: true });
    element.addEventListener("error", failure, { once: true });
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

export async function seekVideo(video, time, signal) {
  abortIfRequested(signal);
  if (Math.abs(video.currentTime - time) < 0.0001 && video.readyState >= 2) return;
  const ready = waitEvent(video, "seeked", { signal });
  video.currentTime = time;
  await ready;
}

export async function prepareVideo(source, video, {
  start, duration, quality, budget = DEFAULT_VIDEO_BUDGET, signal, onProgress = () => {},
}) {
  const availableDuration = source.duration;
  if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration <= 0 ||
      start >= availableDuration || start + duration > availableDuration + 0.05) {
    throw new Error("片段的开始时间和时长超出了原视频范围");
  }
  const frameCount = Math.ceil(Math.min(duration, availableDuration - start) * OUTPUT_FPS - 1e-6);
  if (frameCount > 15 * 60 * 10) throw new Error("片段过长，请先缩短视频");
  const canvas = document.createElement("canvas");
  canvas.width = 480;
  canvas.height = 480;
  const context = canvas.getContext("2d", { alpha: false });
  context.translate(480, 480);
  context.rotate(Math.PI);
  const frames = [];
  let total = 0;
  video.pause();
  for (let index = 0; index < frameCount; index++) {
    abortIfRequested(signal);
    const time = Math.min(start + index / OUTPUT_FPS, availableDuration - 0.001);
    let bitmap;
    if (source.kind === "avi") {
      const sample = Math.min(source.frames.length - 1, Math.floor(time * source.fps));
      bitmap = await createImageBitmap(new Blob([source.frames[sample]], { type: "image/jpeg" }));
      context.drawImage(bitmap, 0, 0, 480, 480);
      bitmap.close();
    } else {
      await seekVideo(video, time, signal);
      context.drawImage(video, 0, 0, 480, 480);
    }
    const blob = await new Promise((resolve, reject) => canvas.toBlob(
      (result) => result ? resolve(result) : reject(new Error("浏览器无法生成 JPEG")),
      "image/jpeg", quality));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const info = jpegInfo(bytes);
    if (!info.baseline || info.width !== 480 || info.height !== 480) {
      throw new Error("当前浏览器生成的 JPEG 与播放器不兼容，请使用最新版 Chrome 或 Edge");
    }
    if (bytes.length > MAX_FRAME_BYTES) throw new Error("单帧数据过大，请降低 JPEG 质量");
    total += bytes.length;
    if (total > budget) {
      throw new Error("转换结果超过存储预算，请缩短片段或降低 JPEG 质量后重试");
    }
    frames.push(bytes);
    onProgress((index + 1) / frameCount, total, index + 1, frameCount);
  }
  return { frames, total, frameCount, duration: frameCount / OUTPUT_FPS, start, quality };
}
