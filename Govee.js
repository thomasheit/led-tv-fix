import udp from "@SignalRGB/udp";

// REQUIRED so PluginCrawler doesn't treat this as invalid HID
export function VendorId() { return 0; }
export function ProductId() { return 0; }

export function Name() { return "Govee"; }
export function Version() { return "1.0.0"; }
export function Type() { return "network"; }
export function Publisher() { return "WhirlwindFX"; }

// Canvas-Größe fürs UI (nicht die Segment-Anzahl im Protokoll)
export function Size() { return [36, 1]; }
export function DefaultPosition() { return [75, 70]; }
export function DefaultScale() { return 8.0; }

/* global
controller:readonly
discovery: readonly
TurnOffOnShutdown:readonly
LightingMode:readonly
forcedColor:readonly
*/

export function ControllableParameters() {
	return [
		{"property":"TurnOffOnShutdown", "group":"settings", "label":"Turn off on App Exit", "type":"boolean", "default":"false"},
		{"property":"LightingMode", "group":"lighting", "label":"Lighting Mode", "type":"combobox", "values":["Canvas", "Forced"], "default":"Canvas"},
		{"property":"forcedColor", "group":"lighting", "label":"Forced Color", "type":"color", "default":"#009bde"},
	];
}

// Wie im Original: export bleibt false – die Runtime setzt es bei Bedarf auf true.
export function SubdeviceController() { return false; }

/** @type {GoveeProtocol} */
let govee;
let subdevices = [];
let UDPServer;

export function Initialize(){
	device.addFeature("base64");

	device.setName(controller.sku);
	device.setImageFromUrl(controller.deviceImage);

	// Make sure we don't have a server floating around still.
	if(UDPServer !== undefined) {
		UDPServer.stop();
		UDPServer = undefined;
	}

	UDPServer = new UdpSocketServer({
		ip : controller.ip,
		broadcastPort : 4003,
		listenPort : 4002
	});

	UDPServer.start();

	ClearSubdevices();
	fetchDeviceInfoFromTableAndConfigure();

	govee = new GoveeProtocol(controller.ip, controller.supportDreamView, controller.supportRazer);

	// Wie im Original (Wireshark)
	govee.setDeviceState(true);
	govee.SetRazerMode(true);
	govee.SetRazerMode(true);
	govee.setDeviceState(true);
}

export function Render(){
	const RGBData = (subdevices.length > 0) ? GetRGBFromSubdevices() : [];

	device.log(`Render: subdevices=${subdevices.length} bytes=${RGBData.length}`);
	govee.SendRGB(RGBData);

	device.pause(10);
}

export function Shutdown(suspend){
	govee.SetRazerMode(false);

	if(TurnOffOnShutdown){
		govee.setDeviceState(false);
	}
}

// ===== FIX: correct buffer indexing across subdevices =====
function GetRGBFromSubdevices(){
	const RGBData = [];
	let o = 0;

	for(const subdevice of subdevices){
		const positions = subdevice.ledPositions;

		for(let i = 0 ; i < positions.length; i++){
			const p = positions[i];
			let color;

			if (LightingMode === "Forced") {
				color = hexToRgb(forcedColor);
			} else {
				color = device.subdeviceColor(subdevice.id, p[0], p[1]);
			}

			RGBData[o++] = color[0];
			RGBData[o++] = color[1];
			RGBData[o++] = color[2];
		}
	}

	return RGBData;
}

function fetchDeviceInfoFromTableAndConfigure() {
	if(GoveeDeviceLibrary.hasOwnProperty(controller.sku)){
		const info = GoveeDeviceLibrary[controller.sku];
		device.setName(`Govee ${info.name}`);

		// Für dieses TV Backlight arbeiten wir nur mit Subdevices/Segmenten
		device.SetIsSubdeviceController(true);
		for(const sd of info.subdevices){
			CreateSubDevice(sd);
		}

		// UI-Größe/Canvas
		device.setSize([36, 1]);

	}else{
		device.log("Unknown SKU - fallback to 36 segments layout.");
		device.setName(`Govee: ${controller.sku}`);

		device.SetIsSubdeviceController(true);
		for(const sd of GoveeDeviceLibrary.H6168.subdevices){
			CreateSubDevice(sd);
		}
		device.setSize([36, 1]);
	}
}

