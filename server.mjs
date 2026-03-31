import usb from 'usb';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

// Debug logging to file
const logFile = fs.createWriteStream('./debug.log', { flags: 'a' });
function logToFile(msg) {
    const timestamp = new Date().toISOString();
    logFile.write(`${timestamp} ${msg}\n`);
}

function dbg(line) { logToFile(`[DBG] ${line}`); }

function logEvent(data) { logToFile(`[EVT] ${JSON.stringify(data)}`); }

console.log('🎛️ DaVinci Micro Color Panel - Web GUI Server');
console.log('='.repeat(50));
console.log('💡 Run with sudo: sudo node server.mjs');

// MIDI Setup - import dynamically
let midiOut = null;
let rotaryValues = new Array(12).fill(0);
let rotaryLastTime = new Array(12).fill(0);
let rotaryUnitsPerDetent = new Array(12).fill(360);
let ROTARY_THROTTLE_MS = 0;
let ROTARY_STEP = 2;
let BALL_STEP = 0;
let BALL_THROTTLE_MS = 0;
let WHEEL_STEP = 0;
let WHEEL_THROTTLE_MS = 0;
let ballLastTime = { left: 0, center: 0, right: 0 };
let wheelLastTime = { left: 0, center: 0, right: 0 };
let wheelPositions = { left: 0, center: 0, right: 0 };
let wheelValues = new Array(3).fill(0);
let wheelMotionState = {
    left: { dir: 0, ts: 0 },
    center: { dir: 0, ts: 0 },
    right: { dir: 0, ts: 0 }
};
let rotaryMotionState = Array.from({ length: 12 }, () => ({ dir: 0, ts: 0, mag: 0, holdUntil: 0, bias: 0 }));

// Speed scale multipliers (0.1x to 5x)
const speedScales = {
    rotary: new Array(12).fill(1),
    wheel: { left: 1, center: 1, right: 1 },
    ball: { left: 1, center: 1, right: 1 }
};
let midiPorts = [];
let midiOctave = 0;
let midiEnabled = true;
let midiChannel = 0;
let appleDlsSoundEnabled = false;
let currentMidiPortName = null;
let previousMidiPortName = null;
let JZZ;

function openMidiOutByName(portName) {
    if (!JZZ || !portName) return false;
    try {
        if (midiOut) {
            try { midiOut.close(); } catch (e) {}
        }
        const jzz = JZZ();
        midiOut = jzz.openMidiOut(portName);
        currentMidiPortName = portName;
        return true;
    } catch (e) {
        return false;
    }
}

function normalizeDelta16(delta) {
    return ((delta + 32768) & 0xffff) - 32768;
}

// Presets system
let presets = {};
let currentPreset = 'default';
let presetDir = './presets';
const calibrationFile = path.join(process.cwd(), 'calibration.json');
const defaultWheelDegPerStep = { left: 1.196, center: 1.272, right: 1.494 };
const defaultBallCalibration = {
    left: { xSign: 1, ySign: 1, gain: 0.16, dominance: 1.8 },
    center: { xSign: 1, ySign: 1, gain: 0.16, dominance: 1.8 },
    right: { xSign: 1, ySign: 1, gain: 0.16, dominance: 1.8 }
};
const defaultControlMidiNotes = {
    button: {},
    rotary: Array.from({ length: 12 }, (_, i) => 60 + i)
};
let wheelDegPerStepServer = { ...defaultWheelDegPerStep };
let ballCalibrationServer = {
    left: { ...defaultBallCalibration.left },
    center: { ...defaultBallCalibration.center },
    right: { ...defaultBallCalibration.right }
};
let controlMidiNotes = {
    button: {},
    rotary: [...defaultControlMidiNotes.rotary]
};

