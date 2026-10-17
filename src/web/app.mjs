// TalkPrompter — the app controller shared by every platform.
//
// Flow: speech engine → hypotheses → ScriptMatcher → current token → the
// highlight moves and a critically-damped spring scrolls it to the reading
// line. Platform-specific bits (files, windows, voice-pack storage) go
// through the adapter from ./platform.

import { loadPlatform } from './platform/index.mjs';
import { buildScript, textRulesFor } from './core/text.mjs';
import { ScriptMatcher, optionsForSensitivity, TrackingState } from './core/matcher.mjs';
import { smoothDamp } from './core/smoothDamp.mjs';
import { LANGUAGES, findLanguage } from './core/languages.mjs';
import { VoskEngine, ZipformerEngine, SimulatedEngine } from './speech.mjs';
import { DEFAULT_SETTINGS, DEFAULT_SCRIPT } from './defaults.mjs';

const $ = (id) => document.getElementById(id);
const READING_FRACTION = 0.33; // the guide line sits a third of the way down
const ASSUMED_WPM = 150;
const MAX_RECENT = 10;

let P;              // platform adapter
let S;              // settings
let script;         // built script model
let spans = [];     // token index -> <span class="w">
let gaps = [];      // token index -> <span class="g"> after that token (or null)
let current = -1;   // index of the token just read (-1 = before the start)
let matcher = null;
let engine = null;
let running = false;
let countingDown = false;
let packStatus = [];
let cameraOn = false;
let pendingFileReload = null;
let take = { start: 0, firstAdvance: 0, words: 0 };

// ---------------------------------------------------------------- settings

let pendingSave = {};
let saveTimer = null;
function save(patch, immediate = false) {
  Object.assign(S, patch);
  Object.assign(pendingSave, patch);
  clearTimeout(saveTimer);
  const flush = () => {
    const p = pendingSave;
    pendingSave = {};
    return P.setSettings(p);
  };
  if (immediate) return flush();
  saveTimer = setTimeout(flush, 300);
  return Promise.resolve({ ok: true });
}

// ----------------------------------------------------------------- scripts

const newId = () => Math.random().toString(36).slice(2, 10);

function deriveName(text, fallback = 'Untitled script') {
  const line = (text || '').split('\n').map((l) => l.trim()).find(Boolean);
  if (!line) return fallback;
  return line.length > 40 ? `${line.slice(0, 39)}…` : line;
}

function activeScript() {
  return S.recentScripts.find((s) => s.id === S.activeScriptId) ?? S.recentScripts[0];
}

function ensureScripts() {
  if (!Array.isArray(S.recentScripts) || S.recentScripts.length === 0) {
    S.recentScripts = [{ id: newId(), name: deriveName(DEFAULT_SCRIPT), text: DEFAULT_SCRIPT, lastTokenIndex: -1, lastOpened: Date.now() }];
  }
  if (!S.recentScripts.some((s) => s.id === S.activeScriptId)) S.activeScriptId = S.recentScripts[0].id;
}

function persistScripts(immediate = false) {
  S.recentScripts.sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0));
  S.recentScripts = S.recentScripts.slice(0, MAX_RECENT);
  return save({ recentScripts: S.recentScripts, activeScriptId: S.activeScriptId }, immediate);
}

function addOrUpdateScript({ text, filePath, name }) {
  let entry = filePath && S.recentScripts.find((s) => s.filePath === filePath);
  if (entry) {
    if (entry.text !== text) entry.lastTokenIndex = -1;
    entry.text = text;
  } else {
    entry = { id: newId(), text, filePath: filePath || null, lastTokenIndex: -1 };
    S.recentScripts.unshift(entry);
  }
  entry.name = name ? name.replace(/\.(docx|txt|md)$/i, '') : deriveName(text);
  entry.lastOpened = Date.now();
  switchScript(entry.id);
}

function switchScript(id) {
  if (running) stop();
  S.activeScriptId = id;
  const entry = activeScript();
  entry.lastOpened = Date.now();
  persistScripts();
  rebuild();
  renderScriptSelect();
  P.watchScript(S.followFileChanges ? entry.filePath : null);
}

function renderScriptSelect() {
  const sel = $('scriptSelect');
  sel.innerHTML = '';
  for (const s of S.recentScripts) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name || 'Untitled script';
    sel.appendChild(opt);
  }
  sel.value = S.activeScriptId;
}

// --------------------------------------------------------------- rendering

function activeLanguage() {
  const saved = findLanguage(S.voiceLanguage);
  if (saved) return saved;
  const installed = packStatus.find((p) => p.installed);
  return findLanguage(installed?.code) ?? LANGUAGES[0];
}

