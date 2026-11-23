const STAGE_TITLE = 'Karaoke Live — Stage';
const WINDOWS_STAGE_AUDIO = 'Karaoke Stage Audio';

function macWindowToken(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// OBS escapes embedded colons and hashes before joining title, class and executable.
function windowsWindowToken(value) {
  return typeof value === 'string' && value.length <= 2048 && /^[^:\x00-\x1f]+:[^:\x00-\x1f]+:[^:\x00-\x1f]+\.exe$/i.test(value)
    ? value : null;
}

const macSettings = Object.freeze({ type: 1, show_cursor: false, show_empty_names: false, show_hidden_windows: true });
const windowsSettings = Object.freeze({ window: '', method: 2, priority: 1, cursor: false, client_area: true, capture_audio: false });

const macCapture = Object.freeze({
  windowKind: 'screen_capture',
  initialWindowSettings: macSettings,
  windowSettings: window => ({ ...macSettings, window }),
  windowToken: macWindowToken,
  isStageWindow: item => item.itemEnabled !== false && String(item.itemName).includes(STAGE_TITLE),
  chromeWindow(item) {
    const prefix = '[Google Chrome] ';
    const id = macWindowToken(item.itemValue);
    return item.itemEnabled !== false && id !== null && String(item.itemName).startsWith(prefix)
      ? { id, title: String(item.itemName).slice(prefix.length) } : null;
  },
  processAudioKind: null
});

const windowsCapture = Object.freeze({
  windowKind: 'window_capture',
  initialWindowSettings: windowsSettings,
  windowSettings: window => ({ ...windowsSettings, window }),
  windowToken: windowsWindowToken,
  isStageWindow(item) {
    const id = windowsWindowToken(item.itemValue);
    if (item.itemEnabled === false || !id) return false;
    const [title, , executable] = id.split(':');
    return title === STAGE_TITLE && ['karaoke live.exe', 'electron.exe'].includes(executable.toLowerCase());
  },
  chromeWindow(item) {
    const id = windowsWindowToken(item.itemValue);
    if (item.itemEnabled === false || !id || id.split(':')[2].toLowerCase() !== 'chrome.exe') return null;
    const prefix = /^\[chrome\.exe\]:\s*/i;
    return { id, title: String(item.itemName).replace(prefix, '') };
  },
  processAudioKind: 'wasapi_process_output_capture',
  // Match the executable if the site's title changes during navigation.
  processAudioSettings: window => ({ window, priority: 2 })
});

function captureForPlatform(platform = process.platform) {
  return platform === 'win32' ? windowsCapture : macCapture;
}

module.exports = { captureForPlatform, WINDOWS_STAGE_AUDIO };