function loadCalibration() {
    try {
        if (!fs.existsSync(calibrationFile)) return;
        const parsed = JSON.parse(fs.readFileSync(calibrationFile, 'utf8'));
        const arr = parsed?.rotaryUnitsPerDetent;
        if (Array.isArray(arr) && arr.length === 12) {
            for (let i = 0; i < 12; i++) {
                const v = Number(arr[i]);
                if (Number.isFinite(v) && v >= 1 && v <= 200000) {
                    rotaryUnitsPerDetent[i] = v;
                }
            }
        }

        const wheelParsed = parsed?.wheelDegPerStep;
        ['left', 'center', 'right'].forEach((id) => {
            const v = Number(wheelParsed?.[id]);
            if (Number.isFinite(v) && v > 0.05 && v < 12) {
                wheelDegPerStepServer[id] = v;
            }
        });

        const noteParsed = parsed?.controlMidiNotes;
        if (noteParsed && typeof noteParsed === 'object') {
            const buttonMap = noteParsed.button || {};
            controlMidiNotes.button = {};
            Object.keys(buttonMap).forEach((k) => {
                const id = Number(k);
                const n = Number(buttonMap[k]);
                if (Number.isFinite(id) && id >= 12 && id <= 51 && Number.isFinite(n) && n >= 0 && n <= 127) {
                    controlMidiNotes.button[id] = Math.round(n);
                }
            });

            const rotaryMap = noteParsed.rotary;
            if (Array.isArray(rotaryMap) && rotaryMap.length === 12) {
                for (let i = 0; i < 12; i++) {
                    const n = Number(rotaryMap[i]);
                    if (Number.isFinite(n) && n >= 0 && n <= 127) {
                        controlMidiNotes.rotary[i] = Math.round(n);
                    }
                }
            }
        }

        const ballParsed = parsed?.ballCalibration;
        ['left', 'center', 'right'].forEach((id) => {
            const cfg = ballParsed?.[id] || {};
            ballCalibrationServer[id].xSign = cfg.xSign === -1 ? -1 : 1;
            ballCalibrationServer[id].ySign = cfg.ySign === -1 ? -1 : 1;
            const gain = Number(cfg.gain);
            if (Number.isFinite(gain) && gain > 0.01 && gain < 1) {
                ballCalibrationServer[id].gain = gain;
            }
            const dom = Number(cfg.dominance);
            if (Number.isFinite(dom) && dom > 1 && dom < 6) {
                ballCalibrationServer[id].dominance = dom;
            }
        });

        console.log('📐 Loaded calibration from calibration.json');
        logToFile('[CAL] loaded calibration.json');
    } catch (e) {
        console.log('⚠️ Failed to load calibration:', e.message);
    }
}

function saveCalibration() {
    try {
        fs.writeFileSync(
            calibrationFile,
            JSON.stringify({
                rotaryUnitsPerDetent,
                wheelDegPerStep: wheelDegPerStepServer,
                ballCalibration: ballCalibrationServer,
                controlMidiNotes
            }, null, 2)
        );
    } catch (e) {
        console.log('⚠️ Failed to save calibration:', e.message);
    }
}

function loadPresets() {
    try { fs.mkdirSync(presetDir, { recursive: true }); } catch(e) {}
    try {
        const files = fs.readdirSync(presetDir);
        files.forEach(f => {
            if (f.endsWith('.json')) {
                const name = f.replace('.json', '');
                presets[name] = JSON.parse(fs.readFileSync(presetDir + '/' + f, 'utf8'));
            }
        });
    } catch(e) {}

    delete presets['Lightroom'];
    delete presets['Logic Pro Transport'];
    
    // Default preset
    if (!presets.default) {
        presets.default = {
            name: 'default',
            octave: 0,
            buttonNotes: {
                49: { note: 37, channel: 0 },  // RWD → Previous photo
                50: { note: 38, channel: 0 },  // FWD → Next photo
                51: { note: 39, channel: 0 }   // STOP → Toggle view
            }
        };
    }
    
}
loadPresets();
loadCalibration();
try {
    const jzzModule = await import('jzz');
    JZZ = jzzModule.default;
    const jzz = JZZ();
    midiPorts = jzz.info().outputs.map(p => p.name);
    console.log('\n🎹 Available MIDI outputs:', midiPorts.length ? midiPorts.join(', ') : 'none');
    
    // Auto-connect to IAC Driver if available, otherwise skip
    const iacIndex = midiPorts.findIndex(p => p.toLowerCase().includes('iac'));
    if (iacIndex >= 0) {
        if (openMidiOutByName(midiPorts[iacIndex])) {
            console.log('✅ Auto-connected to IAC Driver:', midiPorts[iacIndex]);
        }
    } else {
        console.log('⚠️ No IAC Driver found - select manually');
    }
} catch(e) {
    console.log('⚠️ MIDI not available:', e.message);
}

