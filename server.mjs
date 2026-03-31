import usb from 'usb';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';

function dbg(line) { }

function logEvent(data) { }

console.log('🎛️ DaVinci Micro Color Panel - Web GUI Server');
console.log('='.repeat(50));
console.log('💡 Run with sudo: sudo node server.mjs');

// MIDI Setup - import dynamically
let midiOut = null;
let rotaryValues = new Array(12).fill(0);
let rotaryLastTime = new Array(12).fill(0);
let ROTARY_THROTTLE_MS = 5;
let ROTARY_STEP = 1;
let BALL_STEP = 1;
let BALL_THROTTLE_MS = 0;
let WHEEL_STEP = 1;
let WHEEL_THROTTLE_MS = 0;
let ballLastTime = { left: 0, center: 0, right: 0 };
let wheelLastTime = { left: 0, center: 0, right: 0 };
let wheelPositions = { left: 0, center: 0, right: 0 };
let wheelValues = new Array(3).fill(0);
let midiPorts = [];
let midiOctave = 0;
let midiEnabled = true;
let JZZ;

// Presets system
let presets = {};
let currentPreset = 'default';
let presetDir = './presets';

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
    
    // Default preset - same as Lightroom for compatibility
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
    
    // Lightroom preset
    presets['Lightroom'] = {
        name: 'Lightroom',
        octave: 0,
        buttonNotes: {
            49: { note: 37, channel: 0 },  // RWD → Previous photo (C2)
            50: { note: 38, channel: 0 },  // FWD → Next photo (D2)
            51: { note: 39, channel: 0 },  // STOP → Toggle view (E2)
            39: { note: 40, channel: 0 },  // PREV STILL
            40: { note: 41, channel: 0 },   // NEXT STILL
            33: { note: 42, channel: 0 },   // RESET LIFT
            34: { note: 43, channel: 0 },   // RESET GAMMA
            35: { note: 44, channel: 0 }    // RESET GAIN
        }
    };
    
    // Logic Pro Transport preset
    presets['Logic Pro Transport'] = {
        name: 'Logic Pro Transport',
        octave: 0,
        buttonNotes: {
            49: { note: 42, channel: 0 },  // RWD → Rewind (G2)
            50: { note: 44, channel: 0 },  // FWD → Fast Forward (A2)
            51: { note: 45, channel: 0 },  // STOP → Play/Stop toggle (B2)
            26: { note: 45, channel: 0 },  // PLAY STILL → Play
            51: { note: 47, channel: 0 }   // STOP → Stop (C3)
        }
    };
}
loadPresets();
try {
    const jzzModule = await import('jzz');
    JZZ = jzzModule.default;
    const jzz = JZZ();
    midiPorts = jzz.info().outputs.map(p => p.name);
    console.log('\n🎹 Available MIDI outputs:', midiPorts.length ? midiPorts.join(', ') : 'none');
    
    // Auto-connect to IAC Driver if available, otherwise skip
    const iacIndex = midiPorts.findIndex(p => p.toLowerCase().includes('iac'));
    if (iacIndex >= 0) {
        const jzz2 = JZZ();
        midiOut = jzz2.openMidiOut(midiPorts[iacIndex]);
        console.log('✅ Auto-connected to IAC Driver:', midiPorts[iacIndex]);
    } else {
        console.log('⚠️ No IAC Driver found - select manually');
    }
} catch(e) {
    console.log('⚠️ MIDI not available:', e.message);
}

