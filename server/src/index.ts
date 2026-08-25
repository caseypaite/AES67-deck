import { WebSocketServer, WebSocket } from 'ws';
import * as net from 'net';
import * as fs from 'fs';
import * as dgram from 'dgram';
import * as http from 'http';
import { execFile } from 'child_process';
import * as path from 'path';

const SCENES_DIR = path.join(process.cwd(), '..', 'scenes');
if (!fs.existsSync(SCENES_DIR)) {
  fs.mkdirSync(SCENES_DIR);
}

const SOCKET_PATH = '/tmp/aes67_deck.sock';
const WSS_PORT = parseInt(process.env.PORT || '8081', 10);

const PATCHBAY_CONFIG_PATH = 'patchbay_config.json';
const OUTPUT_ROUTING_PATH = 'output_routing.json';
const TALKBACK_CONFIG_PATH = 'talkback_config.json';

// Fixed console topology (mirrors engine/src/main.cpp's constants exactly —
// this is not runtime-configurable, since the engine only registers JACK
// ports once at startup): 32 source-only inputs, a Master output, 8 Aux
// output buses, one dedicated operator Monitor bus, and a dedicated
// push-to-talk Talkback mic input.
const NUM_CHANNELS = 32;
const NUM_AUX = 8;
const MASTER_ID = 100;
const AUX_BASE = 101; // 101..108
const MONITOR_ID = 109;
const TALKBACK_ID = 110;

function isValidTalkbackDest(busId: any): boolean {
  return busId === MASTER_ID || (Number.isInteger(busId) && busId >= AUX_BASE && busId < AUX_BASE + NUM_AUX);
}

interface TalkbackConfig {
  sourcePorts: string[];
  destBusId: number;
  // Set when sourcePorts came from picking a device in the mic dropdown
  // rather than typing ports by hand. micAlsaPortName, when present, is an
  // ALSA port id (e.g. an external mic-jack input) that needs to be made
  // ALSA's active port on micSourceName — the PipeWire graph ports are the
  // same regardless of which physical jack is selected, so without this the
  // capture would keep coming from whatever ALSA already had active.
  micSourceName: string | null;
  micAlsaPortName: string | null;
}

function getTalkbackConfig(): TalkbackConfig {
  let sourcePorts: string[] = [];
  let destBusId = MASTER_ID;
  let micSourceName: string | null = null;
  let micAlsaPortName: string | null = null;
  try {
    if (fs.existsSync(TALKBACK_CONFIG_PATH)) {
      const raw = JSON.parse(fs.readFileSync(TALKBACK_CONFIG_PATH, 'utf8'));
      if (Array.isArray(raw.sourcePorts) && raw.sourcePorts.every((p: any) => typeof p === 'string')) {
        sourcePorts = raw.sourcePorts;
      }
      if (isValidTalkbackDest(raw.destBusId)) destBusId = raw.destBusId;
      if (typeof raw.micSourceName === 'string') micSourceName = raw.micSourceName;
      if (typeof raw.micAlsaPortName === 'string') micAlsaPortName = raw.micAlsaPortName;
    }
  } catch (e) {
    console.error('Error reading talkback config, using defaults', e);
  }
  return { sourcePorts, destBusId, micSourceName, micAlsaPortName };
}

// Set up WebSocket server
const wss = new WebSocketServer({ port: WSS_PORT });
console.log(`WebSocket Server listening on ws://localhost:${WSS_PORT}`);