function rebuild() {
  const entry = activeScript();
  script = buildScript(entry.text, textRulesFor(activeLanguage().code));
  // Lets CSS pick fonts/line height per script (e.g. Bangla conjuncts need more room).
  $('column').lang = activeLanguage().code;
  $('scriptText').lang = activeLanguage().code;
  matcher = null;
  renderScript();
  current = Math.min(entry.lastTokenIndex ?? -1, script.tokenCount - 1);
  applyHighlight(-1, current, true);
  layoutPadding();
  jumpScroll(targetFor(current));
  updateEstimate();
  if (!running) setStatus('idle', script.tokenCount ? 'Ready' : 'Script is empty');
}

function renderScript() {
  const col = $('column');
  col.textContent = '';
  spans = [];
  gaps = [];
  const { text, tokens } = script;
  const frag = document.createDocumentFragment();

  if (tokens.length === 0) {
    const hint = document.createElement('div');
    hint.className = 'empty-hint';
    hint.textContent = 'Your script is empty. Click “Edit script” to paste text, or drop a .docx / .txt file here.';
    frag.appendChild(hint);
  } else if (tokens[0].start > 0) {
    frag.appendChild(document.createTextNode(text.slice(0, tokens[0].start)));
  }

  tokens.forEach((t, i) => {
    const w = document.createElement('span');
    w.className = 'w';
    w.dataset.i = i;
    w.textContent = text.substr(t.start, t.length);
    frag.appendChild(w);
    spans.push(w);

    const end = t.start + t.length;
    const next = i + 1 < tokens.length ? tokens[i + 1].start : text.length;
    if (next > end) {
      const g = document.createElement('span');
      g.className = 'g';
      g.textContent = text.slice(end, next);
      frag.appendChild(g);
      gaps.push(g);
    } else {
      gaps.push(null);
    }
  });
  col.appendChild(frag);
}

/** Updates read/current classes for the tokens whose state changed. */
function applyHighlight(from, to, full = false) {
  const lo = full ? 0 : Math.max(0, Math.min(from, to));
  const hi = full ? spans.length - 1 : Math.min(spans.length - 1, Math.max(from, to));
  for (let j = lo; j <= hi; j++) {
    const read = j < to;
    spans[j].classList.toggle('read', read);
    spans[j].classList.toggle('cur', j === to);
    gaps[j]?.classList.toggle('read', j < to);
  }
}

function setCurrent(index) {
  index = Math.max(-1, Math.min(index, script.tokenCount - 1));
  if (index === current) return;
  const prev = current;
  current = index;
  applyHighlight(prev, current);
  setTarget(targetFor(current));
}

// --------------------------------------------------------------- scrolling

const viewport = () => $('viewport');
const scroll = { current: 0, target: 0, state: { velocity: 0 }, last: 0, written: 0 };
const flow = { paused: false, pausedSince: 0, pace: 0, lastConfirmed: 0, lastTargetAt: 0 };

function layoutPadding() {
  const h = viewport().clientHeight;
  const line = parseFloat(getComputedStyle($('column')).lineHeight) || S.fontSize * 1.38;
  $('column').style.paddingTop = `${Math.max(0, h * READING_FRACTION - line / 2)}px`;
  $('column').style.paddingBottom = `${Math.round(h * (1 - READING_FRACTION))}px`;
  $('guide').style.top = `${h * READING_FRACTION}px`;
}

function targetFor(index) {
  if (index < 0 || !spans[index]) return 0;
  const el = spans[index];
  return Math.max(0, el.offsetTop + el.offsetHeight / 2 - viewport().clientHeight * READING_FRACTION);
}

function setTarget(offset) {
  offset = Math.max(0, offset);
  // Track the pace of confirmed forward motion for flow-mode drift.
  const now = performance.now();
  if (offset > flow.lastConfirmed && flow.lastTargetAt) {
    const dt = (now - flow.lastTargetAt) / 1000;
    if (dt > 0.05 && dt < 3) {
      const rate = Math.min(300, Math.max(0, (offset - flow.lastConfirmed) / dt));
      flow.pace = flow.pace <= 0 ? rate : 0.7 * flow.pace + 0.3 * rate;
    }
  }
  flow.lastConfirmed = offset;
  flow.lastTargetAt = now;
  scroll.target = offset;
}

function jumpScroll(offset) {
  scroll.target = scroll.current = Math.max(0, offset);
  scroll.state.velocity = 0;
  viewport().scrollTop = scroll.current;
  scroll.written = viewport().scrollTop;
}

