# LiveLoop Cloud

फ़ोन/Termux की जगह अब live **GitHub Actions** पर चलता है और dashboard **Vercel** पर। Session kill, battery, नेट की कोई दिक्कत नहीं। जब मर्ज़ी browser से Start/Stop।

```
Browser ── Vercel (dashboard + API) ──► GitHub Actions runner ──► YouTube
                  │                          │  ▲
                  └──────── Firestore ◄──────┘  └── videos: private repo का Release
```

| फ़ोल्डर | काम |
|---|---|
| `web/` | Vercel पर जाता है: dashboard (`public/index.html`) + API (`api/index.js`) |
| `runner/` | Actions पर चलता है: `run.js` (live), `import.js` (link से video), `cleanup.js` |
| `.github/workflows/` | `live.yml`, `import.yml`, `clip.yml` (सिर्फ़ dashboard से `workflow_dispatch`) |
| `env/` | `vercel.env`, `github-secrets.env` (खाली values) और **`KEYS_GUIDE.md`** (कौन-सी key कहाँ मिलेगी) |
| `firestore.rules` | Firestore पर बाहरी access पूरी तरह बंद |

## Live कैसे चलता है
1. Start दबाओ → Vercel GitHub workflow चालू करता है (पूरे में 30–60 सेकंड)।
2. Runner चुने हुए videos Release से download करता है, YouTube broadcast बनाता है और FFmpeg से loop चलाता है। Video सही format में हो तो `copy` mode (CPU लगभग 0), वरना अपने आप software encode।
3. Stop दबाओ या auto-stop पूरा हो → runner ठीक से FFmpeg बंद करके YouTube broadcast **complete** करता है।
4. Status, speed, logs dashboard में दिखते हैं। Runner अचानक मर जाए तो “संपर्क टूटा” + **रीसेट** बटन।

---

## Setup (एक बार, लगभग 30–40 मिनट)

**Keys कहाँ से लानी हैं और क्या हैं, यह सब `env/KEYS_GUIDE.md` में step-by-step लिखा है। पहले उसे पढ़ो।**

> **पहले जान लो:** GitHub Actions का उपयोग streaming जैसे काम के लिए GitHub की शर्तों के दायरे से बाहर माना जा सकता है। इसलिए इसे **अलग GitHub account** पर रखो, जिस पर कोई ज़रूरी काम न हो। Videos आपके अपने (या license वाले) हों।
> Single job अधिकतम 6 घंटे चलता है, इसलिए Auto-stop **5.5 घंटे तक** ही रखा जा सकता है।

### 1. GitHub: दो repo + token
1. **`liveloop-runner`** → **Public**। इस पूरे zip की सामग्री इसमें push करो (`web/`, `runner/`, `.github/`, …)।
2. **`liveloop-videos`** → **Private**, “Add a README” टिक करके बनाओ (खाली repo में Release नहीं बनता)।
3. Settings → Developer settings → **Fine-grained tokens** → New:
   - Repository access: **Only select** → दोनों repo
   - Permissions: **Actions: Read and write**, **Contents: Read and write** (Metadata अपने आप)
   - यही token Vercel में `GH_TOKEN` और GitHub Secrets में `VIDEOS_TOKEN` बनेगा।
4. Runner repo में **Settings → Actions → General → Workflow permissions** को Read-only रखो। **Fork pull request workflows** में “Require approval” रखो।

### 2. Firebase (Firestore)
1. console.firebase.google.com → Project बनाओ → **Build → Firestore Database → Create** (production mode)।
2. **Rules** टैब में `firestore.rules` की सामग्री paste करके Publish करो।
3. Project settings → **Service accounts → Generate new private key** → JSON download। इसका **पूरा text** `FIREBASE_SERVICE_ACCOUNT` बनेगा।

### 3. Google OAuth (YouTube)
1. console.cloud.google.com → वही project चुनो → **APIs & Services → Library → YouTube Data API v3 → Enable**।
2. **OAuth consent screen**: External → नाम/ईमेल भरो → **Publish app (Production)**। Testing में रहा तो token 7 दिन में expire होता है।
3. **Credentials → Create → OAuth client ID → Web application**। Redirect URI बाद में (Vercel का domain मिलने पर) जोड़ेंगे।
4. YouTube channel पर **Live streaming enable** होनी चाहिए (पहली बार 24 घंटे लग सकते हैं)।