let connectedWsClients: WebSocket[] = [];
wss.on('connection', (ws) => {
  console.log('UI Client connected to WebSocket');
  connectedWsClients.push(ws);

  if (fs.existsSync(PATCHBAY_CONFIG_PATH)) {
     try {
       const savedMappings = fs.readFileSync(PATCHBAY_CONFIG_PATH, 'utf8');
       ws.send(JSON.stringify({ type: 'patchbay_config_loaded', mappings: JSON.parse(savedMappings) }));
     } catch (e) {
       console.error('Error sending saved patchbay config', e);
     }
  }

  ws.send(JSON.stringify({ type: 'output_routing_loaded', outputs: getOutputRouting() }));
  ws.send(JSON.stringify({ type: 'talkback_config_loaded', ...getTalkbackConfig() }));
  ws.send(JSON.stringify({ type: 'daemon_destinations_loaded', destinations: lastDaemonDestinations, daemonReachable }));
  ws.send(JSON.stringify({ type: 'mic_devices_loaded', devices: lastMicDevices }));

  ws.on('close', () => {
    connectedWsClients = connectedWsClients.filter(client => client !== ws);
    console.log('UI Client disconnected');
  });

  // Forward UI commands to C++ Engine with basic validation
  ws.on('message', (message) => {
    try {
      const payloadStr = message.toString();
      const data = JSON.parse(payloadStr);
      // Only forward allowed types to prevent arbitrary data injection
      const allowedTypes = ['set_fader', 'set_pan', 'set_mute', 'set_solo', 'set_aux_send', 'start_record', 'stop_record', 'set_plugin_param', 'set_plugin_bypass', 'set_talkback_active'];
      if (data.type === 'save_scene') {
        const safeName = data.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        fs.writeFileSync(path.join(SCENES_DIR, `${safeName}.json`), JSON.stringify(data.state, null, 2));
        const scenes = fs.readdirSync(SCENES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        connectedWsClients.forEach(c => {
           if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify({ type: 'scenes_list', scenes }));
        });
      } else if (data.type === 'list_scenes') {
        const scenes = fs.readdirSync(SCENES_DIR).filter(f => f.endsWith('.json')).map(f => f.replace('.json', ''));
        ws.send(JSON.stringify({ type: 'scenes_list', scenes }));
      } else if (data.type === 'load_scene') {
        const safeName = data.name.replace(/[^a-zA-Z0-9_-]/g, '_');
        const p = path.join(SCENES_DIR, `${safeName}.json`);
        if (fs.existsSync(p)) {
          const state = JSON.parse(fs.readFileSync(p, 'utf8'));
          ws.send(JSON.stringify({ type: 'scene_data', state, name: data.name }));
        }
      } else if (data.type === 'sync_patchbay_matrix') {
        const merged = mergePatchbayMappings(data.mappings);
        fs.writeFileSync(PATCHBAY_CONFIG_PATH, JSON.stringify(merged));

        const mergedOutputs = mergeOutputRouting(data.outputs);
        fs.writeFileSync(OUTPUT_ROUTING_PATH, JSON.stringify(mergedOutputs));

        // Sequenced, not concurrent: both touch AES67_Deck ports via
        // pw-link, and an output endpoint could in principle coincide with
        // one of the engine's own input ports, so run them one at a time
        // rather than racing two independent pw-link sweeps.
        (async () => {
          await handlePatchbaySync(merged);
          await applyOutputRouting(mergedOutputs);
          await applyMonitorRouting();
        })();
      } else if (data.type === 'sync_talkback_config') {
        const sourcePorts = Array.isArray(data.sourcePorts) ? data.sourcePorts.filter((p: any) => typeof p === 'string') : [];
        const destBusId = isValidTalkbackDest(data.destBusId) ? data.destBusId : getTalkbackConfig().destBusId;
        const micSourceName = typeof data.micSourceName === 'string' ? data.micSourceName : null;
        const micAlsaPortName = typeof data.micAlsaPortName === 'string' ? data.micAlsaPortName : null;
        const cfg: TalkbackConfig = { sourcePorts, destBusId, micSourceName, micAlsaPortName };
        fs.writeFileSync(TALKBACK_CONFIG_PATH, JSON.stringify(cfg));

        (async () => {
          await applyTalkbackRouting(cfg);
          if (engineSocket) {
            engineSocket.write(JSON.stringify({ type: 'set_talkback_dest', channel: TALKBACK_ID, busId: destBusId }) + '\n');
          }
        })();

        const loadedMsg = JSON.stringify({ type: 'talkback_config_loaded', ...cfg });
        connectedWsClients.forEach(c => {
          if (c.readyState === WebSocket.OPEN) c.send(loadedMsg);
        });
      } else if (data.type && allowedTypes.includes(data.type)) {
        if (engineSocket) {
          if (data.type === 'set_aux_send') console.log('Forwarding set_aux_send to IPC:', payloadStr);
          engineSocket.write(payloadStr + '\n');
        }
      }
    } catch (e) {
      // Invalid JSON or format, drop it
    }
  });
});

