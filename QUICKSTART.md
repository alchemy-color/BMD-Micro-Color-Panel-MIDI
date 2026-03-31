# Quick Start Guide

## What is this?

This lets you use your BlackMagic DaVinci Resolve Micro Color Panel with other apps like Lightroom or Logic Pro by converting panel movements into MIDI signals.

## Step 1: Install

1. Install Node.js from https://nodejs.org (LTS version)
2. Download this repository:
   ```bash
   git clone https://github.com/alchemy-color/BMD-Micro-Color-Panel-MIDI.git
   cd BMD-Micro-Color-Panel-MIDI
   ```
3. Install dependencies:
   ```bash
   npm install
   ```

## Step 2: Connect Panel

1. Plug your Micro Color Panel into your Mac via USB
2. Turn on your Mac (panel gets power from Mac)

## Step 3: Run Server

Open Terminal and run:

```bash
sudo npm start
```

⚠️ **Important**: You must use `sudo` because the panel needs admin access to read USB.

## Step 4: Open Web Interface

1. Open a browser
2. Go to: http://localhost:8766
3. You should see your panel!

## Step 5: Set Up MIDI (for Lightroom)

1. **Enable IAC Driver** (Mac only):
   - Open "Audio MIDI Setup" (search in Spotlight)
   - Open Window → Show MIDI Devices
  . Check that "IAC Driver" is enabled (double-click to turn on)

2. **Set up MIDI2LR**:
   - Download MIDI2LR from https://rsjacobsen.gumroad.com/l/midi2lr
   - In MIDI2LR, go to Settings → Import Settings
   - Select `presets/MicroPanel_LR.xml`
   - Choose "IAC Driver" as your MIDI input

3. **In our app**:
   - Click the ↻ button next to MIDI device dropdown
   - Select "IAC Driver"
   - Click "Lightroom" preset

## Step 6: Use in Lightroom

Now your panel controls Lightroom:

| Control | Action |
|---------|--------|
| Left knob (Contrast) | Adjust Contrast |
| RWD button | Previous Photo |
| FWD button | Next Photo |

## Troubleshooting

**"No MIDI outputs found"**
- Click ↻ button to refresh
- Make sure IAC Driver is enabled in Audio MIDI Setup

**"Panel not detected"**
- Make sure panel is connected via USB
- Make sure you're running with `sudo`

**"Web page won't load"**
- Make sure server is running (Terminal window should be open)
- Go to http://localhost:8766 (not https)

## Need Help?

- Check full documentation in README.md
- Open an issue on GitHub: https://github.com/alchemy-color/BMD-Micro-Color-Panel-MIDI