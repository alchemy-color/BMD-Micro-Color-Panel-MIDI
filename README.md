# BMD Micro Color Panel MIDI Controller

![Screenshot](screenshot.png)

Turn your Blackmagic DaVinci Resolve Micro Color Panel into a fully customizable MIDI controller. Web-based GUI with per-control speed scaling, MIDI mapping, and preset management.

> **Inspiration**: This project is a derivative of [micro-color-panel-controller](https://github.com/ra100/micro-color-panel-controller) by [ra100](https://github.com/ra100). That project provided the foundation for reverse-engineering the panel's HID protocol.

## Features

- **USB HID Control** - Connects directly to BMD Micro Color Panel (USB PID 0xda0f)
- **Web GUI** - Visual panel representation at http://localhost:8766 with real-time feedback
- **MIDI Output** - Send notes/CC to DAWs like Logic Pro or Lightroom via MIDI2LR
- **Speed Scale Controls** - Individual 0.1x-5x sensitivity sliders for all 12 rotaries, 3 jog wheels, and 3 trackballs
- **MIDI Mapping** - Click any control in MIDI Map mode to assign custom MIDI notes
- **Label Presets** - Save and switch between custom button/rotary/wheel/ball label layouts
- **Preset System** - Save/load/export custom MIDI mappings
- **Real-time Calibration** - Adjust rotary units per detent, wheel degrees per step, and trackball sensitivity

## Requirements

- macOS (Linux/Windows support can be added)
- Node.js 18+
- **sudo** for USB HID access

## Installation

```bash
cd BMD-Micro-Color-Panel-MIDI
npm install
```

## Usage

1. Connect the BMD Micro Color Panel via USB
2. Run the server with sudo:

```bash
sudo npm start
```

3. Open http://localhost:8766 in your browser

## MIDI Configuration

### Default MIDI Assignments

| Control | MIDI |
|---------|------|
| Rotary 0-11 | Notes 60-71 (C4-B4) |
| Left Wheel | CC0 |
| Center Wheel | CC0 |
| Right Wheel | CC0 |
| Trackballs | CC1 (X), CC2 (Y) |
| Buttons 12-51 | Notes 1-40 |

### For Lightroom

Import `MicroPanel_LR.xml` into MIDI2LR:

| Control | Lightroom Action |
|---------|------------------|
| RWD | Previous Photo |
| FWD | Next Photo |
| Rotary 3 (Contrast) | Contrast |
| Rotary 5 (Mid Detail) | Clarity |
| Rotary 6 (Color Boost) | Vibrance |
| Rotary 7 (Shadows) | Shadows |
| Rotary 8 (Highlights) | Highlights |
| Rotary 9 (Saturation) | Saturation |

## Presets

- **Default** - Basic MIDI mapping
- **Lightroom** - Optimized for Lightroom/MIDI2LR
- **Logic Pro Transport** - Transport controls for Logic Pro

### Creating Custom Presets

1. Configure your desired button mappings in the UI
2. Click "Save Current" to save your preset
3. Presets are stored in the `presets/` folder

## Settings

Adjust sensitivity and mapping in the UI panels:

- **Speed Scales** - Per-control sensitivity (0.1x to 5x) for rotary encoders, jog wheels, and trackballs
- **Calibration** - Fine-tune rotary units per detent, wheel degrees per step, and trackball gain/dominance
- **MIDI Map** - Click any control to assign custom MIDI notes
- **Label Presets** - Rename and save custom label layouts for buttons and controls

## Troubleshooting

### Panel not detected
- Ensure USB cable is connected
- Run with `sudo` (required for USB HID)

### MIDI not working
- Enable IAC Driver in Audio MIDI Setup (Mac)
- Use MIDI2LR to map MIDI to Lightroom commands
- Import `presets/MicroPanel_LR.xml` into MIDI2LR

### Server won't start
- Check if another instance is running
- Verify no other process is using port 8765/8766

## Tech Stack

- **Node.js** - Server runtime
- **usb** - USB HID communication
- **ws** - WebSocket server
- **JZZ** - MIDI I/O

## Known Issues & Limitations

### Rotary Encoders
- **Not working yet** - Rotary encoders (12 knobs) are not yet functional. The HID report parsing needs debugging to properly detect rotation and direction.

### Speed Scale
- **Not working yet** - The speed scale sliders (0.1x-5x) are present in the UI but not affecting MIDI output. The velocity scaling logic needs to be applied to the control data.

### Wheels
- **Direction detection incomplete** - The wheel delta detection works but only registers -1 regardless of turn direction. The raw values show alternating patterns that haven't been fully resolved into reliable left/right differentiation.

### General
- **No MIDI input** - The panel only sends HID data; it cannot receive MIDI back. Values are accumulated client-side only.
- **One-way communication** - Panel lights cannot be controlled from the server (attempts to set backlight have not succeeded).
- **Platform limited** - Requires sudo for USB HID, currently tested on macOS.

## Contributing

1. Fork the repo
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT - see [LICENSE](LICENSE) file