# Privacy Policy — Wav Fake Cleaner

_Last updated: 2026-06-24_

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

   At checkout, the email address you used to pay is stored on our
   Cloudflare D1 database **only as a salted HMAC-SHA256 hash** (never
   in plaintext, never logged), so that a license can later be matched
   back to a purchase.

5. **License recovery by email (optional).** If you lose your license
   code, you can enter the email used at purchase to recover it. That
   email is sent over HTTPS in the request body (never in the URL) to
   our Cloudflare Worker, which hashes it (HMAC-SHA256) and compares it
   to the hash stored at checkout. The submitted email is never stored
   in plaintext and never logged. Recovery attempts are rate-limited
   per IP address and per email to deter abuse.

4. **Anonymous technical diagnostics (on by default, opt-out).**
   Since version 3.0, the extension sends minimal technical health
   events to the same Cloudflare Worker so that bugs and breakages
   (e.g., Threads changing its page structure, community votes
   failing to deliver) can be detected and fixed without asking users
   to copy logs. You can turn this off at any time with the
   "Anonymous diagnostics" switch in Settings; existing users were
   shown a one-time notice when updating to v3. Each event contains
   **exactly** these fields:
   - a randomly generated anonymous ID (UUID v4 stored locally, never
     linked to your Threads identity; HMAC-hashed server-side so a
     database dump cannot be reversed to identify a user),
   - the extension version and your selected language,
   - an event category (`fetch`, `clean`, `community`, `drift`,
     `perf`), a technical code (e.g., `scroll_container_not_found`,
     `vote_dropped`), an optional reason code (e.g., `http_403`), an
     optional stage, and an optional small number (e.g., a queue
     length or a duration in seconds).

   **No follower data, no usernames — not even hashed ones — no log
   message content, and no personal identifiers are ever transmitted
   in diagnostics.** Events are rate-limited client-side and
   server-side, and deleted from our database after 90 days.

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