function sendMidi(type, channel, note, velocity) {
    if (!midiEnabled || !midiOut) return;
    try {
        const outChannel = Math.max(0, Math.min(15, midiChannel));
        if (type === 'note') {
            midiOut.send([0x90 + outChannel, note, velocity]);
            console.log(`🎹 NOTE ch${outChannel+1} n${note} v${velocity}`);
        } else if (type === 'cc') {
            midiOut.send([0xb0 + outChannel, note, velocity]);
            console.log(`🎹 CC ch${outChannel+1} n${note} v${velocity}`);
        }
    } catch(e) { console.log('MIDI error:', e); }
    
    // Broadcast MIDI to GUI
    const midiEvent = { type: 'midi', midiType: type, channel: Math.max(0, Math.min(15, midiChannel)), note, velocity };
    broadcast(midiEvent);
}

const VENDOR_ID = 0x1edb;
const PRODUCT_ID = 0xda0f;
const INTERFACE = 2;
const WS_PORT = 8765;

// Find all USB devices for debugging
console.log('\n📱 Scanning USB devices...');
const allDevices = usb.getDeviceList();
allDevices.forEach(d => {
    console.log(`  ${d.deviceDescriptor.idVendor.toString(16).padStart(4,'0')}:${d.deviceDescriptor.idProduct.toString(16).padStart(4,'0')} - ${d.deviceAddress}`);
});

// Find and connect to panel
let device = usb.findByIds(VENDOR_ID, PRODUCT_ID);

if (!device) {
    console.log('❌ Panel not found!');
    console.log('   Expected:', VENDOR_ID.toString(16) + ':' + PRODUCT_ID.toString(16));
    console.log('   Available devices shown above');
    console.log('💡 Try: sudo node server.mjs');
    process.exit(1);
}

device.open();

const iface = device.interfaces[INTERFACE];

// Track button states
const lastButtons = new Array(64).fill(0);
const rotarySwitchPressed = new Array(12).fill(false);

try {
    if (iface.isKernelDriverActive()) {
        iface.detachKernelDriver();
    }
} catch (e) {}

iface.claim();
console.log('✅ Panel connected!');

let lightsOn = true;
let currentBrightness = 100;

// Illumination
function refreshIllumination() {
    try {
        device.controlTransfer(0x21, 0x09, 0x030a, 0x0002, Buffer.from([0x0a, 0x01]));
        device.controlTransfer(0x21, 0x09, 0x0303, 0x0002, Buffer.from([0x03, currentBrightness, currentBrightness]));
    } catch (e) {}
}

refreshIllumination();
setInterval(refreshIllumination, 10000);

// Add keyboard shortcut for kill switch
console.log('\n⌨️  Press L to toggle lights, Q to quit');

// WebSocket clients
const clients = new Set();

// Broadcast to all WebSocket clients
function broadcast(data) {
    const msg = JSON.stringify(data);
    for (const client of clients) {
        if (client.readyState === 1) { // OPEN
            client.send(msg);
        }
    }
}

// Parse button report (ID 02)
function parseButtonReport(data) {
    for (let i = 1; i < Math.min(data.length, 9); i++) {
        const curr = data[i];
        const last = lastButtons[i];
        
        if (curr !== last) {
            for (let bit = 0; bit < 8; bit++) {
                const currBit = (curr >> bit) & 1;
                const lastBit = (last >> bit) & 1;
                
                if (currBit !== lastBit) {
                    const btnId = (i - 1) * 8 + bit;
                    if (btnId >= 0 && btnId <= 11) {
                        rotarySwitchPressed[btnId] = currBit === 1;
                    }
                    const event = { type: 'button', id: btnId, pressed: currBit === 1 };
                    broadcast(event);
                    logEvent(event);
                    
                    // Check preset for custom button mapping
                    const preset = presets[currentPreset];
                    const btnMapping = preset?.buttonNotes?.[btnId];
                    
                    if (btnMapping) {
                        // Custom mapping from preset
                        sendMidi('note', btnMapping.channel, btnMapping.note, currBit === 1 ? 127 : 0);
                    } else if (btnId >= 12 && btnId <= 51 && Number.isFinite(controlMidiNotes.button[btnId])) {
                        sendMidi('note', 0, controlMidiNotes.button[btnId], currBit === 1 ? 127 : 0);
                    } else if (btnId >= 12 && btnId <= 51) {
                        // Default: MIDI note 1-40 for buttons 12-51, shifted by octave
                        sendMidi('note', 0, (btnId - 11) + (midiOctave * 12), currBit === 1 ? 127 : 0);
                    }
                }
            }
            lastButtons[i] = curr;
        }
    }
}

