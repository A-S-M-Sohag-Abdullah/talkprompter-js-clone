export const DEFAULT_SCRIPT =
  'Welcome to TalkPrompter.\n\n' +
  'As you read this text aloud, the script scrolls itself to keep pace with your voice. ' +
  'If you stop speaking or wander off script, the scrolling pauses and waits for you. ' +
  'The moment you start reading again, it picks up right where you left off.\n\n' +
  'Everything runs locally on your device. Your microphone audio never leaves it. ' +
  'Press Start and begin reading whenever you are ready.';

export const DEFAULT_SETTINGS = {
  fontSize: 52,
  scrollSmoothness: 0.22,
  sensitivity: 0.6,
  columnWidth: 680,
  mirror: false,
  topmost: false,
  countdown: true,
  theme: 'dark', // 'auto' | 'dark' | 'light'
  microphoneId: '',
  showHeard: false,
  flowMode: false,
  forceSimulation: false,
  followFileChanges: true,
  hideFromCapture: false,
  keepAwake: true,
  globalShortcut: '',
  voiceLanguage: null,
  modelPromptDismissed: false,
  recentScripts: [], // [{ id, name, text, filePath, lastTokenIndex, lastOpened }]
  activeScriptId: null
};
