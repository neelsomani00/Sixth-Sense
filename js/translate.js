// ---------------------------------------------------------------------------
// Translation — pluggable, tried in this order:
//   1. Bhashini (if the user has entered credentials in Settings) — best
//      quality for the 22 official Indian languages, purpose-built for them.
//   2. Chrome's built-in on-device Translator API (Chrome 138+, desktop
//      only) — genuinely good quality, free, no API key, and nothing leaves
//      the device. Not available in Edge/Firefox/Safari or on mobile, so
//      it's a bonus tier, not something to depend on.
//   3. MyMemory — free public API, works everywhere, but is a crowd-sourced
//      "translation memory" rather than a proper neural MT engine, so
//      quality is noticeably weaker. This is the last-resort fallback that
//      guarantees the app always produces *something*.
//
// To add another provider later: write a function with the same signature
// (text, targetLangCode) => Promise<string>, and add it to the try order
// in translateText() below.
// ---------------------------------------------------------------------------

const BHASHINI_CONFIG_URL = "https://meity-auth.ulcacontrib.org/ulca/apis/v0/model/getModelsPipeline";
// A generally-available public pipeline ID covering ASR+NMT+TTS, used by the
// wider Bhashini developer community as the default starting point. If
// Bhashini ever retires it, a fresh one can be obtained via their Pipeline
// Search Call — see README.
const BHASHINI_PIPELINE_ID = "64392f96daac500b55c543cd";

async function translateViaMyMemory(text, targetLangCode) {
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=en|${targetLangCode}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("MyMemory request failed");
  const data = await res.json();
  const translated = data.responseData?.translatedText || "";
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT|INVALID (SOURCE|TARGET) LANGUAGE/i.test(translated)) {
    throw new Error("MyMemory limit reached or unsupported language pair");
  }
  return translated;
}

async function getBhashiniPipelineConfig(userId, apiKey, targetLangCode) {
  const res = await fetch(BHASHINI_CONFIG_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", userID: userId, ulcaApiKey: apiKey },
    body: JSON.stringify({
      pipelineTasks: [{ taskType: "translation", config: { language: { sourceLanguage: "en", targetLanguage: targetLangCode } } }],
      pipelineRequestConfig: { pipelineId: BHASHINI_PIPELINE_ID }
    })
  });
  if (!res.ok) throw new Error("Bhashini config call failed (check User ID / API Key)");
  return res.json();
}

async function translateViaBhashini(text, targetLangCode, userId, apiKey) {
  const config = await getBhashiniPipelineConfig(userId, apiKey, targetLangCode);
  const serviceId = config?.pipelineResponseConfig?.[0]?.config?.[0]?.serviceId;
  const endpoint = config?.pipelineInferenceAPIEndPoint;
  if (!serviceId || !endpoint) throw new Error("Bhashini didn't return a usable pipeline for this language");

  const computeRes = await fetch(endpoint.callbackUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", [endpoint.inferenceApiKey.name]: endpoint.inferenceApiKey.value },
    body: JSON.stringify({
      pipelineTasks: [{ taskType: "translation", config: { language: { sourceLanguage: "en", targetLanguage: targetLangCode }, serviceId } }],
      inputData: { input: [{ source: text }] }
    })
  });
  if (!computeRes.ok) throw new Error("Bhashini translate call failed");
  const result = await computeRes.json();
  const translated = result?.pipelineResponse?.[0]?.output?.[0]?.target;
  if (!translated) throw new Error("Bhashini returned no translation");
  return translated;
}

// Chrome's built-in Translator API (window.Translator). Runs entirely
// on-device — the model downloads once per language pair on first use
// (which can take a moment), then subsequent calls are fast and fully
// offline. Feature-detected via `'Translator' in self`, since this doesn't
// exist at all outside recent desktop Chrome.
async function translateViaChromeBuiltIn(text, targetLangCode) {
  if (!("Translator" in self)) {
    throw new Error("Chrome's built-in Translator isn't available in this browser");
  }
  const availability = await Translator.availability({ sourceLanguage: "en", targetLanguage: targetLangCode });
  if (availability === "unavailable") {
    throw new Error("Chrome's built-in Translator doesn't support this language pair");
  }
  // "downloadable"/"downloading" mean the on-device model needs fetching
  // first — create() waits for that automatically, so the caller just sees
  // a slightly longer first call for a given language pair.
  const translator = await Translator.create({ sourceLanguage: "en", targetLanguage: targetLangCode });
  const translated = await translator.translate(text);
  if (!translated) throw new Error("Chrome's built-in Translator returned nothing");
  return translated;
}

/**
 * @param {string} text
 * @param {string} targetLangCode - ISO 639-1 code, e.g. "hi", "pa", "gu"
 * @param {{bhashiniUserId:string, bhashiniApiKey:string, preferBhashini:boolean}} apiSettings
 * @returns {Promise<{text:string, engine:string}>}
 */
export async function translateText(text, targetLangCode, apiSettings) {
  if (targetLangCode === "en") return { text, engine: "passthrough" };

  const hasBhashini = apiSettings?.bhashiniUserId && apiSettings?.bhashiniApiKey;
  if (hasBhashini) {
    try {
      const translated = await translateViaBhashini(text, targetLangCode, apiSettings.bhashiniUserId, apiSettings.bhashiniApiKey);
      return { text: translated, engine: "Bhashini" };
    } catch (err) {
      console.warn("Bhashini translation failed, falling back:", err.message);
    }
  }

  try {
    const translated = await translateViaChromeBuiltIn(text, targetLangCode);
    return { text: translated, engine: "Chrome on-device" };
  } catch (err) {
    console.warn("Chrome built-in translation unavailable/failed, falling back:", err.message);
  }

  const translated = await translateViaMyMemory(text, targetLangCode);
  return { text: translated, engine: "MyMemory (fallback)" };
}