function frame(t) {
  const dt = scroll.last ? Math.min(0.1, (t - scroll.last) / 1000) : 1 / 60;
  scroll.last = t;
  const vp = viewport();

  // Flow mode: glide through short pauses at reduced pace instead of a hard
  // stop, but never far past the last confirmed position.
  if (S.flowMode && running && flow.paused && flow.pace > 1
    && (performance.now() - flow.pausedSince) / 1000 < 1.6) {
    scroll.target = Math.min(scroll.target + flow.pace * 0.4 * dt, flow.lastConfirmed + 90);
  }

  const max = Math.max(0, vp.scrollHeight - vp.clientHeight);
  const target = Math.min(scroll.target, max);
  if (dt > 0 && Math.abs(target - scroll.current) >= 0.25) {
    scroll.current = smoothDamp(scroll.current, target, scroll.state, S.scrollSmoothness, dt);
    vp.scrollTop = scroll.current;
    scroll.written = vp.scrollTop;
  }
  requestAnimationFrame(frame);
}

// Any scroll we didn't cause (wheel, trackpad, touch, scrollbar drag) moves the
// target itself — otherwise the spring would drag the view straight back.
// The next voice update re-takes control.
function onUserScroll() {
  const top = viewport().scrollTop;
  if (Math.abs(top - scroll.written) > 2) {
    scroll.current = scroll.target = top;
    scroll.state.velocity = 0;
    scroll.written = top;
  }
}

// ------------------------------------------------------------------ status

function setStatus(kind, text) {
  $('statusDot').className = `dot ${kind}`;
  $('statusText').textContent = text;
}

function remainingSuffix() {
  if (!script || current < 0) return '';
  const remaining = script.tokenCount - (current + 1);
  if (remaining <= 0) return ' · done';
  let wps = ASSUMED_WPM / 60;
  const elapsed = take.firstAdvance ? (performance.now() - take.firstAdvance) / 1000 : 0;
  if (elapsed > 10 && take.words > 15) wps = take.words / elapsed;
  const left = Math.round(remaining / Math.max(0.5, wps));
  return ` · ≈ ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')} left`;
}

function showTrackingState(state) {
  flow.paused = state !== TrackingState.Tracking;
  if (flow.paused && !flow.pausedSince) flow.pausedSince = performance.now();
  if (!flow.paused) flow.pausedSince = 0;
  switch (state) {
    case TrackingState.Tracking: setStatus('tracking', `Tracking${remainingSuffix()}`); break;
    case TrackingState.Paused: setStatus('paused', `Paused${remainingSuffix()}`); break;
    case TrackingState.Lost: setStatus('lost', 'Lost — keep reading, it will find you'); break;
    default: setStatus('tracking', `Listening${remainingSuffix()}`);
  }
}

function takeSummary() {
  const secs = Math.round((performance.now() - take.start) / 1000);
  const mins = Math.max(1 / 60, secs / 60);
  return `Take: ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} · ${take.words} words · ${Math.round(take.words / mins)} wpm`;
}

function setLevel(v) {
  $('meterFill').style.width = `${Math.round(Math.min(1, v) * 100)}%`;
}

function updateEstimate() {
  const words = script?.tokenCount ?? 0;
  const secs = Math.round((words / ASSUMED_WPM) * 60);
  $('estimate').textContent = secs >= 60
    ? `${words} words · ≈ ${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, '0')} s at ${ASSUMED_WPM} wpm`
    : `${words} words · ≈ ${secs} s at ${ASSUMED_WPM} wpm`;
}

// ------------------------------------------------------------ start / stop

function onHypothesis({ text }) {
  if (!running || countingDown || !matcher) return;
  if (S.showHeard) $('heardText').textContent = text;
  const u = matcher.process(text);
  if (u.tokenIndex !== current && u.tokenIndex >= -1) {
    if (u.tokenIndex > current) {
      take.words += u.tokenIndex - current;
      if (!take.firstAdvance) take.firstAdvance = performance.now();
    }
    setCurrent(u.tokenIndex);
  }
  showTrackingState(u.state);
}

function runCountdown() {
  return new Promise((resolve) => {
    countingDown = true;
    const box = $('countdown');
    const num = $('countdownNum');
    let n = 3;
    const show = () => {
      num.textContent = n;
      num.style.animation = 'none';
      void num.offsetWidth; // restart the pop animation
      num.style.animation = '';
    };
    const finish = () => {
      clearInterval(timer);
      box.hidden = true;
      box.onclick = null;
      countingDown = false;
      resolve();
    };
    box.hidden = false;
    box.onclick = finish;
    show();
    const timer = setInterval(() => {
      n--;
      if (n <= 0 || !running) finish();
      else show();
    }, 1000);
  });
}

function packFor(code) {
  return packStatus.find((p) => p.code === code);
}

