// ---------------------------------------------------------------------------
// Shared configuration. Edit VOCAB here to change your trained word list —
// every other module (recognition, playback) reads from this single source.
// ---------------------------------------------------------------------------

export const VOCAB = [
  ...Array.from({ length: 26 }, (_, i) => String.fromCharCode(65 + i)), // A-Z
  ...Array.from({ length: 11 }, (_, i) => String(i)),                   // 0-10
  "HELLO", "THANK YOU", "PLEASE", "SORRY", "YES", "NO",
  "HELP", "SOS / EMERGENCY", "WATER", "FOOD", "DOCTOR",
  "POLICE", "FIRE", "STOP", "WAIT", "CONGRATULATIONS",
  "GOOD", "BAD", "NAME", "WHERE"
];

export const STORAGE_KEYS = {
  references: "sixthsense_isl_references",
  apiSettings: "sixthsense_api_settings",
  vocabOverrides: "sixthsense_vocab_overrides"
};

export const LANGUAGES = [
  { code: "en", name: "English",   ttsLocale: "en-IN" },
  { code: "hi", name: "Hindi",     ttsLocale: "hi-IN" },
  { code: "mr", name: "Marathi",   ttsLocale: "mr-IN" },
  { code: "ta", name: "Tamil",     ttsLocale: "ta-IN" },
  { code: "te", name: "Telugu",    ttsLocale: "te-IN" },
  { code: "bn", name: "Bengali",   ttsLocale: "bn-IN" },
  { code: "gu", name: "Gujarati",  ttsLocale: "gu-IN" },
  { code: "kn", name: "Kannada",   ttsLocale: "kn-IN" },
  { code: "ml", name: "Malayalam", ttsLocale: "ml-IN" },
  { code: "pa", name: "Punjabi",   ttsLocale: "pa-IN" },
  { code: "ur", name: "Urdu",      ttsLocale: "ur-IN" },
  { code: "es", name: "Spanish",   ttsLocale: "es-ES" },
  { code: "fr", name: "French",    ttsLocale: "fr-FR" },
  { code: "de", name: "German",    ttsLocale: "de-DE" },
  { code: "zh", name: "Chinese (Simplified)", ttsLocale: "zh-CN" },
  { code: "ja", name: "Japanese",  ttsLocale: "ja-JP" },
  { code: "ar", name: "Arabic",    ttsLocale: "ar-SA" },
  { code: "ru", name: "Russian",   ttsLocale: "ru-RU" },
  { code: "pt", name: "Portuguese", ttsLocale: "pt-BR" }
];

// Bhashini uses ISO-639-1 codes, same as above for every language listed here.