// Set up Unix Domain Socket Server for C++ Engine
if (fs.existsSync(SOCKET_PATH)) {
  fs.unlinkSync(SOCKET_PATH);
}

let engineSocket: net.Socket | null = null;

const ipcServer = net.createServer((socket) => {
  if (engineSocket) {
    console.log('Replacing existing C++ Engine IPC connection');
    engineSocket.destroy();
  }
  console.log('C++ Engine connected via IPC');
  engineSocket = socket;

  let buffer = '';

  socket.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.trim().length > 0) {
        connectedWsClients.forEach(ws => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(line);
          }
        });
      }
    }
  });

  socket.on('end', () => {
    if (engineSocket === socket) {
      console.log('C++ Engine disconnected');
      engineSocket = null;
    }
  });

  socket.on('error', (err) => {
    console.error('IPC Socket error:', err.message);
    if (engineSocket === socket) engineSocket = null;
  });
});

ipcServer.listen(SOCKET_PATH, () => {
  console.log(`IPC Server listening on ${SOCKET_PATH}`);
});

// Monitor and Talkback's source/destination wiring is fixed/persisted, not
// something the operator re-applies by hand — get it live as soon as the
// server (and hopefully PipeWire) is up, not only after the next manual
// "Apply Routing" click.
(async () => {
  await applyMonitorRouting();
  await applyTalkbackRouting(getTalkbackConfig());
})();

// --- aes67-linux-daemon polling: "AES67 destinations" ---
// This app's Master/Aux buses only ever produce local PipeWire audio;
// getting that onto the AES67 network means feeding it into a *Source*
// configured on the aes67-linux-daemon (a Source reads from a local ALSA
// playback device and transmits RTP out — see daemon/README.md). So the
// daemon's already-configured Sources are exactly the set of real,
// addressable "AES67 destinations" available to route Master/Aux into.
const DAEMON_BASE_URL = process.env.AES67_DAEMON_URL || 'http://localhost:8080';
const DAEMON_POLL_INTERVAL_MS = 5000;

interface DaemonDestination {
  name: string;
  address: string;
}

function fetchDaemonSources(): Promise<{ ok: boolean; sources: DaemonDestination[] }> {
  return new Promise((resolve) => {
    const req = http.get(`${DAEMON_BASE_URL}/api/sources`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          const raw = Array.isArray(parsed.sources) ? parsed.sources : [];
          const sources: DaemonDestination[] = raw.map((s: any) => ({
            name: typeof s.name === 'string' && s.name ? s.name : `Source ${s.id}`,
            address: typeof s.address === 'string' ? s.address : ''
          }));
          resolve({ ok: true, sources });
        } catch (e) {
          resolve({ ok: false, sources: [] });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, sources: [] }); });
    req.on('error', () => resolve({ ok: false, sources: [] }));
  });
}

let lastDaemonDestinations: DaemonDestination[] = [];
let daemonReachable = false;

