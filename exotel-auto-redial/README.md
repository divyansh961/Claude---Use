# Exotel missed-call auto-redial

Automatically calls back a customer who reached your IVR, chose the
support option (e.g. "press 2 for support"), and didn't get connected -
as soon as an agent (or your hunt group) is free to take it. Implemented
as a single Google Apps Script bound to a Google Sheet - no server to run
or patch.

**This is not Exotel's ExoPhone-level "Missed Call Settings".** That
setting only fires when the whole number goes completely unanswered -
once the IVR picks up and plays the menu, Exotel considers the call
"connected," even if the caller then picks support and nobody there
answers. Detecting that requires hooking into the specific Connect applet
inside your call flow that handles the support option, at its "No Answer"
outcome - see **Wiring it into your call flow** below.

How it works: a Passthru applet inside your Exotel App Bazaar flow, wired
to the support Connect applet's "No Answer" outcome, hits this script's
web app URL with the caller's number. The script enqueues that number in a
sheet and immediately tries Exotel's Connect Call API, which rings your
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

4. **Wire it into your call flow** (replaces pointing at ExoPhone Missed
   Call Settings - see the note above on why). In the Exotel dashboard:
   - Go to App Bazaar and open the flow attached to your support number.
   - Follow the branch for your support menu option (e.g. "press 2") to
     the **Connect applet** that dials your agent(s)/queue.
   - Open that Connect applet's **"No Answer"** outcome (also check
     "Busy" / "Failed" if the flow builder shows them separately).
   - Insert a **Passthru applet** into that outcome, placed *before*
     whatever currently happens there (e.g. a voicemail/apology message) -
     so the caller experience doesn't change, we just also log the event.
   - Set the Passthru applet's URL to your Apps Script deployment URL,
     with the caller's number and call ID appended as query params using
     Exotel's call-variable placeholders:
     `https://script.google.com/.../exec?phone={CallFrom}&callsid={CallSid}&secret=<WEBHOOK_SHARED_SECRET>`
   - Save and publish the flow.

5. **Install the retry trigger.** In the Apps Script editor, select the
   `createTimeTrigger` function and click Run once (grants permissions on
   first run). This installs a 5-minute time-driven trigger that calls
   `retryPendingCallbacks`.

6. **Test and verify.** Call your support number, choose the support
   option, and let it ring out unanswered. Then:
   - Check `RawWebhookLogs` - a new row confirms the Passthru applet is
     reaching your script at all (this also tells you whether Exotel used
     GET or POST, since `Code.gs` handles both).
   - Check `Callbacks` - a new row confirms the `phone` query param came
     through correctly. If it's missing but `RawWebhookLogs` has an entry,
     open that row's logged parameters, find the real caller-number value,
     and either fix the Passthru URL's param name or add it to the
     `candidates` array in `extractCallerNumber_` in `Code.gs`.
   - Confirm `EXOTEL_FROM_NUMBER` actually rings and, once answered,
     bridges to your test phone.

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