### 4. Vercel
1. vercel.com → **Add New → Project** → `liveloop-runner` import करो।
2. **Root Directory = `web`** (ज़रूरी), Framework = Other।
3. `env/vercel.env` की सारी keys **Environment Variables** में डालो → Deploy।
4. Domain मिलने पर Google Cloud में OAuth client की **Authorized redirect URI** में डालो:
   `https://आपका-domain.vercel.app/api/oauth/callback` (dashboard के **चैनल** टैब में भी लिखा दिखता है)।

### 5. GitHub Secrets
`env/github-secrets.env` की 5 keys runner repo → Settings → Secrets and variables → Actions में डालो।

### 6. पहला test
1. Dashboard खोलो → **सेटअप** टैब → सब ✔ होना चाहिए (`✘` पर लिखा होता है क्या ठीक करना है)।
2. **चैनल** टैब → चैनल जोड़ो (“unverified app” चेतावनी पर Advanced → Go to… → Allow)।
3. **वीडियो** टैब → **Link से जोड़ो** → छोटा video का direct link डालो → progress देखो।
4. **लाइव** टैब → नया live → video चुनो → **Live शुरू करो** (पहले 5-10 मिनट के auto-stop से)।

---

## Video जोड़ना (Link से)
- Link **सीधी file** की हो: Dropbox में `?dl=1`, या किसी server की `.mp4` link। Google Drive/MediaFire के web-page link अक्सर नहीं चलते (MediaFire कई बार datacenter IP रोक देता है)।
- Runner download करता है, **ज़रूरत हो तो** H.264+AAC और 2-सेकंड keyframe में convert करता है (copy mode के लिए), फिर private Release में रखता है। File **2 GB** से बड़ी नहीं हो सकती (convert के बाद भी)।
- Thumbnail के लिए `.jpg/.png` (2 MB तक) का link दो।
- Playlist में सारे videos की resolution/fps एक जैसी रखो।
- Link Firestore में बस import के दौरान रहता है, खत्म होते ही मिट जाता है, और GitHub के public logs में नहीं आता।

## Clips (Shorts) — नया फ़ीचर
Live वाला सिस्टम जैसा था वैसा ही है। इसके साथ एक नया **क्लिप्स** टैब जुड़ा है।

**क्या करता है:** तुम एक YouTube video का link देते हो → runner उसे download करता है → transcript निकालता है (YouTube captions, न हों तो Whisper) → **Gemini** best moments की timeline बनाता है (कितने Shorts, कौन-सा हिस्सा कितने सेकंड से कितने सेकंड तक) → हर clip captions के साथ 9:16 में बनता है → Gemini हर clip का title, description, tags और upload का समय बताता है → सारे clips **एक साथ** तुम्हारे चैनल पर schedule हो जाते हैं (private + `publishAt`, रोज़ 1 के हिसाब से; तय समय पर YouTube खुद public करता है) → काम पूरा होते ही runner की सब temporary files हट जाती हैं।

**नया setup (कोई नया secret नहीं चाहिए):**
1. नई फ़ाइलें अपने **runner repo** में और **web** वाला हिस्सा Vercel पर दोबारा deploy करो (पूरा zip बदल दो)। Runner repo में `.github/workflows/clip.yml` होना चाहिए।
2. Dashboard → **क्लिप्स** → **+ Key जोड़ो** में Gemini API keys paste करो (aistudio.google.com/apikey)। **हर key अलग Google project की हो**, वरना एक project की सभी keys का free quota साझा रहता है।
3. (ज़रूरत हो तो) **YouTube cookies** डालो। GitHub के IP पर YouTube कभी “bot check” लगाता है। अलग/नए Google account की cookies इस्तेमाल करो।
4. **+ नया क्लिप जॉब** → link, चैनल → शुरू करो।

**Gemini कैसे चलता है:** हर video पर 5 से 20 छोटी calls (सीमा तुम तय करते हो, default 15): moments खोजना → सबसे अच्छे चुनना → start/end ठीक करना → captions की स्पेलिंग सुधारना → title/description/tags → upload का समय → आख़िरी जाँच। हर step का नतीजा सेव होता है, इसलिए बीच में रुकने पर “फिर से कोशिश” दबाने से पुरानी calls दोबारा नहीं लगतीं।
- Models अपने आप `models.list` से मिलते हैं। सबसे नए/बेहतर से शुरू होकर नीचे आते हैं।
- Model नहीं मिला / overload / ख़राब जवाब → **अगला model**। Quota (429) → **अगली key**। Key ग़लत → वह key बंद (dashboard में दिखती है, “सब दोबारा चालू करो” से खुलती है)। Daily quota Pacific midnight (लगभग दोपहर 12:30–1:30 IST) पर लौटता है।

