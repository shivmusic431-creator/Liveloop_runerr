# Keys की गाइड: कौन-सी key क्या है, कहाँ मिलेगी

**env क्या होता है?** ऐप के लिए "गुप्त सेटिंग्स" की list। हर एक में `NAAM=value` होता है। ऐप को पता होना चाहिए कि किस GitHub repo में जाना है, किस Firebase में data रखना है, और आपका password क्या है। यह सब code में नहीं लिखते (code public है), इसलिए Vercel और GitHub की settings में अलग से डालते हैं।

दो फ़ाइलें हैं, दोनों में सिर्फ़ `NAAM=` लिखा है, value आप भरेंगे:

| फ़ाइल | कहाँ डालनी है |
|---|---|
| `vercel.env` | **Vercel** → आपका Project → Settings → Environment Variables। पहले key-box में पूरी फ़ाइल paste कर दो, वह अपने आप सब keys बना देगा। |
| `github-secrets.env` | **GitHub** → `liveloop-runner` repo → Settings → Secrets and variables → Actions → New repository secret। हर लाइन अलग secret बनेगी (5 बार)। |

> सबसे आसान तरीका: नीचे की सारी values एक Notepad में जमा कर लो, फिर दोनों जगह उतार दो।

---

## काम का क्रम (इसी क्रम में चलो)

1. GitHub पर दो repo बनाओ और token लो → `GH_TOKEN`, `RUNNER_REPO`, `VIDEOS_REPO`
2. Firebase बनाओ → `FIREBASE_SERVICE_ACCOUNT`
3. Google Cloud में YouTube login बनाओ → `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
4. Vercel पर deploy करो → domain मिलेगा
5. वह domain Google Cloud में जोड़ो (नीचे बताया है)
6. GitHub Secrets भरो

---

## हर key का हाल

### 1. `ADMIN_PASSWORD`
- **क्या है:** आपके dashboard का password।
- **कहाँ मिलेगा:** कहीं से नहीं मिलता, खुद सोचो। लंबा रखो (जैसे 12+ अक्षर)।
- **क्या होगा:** इसी से आप dashboard में login करेंगे।
- **कहाँ डालना:** सिर्फ़ Vercel में।

### 2. `FIREBASE_SERVICE_ACCOUNT`
- **क्या है:** Firebase (Google का free database) का "चाबी वाला फ़ाइल"। इसमें आपके project की पहचान और password है।
- **कहाँ मिलेगा:**
  1. console.firebase.google.com खोलो → **Add project** → नाम दो → बनाओ।
  2. बाईं तरफ़ **Build → Firestore Database → Create database** → "Production mode" → region चुनो (जैसे `asia-south1` Mumbai) → Enable।
  3. Firestore में ऊपर **Rules** टैब → जो भी लिखा है मिटाकर `firestore.rules` फ़ाइल की सामग्री paste करो → **Publish**।
  4. ऊपर बाईं तरफ़ ⚙ (गियर) → **Project settings → Service accounts** टैब → **Generate new private key** → Generate। एक `.json` फ़ाइल download होगी।
  5. उस फ़ाइल को Notepad में खोलो, **शुरू से अंत तक पूरा text** copy करो (`{` से `}` तक)।
- **क्या होगा:** Dashboard और runner दोनों इसी से आपकी lives की settings, status, logs और channel की login जानकारी पढ़ते-लिखते हैं।
- **कहाँ डालना:** Vercel में भी और GitHub Secrets में भी, **दोनों जगह एक जैसा**।
- **ध्यान:** यही key चैनल की login को encrypt करने में भी इस्तेमाल होती है। इसलिए **दोबारा "Generate new private key" मत दबाओ**। दबाया तो चैनल दोबारा जोड़ने पड़ेंगे।

### 3. `GH_TOKEN` (और GitHub में इसी का नाम `VIDEOS_TOKEN`)
- **क्या है:** GitHub की "इजाज़त-पर्ची"। इससे dashboard आपके repo में काम कर सकता है।
- **कहाँ मिलेगा:**
  1. github.com → ऊपर दाईं तरफ़ अपनी फ़ोटो → **Settings**।
  2. सबसे नीचे बाईं तरफ़ **Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**।
  3. नाम: `liveloop`। Expiration: **1 year** (या No expiration अगर दिखे)।
  4. **Repository access → Only select repositories** → `liveloop-runner` और `liveloop-videos` दोनों चुनो।
  5. **Permissions → Repository permissions** में दो चीज़ें खोजो:
     - **Actions** → *Read and write*
     - **Contents** → *Read and write*
  6. **Generate token** → `github_pat_...` वाला text तुरंत copy करो (दोबारा नहीं दिखेगा)।
- **क्या होगा:** Start/Stop दबाने पर GitHub में workflow चालू होता है, videos की list दिखती है, delete होता है। Runner भी इसी से Release से video download और upload करता है।
- **कहाँ डालना:** Vercel में नाम `GH_TOKEN`, GitHub Secrets में नाम `VIDEOS_TOKEN`। **value वही एक** है।

### 4. `RUNNER_REPO`
- **क्या है:** आपके public repo (जिसमें code है) का पता।
- **कहाँ मिलेगा:** GitHub में उस repo को खोलो। Address bar में `github.com/` के बाद का हिस्सा। जैसे `ramesh123/liveloop-runner`।
- **क्या होगा:** Dashboard को पता चलता है कि live किस repo में चलाना है।
- **कहाँ डालना:** सिर्फ़ Vercel में।

### 5. `VIDEOS_REPO`
- **क्या है:** आपके private repo (जिसमें videos रहते हैं) का पता।
- **कहाँ मिलेगा:** ऊपर जैसा ही, जैसे `ramesh123/liveloop-videos`।
- **क्या होगा:** Videos यहाँ के "Release" में जमा होते हैं और runner यहीं से उठाता है।
- **कहाँ डालना:** Vercel में भी और GitHub Secrets में भी।

### 6. `GOOGLE_CLIENT_ID` और `GOOGLE_CLIENT_SECRET`
- **क्या है:** "Google से login" बटन की पहचान। इससे आप dashboard से अपना YouTube channel जोड़ पाते हैं।
- **कहाँ मिलेगा:**
  1. console.cloud.google.com → ऊपर project चुनने वाले बॉक्स में **वही project** चुनो जो Firebase ने बनाया (नाम वही होगा)।
  2. ☰ मेन्यू → **APIs & Services → Library** → "YouTube Data API v3" खोजो → **Enable**।
  3. **APIs & Services → OAuth consent screen** (नए रूप में *Google Auth Platform*) → **Get started** → App name `LiveLoop`, अपनी Gmail → Audience **External** → Finish।
  4. उसी जगह **Audience** टैब → **Publish app** → Confirm। (ज़रूरी है, वरना login 7 दिन में टूट जाता है।)
  5. **Credentials** (या *Clients*) → **Create credentials / Create client → OAuth client ID** → Application type **Web application** → नाम `liveloop`।
  6. **Authorized redirect URIs** में अभी कुछ मत डालो (नीचे "Redirect URI" देखो) → Create।
  7. जो **Client ID** (`....apps.googleusercontent.com`) और **Client secret** (`GOCSPX-...`) दिखे, दोनों copy करो।
- **क्या होगा:** Dashboard के "चैनल" टैब में **चैनल जोड़ो** दबाने पर Google का login खुलता है। इसके बाद हर live में stream key डालने की ज़रूरत नहीं रहती। Broadcast अपने आप बनता है।
- **कहाँ डालना:** Vercel में भी और GitHub Secrets में भी, दोनों जगह एक जैसा।
- **पहली बार login पर:** Google "app verify नहीं हुआ" दिखाए तो **Advanced → Go to LiveLoop (unsafe) → Allow** दबाओ। यह आपका अपना app है, इसलिए ठीक है।

---

## Redirect URI (Vercel deploy के बाद, एक बार)
1. Vercel पर deploy होने के बाद आपका domain मिलेगा, जैसे `liveloop-abc.vercel.app`।
2. Google Cloud → Credentials → अपना OAuth client खोलो → **Authorized redirect URIs → Add URI** →
   `https://liveloop-abc.vercel.app/api/oauth/callback`
   (अपना domain लगाओ) → Save।