async function start() {
  if (running || !script) return;
  if (script.tokenCount === 0) {
    openEditor();
    return;
  }
  const sim = S.forceSimulation;
  const lang = activeLanguage();
  if (!sim) {
    const st = packFor(lang.code);
    const usable = st && (st.installed || (P.kind === 'web' && st.available));
    if (!usable) {
      openLanguageDialog('needed');
      return;
    }
  }

  running = true;
  updateToggle();
  take = { start: performance.now(), firstAdvance: 0, words: 0 };
  matcher = new ScriptMatcher(script, optionsForSensitivity(S.sensitivity));
  if (current >= 0) matcher.seekToToken(current);
  $('heardText').textContent = '';

  let eng;
  try {
    if (sim) {
      eng = new SimulatedEngine({
        words: script.tokens.map((t) => script.text.substr(t.start, t.length)),
        fromWord: current + 1
      });
    } else {
      setStatus('loading', P.kind === 'web' && !packFor(lang.code)?.installed
        ? 'Downloading voice pack (first time only)…'
        : 'Loading voice pack…');
      if (!(await P.requestMic())) throw new Error('Microphone access was denied. Allow it in your system settings.');
      if (lang.engine === 'zipformer') {
        const firstTime = P.kind === 'web' && !packFor(lang.code)?.installed;
        eng = new ZipformerEngine({
          lang,
          urls: await P.packs.fileUrls(lang),
          cache: P.packs.cacheFiles,
          deviceId: S.microphoneId,
          onProgress: (got, total) => {
            if (running && firstTime) setStatus('loading', `Downloading ${lang.englishName} voice pack… ${Math.round((got / total) * 100)}%`);
          }
        });
      } else {
        eng = new VoskEngine({ modelUrl: await P.packs.modelUrl(lang), deviceId: S.microphoneId, matchWords: script.matchWords });
      }
    }
    eng.onHypothesis = onHypothesis;
    eng.onLevel = setLevel;
    engine = eng;

    const countdown = S.countdown && !sim ? runCountdown() : Promise.resolve();
    await eng.start();
    if (engine !== eng) { eng.stop(); return; } // stopped while loading
    if (!sim) {
      P.packs.markLoaded(lang.code);
      if (P.kind === 'web') refreshPacks();
    }
    if (S.keepAwake) P.keepAwake(true);
    setStatus('tracking', countingDown ? 'Get ready…' : `Listening${remainingSuffix()}`);
    await countdown;
    if (running) showTrackingState(TrackingState.Idle);
    refreshMics();
  } catch (err) {
    console.error(err);
    const msg = err?.name === 'NotAllowedError'
      ? 'Microphone access was denied. Allow it in your system settings.'
      : (err?.message || String(err));
    stop();
    setStatus('lost', `Couldn't start: ${msg}`);
  }
}

function stop() {
  if (!running) return;
  running = false;
  countingDown = false;
  $('countdown').hidden = true;
  engine?.stop();
  engine = null;
  P.keepAwake(false);
  setLevel(0);
  updateToggle();
  rememberPosition(true);
  setStatus('idle', take.words > 0 ? takeSummary() : 'Ready');
  if (pendingFileReload) {
    const p = pendingFileReload;
    pendingFileReload = null;
    applyFileChange(p);
  }
}

const toggle = () => (running ? stop() : start());

function updateToggle() {
  $('btnToggle').textContent = running ? 'Stop' : 'Start';
}

let rememberTimer = null;
function rememberPosition(immediate = false) {
  clearTimeout(rememberTimer);
  const doIt = () => {
    const entry = activeScript();
    if (entry && entry.lastTokenIndex !== current) {
      entry.lastTokenIndex = current;
      save({ recentScripts: S.recentScripts });
    }
  };
  if (immediate) doIt();
  else rememberTimer = setTimeout(doIt, 1500);
}

// ------------------------------------------------------------- navigation

function seekToToken(index) {
  index = Math.max(-1, Math.min(index, script.tokenCount - 1));
  setCurrent(index);
  if (matcher) {
    if (index < 0) matcher.reset();
    else matcher.seekToToken(index);
  }
  rememberPosition();
}

const nudge = (delta) => seekToToken(current + delta);

function jumpParagraph(direction) {
  const starts = script.paragraphStarts;
  if (!starts.length) return;
  let p = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i] <= Math.max(0, current + 1)) p = i;
  const target = Math.max(0, Math.min(starts.length - 1, p + direction));
  seekToToken(starts[target] - 1);
  setStatus(running ? 'tracking' : 'idle', `Paragraph ${target + 1} of ${starts.length}`);
}

// ------------------------------------------------------------- appearance