**अगर upload बीच में रुके** (YouTube quota आदि): जो clips schedule हो चुके वे रहते हैं, बाक़ी private Release (`clips`) में रखे जाते हैं और job “अधूरा” दिखता है। **बचे हुए upload करो** दबाने पर वे भेजे जाते हैं और Release से हट जाते हैं।

**सफ़ाई:** हर job के अंत में temporary files, Release में बेकार clips, 7 दिन से पुराने workflow runs और पुराने records हट जाते हैं।

**ध्यान रखो:** सिर्फ़ अपने या licensed videos के clips बनाओ। दूसरों के video पर copyright strike आ सकती है। एक समय में एक ही clip job चलता है।

## सुरक्षा
- Public repo में सिर्फ़ code है। कोई भी secret/logs में नहीं आता: stream key और tokens `::add-mask::` और अपनी redaction से छिपते हैं।
- Refresh tokens और stream keys Firestore में encrypted रहते हैं (key Firebase की private key से अपने आप बनती है, अलग से कुछ डालना नहीं)।
- Workflows में कोई push/PR trigger नहीं। बाहर वाला इन्हें चला नहीं सकता।
- Login: password + cookie, 5 गलत कोशिश पर 10 मिनट का lock।
- GitHub token सिर्फ़ Vercel के server पर रहता है, browser में कभी नहीं आता।

## सीमाएँ और खर्च
- **GitHub Actions minutes**: public repo में standard runner free है। (3 घंटे/दिन ≈ 90 घंटे/महीना।)
- **YouTube API quota**: 10,000 units/दिन। एक live start ≈ 300 units, यानी रोज़ दर्जनों start आराम से।
- **Firestore free limit**: 50k reads / 20k writes प्रति दिन। Dashboard खुला न हो तो हर 15 सेकंड, live चलते समय 3 सेकंड पर पोल करता है (tab छिपा हो तो रुक जाता है)।
- Runner शुरू होने में ~30–60 सेकंड लगते हैं।

## Debug console (Eruda)
Error समझ न आए तो Dashboard के **सेटअप** टैब में “Debug console → चालू करो” दबाओ (login से पहले भी नीचे “🐞 Debug console खोलो” लिंक है)। नीचे दाएँ गियर बटन में Console, Network (हर API call और उसका जवाब), Elements और Storage मिलते हैं। URL के आख़िर में `?debug=1` लगाने से भी चालू होता है। Eruda इंटरनेट से (jsDelivr) आता है और बंद करने पर पूरी तरह हट जाता है।

## Node.js 24
Runner (GitHub Actions) Node 24 पर चलता है, और workflows में `actions/checkout@v6` + `actions/setup-node@v6` हैं (Node 20 वाली पुरानी actions GitHub ने हटा दी हैं)। Vercel के लिए `web/package.json` में `"node": "24.x"` है। अगर Vercel version पर शिकायत करे तो Project → Settings → General → **Node.js Version = 24.x** चुनो।

## दिक्कत आए तो
| लक्षण | हल |
|---|---|
| “कतार में” 2 मिनट से ज़्यादा | Actions टैब में run खोलो; आमतौर पर Secret गलत/छूटा है |
| `GitHub: 404` start पर | `RUNNER_REPO` का नाम, token की repo-access, और branch (`main`) जाँचो |
| `Decrypt fail …` | Vercel और GitHub का `FIREBASE_SERVICE_ACCOUNT` अलग है (या Firebase key दोबारा बनाई)। दोनों जगह एक करो और चैनल दोबारा जोड़ो |
| `Channel का access खत्म` | चैनल हटाकर दोबारा जोड़ो (OAuth app Production में हो) |
| Import: “direct link नहीं है” | Dropbox `?dl=1` या सीधा `.mp4` link दो |
| “speed <1.0x” चेतावनी | Copy mode या कम quality लो |
| संपर्क टूटा | रीसेट दबाओ; Actions में run देखो |
