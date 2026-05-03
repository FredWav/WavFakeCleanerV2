# Privacy Policy — Wav Fake Cleaner

_Last updated: 2026-05-03_

## Who we are

Wav Fake Cleaner is a Chrome extension developed by Fred Wav
(`@fredwavoff` on Threads). Contact:
[contact@fredwav.com](mailto:contact@fredwav.com)
or DM [@fredwavoff](https://www.threads.net/@fredwavoff) on Threads.

## What data we handle

The extension processes the following information **locally on your
device**, inside Chrome's extension storage:

- Your Threads username (entered manually in Settings).
- The list of accounts that follow you on Threads, with their public
  profile data (username, display name, bio, follower count, post
  count, verification status). This data is fetched directly from the
  official Threads API using your active browser session.
- Your detection threshold and language preferences.
- Your Stripe checkout session ID, only if you purchase a license.

**None of this data leaves your device**, with the two narrow
exceptions described below.

## What data leaves your device

1. **Threads API requests** go directly from your browser to Threads
   (Meta), using your existing Threads session cookies. We do not
   intercept, store, or relay these requests on any third-party
   server.

2. **Community voting (optional, license holders only).** When you
   vote on a profile, we send to our Cloudflare Worker
   (`restless-credit-5e6a.fred-olalde.workers.dev`):
   - the SHA-256 hash of the target username (the username itself is
     never transmitted in plaintext),
   - your verdict (fake / not fake) and the local score,
   - your license token, used only to authenticate the vote.

3. **License verification.** When you activate a license, your Stripe
   checkout session ID is sent to our Cloudflare Worker, which calls
   the Stripe API to confirm that the payment was completed. We do
   not see, store, or transmit any payment card information.

4. **Anonymous error reports (optional, opt-in).** If — and only if —
   you enable "Send anonymous error reports" in Settings (off by
   default), the extension may send a minimal error event to the same
   Cloudflare Worker when a fetch operation fails. Each event
   contains: a randomly generated anonymous ID (UUID v4 stored
   locally, never linked to your Threads identity), the extension
   version, your selected language, and the technical error code
   (e.g., `scroll_container_not_found`, `no_links`). The anonymous
   ID is HMAC-hashed before being stored, so a database dump cannot
   be reversed to identify a user. This setting can be turned off at
   any time. **No follower data, no usernames, no log message
   content, and no personal identifiers are ever transmitted.**

## What we do NOT collect

- No passwords or login credentials.
- No browsing history.
- No location data.
- No clicks, keystrokes, or behavioral tracking.
- No analytics, no advertising identifiers, no third-party trackers.

## Data sharing and selling

We do not sell, rent, or share user data with any third party. We do
not transfer data outside of the use cases described above. Data is
not used for credit assessment or lending purposes.

## Data retention

Local data is kept until you uninstall the extension or clear its
storage. Community votes are stored on our Cloudflare D1 database
indefinitely, in their hashed form, so other users can benefit from
the collective signal. You can request deletion of your votes by
contacting us.

## Permissions justification

The extension requests the minimum permissions required for its
single purpose (Threads follower cleanup):
`sidePanel`, `storage`, `alarms`, `offscreen`, `activeTab`,
`scripting`, `notifications`, plus host access to `threads.net`,
`threads.com`, and the Cloudflare Worker domain. Detailed
justifications are listed on the Chrome Web Store listing.

## Changes

We will update this page if our practices change. The "Last updated"
date at the top reflects the current version.

## Contact

For privacy questions or deletion requests:
- Email: [contact@fredwav.com](mailto:contact@fredwav.com)
- Threads: [@fredwavoff](https://www.threads.net/@fredwavoff)
