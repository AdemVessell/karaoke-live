# Validation and remaining checks

Version 0.3.0 is a macOS prototype. The checks and remaining limits are described below.

## Observed working

- A real macOS session used camera, an SSL 2+ interface, headphones, the embedded YouTube player, and OBS window/audio capture.
- The public X session completed, and its local recording decoded successfully with non-silent audio. The performer confirmed the playback levels and that reverb was audible in the recording.
- The original setup did not require paid model APIs for karaoke.

## Changes checked after that session

- System-default audio and selectable inputs replace the automatic interface-specific selection.
- Control UI commands are checked against the same supported-command contract used by the HTTP bridge.
- Detailed compressor controls, reverb shape, optional delay, and voice peak protection use the shared processing graph.
- A real-time synthetic source passed through that graph and was encoded with MediaRecorder. Decoded audio contained the reverb tail, delay repeats, and compression attenuation; it was finite and did not hard-clip.
- An independent raw-sample test verified the configured pre-codec voice ceiling.
- The first test incorrectly assumed a lossy encoded file must obey the exact raw-sample ceiling. Opus reconstructed higher peaks, so that assumption was rejected. The UI's peak protection is not a delivered-file true-peak guarantee.
- A self-contained OBS connector is tested with mocked authentication and request responses. The app bundle copies its source instead of pointing at a development checkout.

## Broadcast lip-sync checks (0.3.0)

- Unit tests cover both correction directions, reset to the canonical Stage layout, camera-overlay mute/track/monitor isolation, layer order, refreshed window selection, invalid settings, and refusal while recording or streaming.
- Browser tests cover the signed control contract, saved settings, stale responses, failures, active-output blocking, and isolation from Stage voice-effect commands.
- Real OBS 33.0.1 recordings on macOS checked zero, +200 ms, -200 ms, and reset with matching flashes in the two Stage panels. Measured relative picture shifts were 0, +166.7, -166.7, and 0 ms at 30 fps, within the declared 50 ms tolerance. Calibration is manual and frame-limited, not sample-accurate.
- OBS readback confirmed the matching program-audio offset for the negative direction, mute/disabled audio tracks on the camera overlay, and the active-recording guard.
- The first OBS check exposed an invalid cached window on the duplicate capture. Refreshing that source's available-window list before selecting the current Stage fixed the blank overlay. The test was rerun after the repair.
- Synthetic capture audio was silent at baseline and all offsets in this test environment. Those files establish the picture shift and OBS setting application, not complete audio/video alignment. The SSL interface was disconnected; a real clap/playback check with the intended microphone and headphones remains required before relying on a nonzero correction.
- The headphone DSP and output route are unchanged. Sync is implemented in OBS only; it does not add an audio delay node to the app.

## Boundaries

The synthetic encoded-output test does not establish every microphone, audio interface, or OBS/X combination. The new advanced controls have not yet had a second full human singing audition through a public broadcast. A local playback check remains the first step on another machine.

The audio engine has zero compressor lookahead; the complete monitoring round trip depends on hardware and operating-system buffering. Output selection affects voice monitoring; YouTube follows the macOS sound-output device.

## Repeat

```sh
npm ci
npm test
npx playwright install chromium
npm run test:browser
npm run package:mac
```

For a manual end-to-end check, record a brief local performance with reverb or echo first off and then clearly enabled. Listen to the saved OBS file; check the processed voice and backing together, absence of doubling, and clean peaks. Do this before starting a public broadcast.

For lip sync, begin at zero and record visible claps. If needed, apply a small correction in the observed direction, repeat the recording, and compare the saved file. Verify that voice monitoring feels unchanged and that the song picture and sound remain aligned. Reset to zero if the original playback was already correct.