function applyAppearance() {
  const col = $('column');
  col.style.fontSize = `${S.fontSize}px`;
  col.style.maxWidth = `${S.columnWidth}px`;
  viewport().classList.toggle('mirror', !!S.mirror);
  $('stage').classList.toggle('mirror', !!S.mirror);
  $('heard').hidden = !S.showHeard;
  $('btnMirror').classList.toggle('on', !!S.mirror);
  $('btnTopmost').classList.toggle('on', !!S.topmost);
  $('valFont').textContent = `${S.fontSize}px`;
  layoutPadding();
  jumpScroll(targetFor(current));
}

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const theme = S.theme === 'auto' ? (darkQuery.matches ? 'dark' : 'light') : S.theme;
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#0F1115' : '#F3F5F9');
  P.setTheme(S.theme);
}
darkQuery.addEventListener('change', () => S && applyTheme());

function setFontSize(size) {
  save({ fontSize: Math.max(20, Math.min(140, Math.round(size))) });
  $('rngFont').value = S.fontSize;
  applyAppearance();
}

// ----------------------------------------------------------------- editor

function openEditor() {
  closeSettings();
  const entry = activeScript();
  $('scriptText').value = entry.text;
  $('fileNote').textContent = entry.filePath
    ? `Linked to ${entry.filePath}${P.features.fileWatch && S.followFileChanges ? ' — reloads automatically when the file is saved.' : ''}`
    : '';
  $('editor').hidden = false;
  updateEstimate();
  $('scriptText').focus();
}

function closeEditor() {
  if ($('editor').hidden) return;
  const entry = activeScript();
  const text = $('scriptText').value.replace(/\r\n/g, '\n');
  $('editor').hidden = true;
  if (text !== entry.text) {
    if (running) stop();
    entry.text = text;
    if (!entry.filePath) entry.name = deriveName(text);
    entry.lastOpened = Date.now();
    persistScripts();
    rebuild();
    renderScriptSelect();
  }
}

function newScript() {
  const entry = { id: newId(), name: 'Untitled script', text: '', lastTokenIndex: -1, lastOpened: Date.now() };
  S.recentScripts.unshift(entry);
  switchScript(entry.id);
  openEditor();
}

function removeScript() {
  const entry = activeScript();
  S.recentScripts = S.recentScripts.filter((s) => s.id !== entry.id);
  ensureScripts();
  $('editor').hidden = true;
  switchScript(S.recentScripts[0].id);
}

async function loadFile() {
  try {
    const result = await P.openScript();
    if (!result) return;
    $('editor').hidden = true;
    addOrUpdateScript({ text: result.text, filePath: result.filePath, name: result.name ?? result.filePath?.split(/[\\/]/).pop() });
  } catch (err) {
    setStatus('lost', `Could not open file: ${err.message}`);
  }
}

function applyFileChange({ filePath, text }) {
  const entry = S.recentScripts.find((s) => s.filePath === filePath);
  if (!entry || entry.text === text) return;
  if (running && entry.id === S.activeScriptId) {
    pendingFileReload = { filePath, text }; // never yank the script mid-take
    return;
  }
  entry.text = text;
  persistScripts();
  if (entry.id === S.activeScriptId) {
    rebuild();
    setStatus('idle', 'Script reloaded from file');
  }
}

// --------------------------------------------------------------- settings

function openSettings() {
  $('settings').hidden = false;
  $('btnSettings').classList.add('on');
  refreshMics();
}
function closeSettings() {
  $('settings').hidden = true;
  $('btnSettings').classList.remove('on');
}

async function refreshMics() {
  const sel = $('selMic');
  let devices = [];
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  } catch {
    // No media devices API (or blocked).
  }
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = '';
  def.textContent = 'System default';
  sel.appendChild(def);
  devices.filter((d) => d.deviceId && d.deviceId !== 'default').forEach((d, i) => {
    const o = document.createElement('option');
    o.value = d.deviceId;
    o.textContent = d.label || `Microphone ${i + 1}`;
    sel.appendChild(o);
  });
  sel.value = [...sel.options].some((o) => o.value === S.microphoneId) ? S.microphoneId : '';
}

function updateEngineNote() {
  const lang = activeLanguage();
  $('langSummary').textContent = `${lang.englishName}${lang.nativeName !== lang.englishName ? ` (${lang.nativeName})` : ''}`;
  $('engineNote').textContent = S.forceSimulation
    ? 'Simulation mode: the app reads the script by itself at 150 wpm. No microphone is used.'
    : `Speech: ${lang.engine === 'zipformer' ? 'Vosk streaming (ONNX)' : 'Vosk'} offline recognizer (${lang.englishName}). Your audio never leaves this device.`;
}

