import { GoogleApiError } from './search-console.js';

function googleApiErrorText(err: GoogleApiError): string {
  switch (err.problem) {
    case 'insufficient_scope':
      return [
        'Error: Search Console access was not granted. The saved Google authorization only covers Google Analytics:',
        'it was created before this plugin added Search Console, or the Search Console checkbox was left unticked on the Google consent screen.',
        'Run setup_google_auth again and allow "View Search Console data for your verified sites". GA4 tools keep working in the meantime.',
        `(Google said: ${err.message})`,
      ].join(' ');
    case 'api_disabled':
      return [
        'Error: the Google Search Console API is not enabled in the Google Cloud project that owns the OAuth client.',
        err.activationUrl ? `Enable it here: ${err.activationUrl} — then retry (activation can take a few minutes).` : 'Enable "Google Search Console API" in that project, then retry.',
        `(Google said: ${err.message})`,
      ].join(' ');
    case 'site_permission':
      return [
        `Error: no access to this Search Console property. ${err.message}`,
        'Check list_search_console_sites for the exact site_url — a Domain property ("sc-domain:example.com") and a URL-prefix property ("https://www.example.com/") are different properties, and siteUnverifiedUser cannot read data.',
      ].join(' ');
    case 'auth_revoked':
      return `Error: the saved Google authorization is no longer valid (${err.message}). Run setup_google_auth again.`;
    case 'quota':
      return `Error: Google API quota exceeded (${err.message}). Search Analytics short-term quota resets after about 15 minutes; URL Inspection allows 2000 inspections per site per day.`;
    default:
      return `Error: Google API ${err.status}: ${err.message}`;
  }
}

export function formatError(err: unknown): string {
  if (err instanceof GoogleApiError) return googleApiErrorText(err);
  if (err instanceof Error) {
    const msg = err.message || String(err);
    const details = (err as any).errors;
    if (Array.isArray(details)) {
      return `Error: ${msg}\n${details.map((d: any) => `  - ${d.message || JSON.stringify(d)}`).join('\n')}`;
    }
    return `Error: ${msg}`;
  }
  return `Error: ${JSON.stringify(err)}`;
}