function ClearSubdevices(){
	for(const subdevice of device.getCurrentSubdevices()){
		device.removeSubdevice(subdevice);
	}
	subdevices = [];
}

function CreateSubDevice(subdevice){
	const count = device.getCurrentSubdevices().length;
	subdevice.id = `${subdevice.name} ${count + 1}`;
	device.createSubdevice(subdevice.id);

	device.setSubdeviceName(subdevice.id, subdevice.name);
	device.setSubdeviceImage(subdevice.id, controller.deviceImage);
	device.setSubdeviceSize(subdevice.id, subdevice.size[0], subdevice.size[1]);
	device.setSubdeviceLeds(subdevice.id, subdevice.ledNames, subdevice.ledPositions);

	subdevices.push(subdevice);
}

function hexToRgb(hex) {
	const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
	return [parseInt(result[1], 16), parseInt(result[2], 16), parseInt(result[3], 16)];
}

// ===================== Discovery (unverändert minimal) =====================

export function DiscoveryService() {
	this.IconUrl = "https://assets.signalrgb.com/brands/govee/logo.png";
	this.firstRun = true;

	this.Initialize = function(){
		service.log("Searching for Govee network devices...");
		this.LoadCachedDevices();
	};

	this.UdpBroadcastPort = 4001;
	this.UdpListenPort = 4002;
	this.UdpBroadcastAddress = "239.255.255.250";

	this.lastPollTime = 0;
	this.PollInterval = 60000;

	this.cache = new IPCache();
	this.activeSockets = new Map();
	this.activeSocketTimer = Date.now();

	this.LoadCachedDevices = function(){
		service.log("Loading Cached Devices...");
		for(const [key, value] of this.cache.Entries()){
			this.checkCachedDevice(value.ip);
		}
	};

	this.checkCachedDevice = function(ipAddress) {
		if(UDPServer !== undefined) {
			UDPServer.stop();
			UDPServer = undefined;
		}

		const socketServer = new UdpSocketServer({
			ip : ipAddress,
			isDiscoveryServer : true
		});

		this.activeSockets.set(ipAddress, socketServer);
		this.activeSocketTimer = Date.now();
		socketServer.start();
	};

	this.clearSockets = function() {
		if(Date.now() - this.activeSocketTimer > 10000 && this.activeSockets.size > 0) {
			for(const [key, value] of this.activeSockets.entries()){
				value.stop();
				this.activeSockets.delete(key);
			}
		}
	};

	this.forceDiscovery = function(value) {
		const packetType = JSON.parse(value.response).msg.cmd;
		if(packetType != "scan") return;

		const isValid = JSON.parse(value.response).msg.data.hasOwnProperty("ip");
		if(!isValid) return;

		this.CreateControllerDevice(value);
	};

	this.purgeIPCache = function() {
		this.cache.PurgeCache();
	};

	this.CheckForDevices = function(){
		if(Date.now() - discovery.lastPollTime < discovery.PollInterval) return;

		discovery.lastPollTime = Date.now();
		service.broadcast(JSON.stringify({
			msg: { cmd: "scan", data: { account_topic: "reserve" } }
		}));
	};

	this.Update = function(){
		for(const cont of service.controllers){
			cont.obj.update();
		}
		this.clearSockets();
		this.CheckForDevices();
	};

	this.Shutdown = function(){};
	this.Discovered = function(value) {
		const packetType = JSON.parse(value.response).msg.cmd;
		if(packetType != "scan") return;

		const isValid = JSON.parse(value.response).msg.data.hasOwnProperty("ip");
		if(!isValid) return;

		this.CreateControllerDevice(value);
	};
	this.Removal = function(value){};

	this.CreateControllerDevice = function(value){
		const controller = service.getController(value.id);
		if (controller === undefined) {
			service.addController(new GoveeController(value));
		} else {
			controller.updateWithValue(value);
		}
	};
}