// Parse trackball report (ID 05)
function parseTrackballReport(data) {
    // Final correct offsets:
    // Left: X@1 (int32), Y@5 (int32), Wheel@9 (int16)
    // Center: X@13 (int32), Y@17 (int32), Wheel@21 (int16)
    // Right: X@25 (int32), Y@29 (int32), Wheel@33 (int16)
    const zones = [
        { id: 'left',   ballX: 1,  ballY: 5,  wheel: 9 },
        { id: 'center', ballX: 13, ballY: 17, wheel: 21 },
        { id: 'right',  ballX: 25, ballY: 29, wheel: 33 },
    ];

    for (const zone of zones) {
        let rawX = 0, rawY = 0, wheel = 0;
        try { rawX = data.readInt32LE(zone.ballX); } catch(e) {}
        try { rawY = data.readInt32LE(zone.ballY); } catch(e) {}
        try { wheel = data.readInt16LE(zone.wheel); } catch(e) {}

        // Ball - apply speed scale to raw values
        const scaledRawX = rawX * speedScales.ball[zone.id];
        const scaledRawY = rawY * speedScales.ball[zone.id];
        const x = Math.round(scaledRawX / 4096);
        const y = Math.round(scaledRawY / 4096);

        // Log ALL trackball data for debugging
        logToFile(`[TRK] ${zone.id}: x=${x} y=${y} rawX=${rawX} rawY=${rawY} wheel=${wheel}`);

        // Ball - no threshold for debugging, log everything
        if (x !== 0 || y !== 0) {
            const event = { type: 'trackball', id: zone.id, x: x, y: y, rawX: rawX, rawY: rawY };
            broadcast(event);
            logEvent(event);
            // MIDI CC for trackball position with speed scale already applied in x/y
            sendMidi('cc', 0, 1, Math.min(127, Math.abs(x)));
            sendMidi('cc', 0, 2, Math.min(127, Math.abs(y)));
        }
        
        // Wheel - log all wheel data
        if (wheel !== 0) {
            const lastWheel = wheelPositions[zone.id] || 0;
            wheelPositions[zone.id] = wheel;

            const delta = normalizeDelta16(wheel);
            const scaledDelta = delta * speedScales.wheel[zone.id];
            const steps = Math.round(Math.abs(scaledDelta) / 4096);
            let direction = delta > 0 ? 1 : -1;

            const now = Date.now();
            const state = wheelMotionState[zone.id];
            const withinBurstWindow = (now - state.ts) < 120;
            const oppositeBlip = state.dir !== 0 && direction !== state.dir && steps <= 1 && withinBurstWindow;
            if (oppositeBlip) {
                direction = state.dir;
            } else {
                state.dir = direction;
                state.ts = now;
            }

            if (steps > 0) {
                logToFile(`[WHL] ${zone.id}: wheel=${wheel} last=${lastWheel} delta=${delta} steps=${steps} dir=${direction}`);

                const zoneIndex = zone.id === 'left' ? 0 : zone.id === 'center' ? 1 : 2;
                wheelValues[zoneIndex] = Math.max(0, Math.min(127, wheelValues[zoneIndex] + (direction * WHEEL_STEP * Math.min(steps, 5))));

                const event = { type: 'jog', id: zone.id, value: direction * WHEEL_STEP, raw: wheel, delta: delta, steps: steps };
                broadcast(event);
                logEvent(event);
                sendMidi('cc', 0, 0, wheelValues[zoneIndex]);
            }
        }
    }
}

const UNITS_PER_DETENT = 360;

let rotaryLastRaw = new Array(12).fill(0);
let rotaryPosition = new Array(12).fill(0); // Synthetic position

// Parse encoder report (ID 06) - TREAT RAW AS VELOCITY
function parseEncoderReport(data) {
    for (let i = 0; i < 12; i++) {
        const offset = 1 + i * 4;
        if (offset + 1 >= data.length) break;
        
        // Read raw velocity value
        const raw = data.readUInt16LE(offset);
        
        // Skip if same as last (no movement)
        if (raw === rotaryLastRaw[i]) continue;
        
        // Calculate velocity (delta from zero center)
        // Values > 32768 are negative (two's complement)
        let velocity = raw;
        if (velocity > 32768) velocity -= 65536;
        
        // Apply speed scale to velocity
        velocity = velocity * speedScales.rotary[i];
        
        // Skip tiny noise
        if (Math.abs(velocity) < 90) continue;
        
        // Accumulate to synthetic position
        rotaryPosition[i] += velocity;
        
        // Calculate detents from position
        const detents = Math.trunc(rotaryPosition[i] / 360);
        
        if (detents !== 0) {
            // Consume detents
            rotaryPosition[i] -= detents * 360;
            
            // Send MIDI with speed scale applied
            const scaledStep = ROTARY_STEP * speedScales.rotary[i];
            rotaryValues[i] = Math.max(0, Math.min(127, rotaryValues[i] + (detents * scaledStep)));
            const note = Number.isFinite(controlMidiNotes.rotary[i]) ? controlMidiNotes.rotary[i] : (60 + i);
            sendMidi('note', 0, note, rotaryValues[i]);
            
            logToFile(`[ROTARY] id=${i} vel=${velocity} pos=${rotaryPosition[i]} detents=${detents}`);
        }
        
        rotaryLastRaw[i] = raw;
        
        // Broadcast to UI - send velocity as delta for UI compatibility
        broadcast({ 
            type: 'encoder', 
            id: i, 
            delta: velocity,
            detents: detents || 0,
            value: rotaryValues[i]
        });
    }
}