async function pollDaemonDestinations() {
  const { ok, sources } = await fetchDaemonSources();
  if (ok !== daemonReachable) {
    console.log(ok
      ? `Connected to aes67-linux-daemon at ${DAEMON_BASE_URL}`
      : `aes67-linux-daemon unreachable at ${DAEMON_BASE_URL} (destination discovery paused)`);
    daemonReachable = ok;
  }
  if (ok) lastDaemonDestinations = sources;

  const msg = JSON.stringify({ type: 'daemon_destinations_loaded', destinations: lastDaemonDestinations, daemonReachable: ok });
  connectedWsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

setInterval(pollDaemonDestinations, DAEMON_POLL_INTERVAL_MS);
pollDaemonDestinations();

// --- Local microphone discovery (Talkback source dropdown) ---
// Polls `pactl list sources` for real capture devices (not sink monitors),
// classified as builtin/USB/jack by device.bus / device.form_factor and,
// where a device exposes ALSA port-level jack sensing, an "available"
// external mic-jack port. Polling on an interval — rather than a one-shot
// scan — is what makes a USB mic "automatically" show up: PipeWire creates
// its node the moment it's plugged in, so the next cycle just sees it.
const MIC_POLL_INTERVAL_MS = 3000;

interface MicDevice {
  id: string;
  sourceName: string;
  // ALSA port id to activate via `pactl set-source-port` when this entry
  // represents a specific jack rather than "whatever ALSA already has
  // active" — see applyTalkbackRouting.
  alsaPortName: string | null;
  label: string;
  kind: 'builtin' | 'usb' | 'jack' | 'other';
  channels: number;
  ports: string[];
}

function runCmd(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : stdout));
  });
}

async function listAllOutputPorts(): Promise<string[]> {
  const stdout = await runCmd('pw-link', ['-o']);
  return stdout.split('\n').map(l => l.trim()).filter(Boolean);
}

interface PactlSource {
  name: string;
  description: string;
  props: Record<string, string>;
  channelMap: string[];
  ports: Array<{ id: string; desc: string; available: boolean | null }>;
}

// Parses the classic (non-JSON) `pactl list sources` text format. Written
// defensively: this box's only capture device runs ALSA's "pro audio"
// profile, which exposes no Ports:/jack-sensing block at all, so the
// per-port parsing here is unverified against real jack-sensing output — if
// it doesn't match a given system's exact wording, sources still come
// through with a base builtin/USB entry (see fetchMicDevices), only the
// extra jack-specific entries are lost.
function parsePactlSources(text: string): PactlSource[] {
  const chunks = text.split(/\nSource #\d+/).slice(1);
  const out: PactlSource[] = [];

  for (const block of chunks) {
    const nameM = block.match(/\n\tName: (.+)/);
    if (!nameM) continue;
    const descM = block.match(/\n\tDescription: (.+)/);
    const chMapM = block.match(/\n\tChannel Map: (.+)/);

    const props: Record<string, string> = {};
    const propsBlockM = block.match(/\n\tProperties:\n([\s\S]*?)(\n\t[A-Z][a-zA-Z ]*:|$)/);
    if (propsBlockM) {
      const re = /\n\t\t([\w.-]+) = "(.*)"/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(propsBlockM[1]))) props[m[1]] = m[2];
    }

    const ports: PactlSource['ports'] = [];
    const portsBlockM = block.match(/\n\tPorts:\n([\s\S]*?)(\n\tActive Port:|\n\t[A-Z][a-zA-Z ]*:|$)/);
    if (portsBlockM) {
      const re = /\n\t\t([\w-]+): (.+?) \(([^)]*)\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(portsBlockM[1]))) {
        const paren = m[3];
        let available: boolean | null = null;
        if (/not available/i.test(paren)) available = false;
        else if (/\bavailable\b/i.test(paren)) available = true;
        ports.push({ id: m[1], desc: m[2], available });
      }
    }

    out.push({
      name: nameM[1].trim(),
      description: descM ? descM[1].trim() : nameM[1].trim(),
      props,
      channelMap: chMapM ? chMapM[1].split(',').map(s => s.trim()).filter(Boolean) : [],
      ports
    });
  }

  return out;
}