class GoveeController{
	constructor(value){
		this.id = value?.id ?? "Unknown ID";
		const packet = JSON.parse(value.response).msg;
		const response = packet.data;

		this.ip = response?.ip ?? "Unknown IP";
		this.name = response?.sku ?? "Unknown SKU";

		const info = this.GetGoveeDevice(response.sku);
		this.supportDreamView = info?.supportDreamView;
		this.supportRazer = info?.supportRazer;
		this.deviceImage = info?.deviceImage;

		this.device = response.device;
		this.sku = response?.sku ?? "Unknown Govee SKU";
		this.bleVersionHard = response?.bleVersionHard ?? "Unknown";
		this.bleVersionSoft = response?.bleVersionSoft ?? "Unknown";
		this.wifiVersionHard = response?.wifiVersionHard ?? "Unknown";
		this.wifiVersionSoft = response?.wifiVersionSoft ?? "Unknown";
		this.initialized = false;

		if(this.name !== "Unknown") {
			this.cacheControllerInfo(this);
		}
	}

	GetGoveeDevice(sku){
		if(GoveeDeviceLibrary.hasOwnProperty(sku)){
			return GoveeDeviceLibrary[sku];
		}
		return {
			name: "Unknown",
			supportDreamView: true,
			supportRazer: true,
			deviceImage: "https://assets.signalrgb.com/brands/products/govee_ble/icon@2x.png"
		};
	}

	updateWithValue(value){
		this.id = value.id;
		const response = JSON.parse(value.response).msg.data;

		this.ip = response?.ip ?? "Unknown IP";
		this.device = response.device;
		this.sku = response?.sku ?? "Unknown Govee SKU";
		this.bleVersionHard = response?.bleVersionHard ?? "Unknown";
		this.bleVersionSoft = response?.bleVersionSoft ?? "Unknown";
		this.wifiVersionHard = response?.wifiVersionHard ?? "Unknown";
		this.wifiVersionSoft = response?.wifiVersionSoft ?? "Unknown";

		service.updateController(this);
	}

	update(){
		if(!this.initialized){
			this.initialized = true;
			service.updateController(this);
			service.announceController(this);
		}
	}

	cacheControllerInfo(value){
		discovery.cache.Add(value.id, { name: value.name, ip: value.ip, id: value.id });
	}
}

class GoveeProtocol {
	constructor(ip, supportDreamView, supportRazer){
		this.ip = ip;
		this.port = 4003;
		this.lastPacket = 0;
		this.supportDreamView = supportDreamView;
		this.supportRazer = supportRazer;
	}

	setDeviceState(on){
		UDPServer.send(JSON.stringify({ "msg": { "cmd": "turn", "data": { "value": on ? 1 : 0 }}}));
	}

	SetRazerMode(enable){
		UDPServer.send(JSON.stringify({msg:{cmd:"razer", data:{pt:enable?"uwABsQEK":"uwABsQAL"}}}));
	}

	calculateXorChecksum(packet) {
		let checksum = 0;
		for (let i = 0; i < packet.length; i++) checksum ^= packet[i];
		return checksum;
	}

	createDreamViewPacket(colors) {
		const header = [0xBB, 0x00, 0x20, 0xB0, 0x01, colors.length / 3];
		const fullPacket = header.concat(colors);
		fullPacket.push(this.calculateXorChecksum(fullPacket));
		return fullPacket;
	}

	createRazerPacket(colors) {
		const header = [0xBB, 0x00, 0x0E, 0xB0, 0x01, colors.length / 3];
		const fullPacket = header.concat(colors);
		fullPacket.push(0);
		return fullPacket;
	}

	SetStaticColor(RGBData){
		UDPServer.send(JSON.stringify({
			msg: { cmd: "colorwc", data: { color: {r: RGBData[0], g: RGBData[1], b: RGBData[2]}, colorTemInKelvin: 0 } }
		}));
		device.pause(100);
	}

	SendEncodedPacket(packet){
		const command = base64.Encode(packet);
		const now = Date.now();

		if (now - this.lastPacket > 1000) {
			UDPServer.send(JSON.stringify({ msg: { cmd: "status", data: {} } }));
			this.lastPacket = now;
		}

		UDPServer.send(JSON.stringify({ msg: { cmd: "razer", data: { pt: command } } }));
	}

	SendRGB(RGBData) {
		// Wichtig: RGBData muss die Segmentanzahl treffen (hier 36*3=108 Bytes)
		if (this.supportDreamView) {
			this.SendEncodedPacket(this.createDreamViewPacket(RGBData));
		} else if(this.supportRazer) {
			this.SendEncodedPacket(this.createRazerPacket(RGBData));
		} else{
			this.SetStaticColor(RGBData.slice(0, 3));
		}
	}
}

