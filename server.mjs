import usb from 'usb';
import { WebSocketServer } from 'ws';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { exec } from 'child_process';
import { createHash } from 'crypto';

// Debug logging to file
const logFile = fs.createWriteStream('./debug.log', { flags: 'a' });
function logToFile(msg) {
    const timestamp = new Date().toISOString();
    logFile.write(`${timestamp} ${msg}\n`);
}

function dbg(line) { logToFile(`[DBG] ${line}`); }

function logEvent(data) { logToFile(`[EVT] ${JSON.stringify(data)}`); }

// ── HTTP Basic Auth ───────────────────────────────────────────────────────────
const authFile = path.join(process.cwd(), 'auth.json');
let authPasswordHash = null;

function loadAuth() {
    try {
        if (fs.existsSync(authFile)) {
            const parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'));
            authPasswordHash = parsed.passwordHash || null;
        }
    } catch (e) {}
    if (authPasswordHash) {
        console.log('🔒 Password protection enabled');
    } else {
        console.log('🔓 No password set — GUI is open access');
    }
}

function saveAuth() {
    fs.writeFileSync(authFile, JSON.stringify({ passwordHash: authPasswordHash }, null, 2));
}

function hashPassword(pw) {
    return createHash('sha256').update(pw).digest('hex');
}

function checkAuth(req, res) {
    if (!authPasswordHash) return true;
    const header = req.headers['authorization'];
    if (header && header.startsWith('Basic ')) {
        const decoded = Buffer.from(header.slice(6), 'base64').toString('utf8');
        const password = decoded.includes(':') ? decoded.split(':').slice(1).join(':') : decoded;
        if (hashPassword(password) === authPasswordHash) return true;
    }
    res.writeHead(401, {
        'WWW-Authenticate': 'Basic realm="Micro Color Panel"',
        'Content-Type': 'text/plain'
    });
    res.end('Authentication required');
    return false;
}

loadAuth();

console.log('🎛️ DaVinci Micro Color Panel - Web GUI Server');
console.log('='.repeat(50));
console.log('💡 Run with sudo: sudo node server.mjs');

// MIDI Setup - import dynamically
let midiOut = null;
let rotaryLastTime = new Array(12).fill(0);
let rotaryUnitsPerDetent = new Array(12).fill(360);
let ROTARY_THROTTLE_MS = 0;

// Rotary velocity calibration bounds — must be declared here so loadCalibration()
// (called early) can update them before parseEncoderReport uses them.
let rotaryVelMin = 1080;  // absolute velocity at the slowest detectable turn
let rotaryVelMax = 32767; // absolute velocity at the fastest turn
let _rlogK, _rlogB;
function recomputeRotaryLogScale() {
    _rlogK = 126 / Math.log(rotaryVelMax / rotaryVelMin);
    _rlogB = 1 - _rlogK * Math.log(rotaryVelMin);
}
recomputeRotaryLogScale();
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
    rotary:    Array.from({ length: 12 }, (_, i) => 60 + i),
    rotaryCCW: Array.from({ length: 12 }, (_, i) => 72 + i)  // default CCW notes = CW + 12
};
let wheelDegPerStepServer = { ...defaultWheelDegPerStep };
let ballCalibrationServer = {
    left: { ...defaultBallCalibration.left },
    center: { ...defaultBallCalibration.center },
    right: { ...defaultBallCalibration.right }
};
let controlMidiNotes = {
    button: {},
    rotary:    [...defaultControlMidiNotes.rotary],
    rotaryCCW: [...defaultControlMidiNotes.rotaryCCW]
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

            const rotaryCCWMap = noteParsed.rotaryCCW;
            if (Array.isArray(rotaryCCWMap) && rotaryCCWMap.length === 12) {
                for (let i = 0; i < 12; i++) {
                    const n = Number(rotaryCCWMap[i]);
                    if (Number.isFinite(n) && n >= 0 && n <= 127) {
                        controlMidiNotes.rotaryCCW[i] = Math.round(n);
                    }
                }
            }
        }

        const velMin = Number(parsed?.rotaryVelMin);
        const velMax = Number(parsed?.rotaryVelMax);
        if (Number.isFinite(velMin) && velMin >= 1) rotaryVelMin = velMin;
        if (Number.isFinite(velMax) && velMax > rotaryVelMin) rotaryVelMax = velMax;
        recomputeRotaryLogScale();

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
                rotaryVelMin,
                rotaryVelMax,
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

        const x = Math.round(rawX / 4096);
        const y = Math.round(rawY / 4096);

        logToFile(`[TRK] ${zone.id}: x=${x} y=${y} rawX=${rawX} rawY=${rawY} wheel=${wheel}`);

        // ── Ball — relative CC per axis per zone ────────────────────────────
        // CC layout: left X/Y = 1/2, center X/Y = 3/4, right X/Y = 5/6
        if (x !== 0 || y !== 0) {
            const zoneBase = zone.id === 'left' ? 1 : zone.id === 'center' ? 3 : 5;
            const toRelCC = v => v === 0 ? 0 : v > 0
                ? Math.min(63, Math.max(1, Math.abs(v)))
                : 128 - Math.min(63, Math.max(1, Math.abs(v)));
            const ccX = toRelCC(x);
            const ccY = toRelCC(y);
            if (x !== 0) sendMidi('cc', 0, zoneBase,     ccX);
            if (y !== 0) sendMidi('cc', 0, zoneBase + 1, ccY);

            const event = { type: 'trackball', id: zone.id, x, y, rawX, rawY };
            broadcast(event);
            logEvent(event);
        }

        // ── Wheel — relative CC proportional to degrees rotated ─────────────
        // CC layout: left = 7, center = 8, right = 9
        if (wheel !== 0) {
            const lastWheel = wheelPositions[zone.id] || 0;
            wheelPositions[zone.id] = wheel;

            const delta = normalizeDelta16(wheel);
            const steps = Math.round(Math.abs(delta) / 4096);
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
                const degrees = steps * (wheelDegPerStepServer[zone.id] || 1);
                // 360° = CC 63 (full relative range for one full rotation)
                const ccMag = Math.min(63, Math.max(1, Math.round(degrees * 63 / 360)));
                const ccVal = direction > 0 ? ccMag : 128 - ccMag;
                const ccNum = zone.id === 'left' ? 7 : zone.id === 'center' ? 8 : 9;

                logToFile(`[WHL] ${zone.id}: steps=${steps} deg=${degrees.toFixed(2)} ccMag=${ccMag} ccVal=${ccVal}`);

                const event = { type: 'jog', id: zone.id, value: direction, raw: wheel, delta, steps };
                broadcast(event);
                logEvent(event);
                sendMidi('cc', 0, ccNum, ccVal);
            }
        }
    }
}