async function fetchMicDevices(): Promise<MicDevice[]> {
  const [sourcesText, allOutputPorts] = await Promise.all([
    runCmd('pactl', ['list', 'sources']),
    listAllOutputPorts()
  ]);
  if (!sourcesText) return [];

  const sources = parsePactlSources(sourcesText);
  const devices: MicDevice[] = [];

  for (const s of sources) {
    if (s.props['device.class'] === 'monitor') continue;
    if (s.props['media.class'] !== 'Audio/Source') continue;

    const ports = allOutputPorts.filter(p => p.startsWith(`${s.name}:`));
    if (ports.length === 0) continue; // not actually wired into the PipeWire graph

    const bus = s.props['device.bus'];
    const formFactor = s.props['device.form_factor'];
    const isUsb = bus === 'usb';
    const isBuiltin = !isUsb && (formFactor === 'internal' || !bus || bus === 'pci' || bus === 'platform' || bus === 'isa');

    devices.push({
      id: s.name,
      sourceName: s.name,
      alsaPortName: null,
      label: isUsb ? `USB Microphone — ${s.description}` : `Built-in Microphone — ${s.description}`,
      kind: isUsb ? 'usb' : (isBuiltin ? 'builtin' : 'other'),
      channels: s.channelMap.length || 2,
      ports
    });

    // Any external mic-jack ALSA port this device exposes that's currently
    // sensed as plugged in becomes its own selectable entry — same
    // PipeWire graph ports, but picking it also switches ALSA's active
    // port (see applyTalkbackRouting).
    for (const p of s.ports) {
      const looksLikeMic = /mic/i.test(p.id) || /mic/i.test(p.desc);
      const looksInternal = /internal/i.test(p.id) || /internal/i.test(p.desc);
      if (looksLikeMic && !looksInternal && p.available === true) {
        devices.push({
          id: `${s.name}::${p.id}`,
          sourceName: s.name,
          alsaPortName: p.id,
          label: `Mic Jack — ${p.desc} (${s.description})`,
          kind: 'jack',
          channels: s.channelMap.length || 2,
          ports
        });
      }
    }
  }

  return devices;
}

let lastMicDevices: MicDevice[] = [];

async function pollMicDevices() {
  lastMicDevices = await fetchMicDevices();
  const msg = JSON.stringify({ type: 'mic_devices_loaded', devices: lastMicDevices });
  connectedWsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
  });
}

setInterval(pollMicDevices, MIC_POLL_INTERVAL_MS);
pollMicDevices();

// --- AES67 SAP Discovery ---
const SAP_PORT = 9875;
const SAP_MCAST_ADDR = '239.255.255.255';

const sapClient = dgram.createSocket({ type: 'udp4', reuseAddr: true });
const sapDedupe = new Map<string, number>();

sapClient.on('listening', () => {
  try {
    sapClient.addMembership(SAP_MCAST_ADDR);
    console.log(`AES67 SAP Listener bound to ${SAP_MCAST_ADDR}:${SAP_PORT}`);
  } catch (err) {
    console.error(`Failed to add multicast membership. You may need a route for multicast traffic: ${err}`);
  }
});

sapClient.on('message', (message, rinfo) => {
  if (message.length < 4) return;

  // RFC 2974 SAP header parsing
  const v = message[0] >> 5;
  if (v !== 1) return; // Only SAP v1

  const a = (message[0] >> 4) & 1; // 0 = IPv4, 1 = IPv6
  const authLen = message[1];
  const ipLen = a === 0 ? 4 : 16;
  const headerLen = 4 + ipLen + (authLen * 4);

  if (message.length <= headerLen) return;

  const payload = message.toString('utf8', headerLen);
  const lines = payload.split(/[\r\n]+/);

  let streamName = 'Unknown Stream';
  const sLine = lines.find(l => l.startsWith('s='));
  if (sLine) streamName = sLine.substring(2).trim();

  // Deduplicate discovery updates (throttle to 1 update per 10s per stream)
  const dedupKey = `${rinfo.address}-${streamName}`;
  const now = Date.now();
  if (sapDedupe.has(dedupKey) && (now - (sapDedupe.get(dedupKey) || 0)) < 10000) {
    return;
  }
  sapDedupe.set(dedupKey, now);

  const discoveryMsg = JSON.stringify({
    type: 'aes67_discovery',
    name: streamName,
    address: rinfo.address
  });

  connectedWsClients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(discoveryMsg);
    }
  });
});

