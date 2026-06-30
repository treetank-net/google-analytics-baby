# google-analytics-baby

Claude Code plugin: read-only MCP server for Google Analytics 4 (GA4). Członek rodziny `*-baby`
(obok `google-ads-baby` i `meta-ads-baby`).

## Architektura

Plugin = MCP server (stdio). Bez hooków — bo read-only.

### Read-only — i DLACZEGO zero safety
To CELOWO najlżejszy członek rodziny. `google-ads-baby` i `meta-ads-baby` mają two-phase mutation
safety (prepare/confirm + safe word + PreToolUse hook + audit log mutacji), bo mutacja na koncie
reklamowym przez LLM = ryzyko wydania budżetu. Tu nic takiego nie ma czego chronić: czytanie raportów
nie wydaje budżetu. Dlatego:
- brak hooków (`hooks.json`, `safety-hook.js`),
- brak `prepare_*` / `confirm_*`, brak safe word,
- brak audit logu mutacji.
To świadoma decyzja, nie brak. Gdy kiedyś pojawią się mutacje GA4 Admin (Faza 4 w ROADMAP) — DOPIERO
wtedy reużyjemy posture z rodziny.

### OAuth — osobny od ads
Reużywamy WZORZEC z `google-ads-baby` (`config.ts`: loadSavedConfig/saveConfig/configFromEnv;
`auth.ts`: lokalny serwer OAuth, `/open` landing, `/callback`), ale z różnicami:
- scope = `https://www.googleapis.com/auth/analytics.readonly` (w ads było `adwords`),
- osobny config dir: `.google-analytics-baby` (env override `GA_BABY_DATA`),
- env prefix `GOOGLE_ANALYTICS_*` (CLIENT_ID, CLIENT_SECRET, REFRESH_TOKEN),
- brak developer tokena, brak MCC, brak pól safety,
- osobny refresh token — osobny consent Google, nie współdzieli tokenu z ads,
- port lokalnego serwera OAuth: 9877 (ads używa 9876 — żeby nie kolidowały).

### API — GA4 Data + Admin
- GA4 Data API: `@google-analytics/data`, `BetaAnalyticsDataClient` (raporty, realtime).
- GA4 Admin API: `@google-analytics/admin`, `AnalyticsAdminServiceClient` (properties, linki Ads, custom dims).
- Auth: OAuth2 refresh token przez `google-auth-library` (`OAuth2Client`), przekazany jako `authClient`
  do konstruktora klientów GA.
- **Haczyk do dopięcia:** oba SDK domyślnie używają ADC (Application Default Credentials) i trzeba je
  ZMUSIĆ do użycia `OAuth2Client` — przez `new BetaAnalyticsDataClient({ authClient })`. To realny
  punkt do zweryfikowania end-to-end w osobnym wątku (cast typu w `client.ts` jest tymczasowy).

### Bundling — ten sam pipeline co ads
`tsc` → `dist/` (intermediate, nie w git) → esbuild bundle CJS (`bundle.cjs`, minify, target node18, w git).
`index.ts` owinięty w `async function main(){...} main()` — bez top-level await (wymóg CJS).

### Brak współdzielonego `baby-core`
Świadomie KOPIUJEMY rusztowanie z `google-ads-baby` (start-mcp, check_update, OAuth flow, config).
Reguła trzech: wspólny kod ekstrahujemy dopiero gdy wzorzec potwierdzi się przy TRZECIM projekcie i tylko
mechanizmy bez wiedzy domenowej — nigdy modele danych GA4/Ads/Meta.

#### Source layout (`server/src/`)
```
index.ts            — entrypoint: McpServer, instructions, rejestracja tooli, stdio. Owinięte w main()
config.ts           — GaConfig, getConfigDir() (.google-analytics-baby / GA_BABY_DATA), loadSavedConfig/saveConfig/configFromEnv
constants.ts        — OAUTH_CLIENT_ID/SECRET (placeholdery — patrz niżej), GA_SCOPES
errors.ts           — formatError()
auth.ts             — lokalny serwer OAuth (port 9877), /open landing, /start-oauth, /callback
client.ts           — klienci GA4 (Data+Admin) + funkcje read

tools/
  auth.ts           — registerAuthTools(): setup_google_auth, check_update
  read.ts           — registerReadTools(): wszystkie toole read
```

#### OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET
`constants.ts` celowo nie zawiera wbudowanych OAuth credentials. Użytkownik podaje własne Client
ID/Secret przez env (`GOOGLE_ANALYTICS_CLIENT_ID`, `GOOGLE_ANALYTICS_CLIENT_SECRET`) albo w `/open`
page podczas `setup_google_auth`; zapisują się wtedy lokalnie w `~/.google-analytics-baby/config.json`.

Można reużyć desktop-app credentials z projektu OAuth używanego przez `google-ads-baby` zamiast
zakładać nową aplikację:
1. w tym projekcie Cloud Console włącz Analytics Data API + Analytics Admin API,
2. dodaj scope `analytics.readonly` do OAuth consent screen,
3. podaj Client ID/Secret przez env albo w `/open` page.
Refresh token i tak jest osobny (inny scope, inny katalog config `.google-analytics-baby`), więc
współdzielenie OAuth clienta jest bezpieczne. Osobny projekt Cloud = czystszy rozdział, więcej setupu —
dla własnego użytku różnica kosmetyczna. Uwaga: `analytics.readonly` to scope "sensitive" — w trybie
Testing działa od razu (do 100 userów); publiczna dystrybucja wymaga Google OAuth verification.
W przeciwieństwie do ads NIE ma developer tokena ani MCC approval.

## Jak dodawać nowe toole

**Nowy read tool:**
1. Handler `server.tool('...')` → `tools/read.ts`.
2. Funkcja klienta (Data/Admin API) → `client.ts`, sygnatura `(cfg: GaConfig, property, ...params) => Promise<unknown>`.
3. Walidacja wejścia przez zod w handlerze.
4. `npm run build` po każdej zmianie w `src/`.

**Konwencje (rodzina):**
- NIE pisz komentarzy w kodzie — nazwy funkcji/zmiennych mają być samodokumentujące.
- TODO/plany → `ROADMAP.md` i `CLAUDE.md`, nie do kodu.

## Commands
- `cd server && npm install && npm run build` — zainstaluj zależności, skompiluj TS i zbuduj bundle
- `cd server && npm run dev` — watch mode (rebuild TS przy zmianach)
- `cd server && npm start` — uruchom MCP server z bundle.cjs

## Config
Env vars (set in plugin.json, sourced from user's environment) OR saved in `config.json` via OAuth flow:
- `GOOGLE_ANALYTICS_CLIENT_ID` / `GOOGLE_ANALYTICS_CLIENT_SECRET` — OAuth2 app (optional — defaults to built-in app, can be set via /open page)
- `GOOGLE_ANALYTICS_REFRESH_TOKEN` — user's OAuth2 refresh token (scope analytics.readonly)
- `GA_BABY_DATA` — override config dir (default `~/.google-analytics-baby`)

## Closed-loop — co GA4 daje za darmo
GA4 Data API zna metryki kosztowe z POŁĄCZONEGO konta Google Ads. Dla ruchu z linkowanego konta Ads
w tym samym raporcie dostępne są: `advertiserAdCost`, `advertiserAdClicks`, `advertiserAdCostPerClick`,
`returnOnAdSpend`. Czyli `get_channel_performance` daje gotowy closed-loop ROAS (spend + outcomes)
bez sięgania do Google Ads API.

Dla Meta jest gorzej: GA4 zna tylko outcomes atrybuowane po source/medium (np. `facebook / cpc`),
bo Meta nie linkuje kosztu do GA4. Spend dla Meta trzeba dołożyć z `meta-ads-baby` i skorelować po
source/medium (klucz join = źródło/medium kampanii).

## Repo & CI (do utworzenia)
- GitLab: `treetank/google-analytics-baby` (origin, primary)
- GitHub: `treetank-net/google-analytics-baby` (mirror)
- `.gitlab-ci.yml`: mirror job pushuje `main` + tagi do GitHuba (runner tag `vps`, wymaga `GITHUB_TREETANK_TOKEN`)
- URL raw w `start-mcp.js` i `check_update`: `https://raw.githubusercontent.com/treetank-net/google-analytics-baby/main`

## Roadmapa
Patrz `ROADMAP.md`. Skrót: (1) OAuth + list_analytics_properties + run_report e2e,
(2) get_channel_performance z advertiser cost, (3) realtime + funnel + custom dims,
(4) ewentualnie GA4 Admin mutacje — i WTEDY reużycie two-phase posture z rodziny.
