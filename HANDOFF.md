# Handoff — dokończenie `google-analytics-baby`

Read-only MCP server do Google Analytics 4, członek rodziny pluginów `*-baby`
(obok `google-ads-baby`, `meta-ads-baby`). Szkielet jest gotowy — Twoim zadaniem jest
zaimplementować stuby i doprowadzić do działania end-to-end na realnym koncie GA4.

## Stan na teraz (gotowe)
- Pełna struktura projektu (manifesty, scripts, server/src) — patrz `CLAUDE.md`.
- Konto Google: Data API + Admin API włączone, scope `analytics.readonly` dodany do consent screen.
- OAuth credentials nie są commitowane. Podaj je przez env albo `/open` page podczas `setup_google_auth`.
- `check_update` zaimplementowany (skopiowany ze wzorca). Zweryfikuj tylko `REPO_RAW`.
- `server/src/client.ts` i `server/src/tools/read.ts` mają zaimplementowane read-only toole GA4.
- `server/package.json` używa istniejących wersji SDK: `@google-analytics/data` ^6.1.0,
  `@google-analytics/admin` ^9.2.0 i `google-auth-library` ^10.9.0.
- `cd server && npm install && npm run build` przechodzi; bundle jest wygenerowany w `server/bundle.cjs`.
- OAuth + Admin API + Data API zweryfikowane end-to-end na `properties/261501807`.

## Zostało do zrobienia
- Po weryfikacji zrobić release z bumpem wersji i changelogiem.

## Kierunek produktowy — lepsza analityka reklamowa

`google-analytics-baby` nie powinien być tylko cienkim wrapperem na GA4 Data API. Jego rola w rodzinie
ads powinna być taka:
- zebrać i znormalizować marketingowe dane z GA4,
- policzyć metryki, których marketer faktycznie używa,
- znaleźć problemy trackingowe i jakościowe,
- zwrócić ustrukturyzowany insight gotowy do użycia przez `report-baby`.

`report-baby` jest warstwą prezentacji: składa końcowy HTML/PDF/raport narracyjny. Ten plugin powinien
dostarczać mu gotowe bloki danych i wniosków, np. winners/losers, tracking gaps, campaign summary,
period comparison. Dzięki temu logika marketingowa zostaje przy GA4/ads, a rendering przy `report-baby`.

Najbardziej wartościowe następne toole:
- `get_campaign_performance` — source/medium/campaign/channel + sessions, engaged sessions,
  conversions, conversion rate, revenue/value, Google Ads cost/clicks/CPC/ROAS, CPA.
- `get_google_ads_campaign_performance` — wariant po natywnych wymiarach Google Ads z GA4:
  customer ID, campaign ID/name/type, ad group ID/name, query/keyword tam gdzie dostępne.
- `get_paid_social_performance` — paid social outcomes z GA4 po UTM/manual campaign fields, z flagą
  `requires_external_cost_join` dla Meta/LinkedIn/TikTok.
- `audit_campaign_tracking` — diagnostyka: `(not set)`, paid traffic bez kosztu, source naming drift,
  conversions bez value, cost bez conversions, podejrzanie wysokie conversion/session ratio.
- `compare_campaign_periods` — current vs previous period dla kanału/kampanii/source-medium.
- `get_conversion_breakdown` — jakie eventy budują `conversions`, ich value, udział kanałów/kampanii.
- `generate_marketing_insights` — JSON/markdown-ready insight blocks dla `report-baby`: top winners,
  wasted spend, growth/decline, tracking warnings, recommended next actions.

Priorytet implementacji:
1. `audit_campaign_tracking`
2. `get_google_ads_campaign_performance`
3. `get_paid_social_performance`
4. `compare_campaign_periods`
5. `generate_marketing_insights`

## Wzorzec referencyjny — KORZYSTAJ Z NIEGO
Sąsiednie repo `../google-ads-baby` to działający, dojrzały wzorzec tej samej rodziny.
Naśladuj jego rozwiązania, zwłaszcza:
- `../google-ads-baby/server/src/auth.ts` — kompletny OAuth flow (lokalny serwer HTTP, `/open` landing,
  `/start-oauth`, `/callback`, zapis refresh tokena przez `saveConfig`). Nasz `auth.ts` używa portu **9877**
  (ads ma 9876 — nie zmieniaj, żeby oba serwery mogły działać równolegle).
- `../google-ads-baby/server/src/client/core.ts` — wzorzec tworzenia klienta z OAuth2 refresh tokenem.
- `../google-ads-baby/server/src/tools/read-accounts.ts` — wzorzec handlerów read-tooli.

