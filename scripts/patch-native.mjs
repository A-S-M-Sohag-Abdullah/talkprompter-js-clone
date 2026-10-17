// Adds the microphone permissions the native mobile projects need. Safe to
// run repeatedly (runs automatically as part of `npm run mobile:sync`).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const manifest = path.join(ROOT, 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
if (fs.existsSync(manifest)) {
  let xml = fs.readFileSync(manifest, 'utf8');
  for (const perm of ['android.permission.RECORD_AUDIO', 'android.permission.MODIFY_AUDIO_SETTINGS']) {
    if (!xml.includes(perm)) {
      xml = xml.replace('</manifest>', `    <uses-permission android:name="${perm}" />\n</manifest>`);
    }
  }
  fs.writeFileSync(manifest, xml);
  console.log('Android: microphone permissions set');
}

const plist = path.join(ROOT, 'ios', 'App', 'App', 'Info.plist');
if (fs.existsSync(plist)) {
  let xml = fs.readFileSync(plist, 'utf8');
  if (!xml.includes('NSMicrophoneUsageDescription')) {
    const entry = '\t<key>NSMicrophoneUsageDescription</key>\n'
      + '\t<string>TalkPrompter listens to you read so it can scroll your script. Audio is processed on this device and never leaves it.</string>\n';
    const at = xml.lastIndexOf('</dict>');
    xml = xml.slice(0, at) + entry + xml.slice(at);
  }
  fs.writeFileSync(plist, xml);
  console.log('iOS: microphone usage description set');
}
