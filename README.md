# Karaoke Live

A small macOS app for singing or presenting on camera with low-latency vocal effects and an OBS-ready stage.

The private Control Desk holds the source and audio controls. OBS can show your camera beside the YouTube karaoke player or a window from your regular Chrome session. Use OBS to record locally or send the scene to your streaming service.

## What it does

- Plays a single YouTube video through the official embedded player.
- Captures a Chrome window for browsing, commentary, or playing songs on sites such as Suno.
- Uses your system microphone or a microphone/audio interface you select.
- Processes your voice with compression, reverb, optional echo, and peak protection.
- Keeps music and voice levels separately adjustable.
- Creates an OBS scene that captures the Stage window **and its processed audio**.
- Records locally through OBS. Starting a public broadcast remains a deliberate action in OBS and your streaming service.
- Saves an optional broadcast lip-sync adjustment without delaying headphone monitoring.

No OpenAI, Nuance, or other paid API key is needed. No particular audio interface is required.

## Requirements

- macOS 13 or later for the OBS screen-and-audio capture route.
- OBS Studio with its WebSocket server enabled under **Tools → WebSocket Server Settings**.
- Headphones, a microphone, and an internet connection for YouTube.
- Node.js 22 or later and npm to run from source.

This is a macOS prototype. Windows/Linux capture setup and a signed/notarized installer are not included.

## Run from source

```sh
git clone https://github.com/AdemVessell/karaoke-live.git
cd karaoke-live
npm ci
npm start
```

For a portable local app bundle:

```sh
npm run package:mac
```

The result is `dist/KaraokeLive.app`. It contains the app source; it does not depend on the checkout's location. The build uses the Electron architecture installed by npm and is signed ad hoc for local testing, not notarized for distribution.

## First session

1. Set macOS sound output to your headphones or audio interface. If the interface has direct monitoring, avoid mixing a second dry microphone path with the app's processed voice.
2. Open Karaoke Live. Paste a single YouTube karaoke/instrumental URL and load it.
3. Enable camera and microphone, granting macOS permissions when asked. Refresh the device list after permission is granted if labels were previously hidden.
4. Use the system microphone or choose another input. Device changes in the Control Desk require stopping capture first.
5. Adjust Voice, Music, Reverb, and compression. Open **Voice effects** for detailed controls.
6. Keep the Stage window open. Use **Set up OBS** while OBS is neither recording nor streaming. Grant OBS screen/system-audio capture permission if macOS requests it.
7. Record a short local test and listen to the saved file before broadcasting.

If the Control Desk is hidden, use **Karaoke Live → Show controls** in the app menu.

The output selector controls **processed voice monitoring**. YouTube follows the macOS sound output, so select the same headphones there. Both default to the system output.

## Voice effects

Choose **Rock Vocals**, **Rap Vocals**, or **Pop Vocals** in either the **Male** or **Female** group. Rock uses firmer compression and a short room. Rap keeps reverb low and echo off. Pop uses a longer reverb and a light echo. Both groups are adjustable starting points. Use whichever sounds best with your voice and mic.

Adjust **Voice**, **Reverb**, or the detailed **Voice effects** after selecting a preset. Changes are saved on this Mac for that preset, including edits during capture. **Reset preset** brings back its original values. **Manual** recalls your own settings, including settings from before this update. The **Backing track** level is independent of the vocal preset.

- **Compression strength:** a convenient gentle-to-firm control. Advanced threshold, ratio, makeup gain, attack, and release are also available.
- **Reverb:** adjustable send, decay, pre-delay, and tone. The wet sound is added behind the dry voice; the number is a send amount, not a guaranteed perceived wet/dry balance.
- **Echo:** optional short delay with bounded feedback.
- **Peak ceiling:** zero-lookahead soft clipping protection for the voice. This is not loudness normalization.

The ceiling applies to audio samples before encoding. Lossy codecs can reconstruct slightly higher peaks; it is not a delivered-file true-peak guarantee.

The voice runs at 48 kHz through a mono input fold, high-pass filter, compressor, wet effects, and peak protection. The resulting signal reaches the Stage's audio output, so these are recording/broadcast effects as well as headphone effects. OBS also has a final -1 dB limiter for the mixed program.

