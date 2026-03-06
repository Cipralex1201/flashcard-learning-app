import type { Settings } from "./types";

export function listVoices(): SpeechSynthesisVoice[] {
  return window.speechSynthesis.getVoices();
}

function isAudioFile(s: string) {
  return /\.(mp3|wav|ogg)$/i.test((s ?? "").trim());
}

export function speak(textRaw: string, settings: Settings) {
  if (!settings.ttsEnabled) return;

  const text = (textRaw ?? "").trim();
  if (!text) return;

  // ✅ If it's a generated audio filename, play it from /public/audio/
  if (isAudioFile(text)) {
    const audio = new Audio(`/audio/${encodeURIComponent(text)}`);
    // stop any ongoing speech so you don't get overlap
    window.speechSynthesis.cancel();

    audio.play().catch((err) => {
      console.error("Audio play failed:", err);
    });
    return;
  }

  // ✅ Otherwise, fallback to browser TTS
  const u = new SpeechSynthesisUtterance(text);
  u.lang = settings.ttsLang || "he-IL";

  const voices = window.speechSynthesis.getVoices();
  if (settings.preferredVoiceURI) {
    const v = voices.find((vv) => vv.voiceURI === settings.preferredVoiceURI);
    if (v) u.voice = v;
  }

  window.speechSynthesis.cancel(); // stop previous
  window.speechSynthesis.speak(u);
}

