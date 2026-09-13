// ---------------------------------------------------------------------------
// Speech — STT always via the browser's built-in Web Speech API (already
// reliable, free, no setup). TTS defaults to whatever voices the browser/OS
// has installed, with Bhashini as an optional higher-coverage engine (returns
// real generated audio for any of its supported languages, regardless of
// what's installed locally) when credentials are present in Settings.
// ---------------------------------------------------------------------------

const BHASHINI_CONFIG_URL = "https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline";
const BHASHINI_PIPELINE_ID = "64392f96daac500b55c543cd";

const SpeechRecognitionImpl = window.SpeechRecognition || window.webkitSpeechRecognition;

/**
 * @param {(finalText:string) => void} onResult
 * @param {(error:string) => void} onError
 */
export function createSpeechRecognizer(onResult, onError) {
  if (!SpeechRecognitionImpl) return null;
  const recognizer = new SpeechRecognitionImpl();
  recognizer.continuous = true;
  recognizer.interimResults = true;
  recognizer.lang = "en-IN";
  let isListening = false;

  recognizer.onresult = (e) => {
    let finalText = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalText += e.results[i][0].transcript + " ";
    }
    if (finalText) onResult(finalText);
  };
  recognizer.onerror = (e) => onError(e.error);
  recognizer.onend = () => { if (isListening) recognizer.start(); };

  return {
    start() { isListening = true; recognizer.start(); },
    stop() { isListening = false; recognizer.stop(); },
    get listening() { return isListening; }
  };
}

export function isSTTSupported() {
  return !!SpeechRecognitionImpl;
}

// ---------------------------------------------------------------------------
// TTS
// ---------------------------------------------------------------------------

let voiceCache = [];
function refreshVoices() { voiceCache = speechSynthesis.getVoices(); }
speechSynthesis.onvoiceschanged = refreshVoices;
refreshVoices();

function findBrowserVoice(locale) {
  return voiceCache.find(v => v.lang === locale) || voiceCache.find(v => v.lang.startsWith(locale.split("-")[0]));
}

export function hasBrowserVoiceFor(locale) {
  return !!findBrowserVoice(locale);
}

function speakViaBrowser(text, locale) {
  const utter = new SpeechSynthesisUtterance(text);
  const voice = findBrowserVoice(locale);
  if (voice) { utter.voice = voice; utter.lang = voice.lang; }
  else { utter.lang = locale; }
  speechSynthesis.cancel();
  speechSynthesis.speak(utter);
}

async function speakViaBhashini(text, langCode, userId, apiKey) {
  const configRes = await fetch(BHASHINI_CONFIG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", userID: userId, ulcaApiKey: apiKey },
    body: JSON.stringify({
      pipelineTasks: [{ taskType: "tts", config: { language: { sourceLanguage: langCode } } }],
      pipelineRequestConfig: { pipelineId: BHASHINI_PIPELINE_ID }
    })
  });
  if (!configRes.ok) throw new Error("Bhashini TTS config call failed");
  const config = await configRes.json();
  const serviceId = config?.pipelineResponseConfig?.[0]?.config?.[0]?.serviceId;
  const endpoint = config?.pipelineInferenceAPIEndPoint;
  if (!serviceId || !endpoint) throw new Error("Bhashini didn't return a usable TTS pipeline for this language");

  const computeRes = await fetch(endpoint.callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", [endpoint.inferenceApiKey.name]: endpoint.inferenceApiKey.value },
    body: JSON.stringify({
      pipelineTasks: [{ taskType: "tts", config: { language: { sourceLanguage: langCode }, serviceId, gender: "female" } }],
      inputData: { input: [{ source: text }] }
    })
  });
  if (!computeRes.ok) throw new Error("Bhashini TTS compute call failed");
  const result = await computeRes.json();
  const audioBase64 = result?.pipelineResponse?.[0]?.audio?.[0]?.audioContent;
  if (!audioBase64) throw new Error("Bhashini returned no audio");

  const audio = new Audio("data:audio/wav;base64," + audioBase64);
  await audio.play();
}

/**
 * @param {string} text
 * @param {string} locale - e.g. "hi-IN" (used for browser fallback)
 * @param {string} langCode - e.g. "hi" (used for Bhashini)
 * @param {{bhashiniUserId:string, bhashiniApiKey:string}} apiSettings
 */
export async function speak(text, locale, langCode, apiSettings) {
  if (!text) return;
  const hasBhashini = apiSettings?.bhashiniUserId && apiSettings?.bhashiniApiKey;
  if (hasBhashini) {
    try {
      await speakViaBhashini(text, langCode, apiSettings.bhashiniUserId, apiSettings.bhashiniApiKey);
      return "Bhashini";
    } catch (err) {
      console.warn("Bhashini TTS failed, falling back to browser voice:", err.message);
    }
  }
  speakViaBrowser(text, locale);
  return "Browser (fallback)";
}
