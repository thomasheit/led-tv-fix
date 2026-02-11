import udp from "@SignalRGB/udp";

export function Name() { return "Govee (H6168 20-seg proxy)"; }
export function Version() { return "1.0.0"; }
export function Type() { return "network"; }
export function Publisher() { return "custom"; }

// Base device “canvas” size is irrelevant when we use subdevices,
// but SignalRGB expects something sensible.
export function Size() { return [1, 1]; }
export function DefaultPosition() { return [75, 70]; }
export function DefaultScale() { return 8.0; }

export function SubdeviceController() { return true; }

/* global
controller:readonly
discovery: readonly
TurnOffOnShutdown:readonly
LightingMode:readonly
forcedColor:readonly
protocolSelect:readonly
*/

export function ControllableParameters() {
  return [
    { property:"protocolSelect", group:"settings", label:"Protocol",
      description:"Which protocol to use.", type:"combobox",
      values:["DreamviewV1","DreamviewV2","RazerV1","RazerV2","Static"],
      default:"RazerV1"
    },
    { property:"TurnOffOnShutdown", group:"settings", label:"Turn off on App Exit",
      type:"boolean", default:"false"
    },
    { property:"LightingMode", group:"lighting", label:"Lighting Mode",
      description:"Canvas uses placed components, Forced overrides to a single color.",
      type:"combobox", values:["Canvas","Forced"], default:"Canvas"
    },
    { property:"forcedColor", group:"lighting", label:"Forced Color",
      type:"color", default:"#009bde"
    },
  ];
}

/** @type {GoveeProtocol} */
let govee;

/** @type {UdpSocketServer | undefined} */
let UDPServer;

// We store created subdevice metadata here (from library)
let subdevices = [];
let totalLedCount = 0;

export function Initialize() {
  device.addFeature("base64");

  device.setName(controller.sku);
  device.setImageFromUrl(controller.deviceImage);

  // Kill old socket if any
  if (UDPServer !== undefined) {
    UDPServer.stop();
    UDPServer = undefined;
  }

  // Connect UDP to device:4003 (control)
  UDPServer = new UdpSocketServer({
    ip: controller.ip,
    broadcastPort: 4003,
    listenPort: 0,
  });
  UDPServer.start();

  // Build Components/Subdevices layout from library
  ClearSubdevices();
  fetchDeviceInfoFromTableAndConfigure();

  // Protocol handler
  govee = new GoveeProtocol(controller.ip, controller.supportDreamView, controller.supportRazer);

  // Make sure device is on + razer mode enabled
  govee.setDeviceState(true);
  govee.SetRazerMode(true);
}

export function Render() {
  // If we have subdevices/components placed, use them.
  // Otherwise fall back to a single forced/static color.
  const RGBData = (subdevices.length > 0) ? GetRGBFromSubdevices() : GetFallbackRGB();

  govee.SendRGB(RGBData);
  device.pause(10);
}

export function Shutdown(systemSuspending) {
  try {
    govee.SetRazerMode(false);
    if (TurnOffOnShutdown) govee.setDeviceState(false);
  } catch (e) {
    // ignore
  }
}

// --------------------- Color collection ---------------------

function GetFallbackRGB() {
  // Total LED count matters for packet size.
  // If we don’t know it, default 20.
  const n = (totalLedCount > 0) ? totalLedCount : 20;
  const out = new Array(n * 3);

  const c = (LightingMode === "Forced") ? hexToRgb(forcedColor) : [0, 0, 0];
  for (let i = 0; i < n; i++) {
    out[i * 3] = c[0];
    out[i * 3 + 1] = c[1];
    out[i * 3 + 2] = c[2];
  }
  return out;
}

function GetRGBFromSubdevices() {
  // IMPORTANT:
  // We concatenate subdevices in EXACT order of `subdevices[]`
  // (Top -> Right -> Bottom -> Left in our library entry).
  const out = new Array(totalLedCount * 3);
  let offsetLed = 0;

  for (const sd of subdevices) {
    for (let i = 0; i < sd.ledPositions.length; i++) {
      let rgb;
      if (LightingMode === "Forced") {
        rgb = hexToRgb(forcedColor);
      } else {
        const p = sd.ledPositions[i];
        rgb = device.subdeviceColor(sd.id, p[0], p[1]); // returns [r,g,b]
      }

      out[(offsetLed + i) * 3] = rgb[0];
      out[(offsetLed + i) * 3 + 1] = rgb[1];
      out[(offsetLed + i) * 3 + 2] = rgb[2];
    }
    offsetLed += sd.ledCount;
  }

  return out;
}