The compressor adds no algorithmic lookahead. Device, operating-system, and audio-buffer latency still vary. Headphone monitoring does not pass through OBS.

## Lip sync (optional)

If your recorded playback already looks aligned, leave this at **Already aligned / 0 ms**.

1. Enable your camera and microphone, then use **Set up OBS**. Pause the song and record a short test with a few visible claps using **Record in OBS**.
2. **Stop & save**, then use **Show recording** to find the file. Review it in a player that supports your OBS recording format. Check the actual recording, not the headphone sound or OBS preview.
3. Open **Lip sync (optional)**. Choose whether you hear your voice first or see your mouth move first, set a small correction, and **Apply**. Record another short test. **Reset** restores zero.

This is manual calibration, not automatic lip reading or delay measurement. The setting is saved on this Mac and applied by **Set up OBS** in each new session. Adjustments are blocked while OBS records or streams. Recheck after changing a camera, audio device, or capture setup. A fixed offset cannot repair a connection whose timing keeps drifting.

The adjustment affects only the OBS recording/stream. Your processed voice and song still go directly to your headphones with the same monitoring path. To preserve the song's own picture/sound timing, OBS uses a muted camera overlay when correction is enabled. The base Stage remains the only audible source. Seeing the mouth first delays the camera; hearing the voice first delays the broadcast mix and song picture together. The direct Stage window stays responsive and does not show this broadcast correction.

The supported range is 0–500 ms in either direction; picture timing is limited by the video frame rate. Keep the app-created OBS sources and filters intact. Stage resizing is locked while a nonzero correction is applied; reset to zero before resizing, then run setup again.

## OBS audio: one path

Use **Karaoke Stage**, the macOS window-capture source, for picture **and audio**. Keep it unmuted, on track 1, with OBS monitoring off. The old `Karaoke App Audio` source, if present, stays muted. Targeting Electron's parent application as a separate audio source can capture silence; targeting a generic helper can capture unrelated applications.

Mute other global microphone/desktop sources that would duplicate the Stage mix. The app reports active global inputs rather than silently changing unrelated audio configuration.

**Stop capture** stops camera/microphone playback and an app-owned local recording. It does **not** end a public broadcast. End the broadcast in your streaming service and stop streaming in OBS.

## YouTube behavior

Some videos disallow embedding or are unavailable. The app reports those errors and clears stale messages after successful playback. It does not download tracks or bypass embedding restrictions. Your choice of content and broadcasting permissions remain separate from whether a video plays in the app.

## Website mode

1. Open Suno, YouTube, or another site in its own regular Chrome window. You can browse with your existing Chrome sign-in.
2. In the Control Desk, choose **Website**, select that Chrome window, and click **Set up OBS**. If you opened it after the list appeared, use **Refresh**.
3. Use the website’s own playback and volume controls. OBS puts that window beside the Stage camera and mixes browser audio with the app’s processed vocal. Keep other Chrome tabs quiet because audio capture covers all of Chrome.
4. Use **Record in OBS** and **Stop & save** for a local take. You can change songs or navigate within the selected Chrome window during the take. Stop the take before switching back to the dedicated **YouTube karaoke** mode and setting up OBS again.

The optional lip-sync editor applies to the dedicated YouTube karaoke scene. Review a short clap test in the website recording to check the camera timing with your setup.

## Privacy and local state

- OBS authentication is read from your own local OBS configuration and is never included in the source package.
- Song and device preferences stay in the app's local browser storage.
- The broadcast sync setting stays in the app's local data folder; it is separate from voice effects and device preferences.
- The HTTP control server binds to `127.0.0.1` and checks request origin/host.
- Recordings go to `Desktop/Karaoke Recordings` unless OBS manages a recording started outside the app.
- Source archives exclude recordings, local evidence, runtime files, credentials, and dependencies.

## Development and verification

```sh
npm test
npx playwright install chromium
npm run test:browser
npm run package:source
npm run package:mac
```

The source ZIP is created in `dist/`. Tests include device/control contracts, audio-setting normalization, and mocked OBS authentication. Recorded-audio verification results and remaining hardware checks are described in `VALIDATION.md`.

## License

[MIT](LICENSE) © 2026 AdemVessell. Electron and other dependencies retain their respective licenses.
