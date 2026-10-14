# YouTube Knowledge Extension

The extension combines a dashboard workspace with a React sidebar injected into
YouTube watch pages. The sidebar remains the place to capture video-linked
notes, inspect video analysis, and ask grounded questions.

## Dashboard

Click the extension toolbar button to open the dashboard at `index.html#/dashboard`.
If the dashboard is already open, the extension focuses that tab and returns it
to the Dashboard route instead of opening a duplicate. The
responsive sidebar links use hash routes so each workspace section can also be
opened directly:

- `#/dashboard` — overview, note statistics, recent notes and videos, and quick
  actions.
- `#/notes` — notes returned by the existing authenticated `GET /api/notes/`
  endpoint.
- `#/videos`, `#/folders`, `#/search`, and `#/knowledge` — browse the video
  library, organize folders, find folders and note titles, and ask questions
  grounded in saved learning.
- `#/profile` — view the authenticated email, create or edit a unique username,
  and manage password settings.

Usernames are trimmed and stored in lowercase; comparisons are
case-insensitive. They must contain 3–30 lowercase letters, numbers, or
underscores.

The dashboard requires a Supabase session, with login, signup, password
recovery, and sign-out handled through the background
service worker. Django API requests are brokered by that worker and carry the
current Supabase access token as a Bearer token; access tokens are not returned
to dashboard or content-script messages. Existing records belonging to the
legacy `devuser` account are preserved and are not automatically reassigned to
Supabase users. The manifest's `tabs` permission is used to locate and focus
the dashboard tab.

Dashboard totals, notes created in the last seven days, video-associated note
counts, and recent-note ordering are derived from one complete, unpaginated
notes response. Recent notes are ordered by `updated_at` (falling back to
`created_at`) and display the available title, text, date, and note timestamp.
The current note response exposes only the related video's database ID, not
its YouTube ID, so timestamp badges are shown without constructing video links.
Dashboard refresh requests the note list again through the background service.

## Development

From this directory:

```powershell
npm install
npm run dev
npm run build
npm run lint
```

Copy `.env.example` to `.env.local` and set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_PUBLISHABLE_KEY` for the background authentication service.
Vite embeds `VITE_` variables in the built extension, so these must contain
only public client configuration. Never place a Supabase secret/service-role
key, Django secret, or database credential in a Vite variable.

The Supabase session is persisted by the background service worker in
`chrome.storage.local`. Access to that storage area is restricted to trusted
extension contexts; the YouTube sidebar reads and saves its position through
the background worker instead of accessing storage directly.
Supabase authentication requires Chrome 102 or newer, which provides
`chrome.storage.local.setAccessLevel`. On older browsers, authentication
returns an actionable unsupported-browser error rather than weakening storage
access restrictions. The extension does not declare a higher
`minimum_chrome_version`, so its other Manifest V3 features retain their
existing browser support range.

### Google sign-in configuration

Google sign-in uses the background service worker, Chrome's
`chrome.identity.launchWebAuthFlow()`, and Supabase's PKCE authorization-code
flow. Configure each redirect in the system that receives it:

1. In Google Cloud Console, create a **Web application** OAuth client. Add the
   Supabase project's callback URL as an authorized redirect URI:
   `https://<project-ref>.supabase.co/auth/v1/callback`. This is Google's
   redirect back to Supabase, not the final extension callback.
2. In Supabase Dashboard, enable the Google provider and enter that Google
   OAuth client ID and client secret. Under Authentication URL Configuration,
   add the extension redirect URL to the allowed redirect URLs.
3. The extension callback is generated for the installed extension by
   `chrome.identity.getRedirectURL()`, normally
   `https://<extension-id>.chromiumapp.org/`. Obtain the exact value for your
   installation from the extension service worker DevTools console by running
   `chrome.identity.getRedirectURL()`, then add that exact URL (including any
   path) to the Supabase allowed redirect URLs. The manifest's `identity`
   permission is required for this flow.

### Password recovery configuration

Forgot Password uses Supabase Auth and returns to the dashboard's recovery
screen. Add the exact URL generated for the installed extension to
**Supabase Dashboard → Authentication → URL Configuration → Redirect URLs**:
run `chrome.runtime.getURL("index.html?flow=recovery")` in the extension
service worker DevTools console and allow that exact result. The recovery
email request passes that URL as `redirectTo`; it is distinct from the OAuth
`chromiumapp.org` callback. In the PKCE flow, Supabase verifies the email link
and redirects to the extension with a short-lived authorization code. The
background worker exchanges that code using the verifier persisted in trusted
extension storage before the password form is enabled. Token-hash and legacy
recovery-token callbacks are also verified by the background worker. The
dashboard removes callback credentials from its address bar before sending
them to the worker. Invalid or expired links cannot update a password.

The extension uses the public Supabase URL and publishable key only. Keep the
Google client secret in Supabase Dashboard; never add it to extension source or
Vite environment variables.

The Vite development page previews the dashboard shell. Loading personal notes
requires the page to be opened in the browser extension so it can communicate
with the extension background service. The build emits the dashboard page,
YouTube content script, and background service worker into `dist/`.