// --------------------- Device/library config ---------------------

function fetchDeviceInfoFromTableAndConfigure() {
  const sku = controller.sku;

  if (!GoveeDeviceLibrary.hasOwnProperty(sku)) {
    device.log(`SKU (${sku}) not found in library, using fallback 20 LEDs no subdevices.`);
    device.setName(`Govee: ${sku}`);
    device.SetIsSubdeviceController(false);
    totalLedCount = 20;
    device.setSize([20, 1]);
    device.SetLedLimit(20);
    device.addChannel("Channel 1", 20);
    device.channel("Channel 1").SetLedLimit(20);
    return;
  }

  const info = GoveeDeviceLibrary[sku];
  device.setName(`Govee ${info.sku} - ${info.name}`);

  if (info.usesSubDevices) {
    device.SetIsSubdeviceController(true);

    // Create subdevices (components)
    subdevices = [];
    totalLedCount = 0;

    for (const s of info.subdevices) {
      CreateSubDevice(s);
      totalLedCount += s.ledCount;
    }

    // Base device doesn’t need LEDs when using subdevices
    device.setSize([1, 1]);
    device.SetLedLimit(0);

    device.log(`Created ${subdevices.length} subdevices, total LEDs: ${totalLedCount}`);
  } else {
    device.SetIsSubdeviceController(false);

    const count = info.ledCount || 20;
    totalLedCount = count;

    device.setSize([count, 1]);
    device.SetLedLimit(count);

    device.addChannel("Channel 1", count);
    device.channel("Channel 1").SetLedLimit(count);
  }
}

function ClearSubdevices() {
  // Remove all currently created subdevices
  for (const sd of device.getCurrentSubdevices()) {
    device.removeSubdevice(sd);
  }
  subdevices = [];
  totalLedCount = 0;
}

function CreateSubDevice(sd) {
  // give it a stable id
  const count = device.getCurrentSubdevices().length;
  const id = `${sd.name} ${count + 1}`;

  device.createSubdevice(id);
  device.setSubdeviceName(id, sd.name);
  device.setSubdeviceImage(id, controller.deviceImage);

  device.setSubdeviceSize(id, sd.size[0], sd.size[1]);
  device.setSubdeviceLeds(id, sd.ledNames, sd.ledPositions);

  // store for Render()
  subdevices.push({
    id,
    name: sd.name,
    ledCount: sd.ledCount,
    ledPositions: sd.ledPositions
  });
}

// --------------------- Helpers ---------------------

function hexToRgb(hex) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  return [
    parseInt(result[1], 16),
    parseInt(result[2], 16),
    parseInt(result[3], 16),
  ];
}

// --------------------- UDP + Protocol ---------------------

class GoveeProtocol {
  constructor(ip, supportDreamView, supportRazer) {
    this.ip = ip;
    this.port = 4003;
    this.lastPacket = 0;
    this.supportDreamView = supportDreamView;
    this.supportRazer = supportRazer;
  }

  setDeviceState(on) {
    UDPServer.send(JSON.stringify({
      msg: { cmd: "turn", data: { value: on ? 1 : 0 } }
    }));
  }

  SetRazerMode(enable) {
    // This is the magic toggle you already saw in Wireshark.
    UDPServer.send(JSON.stringify({
      msg: { cmd: "razer", data: { pt: enable ? "uwABsQEK" : "uwABsQAL" } }
    }));
  }

  SetStaticColor(rgb3) {
    UDPServer.send(JSON.stringify({
      msg: {
        cmd: "colorwc",
        data: { color: { r: rgb3[0], g: rgb3[1], b: rgb3[2] }, colorTemInKelvin: 0 }
      }
    }));
  }

  calculateXorChecksum(packet) {
    let c = 0;
    for (let i = 0; i < packet.length; i++) c ^= packet[i];
    return c;
  }

  createDreamViewPacketV1(colors) {
    // [BB 00 20 B0 01 <count>] + colors + checksum
    const header = [0xBB, 0x00, 0x20, 0xB0, 0x01, colors.length / 3];
    const full = header.concat(colors);
    full.push(this.calculateXorChecksum(full));
    return full;
  }

  createDreamViewPacketV2(colors) {
    const payload = [0x01, colors.length / 3].concat(colors);
    const header = [0xBB, (payload.length >> 8) & 0xff, payload.length & 0xff, 0xB0];
    const full = header.concat(payload);
    full.push(this.calculateXorChecksum(full));
    return full;
  }

