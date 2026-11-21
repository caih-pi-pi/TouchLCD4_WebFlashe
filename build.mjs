import { build } from "esbuild";
import { copyFile, readFile, writeFile, mkdir } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const webOnly = process.argv.includes("--web-only");
const compiled = join(root, "..", "TouchLCD4_Player", "build");
const images = [
  [0x0, join(compiled, "TouchLCD4_Player.ino.bootloader.bin")],
  [0x8000, join(compiled, "TouchLCD4_Player.ino.partitions.bin")],
  [0xe000, join(compiled, "boot_app0.bin")],
  [0x10000, join(compiled, "TouchLCD4_Player.ino.bin")],
  [0x310000, join(root, "assets", "empty-media.bin.gz")],
];
const firmwarePath = join(root, "firmware.json");
if (process.argv.includes("--refresh-firmware")) {
  const files = [];
  for (const [address, path] of images) {
    const content = await readFile(path);
    const data = address === 0x310000 ? gunzipSync(content) : content;
    files.push({ address, size: data.length,
      sha256: createHash("sha256").update(data).digest("hex"),
      gzip: gzipSync(data, { level: 9 }).toString("base64") });
  }
  await writeFile(firmwarePath, JSON.stringify({
    board: "ESP32-S3-Touch-LCD-4", revision: 4, protocol: 2, flashBytes: 16 * 1024 * 1024, files,
  }));
}
const embeddedFirmware = webOnly ? "null" : await readFile(firmwarePath, "utf8").catch((error) => {
  if (error.code === "ENOENT") return "null";
  throw error;
});
const output = await build({
  entryPoints: [join(root, "app.js")], bundle: true, write: false, format: "iife",
  platform: "browser", target: ["chrome109", "edge109"], minify: true,
  define: { __EMBEDDED_FIRMWARE__: embeddedFirmware },
  legalComments: "inline", logLevel: "warning",
});
const template = await readFile(join(root, "index.template.html"), "utf8");
const styles = await readFile(join(root, "styles.css"), "utf8");
const script = output.outputFiles[0].text.replaceAll("</script", "<\\/script");
const html = template
  .replace('<link rel="stylesheet" href="./styles.css">', () => `<style>\n${styles}\n</style>`)
  .replace('<script type="module" src="./app.js"></script>', () => `<script>\n${script}\n</script>`);
const dist = join(root, "dist");
await mkdir(dist, { recursive: true });
await writeFile(join(dist, "index.html"), html);
if (webOnly) {
  await copyFile(join(root, "THIRD_PARTY_NOTICES.txt"), join(dist, "THIRD_PARTY_NOTICES.txt"));
}
if (process.argv.includes("--export-html")) {
  await writeFile(join(root, "..", "TouchLCD4_视频烧录器.html"), html);
}
console.log(`Single-file HTML built, ${(Buffer.byteLength(html) / 1024).toFixed(0)} KiB`);