// Start reading from endpoint
const endpoint = iface.endpoints.find(e => e.direction === 'in');

endpoint.startPoll(3, 64);

endpoint.on('data', (data) => {
    const reportId = data[0];

    if (reportId === 0x02) {
        parseButtonReport(data);
    } else if (reportId === 0x05) {
        parseTrackballReport(data);
    } else if (reportId === 0x06) {
        parseEncoderReport(data);
    }
});

endpoint.on('error', (err) => {
    console.log('Endpoint error:', err.message);
});

// Start HTTP server for GUI
const httpServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }
    
    // Serve GUI files
    if (req.method === 'GET' && (req.url === '/' || req.url === '/gui.html' || req.url === '/index.html')) {
        try {
            const html = fs.readFileSync('./DaVinci Micro Color Panel - Editor.html', 'utf8');
            res.writeHead(200, { 'Content-Type': 'text/html' });
            res.end(html);
            return;
        } catch (e) {
            res.writeHead(404);
            res.end('Not found');
            return;
        }
    }
    
    // Serve static files (Panel.svg, etc.)
    if (req.method === 'GET') {
        const filePath = '.' + req.url;
        const ext = path.extname(filePath);
        const contentTypes = {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.json': 'application/json',
            '.svg': 'image/svg+xml',
            '.jpg': 'image/jpeg',
            '.png': 'image/png'
        };
        const contentType = contentTypes[ext] || 'text/plain';
        
        try {
            const content = fs.readFileSync(filePath);
            res.writeHead(200, { 'Content-Type': contentType });
            res.end(content);
            return;
        } catch (e) {}
    }
    
    if (req.method === 'POST' && req.url === '/save-config') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            fs.writeFileSync('./panel-config.json', body);
            console.log('📁 Config saved to panel-config.json');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true }));
        });
    } else if (req.method === 'GET' && req.url === '/load-config') {
        try {
            const data = fs.readFileSync('./panel-config.json', 'utf8');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(data);
        } catch (e) {
            res.writeHead(404);
            res.end();
        }
    } else if (req.method === 'GET' && req.url === '/presets') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ presets: Object.keys(presets), current: currentPreset }));
    } else if (req.method === 'POST' && req.url.startsWith('/preset/')) {
        const name = req.url.split('/preset/')[1];
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                presets[name] = data;
                fs.writeFileSync(presetDir + '/' + name + '.json', JSON.stringify(data, null, 2));
                console.log('💾 Preset saved:', name);
                res.writeHead(200);
                res.end(JSON.stringify({ success: true }));
            } catch(e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
    } else if (req.method === 'POST' && req.url === '/set-preset') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                currentPreset = data.name;
                midiOctave = presets[currentPreset]?.octave || 0;
                broadcast({ type: 'presetChanged', name: currentPreset, octave: midiOctave });
                res.writeHead(200);
                res.end(JSON.stringify({ success: true }));
            } catch(e) {
                res.writeHead(400);
                res.end();
            }
        });
    } else if (req.method === 'DELETE' && req.url.startsWith('/preset/')) {
        const name = req.url.split('/preset/')[1];
        if (name !== 'default' && presets[name]) {
            delete presets[name];
            try { fs.unlinkSync(presetDir + '/' + name + '.json'); } catch(e) {}
            console.log('🗑️ Preset deleted:', name);
        }
        res.writeHead(200);
        res.end();
    } else if (req.method === 'GET' && req.url.startsWith('/export/')) {
        const name = req.url.split('/export/')[1];
        res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Disposition': 'attachment; filename="' + name + '.json"' });
        res.end(JSON.stringify(presets[name] || {}, null, 2));
    } else {
        res.writeHead(404);
        res.end();
    }
});

