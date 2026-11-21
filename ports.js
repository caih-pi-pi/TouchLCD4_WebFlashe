// USB IDs are discovery hints. Only the player's INFO/STATUS handshake confirms
// the board; Web Serial does not expose a COM name or a unique USB serial number.
export const PORT_FILTERS = [
  { usbVendorId: 0x303A },
  { usbVendorId: 0x10C4, usbProductId: 0xEA60 },
  { usbVendorId: 0x1A86, usbProductId: 0x7523 },
  { usbVendorId: 0x1A86, usbProductId: 0x5523 },
  { usbVendorId: 0x1A86, usbProductId: 0x55D4 },
  { usbVendorId: 0x0403, usbProductId: 0x6001 },
];

export function portKey(port) {
  const { usbVendorId, usbProductId } = port.getInfo();
  return usbVendorId === undefined || usbProductId === undefined ? ""
    : `${usbVendorId.toString(16).padStart(4, "0")}:${usbProductId.toString(16).padStart(4, "0")}`;
}

function portType(port) {
  const { usbVendorId, usbProductId } = port.getInfo();
  if (usbVendorId === 0x303A) return "ESP32 USB";
  return PORT_FILTERS.some((filter) => filter.usbVendorId === usbVendorId && filter.usbProductId === usbProductId)
    ? "USB 转串口" : "";
}

export function candidatePorts(ports, { automatic = false, remembered = "" } = {}) {
  const candidates = [];
  for (const port of ports) {
    if (port.connected === false) continue;
    const key = portKey(port);
    const type = portType(port);
    if (key && key === remembered) candidates.push({ port, priority: 3 });
    else if (type === "ESP32 USB") candidates.push({ port, priority: key === "303a:1001" ? 2 : 1 });
    else if (!automatic && type) candidates.push({ port, priority: 0 });
  }
  return candidates.sort((a, b) => b.priority - a.priority).map(({ port }) => port);
}

const LABELS = { verified: "已验证播放器", unavailable: "无法打开", unmatched: "未识别播放器" };

export function portLabel(port, index, result) {
  const status = LABELS[result] || portType(port) || "其他串口";
  return [`设备 ${index + 1}`, status, portKey(port)].filter(Boolean).join(" · ");
}