function bindSettings() {
  const bindRange = (id, key, apply) => {
    const el = $(id);
    el.value = S[key];
    el.addEventListener('input', () => {
      save({ [key]: Number(el.value) });
      apply?.();
    });
  };
  bindRange('rngFont', 'fontSize', applyAppearance);
  bindRange('rngSmooth', 'scrollSmoothness');
  bindRange('rngSens', 'sensitivity', () => { if (matcher) matcher.options = optionsForSensitivity(S.sensitivity); });
  bindRange('rngCol', 'columnWidth', applyAppearance);

  const bindCheck = (id, key, apply) => {
    const el = $(id);
    el.checked = !!S[key];
    el.addEventListener('change', () => {
      save({ [key]: el.checked }, true);
      apply?.();
    });
  };
  bindCheck('chkCountdown', 'countdown');
  bindCheck('chkFollow', 'followFileChanges', () => P.watchScript(S.followFileChanges ? activeScript().filePath : null));
  bindCheck('chkHeard', 'showHeard', applyAppearance);
  bindCheck('chkFlow', 'flowMode');
  bindCheck('chkCapture', 'hideFromCapture');
  bindCheck('chkAwake', 'keepAwake', () => { if (running) P.keepAwake(S.keepAwake); });
  bindCheck('chkSim', 'forceSimulation', updateEngineNote);

  $('selTheme').value = S.theme;
  $('selTheme').addEventListener('change', () => {
    save({ theme: $('selTheme').value }, true);
    applyTheme();
  });
  $('selMic').addEventListener('change', () => save({ microphoneId: $('selMic').value }, true));

  $('txtShortcut').value = S.globalShortcut || '';
  $('btnShortcut').addEventListener('click', async () => {
    const res = await save({ globalShortcut: $('txtShortcut').value.trim() }, true);
    $('shortcutNote').textContent = res?.ok ? 'Shortcut active.' : `Could not register: ${res?.error || 'invalid shortcut'}`;
  });

  $('btnLanguage').addEventListener('click', () => openLanguageDialog('change'));
  $('btnDataFolder').addEventListener('click', () => P.openDataFolder());
  document.querySelectorAll('a[data-href]').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    P.openExternal(a.dataset.href);
  }));
}

// ---------------------------------------------------------- voice packs

async function refreshPacks() {
  packStatus = await P.packs.list(LANGUAGES);
  updateEngineNote();
  if (!$('langDialog').hidden) renderLanguageList();
}

const formatMB = (bytes) => `${Math.round(bytes / 1_000_000)} MB`;
const progress = new Map(); // code -> { received, total }

function openLanguageDialog(reason) {
  const titles = {
    first: ['Choose your language', 'TalkPrompter needs a voice pack to understand you. It is downloaded once (30–55 MB) and then runs fully offline. Your voice never leaves this device.'],
    needed: ['Download a voice pack to start', 'Pick the language you read in. Or turn on Simulation mode in Settings to try the app without a microphone.'],
    change: ['Language', 'The language you read in. Each voice pack is downloaded once and runs offline.']
  };
  const [title, text] = titles[reason] ?? titles.change;
  $('langTitle').textContent = title;
  $('langText').textContent = text;
  $('langStatus').textContent = P.kind === 'web'
    ? 'On the web a voice pack downloads the first time you press Start, then it works offline. Packs marked “not on the web” can be self-hosted (see README).'
    : '';
  $('btnLangClose').textContent = reason === 'first' ? 'Not now' : 'Close';
  $('langDialog').hidden = false;
  renderLanguageList();
}

function closeLanguageDialog() {
  $('langDialog').hidden = true;
  if (!S.modelPromptDismissed) save({ modelPromptDismissed: true }, true);
}

function renderLanguageList() {
  const list = $('langList');
  list.textContent = '';
  const active = activeLanguage().code;
  for (const lang of LANGUAGES) {
    const st = packFor(lang.code) ?? {};
    const row = document.createElement('div');
    row.className = `lang-row${lang.code === active ? ' active' : ''}`;

    const name = document.createElement('div');
    name.className = 'name';
    name.innerHTML = `<span></span><small></small>`;
    name.firstChild.textContent = lang.englishName;
    name.lastChild.textContent = lang.nativeName !== lang.englishName ? lang.nativeName : '';
    const prog = progress.get(lang.code);
    if (prog) {
      const bar = document.createElement('div');
      bar.className = 'progress';
      bar.innerHTML = '<div></div>';
      bar.firstChild.style.width = `${Math.round((prog.received / (prog.total || lang.bytes)) * 100)}%`;
      name.appendChild(bar);
    }
    row.appendChild(name);

    const size = document.createElement('div');
    size.className = 'size';
    size.textContent = st.installed ? 'Installed' : (st.available === false ? 'not on the web' : formatMB(lang.bytes));
    row.appendChild(size);

    const btns = document.createElement('div');
    btns.className = 'btns';
    const button = (label, onClick, primary = false) => {
      const b = document.createElement('button');
      b.textContent = label;
      if (primary) b.className = 'primary';
      b.addEventListener('click', onClick);
      btns.appendChild(b);
    };
    const usable = st.installed || (P.kind === 'web' && st.available);
    if (st.downloading || prog) {
      if (P.kind === 'electron') button('Cancel', () => P.packs.cancel(lang.code));
    } else if (usable) {
      if (lang.code !== active) button('Use', () => useLanguage(lang.code), true);
      if (st.installed && P.features.packDownload) button('Remove', () => removePack(lang.code));
    } else if (P.features.packDownload) {
      button('Download', () => installPack(lang.code), true);
    }
    row.appendChild(btns);
    list.appendChild(row);
  }
}