try {
  sapClient.bind(SAP_PORT);
} catch (e) {
  console.error("Failed to bind SAP port (might require root or cap_net_admin):", e);
}


// Merges an incoming (possibly partial) mapping payload on top of whatever is
// currently persisted, so a client that only touched one channel can never
// wipe out every other channel's routing. Also rejects any channel id that
// isn't a real channel number before it's written to disk.
function mergePatchbayMappings(incoming: any): Record<string, any> {
  let merged: Record<string, any> = {};
  try {
    if (fs.existsSync(PATCHBAY_CONFIG_PATH)) {
      merged = JSON.parse(fs.readFileSync(PATCHBAY_CONFIG_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading existing patchbay config, starting fresh', e);
    merged = {};
  }

  if (!incoming || typeof incoming !== 'object') return merged;

  for (const rawChId in incoming) {
    const chId = Number(rawChId);
    if (!Number.isInteger(chId) || chId < 1 || chId > NUM_CHANNELS) {
      console.error(`Rejected invalid patchbay channel id in sync: ${JSON.stringify(rawChId)}`);
      continue;
    }
    merged[String(chId)] = incoming[rawChId];
  }

  return merged;
}

// The Monitor bus's fixed destination — "the system's audio out device" for
// the operator to hear locally. Not user-editable (Monitor never appears in
// output_routing.json); Master and the Aux buses have no forced default of
// their own and are freely mapped to any destination via Output Endpoints.
const HARDWARE_OUT_L = 'alsa_output.pci-0000_06_00.6.pro-output-0:playback_AUX0';
const HARDWARE_OUT_R = 'alsa_output.pci-0000_06_00.6.pro-output-0:playback_AUX1';

// Merges an incoming (possibly partial) output-endpoint payload for Master
// (100) and the 8 Aux buses (101..108) on top of whatever is currently
// persisted, so a client that only touched one bus can't wipe the rest.
function mergeOutputRouting(incoming: any): Record<string, string[]> {
  let merged: Record<string, string[]> = {};
  try {
    if (fs.existsSync(OUTPUT_ROUTING_PATH)) {
      merged = JSON.parse(fs.readFileSync(OUTPUT_ROUTING_PATH, 'utf8'));
    }
  } catch (e) {
    console.error('Error reading existing output routing config, starting fresh', e);
    merged = {};
  }

  if (incoming && typeof incoming === 'object') {
    for (const rawBusId in incoming) {
      const busId = Number(rawBusId);
      if (!Number.isInteger(busId) || busId < MASTER_ID || busId > MASTER_ID + NUM_AUX) {
        console.error(`Rejected invalid output bus id in sync: ${JSON.stringify(rawBusId)}`);
        continue;
      }
      const ports = incoming[rawBusId];
      if (!Array.isArray(ports) || !ports.every((p: any) => typeof p === 'string')) {
        console.error(`Rejected invalid output ports for bus ${busId}`);
        continue;
      }
      if (ports.length === 0) {
        // Explicit empty list clears this bus's assignment.
        delete merged[String(busId)];
      } else {
        merged[String(busId)] = ports;
      }
    }
  }

  return merged;
}

function getOutputRouting(): Record<string, string[]> {
  return mergeOutputRouting(null);
}

// Runs pw-link with an argv array (never a shell string) so no piece of a
// mapping can ever be interpreted as shell syntax. Failures (e.g. "link
// already exists" / "no such link") are expected and ignored.
function pwLink(args: string[]): Promise<void> {
  return new Promise((resolve) => {
    execFile('pw-link', args, () => resolve());
  });
}

function listPwLinks(): Promise<string> {
  return new Promise((resolve) => {
    execFile('pw-link', ['-l'], (err, stdout) => resolve(err ? '' : stdout));
  });
}

// Parses `pw-link -l` output (each output port listed as a bare line,
// followed by indented "|-> <input port>" lines for each of its current
// connections) to find who is currently feeding a given input port.
async function findLinksTo(inputPort: string): Promise<string[]> {
  const stdout = await listPwLinks();
  const sources: string[] = [];
  let currentOutput: string | null = null;
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.trim()) continue;
    if (!/^\s/.test(rawLine)) {
      currentOutput = rawLine.trim();
    } else {
      const m = rawLine.match(/\|->\s*(.+)$/);
      if (m && currentOutput && m[1].trim() === inputPort) {
        sources.push(currentOutput);
      }
    }
  }
  return sources;
}

// Same idea in the other direction: finds what a given output port currently
// feeds.
async function findLinksFrom(outputPort: string): Promise<string[]> {
  const stdout = await listPwLinks();
  const dests: string[] = [];
  let capturing = false;
  for (const rawLine of stdout.split('\n')) {
    if (!rawLine.trim()) continue;
    if (!/^\s/.test(rawLine)) {
      capturing = rawLine.trim() === outputPort;
    } else if (capturing) {
      const m = rawLine.match(/\|->\s*(.+)$/);
      if (m) dests.push(m[1].trim());
    }
  }
  return dests;
}

async function disconnectAllInputsOf(inputPort: string) {
  const sources = await findLinksTo(inputPort);
  for (const src of sources) {
    await pwLink(['-d', src, inputPort]);
  }
}

async function disconnectAllOutputsOf(outputPort: string) {
  const dests = await findLinksFrom(outputPort);
  for (const dest of dests) {
    await pwLink(['-d', outputPort, dest]);
  }
}

// Resolves which real PipeWire ports feed a channel mapping. Prefers the
// explicit `sourcePorts` the UI resolved from its stream registry (so any
// discovered/manual AES67 stream can be routed, not just one hardcoded
// name); falls back to the original hardcoded loopback for mapping entries
// persisted before per-stream ports existed.
function resolveSourcePorts(m: any): string[] | null {
  if (Array.isArray(m.sourcePorts) && m.sourcePorts.length > 0 && m.sourcePorts.every((p: any) => typeof p === 'string')) {
    return m.sourcePorts;
  }
  if (m.sourceStreamId === 'system-audio-loopback') {
    return ['AES67_System_Audio_Loopback:output_FL', 'AES67_System_Audio_Loopback:output_FR'];
  }
  return null;
}

async function handlePatchbaySync(mappings: any) {
  if (!mappings || typeof mappings !== 'object') return;

  for (let i = 1; i <= NUM_CHANNELS; i++) {
    await disconnectAllInputsOf(`AES67_Deck:in_${i}_L`);
    await disconnectAllInputsOf(`AES67_Deck:in_${i}_R`);
  }

  for (const rawChId in mappings) {
    // Channel ids are only ever used to build JACK/PipeWire port names
    // below, so reject anything that isn't a real channel number before
    // it touches a subprocess argument.
    const chId = Number(rawChId);
    if (!Number.isInteger(chId) || chId < 1 || chId > NUM_CHANNELS) {
      console.error(`Rejected invalid patchbay channel id: ${JSON.stringify(rawChId)}`);
      continue;
    }

    const m = mappings[rawChId];
    if (!m) continue;
    const ports = resolveSourcePorts(m);
    if (!ports) continue;

    const targetL = `AES67_Deck:in_${chId}_L`;
    const targetR = `AES67_Deck:in_${chId}_R`;

    if (m.sourceChannel === 0 && ports.length >= 2) {
      // Stereo mapping
      await pwLink([ports[0], targetL]);
      await pwLink([ports[1], targetR]);
    } else if (typeof m.sourceChannel === 'number' && m.sourceChannel >= 1) {
      const port = ports[m.sourceChannel - 1];
      if (port) {
        await pwLink([port, targetL]);
        await pwLink([port, targetR]); // mono to both
      }
    }
  }

  console.log('Patchbay matrix applied successfully');
}

// Applies Master (100) and each of the 8 Aux buses' (101..108) output
// endpoint assignment. Unlike Monitor, neither has a forced default — if
// nothing is assigned, that bus just isn't routed anywhere.
async function applyOutputRouting(routing: Record<string, string[]>) {
  for (let busId = MASTER_ID; busId <= MASTER_ID + NUM_AUX; busId++) {
    const outL = busId === MASTER_ID ? 'AES67_Deck:out_L' : `AES67_Deck:bus_${busId}_L`;
    const outR = busId === MASTER_ID ? 'AES67_Deck:out_R' : `AES67_Deck:bus_${busId}_R`;

    await disconnectAllOutputsOf(outL);
    await disconnectAllOutputsOf(outR);

    const dest = routing[String(busId)];
    if (!dest || dest.length === 0) continue;

    if (dest.length >= 2) {
      await pwLink([outL, dest[0]]);
      await pwLink([outR, dest[1]]);
    } else {
      await pwLink([outL, dest[0]]);
      await pwLink([outR, dest[0]]);
    }
  }

  console.log('Output routing applied successfully');
}

// Monitor's destination is fixed, not user-editable: it always goes to the
// system's local audio out device so the operator can hear the mix.
async function applyMonitorRouting() {
  await disconnectAllOutputsOf('AES67_Deck:monitor_L');
  await disconnectAllOutputsOf('AES67_Deck:monitor_R');
  await pwLink(['AES67_Deck:monitor_L', HARDWARE_OUT_L]);
  await pwLink(['AES67_Deck:monitor_R', HARDWARE_OUT_R]);
  console.log('Monitor routing applied successfully');
}

// Wires the talkback mic's configured source ports to the engine's dedicated
// talkback_L/R input. This is the source side only — where the resulting
// audio goes (Master or an Aux bus, never Monitor) is the engine's own
// `talkback.dest_bus_id`, set via the `set_talkback_dest` IPC command.
async function applyTalkbackRouting(cfg: TalkbackConfig) {
  if (cfg.micSourceName && cfg.micAlsaPortName) {
    // The PipeWire graph ports (cfg.sourcePorts) are the same regardless of
    // which physical input is selected — switching to e.g. an external mic
    // jack instead of the internal mic is an ALSA-level routing choice on
    // the source itself, so it needs its own command.
    await new Promise<void>((resolve) => {
      execFile('pactl', ['set-source-port', cfg.micSourceName as string, cfg.micAlsaPortName as string], () => resolve());
    });
  }

  await disconnectAllInputsOf('AES67_Deck:talkback_L');
  await disconnectAllInputsOf('AES67_Deck:talkback_R');

  if (cfg.sourcePorts.length >= 2) {
    await pwLink([cfg.sourcePorts[0], 'AES67_Deck:talkback_L']);
    await pwLink([cfg.sourcePorts[1], 'AES67_Deck:talkback_R']);
  } else if (cfg.sourcePorts.length === 1) {
    await pwLink([cfg.sourcePorts[0], 'AES67_Deck:talkback_L']);
    await pwLink([cfg.sourcePorts[0], 'AES67_Deck:talkback_R']);
  }

  console.log('Talkback routing applied successfully');
}
