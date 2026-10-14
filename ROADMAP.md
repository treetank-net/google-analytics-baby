# Roadmap

## Faza 1 — OAuth + odczyt podstawowy (e2e)
- [ ] Dopiąć OAuth flow: `setup_google_auth` → refresh token zapisany w `config.json`.
- [ ] Zmusić `BetaAnalyticsDataClient` / `AnalyticsAdminServiceClient` do użycia `OAuth2Client` zamiast ADC (`authClient` w konstruktorze) — realny haczyk, te SDK domyślnie szukają Application Default Credentials.
- [ ] `list_analytics_properties` działające e2e: account summaries z Admin API + linki Google Ads per property.
- [ ] `run_report` działające e2e: generyczny GA4 Data API (dimensions, metrics, date range, filter, limit).

## Faza 2 — closed-loop ROAS
- [ ] `get_channel_performance` z advertiser cost: per source/medium/kampania sesje/konwersje/przychód/engagement + (dla Google Ads) `advertiserAdCost`, `advertiserAdClicks`, `advertiserAdCostPerClick`, `returnOnAdSpend`.
- [ ] `get_property_details` — strefa czasowa, waluta, branża, data streams, linki Ads.

## Faza 3 — realtime + funnel + custom
- [ ] `run_realtime_report` (aktywni użytkownicy, ostatnie 30 min).
- [ ] `get_custom_dimensions_and_metrics` — lista custom dims/metrics, gotowa do użycia w `run_report`.
- [ ] Funnel / path exploration helpery (opinionated tools nad Data API).

## Faza 3.5 — Google Search Console (ten sam plugin, ten sam OAuth)
- [x] Scope `webmasters.readonly` obok `analytics.readonly`; klient REST przez `fetch` (bez `googleapis`).
- [x] `list_search_console_sites` (+ dopasowanie do GA4 po domenie web streamu), `run_search_analytics`, `inspect_url`, `list_sitemaps`.
- [x] Skill `gsc` (pułapki danych + przepisy SEO).
- [x] Komunikat przy starym tokenie bez scope'u GSC — zweryfikowany na prawdziwym API (`insufficient_scope` → „run setup_google_auth again”).
- [x] Google Cloud Console (projekt klienta OAuth): włączyć „Google Search Console API”, dopisać `webmasters.readonly` do consent screen (przy opublikowanej aplikacji może wymagać weryfikacji).
- [x] `setup_google_auth` od zera + 4 toole GSC na realnej property.
- [ ] Release skillem `plugin-release` (bump wersji, `## Unreleased` w CHANGELOG → wersja) — dopiero po e2e.
- Ahrefs / Clarity → osobny plugin `seo-baby`, który korzysta z GSC przez ten plugin.

## Faza 4 — ewentualne mutacje (Admin API)
- [ ] Jeśli pojawi się potrzeba mutacji na poziomie GA4 Admin (np. tworzenie konwersji, audiences), DOPIERO wtedy reużyć two-phase posture z rodziny `*-baby` (prepare/confirm + safe word + hook + audit log). Do tego czasu projekt zostaje read-only.

## Cross-projekt
- [ ] Reguła trzech: jeśli przy trzecim projekcie wzorzec rusztowania (start-mcp, update_plugin, OAuth flow, config) się potwierdzi, rozważyć ekstrakcję `baby-core` — tylko mechanizmy bez wiedzy domenowej, nigdy modele danych.
