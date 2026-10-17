// Helpers shared by the browser-based adapters (web + mobile).

/** Reads a .docx / .txt File object into plain script text. */
export async function readFileObject(file) {
  if (/\.docx$/i.test(file.name)) {
    await ensureMammoth();
    const { value } = await window.mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
    return value.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }
  return (await file.text()).replace(/^﻿/, '').replace(/\r\n/g, '\n');
}

let mammothLoading = null;
function ensureMammoth() {
  if (window.mammoth) return Promise.resolve();
  mammothLoading ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'vendor/mammoth.browser.min.js';
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the Word reader'));
    document.head.appendChild(s);
  });
  return mammothLoading;
}

/** Opens a file picker and returns { text, name } or null. */
export function pickScriptFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.docx,.txt,.md,text/plain,application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return resolve(null);
      resolve({ text: await readFileObject(file), name: file.name });
    };
    input.click();
  });
}

export function localSettings(key = 'talkprompter.settings') {
  return {
    async getSettings() {
      try {
        return JSON.parse(localStorage.getItem(key) || '{}');
      } catch {
        return {};
      }
    },
    async setSettings(patch) {
      try {
        const cur = JSON.parse(localStorage.getItem(key) || '{}');
        localStorage.setItem(key, JSON.stringify({ ...cur, ...patch }));
      } catch {
        // Storage full or blocked: settings simply won't persist.
      }
      return { ok: true };
    }
  };
}

/** Screen Wake Lock — keeps the display on while reading. */
export function browserWakeLock() {
  let lock = null;
  let wanted = false;
  document.addEventListener('visibilitychange', async () => {
    if (wanted && document.visibilityState === 'visible' && !lock) await acquire();
  });
  async function acquire() {
    try {
      lock = await navigator.wakeLock?.request('screen');
      lock?.addEventListener('release', () => { lock = null; });
    } catch {
      lock = null;
    }
  }
  return async (on) => {
    wanted = on;
    if (on) await acquire();
    else {
      await lock?.release().catch(() => {});
      lock = null;
    }
  };
}

export const noop = () => {};
export const noopSubscribe = () => () => {};