class UdpSocketServer{
	constructor (args) {
		this.server = null;
		this.listenPort = args?.listenPort ?? 0;
		this.broadcastPort = args?.broadcastPort ?? 4001;
		this.ipToConnectTo = args?.ip ?? "239.255.255.250";
		this.isDiscoveryServer = args?.isDiscoveryServer ?? false;
	}

	send(packet) {
		if(!this.server) this.server = udp.createSocket();
		this.server.send(packet);
	}

	start(){
		this.server = udp.createSocket();
		if(this.server){
			this.server.on('error', this.onError.bind(this));
			this.server.on('message', this.onMessage.bind(this));
			this.server.on('listening', this.onListening.bind(this));
			this.server.on('connection', this.onConnection.bind(this));
			this.server.bind(this.listenPort);
			this.server.connect(this.ipToConnectTo, this.broadcastPort);
		}
	};

	stop(){
		if(this.server) {
			this.server.disconnect();
			this.server.close();
		}
	}

	onConnection(){
		if(!this.server) return;
		this.server.send(JSON.stringify({ msg: { cmd: "scan", data: { account_topic: "reserve" }}}));
	};

	onListening(){};
	onMessage(msg){
		if(this.isDiscoveryServer) discovery.forceDiscovery(msg);
	};
	onError(code, message){
		service.log(`Error: ${code} - ${message}`);
	};
}

class IPCache{
	constructor(){
		this.cacheMap = new Map();
		this.persistanceId = "ipCache";
		this.persistanceKey = "cache";
		this.PopulateCacheFromStorage();
	}
	Add(key, value){
		if(!this.cacheMap.has(key)) {
			this.cacheMap.set(key, value);
			this.Persist();
		}
	}
	Entries(){ return this.cacheMap.entries(); }
	PurgeCache() { service.removeSetting(this.persistanceId, this.persistanceKey); }
	PopulateCacheFromStorage(){
		const storage = service.getSetting(this.persistanceId, this.persistanceKey);
		if(storage === undefined) return;

		let mapValues;
		try { mapValues = JSON.parse(storage); } catch(e){ service.log(e); }
		if(mapValues === undefined) return;

		this.cacheMap = new Map(mapValues);
	}
	Persist(){
		service.saveSetting(this.persistanceId, this.persistanceKey, JSON.stringify(Array.from(this.cacheMap.entries())));
	}
}

/**
 * Minimal Library: H6168 als TV Backlight mit 36 Segmenten (Clockwise)
 * Aufteilung basierend auf 114 physischen LEDs -> auf 36 Zonen runtergebrochen:
 * Top 11, Right 9, Bottom 11, Left 5  => 36
 */
const GoveeDeviceLibrary = {
	H6168: {
		name: "TV Backlight (36 Segments, Clockwise)",
		deviceImage: "https://assets.signalrgb.com/devices/brands/govee/wifi/h6168.png",
		sku: "H6168",
		state: 1,
		supportRazer: true,
		supportDreamView: true,
		ledCount: 0,
		usesSubDevices: true,
		subdevices: [
  // TOP: 11 (oben links -> rechts)
  {
    name: "TV Top",
    ledCount: 11,
    size: [11, 1],
    ledNames: Array.from({ length: 11 }, (_, i) => `Led ${i + 1}`),
    ledPositions: Array.from({ length: 11 }, (_, i) => [i, 0]),
  },

  // RIGHT: 7 (oben -> unten)
  {
    name: "TV Right",
    ledCount: 7,
    size: [1, 7],
    ledNames: Array.from({ length: 7 }, (_, i) => `Led ${i + 1}`),
    ledPositions: Array.from({ length: 7 }, (_, i) => [0, i]),
  },

  // BOTTOM: 11 (rechts -> links)
  {
    name: "TV Bottom",
    ledCount: 11,
    size: [11, 1],
    ledNames: Array.from({ length: 11 }, (_, i) => `Led ${i + 1}`),
    ledPositions: Array.from({ length: 11 }, (_, i) => [10 - i, 0]),
  },

  // LEFT: 7 (unten -> oben)
  {
    name: "TV Left",
    ledCount: 7,
    size: [1, 7],
    ledNames: Array.from({ length: 7 }, (_, i) => `Led ${i + 1}`),
    ledPositions: Array.from({ length: 7 }, (_, i) => [0, 6 - i]),
  },
]
	},
};