  createRazerPacketV1(colors) {
    // [BB 00 0E B0 01 <count>] + colors + 0
    const header = [0xBB, 0x00, 0x0E, 0xB0, 0x01, colors.length / 3];
    const full = header.concat(colors);
    full.push(0x00);
    return full;
  }

  createRazerPacketV2(colors) {
    // variant where length is raw bytes count
    const header = [0xBB, 0x00, 0x0E, 0xB0, 0x01, colors.length];
    const full = header.concat(colors);
    full.push(this.calculateXorChecksum(full));
    return full;
  }

  SendEncodedPacket(packet) {
    const command = base64.Encode(packet);

    const now = Date.now();
    if (now - this.lastPacket > 1000) {
      UDPServer.send(JSON.stringify({ msg: { cmd: "status", data: {} } }));
      this.lastPacket = now;
    }

    UDPServer.send(JSON.stringify({
      msg: { cmd: "razer", data: { pt: command } }
    }));
  }

  SendRGB(RGBData) {
    // If forced protocol selection ignores support flags, fine.
    // If Static: just take first LED.
    if (protocolSelect === "Static") {
      this.SetStaticColor(RGBData.slice(0, 3));
      return;
    }

    let packet = [];

    switch (protocolSelect) {
      case "DreamviewV1":
        packet = this.createDreamViewPacketV1(RGBData);
        this.SendEncodedPacket(packet);
        break;
      case "DreamviewV2":
        packet = this.createDreamViewPacketV2(RGBData);
        this.SendEncodedPacket(packet);
        break;
      case "RazerV1":
        packet = this.createRazerPacketV1(RGBData);
        this.SendEncodedPacket(packet);
        break;
      case "RazerV2":
        packet = this.createRazerPacketV2(RGBData);
        this.SendEncodedPacket(packet);
        break;
      default:
        packet = this.createRazerPacketV1(RGBData);
        this.SendEncodedPacket(packet);
        break;
    }
  }
}

class UdpSocketServer {
  constructor(args) {
    this.server = null;
    this.listenPort = args?.listenPort ?? 0;
    this.broadcastPort = args?.broadcastPort ?? 4001;
    this.ipToConnectTo = args?.ip ?? "239.255.255.250";
  }

  send(packet) {
    if (!this.server) this.server = udp.createSocket();
    this.server.send(packet);
  }

  start() {
    this.server = udp.createSocket();

    this.server.on("error", (code, message) => {
      device.log(`UDP error: ${code} - ${message}`);
    });

    this.server.on("listening", () => {
      const address = this.server.address();
      device.log(`Server is listening at port ${address.port}`);
      device.log(`Socket Bound: ${this.server.state === this.server.BoundState}`);
    });

    this.server.on("connection", () => {
      device.log("Connected to remote socket!");
      device.log(JSON.stringify(this.server.remoteAddress()));
    });

    this.server.bind(this.listenPort);
    this.server.connect(this.ipToConnectTo, this.broadcastPort);
  }

  stop() {
    if (this.server) {
      this.server.disconnect();
      this.server.close();
      this.server = null;
    }
  }
}

// --------------------- Minimal library (only H6168 needed) ---------------------

const GoveeDeviceLibrary = {
  H6168: {
    name: "RGBIC TV Backlight (20-seg proxy)",
    deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6168.png",
    sku: "H6168",
    state: 1,
    supportRazer: true,
    supportDreamView: true,
    ledCount: 0,
    usesSubDevices: true,

    // 4 movable bars / components
    // Order here defines packet order: Top -> Right -> Bottom -> Left
    subdevices: [
      {
        name: "Top",
        ledCount: 6,
        size: [1, 6],
        ledNames: ["Led 1","Led 2","Led 3","Led 4","Led 5","Led 6"],
        ledPositions: [[0,0],[0,1],[0,2],[0,3],[0,4],[0,5]],
      },
      {
        name: "Right",
        ledCount: 4,
        size: [1, 4],
        ledNames: ["Led 1","Led 2","Led 3","Led 4"],
        ledPositions: [[0,0],[0,1],[0,2],[0,3]],
      },
      {
        name: "Bottom",
        ledCount: 6,
        size: [1, 6],
        ledNames: ["Led 1","Led 2","Led 3","Led 4","Led 5","Led 6"],
        ledPositions: [[0,0],[0,1],[0,2],[0,3],[0,4],[0,5]],
      },
      {
        name: "Left",
        ledCount: 4,
        size: [1, 4],
        ledNames: ["Led 1","Led 2","Led 3","Led 4"],
        ledPositions: [[0,0],[0,1],[0,2],[0,3]],
      },
    ]
  }
};