httpServer.listen(8766, () => {
    console.log('🌐 HTTP Server: http://localhost:8766');
    
    // Open browser automatically
    const url = 'http://localhost:8766';
    const browserCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${browserCmd} ${url}`, (err) => {
        if (err) console.log('Could not open browser automatically');
    });
});

// Start WebSocket server
const wss = new WebSocketServer({ port: WS_PORT });

console.log('🔌 WebSocket server started on port', WS_PORT);

wss.on('connection', (ws) => {
    clients.add(ws);
    console.log('🔌 Client connected! Total:', clients.size);
    ws.send(JSON.stringify({ type: 'connected' }));
    
    // Send MIDI ports list to new client
    ws.send(JSON.stringify({ type: 'midiPorts', ports: midiPorts }));
    ws.send(JSON.stringify({ type: 'rotaryCalibrationAll', unitsPerDetent: rotaryUnitsPerDetent }));
    ws.send(JSON.stringify({
        type: 'calibrationAll',
        rotaryUnitsPerDetent,
        wheelDegPerStep: wheelDegPerStepServer,
        ballCalibration: ballCalibrationServer
    }));
    ws.send(JSON.stringify({ type: 'midiChannel', value: midiChannel }));
    ws.send(JSON.stringify({ type: 'controlMidiNoteMap', map: controlMidiNotes }));
    ws.send(JSON.stringify({ type: 'appleDlsSynthState', enabled: appleDlsSoundEnabled, port: currentMidiPortName }));

    ws.on('message', (msg) => {
        try {
            const data = JSON.parse(msg);
            if (data.type === 'setBacklight') {
                const b = Math.max(0, Math.min(100, parseInt(data.value) || 0));
                currentBrightness = b;
                lightsOn = b > 0;
                device.controlTransfer(0x21, 0x09, 0x030a, 0x0002, Buffer.from([0x0a, 0x01]));
                device.controlTransfer(0x21, 0x09, 0x0303, 0x0002, Buffer.from([0x03, b, b]));
            } else if (data.type === 'setMidiDevice') {
                const idx = parseInt(data.index);
                if (idx >= 0 && idx < midiPorts.length && JZZ) {
                    if (openMidiOutByName(midiPorts[idx])) {
                        appleDlsSoundEnabled = false;
                        console.log('✅ MIDI output changed to:', midiPorts[idx]);
                        ws.send(JSON.stringify({ type: 'midiDeviceChanged', name: midiPorts[idx] }));
                        broadcast({ type: 'appleDlsSynthState', enabled: appleDlsSoundEnabled, port: currentMidiPortName });
                    }
                }
            } else if (data.type === 'setOctave') {
                midiOctave = Math.max(-3, Math.min(3, parseInt(data.value) || 0));
                console.log('🎹 Octave:', midiOctave);
                broadcast({ type: 'octave', value: midiOctave });
                if (presets[currentPreset]) {
                    presets[currentPreset].octave = midiOctave;
                }
            } else if (data.type === 'setMidiChannel') {
                midiChannel = Math.max(0, Math.min(15, parseInt(data.value) || 0));
                broadcast({ type: 'midiChannel', value: midiChannel });
                console.log('🎹 MIDI channel:', midiChannel + 1);
            } else if (data.type === 'setControlMidiNote') {
                const controlType = String(data.controlType || '');
                const id = Number(data.id);
                const note = data.note === null || data.note === undefined || data.note === ''
                    ? null
                    : Number(data.note);

                if (controlType === 'button' && Number.isFinite(id) && id >= 12 && id <= 51) {
                    if (note === null) {
                        delete controlMidiNotes.button[id];
                    } else if (Number.isFinite(note) && note >= 0 && note <= 127) {
                        controlMidiNotes.button[id] = Math.round(note);
                    }
                    saveCalibration();
                    broadcast({ type: 'controlMidiNoteMap', map: controlMidiNotes });
                } else if (controlType === 'rotary' && Number.isFinite(id) && id >= 0 && id < 12) {
                    if (note !== null && Number.isFinite(note) && note >= 0 && note <= 127) {
                        controlMidiNotes.rotary[id] = Math.round(note);
                        saveCalibration();
                        broadcast({ type: 'controlMidiNoteMap', map: controlMidiNotes });
                    }
                }
            } else if (data.type === 'getControlMidiNoteMap') {
                ws.send(JSON.stringify({ type: 'controlMidiNoteMap', map: controlMidiNotes }));
            } else if (data.type === 'getPresets') {
                ws.send(JSON.stringify({ type: 'presets', presets: Object.keys(presets), current: currentPreset }));
            } else if (data.type === 'savePreset') {
                const name = data.name || 'default';
                presets[name] = presets[name] || {};
                presets[name].octave = midiOctave;
                fs.writeFileSync(presetDir + '/' + name + '.json', JSON.stringify(presets[name], null, 2));
                currentPreset = name;
                console.log('💾 Preset saved:', name);
                ws.send(JSON.stringify({ type: 'presetSaved', name }));
            } else if (data.type === 'loadPreset') {
                const name = data.name;
                if (presets[name]) {
                    currentPreset = name;
                    midiOctave = presets[name].octave || 0;
                    broadcast({ type: 'presetLoaded', name, octave: midiOctave });
                }
            } else if (data.type === 'deletePreset') {
                const name = data.name;
                if (name !== 'default' && presets[name]) {
                    delete presets[name];
                    try { fs.unlinkSync(presetDir + '/' + name + '.json'); } catch(e) {}
                    console.log('🗑️ Preset deleted:', name);
                    loadPresets();
                    broadcast({ type: 'presets', presets: Object.keys(presets), current: currentPreset });
                }
            } else if (data.type === 'toggleMidi') {
                midiEnabled = data.enabled;
                broadcast({ type: 'midiToggled', enabled: midiEnabled });
                console.log('🎹 MIDI', midiEnabled ? 'enabled' : 'disabled');
            } else if (data.type === 'refreshMidi') {
                midiPorts = jzz.info().outputs.map(p => p.name);
                broadcast({ type: 'midiPorts', ports: midiPorts });
                console.log('🔄 MIDI ports refreshed:', midiPorts.length);
            } else if (data.type === 'toggleAppleDlsSynth') {
                const enabled = !!data.enabled;
                if (enabled) {
                    const dlsPort = midiPorts.find(p => p.toLowerCase().includes('dls synth'));
                    if (dlsPort) {
                        previousMidiPortName = currentMidiPortName;
                        if (openMidiOutByName(dlsPort)) {
                            appleDlsSoundEnabled = true;
                            midiEnabled = true;
                            broadcast({ type: 'appleDlsSynthState', enabled: true, port: currentMidiPortName });
                            logToFile(`[SYNTH] Apple DLS ON port=${currentMidiPortName}`);
                        }
                    } else {
                        ws.send(JSON.stringify({ type: 'appleDlsSynthState', enabled: false, port: currentMidiPortName, error: 'Apple DLS Synth not found' }));
                    }
                } else {
                    appleDlsSoundEnabled = false;
                    if (previousMidiPortName) {
                        openMidiOutByName(previousMidiPortName);
                    }
                    broadcast({ type: 'appleDlsSynthState', enabled: false, port: currentMidiPortName });
                    logToFile('[SYNTH] Apple DLS OFF');
                }
            } else if (data.type === 'setRotaryCalibration') {
                const id = parseInt(data.id);
                const units = Number(data.unitsPerDetent);
                if (id >= 0 && id < 12 && Number.isFinite(units) && units >= 1 && units <= 200000) {
                    rotaryUnitsPerDetent[id] = units;
                    saveCalibration();
                    broadcast({ type: 'rotaryCalibration', id, unitsPerDetent: units });
                    logToFile(`[CAL] rotary=${id} unitsPerDetent=${units.toFixed(2)}`);
                }
            } else if (data.type === 'getRotaryCalibration') {
                ws.send(JSON.stringify({ type: 'rotaryCalibrationAll', unitsPerDetent: rotaryUnitsPerDetent }));
            } else if (data.type === 'setCalibrationAll') {
                const r = data.rotaryUnitsPerDetent;
                if (Array.isArray(r) && r.length === 12) {
                    for (let i = 0; i < 12; i++) {
                        const v = Number(r[i]);
                        if (Number.isFinite(v) && v >= 1 && v <= 200000) {
                            rotaryUnitsPerDetent[i] = v;
                        }
                    }
                }

                const w = data.wheelDegPerStep || {};
                ['left', 'center', 'right'].forEach((id) => {
                    const v = Number(w[id]);
                    if (Number.isFinite(v) && v > 0.05 && v < 12) {
                        wheelDegPerStepServer[id] = v;
                    }
                });

                const b = data.ballCalibration || {};
                ['left', 'center', 'right'].forEach((id) => {
                    const cfg = b[id] || {};
                    ballCalibrationServer[id].xSign = cfg.xSign === -1 ? -1 : 1;
                    ballCalibrationServer[id].ySign = cfg.ySign === -1 ? -1 : 1;
                    const gain = Number(cfg.gain);
                    if (Number.isFinite(gain) && gain > 0.01 && gain < 1) {
                        ballCalibrationServer[id].gain = gain;
                    }
                    const dom = Number(cfg.dominance);
                    if (Number.isFinite(dom) && dom > 1 && dom < 6) {
                        ballCalibrationServer[id].dominance = dom;
                    }
                });

                saveCalibration();
                broadcast({
                    type: 'calibrationAll',
                    rotaryUnitsPerDetent,
                    wheelDegPerStep: wheelDegPerStepServer,
                    ballCalibration: ballCalibrationServer
                });
                logToFile('[CAL] setCalibrationAll');
            } else if (data.type === 'getCalibrationAll') {
                ws.send(JSON.stringify({
                    type: 'calibrationAll',
                    rotaryUnitsPerDetent,
                    wheelDegPerStep: wheelDegPerStepServer,
                    ballCalibration: ballCalibrationServer
                }));
            } else if (data.type === 'setSpeedScale') {
                // Handle reset command
                if (data.reset) {
                    const which = data.reset;
                    if (which === 'all' || which === 'rotary') {
                        for (let i = 0; i < 12; i++) speedScales.rotary[i] = 1;
                    }
                    if (which === 'all' || which === 'wheel') {
                        speedScales.wheel = { left: 1, center: 1, right: 1 };
                    }
                    if (which === 'all' || which === 'ball') {
                        speedScales.ball = { left: 1, center: 1, right: 1 };
                    }
                    logToFile(`[SPEED] Reset ${which} to 1.0x`);
                } else {
                    // Handle individual speed scale update
                    const controlType = data.controlType;
                    const id = data.id;
                    const value = Number(data.value);
                    
                    if (Number.isFinite(value) && value >= 0.1 && value <= 5) {
                        if (controlType === 'rotary' && id >= 0 && id < 12) {
                            speedScales.rotary[id] = value;
                            logToFile(`[SPEED] rotary ${id} = ${value.toFixed(1)}x`);
                        } else if (controlType === 'wheel' && ['left', 'center', 'right'].includes(id)) {
                            speedScales.wheel[id] = value;
                            logToFile(`[SPEED] wheel ${id} = ${value.toFixed(1)}x`);
                        } else if (controlType === 'ball' && ['left', 'center', 'right'].includes(id)) {
                            speedScales.ball[id] = value;
                            logToFile(`[SPEED] ball ${id} = ${value.toFixed(1)}x`);
                        }
                    }
                }
            }
        } catch(e) {}
    });

    ws.on('close', () => {
        clients.delete(ws);
        console.log('🔌 Client disconnected');
    });
});

// Cleanup function - turn off lights
function cleanup() {
    console.log('\n🔄 Turning off panel lights...');
    try {
        device.controlTransfer(0x21, 0x09, 0x030a, 0x0002, Buffer.from([0x0a, 0x01]));
        device.controlTransfer(0x21, 0x09, 0x0303, 0x0002, Buffer.from([0x03, 0x00, 0x00]));
    } catch (e) {
        console.log('Could not turn off lights:', e.message);
    }
    
    try {
        iface.release();
    } catch (e) {}
    
    try {
        device.close();
    } catch (e) {}
    
    process.exit(0);
}

// Handle shutdown signals
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

// Read stdin for keyboard shortcuts
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.on('data', (key) => {
    const k = key.toString();
    if (k === 'q' || k === 'Q') {
        console.log('\nQuit requested');
        cleanup();
    } else if (k === 'l' || k === 'L') {
        lightsOn = !lightsOn;
        const brightness = lightsOn ? 100 : 0;
        try {
            device.controlTransfer(0x21, 0x09, 0x030a, 0x0002, Buffer.from([0x0a, 0x01]));
            device.controlTransfer(0x21, 0x09, 0x0303, 0x0002, Buffer.from([0x03, brightness, brightness]));
            console.log('💡 Lights ' + (lightsOn ? 'ON' : 'OFF'));
        } catch (e) {}
    }
});

console.log('\n🌐 Web GUI: http://localhost:8766');
console.log('🔌 WebSocket: ws://localhost:8765');
console.log('Press Ctrl+C to stop');
console.log('💡 Panel will turn off when server stops');