function sendMidi(type, channel, note, velocity) {
    if (!midiEnabled || !midiOut) return;
    try {
        if (type === 'note') {
            midiOut.send([0x90 + channel, note, velocity]);
            console.log(`🎹 NOTE ch${channel+1} n${note} v${velocity}`);
        } else if (type === 'cc') {
            midiOut.send([0xb0 + channel, note, velocity]);
            console.log(`🎹 CC ch${channel+1} n${note} v${velocity}`);
        }
    } catch(e) { console.log('MIDI error:', e); }
    
    // Broadcast MIDI to GUI
    const midiEvent = { type: 'midi', midiType: type, channel, note, velocity };
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
                    const event = { type: 'button', id: btnId, pressed: currBit === 1 };
                    broadcast(event);
                    logEvent(event);
                    
                    // Check preset for custom button mapping
                    const preset = presets[currentPreset];
                    const btnMapping = preset?.buttonNotes?.[btnId];
                    
                    if (btnMapping) {
                        // Custom mapping from preset
                        sendMidi('note', btnMapping.channel, btnMapping.note, currBit === 1 ? 127 : 0);
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
    // Left: X@1, Y@3, Wheel@9
    // Center: X@13, Y@15, Wheel@21
    // Right: X@25, Y@27, Wheel@33
    const zones = [
        { id: 'left',   ballX: 1,  ballY: 3,  wheel: 9 },
        { id: 'center', ballX: 13, ballY: 15, wheel: 21 },
        { id: 'right',  ballX: 25, ballY: 27, wheel: 33 },
    ];

    for (const zone of zones) {
        let x = 0, y = 0, wheel = 0;
        try { x = data.readInt16LE(zone.ballX); } catch(e) {}
        try { y = data.readInt16LE(zone.ballY); } catch(e) {}
        try { wheel = data.readInt16LE(zone.wheel); } catch(e) {}

        // Ball - threshold 30
        if (Math.abs(x) > 30 || Math.abs(y) > 30) {
            const now = Date.now();
            if (now - ballLastTime[zone.id] < BALL_THROTTLE_MS) return;
            ballLastTime[zone.id] = now;
            
            const event = { type: 'trackball', id: zone.id, x: Math.sign(x) * BALL_STEP, y: Math.sign(y) * BALL_STEP };
            broadcast(event);
            logEvent(event);
            // MIDI CC for trackball position - same channel for all
            sendMidi('cc', 0, 1, Math.min(127, Math.abs(x)));
            sendMidi('cc', 0, 2, Math.min(127, Math.abs(y)));
        }
        
        // Wheel - only when ball is not moving
        if (Math.abs(x) <= 30 && Math.abs(y) <= 30) {
            if (wheel !== 0) {
                const now = Date.now();
                if (now - wheelLastTime[zone.id] < WHEEL_THROTTLE_MS) return;
                wheelLastTime[zone.id] = now;
                
                // Calculate delta from last position - this represents speed
                const lastWheel = wheelPositions[zone.id] || 0;
                const delta = wheel - lastWheel;
                wheelPositions[zone.id] = wheel;
                
                // Each detent is 4096 - get step count (can be multiple if moving fast)
                const steps = Math.abs(delta) >> 12;
                const direction = delta > 0 ? 1 : -1;
                
                console.log(`🎡 Wheel ${zone.id}: wheel=${wheel}, lastWheel=${lastWheel}, delta=${delta}, steps=${steps}, dir=${direction}`);
                
                // Update wheel value like balls - just sign * step
                const zoneIndex = zone.id === 'left' ? 0 : zone.id === 'center' ? 1 : 2;
                wheelValues[zoneIndex] = Math.max(0, Math.min(127, wheelValues[zoneIndex] + (direction * WHEEL_STEP)));
                
                const event = { type: 'jog', id: zone.id, value: direction * WHEEL_STEP };
                broadcast(event);
                logEvent(event);
                // MIDI CC for jog wheel - channel 0
                sendMidi('cc', 0, 0, wheelValues[zoneIndex]);
            }
        }
    }
}

// Parse encoder report (ID 06)
function parseEncoderReport(data) {
    // 12 encoders, 4-byte stride: offsets 1,5,9,13,17,21,25,29,33,37,41,45
    // Values are multiples of 4096; >> 12 gives integer deltas (±1 per detent)
    for (let i = 0; i < 12; i++) {
        const offset = 1 + i * 4;
        if (offset + 1 >= data.length) break;
        const raw = data.readInt16LE(offset);
        if (raw === 0) continue;
        const value = raw >> 12;
        console.log(`🎛️ Rotary ${i}: raw=${raw}, value=${value}`);
        if (value) {
            const now = Date.now();
            if (now - rotaryLastTime[i] < ROTARY_THROTTLE_MS) continue;
            rotaryLastTime[i] = now;
            
            const event = { type: 'encoder', id: i, value: value > 0 ? 1 : -1, direction: value > 0 ? 1 : -1 };
            broadcast(event);
            logEvent(event);
            // MIDI notes for rotary encoders - notes 60-71 (C4 to B4)
            rotaryValues[i] = Math.max(0, Math.min(127, rotaryValues[i] + (value > 0 ? ROTARY_STEP : -ROTARY_STEP)));
            sendMidi('note', 0, 60 + i, rotaryValues[i]);
        }
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
                    try { midiOut.close(); } catch(e) {}
                    const jzz = JZZ();
                    midiOut = jzz.openMidiOut(midiPorts[idx]);
                    console.log('✅ MIDI output changed to:', midiPorts[idx]);
                    ws.send(JSON.stringify({ type: 'midiDeviceChanged', name: midiPorts[idx] }));
                }
            } else if (data.type === 'setOctave') {
                midiOctave = Math.max(-3, Math.min(3, parseInt(data.value) || 0));
                console.log('🎹 Octave:', midiOctave);
                broadcast({ type: 'octave', value: midiOctave });
                if (presets[currentPreset]) {
                    presets[currentPreset].octave = midiOctave;
                }
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
            } else if (data.type === 'setSetting') {
                if (data.name === 'rotaryStep') ROTARY_STEP = data.value;
                else if (data.name === 'rotaryThrottle') ROTARY_THROTTLE_MS = data.value;
                else if (data.name === 'ballStep') BALL_STEP = data.value;
                else if (data.name === 'ballThrottle') BALL_THROTTLE_MS = data.value;
                else if (data.name === 'wheelStep') WHEEL_STEP = data.value;
                else if (data.name === 'wheelThrottle') WHEEL_THROTTLE_MS = data.value;
                console.log('⚙️ Setting:', data.name, '=', data.value);
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