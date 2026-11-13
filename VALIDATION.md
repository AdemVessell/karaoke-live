# Validation and remaining checks

Version 0.2.0 is a macOS prototype. The checks and remaining limits are described below.

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