## Zasady (konwencje rodziny — przestrzegaj)
- **Bez komentarzy w kodzie** — nazwy funkcji/zmiennych samodokumentujące.
- `npm run build` po KAŻDEJ zmianie w `src/` (tsc → dist → esbuild bundle.cjs).
- `index.ts` owinięty w `async function main(){…} main()` — bez top-level await (wymóg CJS bundle).
- Read-only: NIE dodawaj prepare/confirm/hooków/safety. To celowo najlżejszy plugin rodziny.

## Kroki

### 0. Build bazowy
```
cd server && npm install && npm run build
```
Napraw ewentualne błędy kompilacji TS (typy SDK, importy). Wersje SDK w `package.json`:
`@google-analytics/data` ^6.1.0, `@google-analytics/admin` ^9.2.0, `google-auth-library` ^10.9.0.
Starszy `google-auth-library` 9.x nie działał z aktualnym `google-gax` 5.x (`headers.forEach is not a function`).

### 1. Auth client (krytyczny haczyk)
W `client.ts` zbuduj `OAuth2Client` z `google-auth-library`, ustaw refresh token z configu, i przekaż
go do klientów GA4. **SDK GA4 domyślnie używają ADC** — trzeba je zmusić do OAuth2:
```ts
const auth = new OAuth2Client(cfg.clientId, cfg.clientSecret);
auth.setCredentials({ refresh_token: cfg.refreshToken });
new BetaAnalyticsDataClient({ authClient: auth as any });
new AnalyticsAdminServiceClient({ authClient: auth as any });
```
Zweryfikuj na realnym koncie, że to faktycznie uwierzytelnia (nie spada na ADC). To główne ryzyko projektu.

### 2. OAuth flow (`auth.ts` + `tools/auth.ts`)
Dokończ `setup_google_auth` na wzór ads — ale BEZ stron developer-token/MCC/safety/account-picker
(GA ich nie ma). Callback zapisuje refresh token przez `saveConfig` i pokazuje stronę „DONE".
Scope: `GA_SCOPES` z `constants.ts` (`analytics.readonly`).

### 3. Toole read (`client.ts` + `tools/read.ts`)
Property ID w formacie `properties/123456`. Zaimplementuj:
- `list_analytics_properties` → Admin `listAccountSummaries()` (zwraca accounts + propertySummaries);
  opcjonalnie dorzuć `listGoogleAdsLinks({ parent })` per property dla mapowania na konta Ads.
- `get_property_details` → Admin `getProperty({ name: 'properties/{id}' })`.
- `run_report` → Data `runReport({ property, dimensions, metrics, dateRanges, dimensionFilter?, limit? })`.
  Generyczny: mapuj wejście (string[] dimensions/metrics, start_date/end_date) na request GA4.
- `run_realtime_report` → Data `runRealtimeReport(...)`.
- `get_custom_dimensions_and_metrics` → Admin `listCustomDimensions` + `listCustomMetrics`.
- `get_channel_performance` (FLAGOWY) → Data `runReport` z:
  - dimensions: `sessionSourceMedium` (i/lub `sessionCampaignName`, `sessionDefaultChannelGroup`)
  - metrics: `sessions`, `engagedSessions`, `conversions`, `totalRevenue`
  - **advertiser cost (closed-loop dla Google Ads)**: `advertiserAdCost`, `advertiserAdClicks`,
    `advertiserAdCostPerClick`, `returnOnAdSpend` — działają dla połączonego konta Google Ads.
    Dla Meta tych metryk nie będzie (zwrócą 0) — to oczekiwane; spend Meta dokłada się z `meta-ads-baby`.
  - parametr `days` → dateRange `{ startDate: '{days}daysAgo', endDate: 'today' }`.

### 4. Test e2e — zrobione
Uruchom `setup_google_auth`, przejdź flow (tryb Testing → ekran „unverified app" → dalej), potem
`list_analytics_properties` i `get_channel_performance` na realnym property. To weryfikuje pkt 1.

Zweryfikowane 2026-06-30 na `properties/261501807`:
- `list_analytics_properties` zwróciło 4 properties i linki Google Ads.
- `run_report` zwrócił sesje/użytkowników dla ostatnich 7 dni.
- `get_channel_performance` zwrócił source/medium/campaign/channel + metryki kosztowe Ads.

### 5. Release (gdy działa)
Bump wersji w `package.json` (root — źródło prawdy dla check_update), `server/package.json`,
`.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`. Wpis w `CHANGELOG.md` (`## vX.Y.Z`).
Załóż repo: GitLab `treetank/google-analytics-baby` + GitHub mirror `treetank-net/google-analytics-baby`
(manifesty i `REPO_RAW` już na to wskazują).

Szczegóły architektury i decyzje: `CLAUDE.md`. Plan fazowy: `ROADMAP.md`.
