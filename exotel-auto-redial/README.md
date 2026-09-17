# Exotel missed-call auto-redial

Automatically calls back a customer whose call to your Exotel support
number went unanswered, as soon as an agent (or your hunt group) is free
to take it. Implemented as a single Google Apps Script bound to a Google
Sheet - no server to run or patch.

How it works: Exotel's missed-call webhook enqueues the caller's number in
a sheet and we immediately try Exotel's Connect Call API, which rings your
agent/hunt number first and only bridges the customer once that leg
answers - that answer/no-answer outcome is the "agent is free" check, no
separate polling needed. If nobody's free, a 5-minute trigger retries, up
to `MAX_ATTEMPTS`, only inside business hours.

## Setup

1. **Create the Apps Script project.**
   - Create a new Google Sheet (this becomes your queue + log storage).
   - Extensions -> Apps Script.
   - Replace the default `Code.gs` with this repo's `exotel-auto-redial/Code.gs`.
   - In the editor, open `appsscript.json` via Project Settings ->
     "Show appsscript.json manifest file in editor", and replace its
     contents with this repo's `exotel-auto-redial/appsscript.json`.

2. **Set Script Properties** (Project Settings -> Script Properties -> Add
   property). Never put these values in code or commit them anywhere:

   | Property | Required | Example | Notes |
   |---|---|---|---|
   | `EXOTEL_SID` | yes | `abc123` | Your Exotel Account SID |
   | `EXOTEL_API_KEY` | yes | | From Exotel dashboard -> Settings -> API Credentials |
   | `EXOTEL_API_TOKEN` | yes | | Same page as above |
   | `EXOTEL_CALLER_ID` | yes | `08040...` | ExoPhone to show as caller ID for the outbound leg |
   | `EXOTEL_FROM_NUMBER` | yes | `09876...` | Number Connect Call rings first - your agent's number, or a hunt-group/ACD virtual number if you have several agents |
   | `EXOTEL_SUBDOMAIN` | no | `api.exotel.com` | Change if your account is on a regional subdomain (e.g. `api.in.exotel.com`) |
   | `WEBHOOK_SHARED_SECRET` | recommended | a random string | The Apps Script web app URL is publicly reachable; this rejects requests that don't include `?secret=...` |
   | `MAX_ATTEMPTS` | no | `3` | Total redial attempts before giving up |
   | `BUSINESS_HOURS_START` / `BUSINESS_HOURS_END` | no | `09:00` / `19:00` | 24h format, script's timezone |
   | `TIMEZONE` | no | `Asia/Kolkata` | Defaults to the script's project timezone |

3. **Deploy as a Web App.**
   - Deploy -> New deployment -> type "Web app".
   - Execute as: Me. Who has access: Anyone.
   - Copy the deployment URL - this is your webhook endpoint. Append
     `?secret=<WEBHOOK_SHARED_SECRET>` if you set one.

4. **Point Exotel at it.** Dashboard -> ExoPhones -> your support number ->
   Missed Call Settings -> Webhook URL -> paste the deployment URL from
   step 3.

5. **Install the retry trigger.** In the Apps Script editor, select the
   `createTimeTrigger` function and click Run once (grants permissions on
   first run). This installs a 5-minute time-driven trigger that calls
   `retryPendingCallbacks`.

6. **Verify the payload field name.** Exotel's exact field name for the
   caller's number on this webhook wasn't confirmed while writing this
   (couldn't reach `developer.exotel.com` from the environment this was
   built in). After the very first real missed call:
   - Open the `RawWebhookLogs` sheet tab and inspect the logged
     `parameters` / `post_body` for that hit.
   - If the `Callbacks` sheet did NOT get a new row, the caller-number
     field wasn't one of the guessed candidates
     (`CallFrom`, `From`, `Caller`, `caller_number`, `from`) - add the
     real key to the `candidates` array in `extractCallerNumber_` in
     `Code.gs`.

## Sheets created automatically

- **Callbacks** - the queue: `phone, missed_at, attempts, status, last_attempt_at, call_sid`.
  `status` is one of `pending`, `connected`, `exhausted`.
- **RawWebhookLogs** - every raw webhook hit, for debugging field names.

## Known limits

- Exotel's Connect Call API is rate-limited to 200 calls/minute
  account-wide; irrelevant at small volume, but a spike of missed calls
  could hit it if you scale this up.
- This calls back someone who called you first, so it isn't unsolicited
  commercial traffic under India's DND/TRAI rules - but that's a
  reasonable inference, not a legal confirmation. Check with whoever
  handles compliance before relying on it at volume.
- Duration/price/final call status can update asynchronously a couple of
  minutes after a call ends; this script only relies on the immediate
  Connect Call response (`Call.Status`) to decide `connected` vs retry,
  which is enough to drive the retry loop but not for billing reconciliation.