function useLanguage(code) {
  if (running) stop();
  save({ voiceLanguage: code, modelPromptDismissed: true }, true);
  rebuild();
  updateEngineNote();
  renderLanguageList();
}

async function installPack(code) {
  progress.set(code, { received: 0, total: 0 });
  renderLanguageList();
  let lastRender = 0;
  const res = await P.packs.install(code, (p) => {
    progress.set(code, p);
    const now = performance.now();
    if (now - lastRender > 200) {
      lastRender = now;
      renderLanguageList();
    }
  });
  progress.delete(code);
  await refreshPacks();
  if (res?.ok) {
    useLanguage(code); // downloading a language means you want to read in it
    $('langStatus').textContent = `${findLanguage(code).englishName} is ready. Press Start and read.`;
  } else {
    $('langStatus').textContent = `Download failed: ${res?.error || 'unknown error'}`;
  }
  renderLanguageList();
}

async function removePack(code) {
  if (running) stop();
  await P.packs.remove(code);
  await refreshPacks();
  rebuild();
}

// ------------------------------------------------------------ window bits

async function toggleCamera() {
  cameraOn = await P.setCameraMode(!cameraOn);
  $('btnCamera').classList.toggle('on', cameraOn);
  requestAnimationFrame(() => { layoutPadding(); jumpScroll(targetFor(current)); });
}

async function toggleFullscreen(force) {
  const on = await P.setFullscreen(force);
  setFullscreenUi(on);
}

function setFullscreenUi(on) {
  document.documentElement.classList.toggle('fullscreen', !!on);
  $('btnFull').classList.toggle('on', !!on);
}

// --------------------------------------------------------------- keyboard

function isTyping() {
  const el = document.activeElement;
  return el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text') || el.isContentEditable);
}

function onKeyDown(e) {
  const mod = e.metaKey || e.ctrlKey;
  if (e.key === 'Escape') {
    if (!$('langDialog').hidden) closeLanguageDialog();
    else if (!$('editor').hidden) closeEditor();
    else if (!$('settings').hidden) closeSettings();
    else if (document.documentElement.classList.contains('fullscreen')) toggleFullscreen(false);
    else return;
    e.preventDefault();
    return;
  }
  if (e.key === 'F11' || (e.key === 'f' && e.metaKey && e.ctrlKey)) {
    if (P.features.fullscreen) toggleFullscreen();
    e.preventDefault();
    return;
  }
  if (mod && (e.key === '=' || e.key === '+')) { setFontSize(S.fontSize + 4); e.preventDefault(); return; }
  if (mod && e.key === '-') { setFontSize(S.fontSize - 4); e.preventDefault(); return; }
  if (isTyping() || !$('langDialog').hidden || !$('editor').hidden) return;

  switch (e.key) {
    case ' ': toggle(); break;
    case 'Home': seekToToken(-1); break;
    case 'PageDown': mod ? jumpParagraph(1) : nudge(8); break;
    case 'PageUp': mod ? jumpParagraph(-1) : nudge(-8); break;
    case 'ArrowDown': e.shiftKey ? jumpParagraph(1) : nudge(8); break;
    case 'ArrowUp': e.shiftKey ? jumpParagraph(-1) : nudge(-8); break;
    default: return;
  }
  e.preventDefault();
}

// ----------------------------------------------------------------- wiring