// ── Rotary velocity calibration ──────────────────────────────────────────────
// rotaryVelMin/Max and recomputeRotaryLogScale() are declared near the top of
// the file so loadCalibration() can update bounds before any encoder events fire.

// Active calibration session state
let rotaryVelCalib = {
    active: false,
    phase: null,           // 'slow' | 'fast'
    observedMin: Infinity,
    observedMax: 0
};

// Direction hysteresis — require DIRECTION_CONFIRM consecutive frames agreeing
// on a new direction before accepting the flip. Prevents false reversals.
const DIRECTION_CONFIRM = 2;
let rotaryDirConfirmed    = new Array(12).fill(0); // 1=CW, -1=CCW, 0=unknown
let rotaryDirPending      = new Array(12).fill(0);
let rotaryDirPendingCount = new Array(12).fill(0);

let rotaryLastRaw = new Array(12).fill(0);

// Parse encoder report (ID 06) — rotation-proportional relative CC.
// CC number = controlMidiNotes.rotary[i]. Direction + magnitude in CC value:
//   CW = 1–63, CCW = 65–127 (2's-complement relative encoding).
// Magnitude ∝ physical rotation per poll → total CC delta for a fixed angle is
// constant regardless of turning speed.
function parseEncoderReport(data) {
    for (let i = 0; i < 12; i++) {
        const offset = 1 + i * 4;
        if (offset + 1 >= data.length) break;

        const raw = data.readUInt16LE(offset);
        if (raw === rotaryLastRaw[i]) continue;

        // Two's-complement signed velocity
        let velocity = raw > 32768 ? raw - 65536 : raw;

        // Skip electrical noise
        if (Math.abs(velocity) < 90) continue;

        // ── Direction hysteresis ────────────────────────────────────────────
        const sign = velocity > 0 ? 1 : -1;
        if (sign !== rotaryDirConfirmed[i] && rotaryDirConfirmed[i] !== 0) {
            // Potential direction flip — require confirmation
            if (sign === rotaryDirPending[i]) {
                rotaryDirPendingCount[i]++;
            } else {
                rotaryDirPending[i] = sign;
                rotaryDirPendingCount[i] = 1;
            }
            if (rotaryDirPendingCount[i] < DIRECTION_CONFIRM) {
                rotaryLastRaw[i] = raw; // advance lastRaw so we don't stall
                continue;              // suppress until confirmed
            }
        }
        rotaryDirConfirmed[i] = sign;
        rotaryDirPending[i] = 0;
        rotaryDirPendingCount[i] = 0;

        // ── Velocity calibration recording ──────────────────────────────────
        const absV = Math.abs(velocity);
        if (rotaryVelCalib.active) {
            if (rotaryVelCalib.phase === 'slow') {
                rotaryVelCalib.observedMin = Math.min(rotaryVelCalib.observedMin, absV);
            } else if (rotaryVelCalib.phase === 'fast') {
                rotaryVelCalib.observedMax = Math.max(rotaryVelCalib.observedMax, absV);
            }
        }

        // ── Rotation-proportional relative CC ───────────────────────────────
        // ccMag scales linearly with velocity (= physical rotation per poll).
        // total CC change for a fixed rotation angle is constant regardless of speed.
        const ccMag = Math.min(63, Math.max(1, Math.round(absV * 63 / rotaryVelMax)));
        // Relative CC encoding: CW = 1–63, CCW = 65–127 (standard 2's-complement style)
        const ccVal = sign > 0 ? ccMag : 128 - ccMag;
        const ccNum = Number.isFinite(controlMidiNotes.rotary[i]) ? controlMidiNotes.rotary[i] : (60 + i);
        sendMidi('cc', 0, ccNum, ccVal);

        rotaryLastRaw[i] = raw;
        logToFile(`[ROTARY] id=${i} vel=${velocity} dir=${sign > 0 ? 'CW' : 'CCW'} ccMag=${ccMag} ccVal=${ccVal} cc=${ccNum}`);

        broadcast({
            type: 'encoder',
            id: i,
            delta: velocity,
            detents: sign * ccMag,
            value: ccVal
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

    if (!checkAuth(req, res)) return;

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
    
    // Send server info so client can cache the correct node path for the "how to run" banner
    ws.send(JSON.stringify({ type: 'serverInfo', nodePath: process.execPath, serverDir: process.cwd() }));
    ws.send(JSON.stringify({ type: 'backlight', value: currentBrightness }));

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
                broadcast({ type: 'backlight', value: b });
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
                } else if (controlType === 'rotaryCCW' && Number.isFinite(id) && id >= 0 && id < 12) {
                    if (note !== null && Number.isFinite(note) && note >= 0 && note <= 127) {
                        controlMidiNotes.rotaryCCW[id] = Math.round(note);
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
            } else if (data.type === 'startRotaryVelCalib') {
                // Begin a calibration recording session.
                // phase: 'slow' — user turns knobs as slowly as possible
                // phase: 'fast' — user turns knobs as fast as possible
                const phase = data.phase === 'fast' ? 'fast' : 'slow';
                rotaryVelCalib = {
                    active: true,
                    phase,
                    observedMin: Infinity,
                    observedMax: 0
                };
                logToFile(`[CAL-VEL] started phase=${phase}`);
                broadcast({ type: 'rotaryVelCalibStatus', active: true, phase });

            } else if (data.type === 'stopRotaryVelCalib') {
                // Stop recording and apply the observed bound.
                if (rotaryVelCalib.active) {
                    const { phase, observedMin, observedMax } = rotaryVelCalib;
                    rotaryVelCalib.active = false;

                    let updated = false;
                    if (phase === 'slow' && Number.isFinite(observedMin) && observedMin >= 1) {
                        rotaryVelMin = observedMin;
                        updated = true;
                        logToFile(`[CAL-VEL] slow done → rotaryVelMin=${rotaryVelMin}`);
                    } else if (phase === 'fast' && observedMax > 0) {
                        rotaryVelMax = observedMax;
                        updated = true;
                        logToFile(`[CAL-VEL] fast done → rotaryVelMax=${rotaryVelMax}`);
                    }

                    if (updated && rotaryVelMax > rotaryVelMin) {
                        recomputeRotaryLogScale();
                        saveCalibration();
                        logToFile(`[CAL-VEL] recomputed: K=${_rlogK.toFixed(4)} B=${_rlogB.toFixed(4)}`);
                    }

                    broadcast({
                        type: 'rotaryVelCalibStatus',
                        active: false,
                        phase,
                        rotaryVelMin,
                        rotaryVelMax
                    });
                }

            } else if (data.type === 'setPassword') {
                const { currentPassword, newPassword } = data;
                // If a password is currently set, the correct current password is required
                if (authPasswordHash && hashPassword(String(currentPassword || '')) !== authPasswordHash) {
                    ws.send(JSON.stringify({ type: 'passwordResult', success: false, error: 'Incorrect current password' }));
                    return;
                }
                if (newPassword) {
                    authPasswordHash = hashPassword(String(newPassword));
                    saveAuth();
                    logToFile('[AUTH] Password updated');
                    ws.send(JSON.stringify({ type: 'passwordResult', success: true, message: 'Password set — reload to re-authenticate' }));
                } else {
                    // Empty newPassword = remove auth
                    authPasswordHash = null;
                    saveAuth();
                    logToFile('[AUTH] Password removed');
                    ws.send(JSON.stringify({ type: 'passwordResult', success: true, message: 'Password removed' }));
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