3. Dashboard के **चैनल** टैब में भी यही पता लिखा दिखता है, वहाँ से Copy कर सकते हो।
4. Save के बाद 1-5 मिनट लग सकते हैं।

---

## Gemini API keys (Clips के लिए)
- **क्या है:** Clips बनाने में Gemini AI best moments, title, description, tags और upload का समय तय करता है।
- **कहाँ मिलेगा:** aistudio.google.com/apikey → **Create API key** (हर बार **नया project**) → `AIza...` वाली key copy करो।
- **कहाँ डालना:** Vercel या GitHub में **नहीं**। Dashboard → **क्लिप्स** → **+ Key जोड़ो** (कई keys एक साथ, हर एक नई line में)। Keys encrypted सेव होती हैं।
- **कितनी:** जितनी ज़्यादा (अलग-अलग projects की), उतना ज़्यादा रोज़ का free quota।

## ज़रूरी नहीं वाली keys (डालना ज़रूरी नहीं)
`ENC_KEY`, `SESSION_SECRET`, `VIDEOS_TAG`, `CLIPS_TAG`, `RUNNER_REF`, `APP_URL`। इनके बिना सब चलता है, ऐप अपने आप डिफ़ॉल्ट लेता है।

## सब ठीक डाला या नहीं, कैसे जाँचें
Vercel पर Redeploy करो → dashboard खोलो → **सेटअप** टैब। हर चीज़ के आगे ✔ या ✘ दिखता है, और ✘ पर लिखा होता है कि क्या ठीक करना है। (GitHub Secrets इसमें नहीं जाँचे जा सकते। पहला छोटा test live चलाकर देखो।)