function bindUi() {
  $('btnToggle').addEventListener('click', toggle);
  $('btnEdit').addEventListener('click', openEditor);
  $('btnReset').addEventListener('click', () => seekToToken(-1));
  $('scriptSelect').addEventListener('change', (e) => switchScript(e.target.value));
  $('btnSmaller').addEventListener('click', () => setFontSize(S.fontSize - 4));
  $('btnLarger').addEventListener('click', () => setFontSize(S.fontSize + 4));
  $('btnMirror').addEventListener('click', () => { save({ mirror: !S.mirror }, true); applyAppearance(); });
  $('btnTopmost').addEventListener('click', () => {
    save({ topmost: !S.topmost });
    P.setTopmost(S.topmost);
    applyAppearance();
  });
  $('btnCamera').addEventListener('click', toggleCamera);
  $('btnFull').addEventListener('click', () => toggleFullscreen());
  $('btnSettings').addEventListener('click', () => ($('settings').hidden ? openSettings() : closeSettings()));
  $('btnMore').addEventListener('click', (e) => {
    e.stopPropagation();
    const open = $('secondary').classList.toggle('open');
    $('btnMore').setAttribute('aria-expanded', String(open));
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#secondary')) $('secondary').classList.remove('open');
  });

  $('btnNew').addEventListener('click', newScript);
  $('btnLoad').addEventListener('click', loadFile);
  $('btnDeleteScript').addEventListener('click', removeScript);
  $('btnDone').addEventListener('click', closeEditor);
  $('scriptText').addEventListener('input', () => {
    const words = buildScript($('scriptText').value).tokenCount;
    const secs = Math.round((words / ASSUMED_WPM) * 60);
    $('estimate').textContent = `${words} words · ≈ ${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, '0')} s at ${ASSUMED_WPM} wpm`;
  });
  $('btnLangClose').addEventListener('click', closeLanguageDialog);

  // Click (or tap) a word to re-anchor there.
  $('column').addEventListener('click', (e) => {
    const w = e.target.closest('.w');
    if (w) seekToToken(Number(w.dataset.i));
  });
  viewport().addEventListener('scroll', onUserScroll, { passive: true });

  window.addEventListener('resize', () => {
    layoutPadding();
    jumpScroll(targetFor(current));
  });
  window.addEventListener('keydown', onKeyDown);

  // Drag & drop a .docx / .txt anywhere.
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if (![...(e.dataTransfer?.types ?? [])].includes('Files')) return;
    dragDepth++;
    $('dropHint').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    dragDepth = Math.max(0, dragDepth - 1);
    if (!dragDepth) $('dropHint').hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropHint').hidden = true;
    const file = e.dataTransfer?.files?.[0];
    if (!file || !/\.(docx|txt|md)$/i.test(file.name)) return;
    try {
      const res = await P.readDroppedFile(file);
      if (res) addOrUpdateScript({ text: res.text, filePath: res.filePath, name: res.name ?? file.name });
    } catch (err) {
      setStatus('lost', `Could not read file: ${err.message}`);
    }
  });

  P.onScriptFileChanged((data) => { if (S.followFileChanges) applyFileChange(data); });
  P.onShortcutToggle(toggle);
  P.onFullscreenChanged(setFullscreenUi);
  navigator.mediaDevices?.addEventListener?.('devicechange', refreshMics);
  window.addEventListener('beforeunload', () => {
    rememberPosition(true);
    const p = pendingSave;
    pendingSave = {};
    if (Object.keys(p).length) P.setSettings(p);
  });
}

async function init() {
  P = await loadPlatform();
  const info = await P.appInfo();
  const saved = await P.getSettings();
  S = { ...DEFAULT_SETTINGS, ...saved };
  if (saved.fontSize == null && window.innerWidth < 600) S.fontSize = 34; // phones
  if (!S.globalShortcut && P.features.globalShortcut) {
    S.globalShortcut = info.platform === 'darwin' ? 'Command+Shift+Space' : 'Control+Alt+Space';
  }

  const html = document.documentElement;
  html.classList.add(`platform-${P.kind}`);
  if (info.platform === 'darwin' && P.kind === 'electron') html.classList.add('mac');
  if (P.kind === 'android' || P.kind === 'ios') html.classList.add('mobile');
  document.querySelectorAll('[data-feature]').forEach((el) => {
    if (!P.features[el.dataset.feature]) el.hidden = true;
  });
  $('platformLabel').textContent = `for ${P.label}`;
  $('appVersion').textContent = info.version ? `v${info.version}` : '';

  ensureScripts();
  bindUi();
  bindSettings();
  applyTheme();
  await refreshPacks();
  renderScriptSelect();
  applyAppearance();
  rebuild();
  P.watchScript(S.followFileChanges ? activeScript().filePath : null);
  requestAnimationFrame(frame);

  if (!S.modelPromptDismissed && !S.forceSimulation && !packStatus.some((p) => p.installed) && P.features.packDownload) {
    openLanguageDialog('first');
  }

  // Offline support for the web build (not needed inside desktop/mobile shells).
  if (P.kind === 'web' && 'serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}

init().catch((err) => {
  console.error(err);
  document.body.insertAdjacentHTML('beforeend',
    `<pre style="position:fixed;inset:auto 10px 10px;color:#F87171;white-space:pre-wrap">Startup error: ${String(err?.stack || err)}</pre>`);
});
