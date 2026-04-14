# Quick Start Guide

## What is this?

This lets you use your Blackmagic DaVinci Resolve Micro Color Panel with other apps like Lightroom, Logic Pro, or any MIDI-compatible software, by converting panel movements into MIDI signals.

---

## Step 1: Install Node.js

**macOS:**
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
brew install node
```

**Windows:** Download the installer from [nodejs.org](https://nodejs.org) (LTS version).

---

## Step 2: Get the project

```bash
git clone https://github.com/alchemy-color/BMD-Micro-Color-Panel-MIDI.git
cd BMD-Micro-Color-Panel-MIDI
npm install
```

---

## Step 3: Connect the panel

Plug the Micro Color Panel into your computer via USB.

---

## Step 4: Start the server

**macOS:**
```bash
sudo node server.mjs
```

**Windows:** Open Terminal or PowerShell as Administrator, then:
```
node server.mjs
```

> `sudo` / Administrator is required for USB HID access. The browser will open automatically at http://localhost:8766.

If the browser does not open, navigate there manually. If the server is not running, the GUI will display the exact command needed to start it.

---

## Step 5: Set up a virtual MIDI port

The panel sends MIDI to other apps via a virtual MIDI port.

**macOS — enable IAC Driver:**
1. Open **Audio MIDI Setup** (search in Spotlight)
2. Go to **Window → Show MIDI Studio**
3. Double-click **IAC Driver** and tick **Device is online**

**Windows — install loopMIDI:**
1. Download [loopMIDI](https://www.tobias-erichsen.de/software/loopmidi.html)
2. Create a new virtual port (click **+**)

---

## Step 6: Select the MIDI device in the GUI

1. Open the **MIDI Options** panel on the right sidebar
2. Click **↻** to refresh the device list
3. Select **IAC Driver Bus 1** (macOS) or your loopMIDI port (Windows)

---

## Step 7: Use with your app

The panel now outputs MIDI CC messages to your chosen virtual port. Connect that port as a MIDI input in your app:

- **Lightroom / MIDI2LR** — import `presets/MicroPanel_LR.xml` into MIDI2LR and set its input to IAC Driver Bus 1
- **Logic Pro** — add the IAC Driver port as an external MIDI input
- **Any DAW** — map incoming CC 60–71 (rotary knobs), CC 7–9 (jog wheels), CC 1–6 (trackballs)

---

## Troubleshooting

**GUI shows "Server not running" banner**
- Follow the commands shown in the banner — they are generated for your machine automatically

**Panel not detected**
- Make sure the USB cable is connected before starting the server
- Confirm you are running with `sudo` (macOS) or as Administrator (Windows)
- On Windows, the panel USB driver must be replaced with WinUSB via [Zadig](https://zadig.akeo.ie/) first

**No MIDI output**
- Check that IAC Driver (macOS) or loopMIDI (Windows) is active
- Confirm the correct device is selected in MIDI Options and MIDI is enabled

**Web page won't load**
- Confirm the server is running in Terminal
- Navigate to http://localhost:8766 (not https)

---

## Need help?

See full documentation in [README.md](README.md) or open an issue at https://github.com/alchemy-color/BMD-Micro-Color-Panel-MIDI
