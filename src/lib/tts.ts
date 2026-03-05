import { Settings } from "./types";

export function listVoices(): SpeechSynthesisVoice[] {
  return window.speechSynthesis.getVoices();
}

export function speak(textRaw: string, settings: Settings) {
  if (!settings.ttsEnabled) return;
  const text = textRaw.trim();
  if (!text) return;

  const u = new SpeechSynthesisUtterance(text);
  u.lang = settings.ttsLang || "he-IL";

  const voices = window.speechSynthesis.getVoices();
  if (settings.preferredVoiceURI) {
    const v = voices.find(vv => vv.voiceURI === settings.preferredVoiceURI);
    if (v) u.voice = v;
  }

  window.speechSynthesis.cancel(); // stop previous
  window.speechSynthesis.speak(u);
}
