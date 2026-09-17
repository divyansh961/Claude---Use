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

**Also verify which outcome your Passthru is actually attached to.** If
you inserted it right after an existing Passthru applet that was already
there (e.g. one feeding a CRM/helpdesk), check that outcome is genuinely
"No Answer" and not "If Answered"/"On completion" - a CRM call-logging
integration is often wired to log *every* completed call, which is the
opposite of what you want here. As a safety net, the script itself now
refuses to queue a callback if the payload's `DialCallStatus` is
`completed` (see `handleIncoming_` in `Code.gs`) - real answered calls get
logged to an `IgnoredWebhookHits` sheet instead of triggering a redial.
But that's a backstop, not a substitute for wiring it to the right branch:
if it's on the wrong outcome, you'll never see genuine missed calls
trigger a callback either.

How it works: a Passthru applet inside your Exotel App Bazaar flow, wired
to the support Connect applet's "No Answer" outcome, hits this script's
web app URL with the caller's number. The script enqueues that number in a
sheet, then queries Exotel's **CCM Users API** (`ccm-api.exotel.com` -
note: not the `.in.` subdomain, which returns 401 on this account)
to see which of `EXOTEL_FROM_NUMBERS` are actually live/available right
now, and tries Exotel's Connect Call API against just those, in turn -
this is how a shift team (not everyone on duty at once) gets handled
without a static list going stale. The agent leg answering is still the
final "are they actually free" check, since a device can show available
between the check and the dial. If nobody's free, a 5-minute trigger
retries, up to `MAX_ATTEMPTS`, only inside business hours.

**Phone number format**: everything is normalized to E.164 (`+91...`)
before being sent to Exotel - `EXOTEL_FROM_NUMBERS`, the caller's number,
and `EXOTEL_CALLER_ID` - via `toE164_` in `Code.gs`. This matches the
format Exotel's own CCM Users API returns for `contact_uri`, and is a
likely fix for an "invalid number" error seen when a redialed call was
answered (previously numbers were sent in leading-zero domestic format
like `09108213860`). Confirm this resolved it by checking
`CallDetailsLog` after a live test.

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
   | `EXOTEL_FROM_NUMBERS` | yes | `09876...,09877...,09878...` | Comma-separated list of your shift agents' numbers. Exotel's Connect Call API only accepts one number per call (it can't take a Group the way the in-flow Connect applet can), so the script rings each one in turn until someone answers - this is how it copes with agents not all being available at once |
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
   - Confirm the first agent in `EXOTEL_FROM_NUMBERS` actually rings and,
     once answered, bridges to your test phone. Then try again with that
     agent's phone unavailable/off to confirm it moves on to the next
     number in the list.

## Sheets created automatically

- **Callbacks** - the queue: `phone, missed_at, attempts, status, last_attempt_at, call_sid`.
  `status` is one of `pending`, `connected`, `exhausted`.
- **RawWebhookLogs** - every raw webhook hit, for debugging field names.
- **IgnoredWebhookHits** - webhook hits skipped because the call was already answered (`DialCallStatus: completed`).
- **CallDetailsLog** - full raw response from every post-callback status check, for diagnosing whether a call actually connected.
- **AgentAvailabilityLog** - full raw response from every CCM Users API availability check, for diagnosing the live shift-rotation query.

## Known limits

- Exotel's Connect Call API is rate-limited to 200 calls/minute
  account-wide; irrelevant at small volume, but a spike of missed calls
  could hit it if you scale this up.
- This calls back someone who called you first, so it isn't unsolicited
  commercial traffic under India's DND/TRAI rules - but that's a
  reasonable inference, not a legal confirmation. Check with whoever
  handles compliance before relying on it at volume.
- Placing a call returns almost immediately (the ring happens
  asynchronously), so the script waits 25 seconds after each Connect Call
  and then checks the call's real status before deciding `connected` vs
  retry - otherwise a customer who doesn't pick up the callback (phone
  off, busy, ignored) would get wrongly marked done. The exact status
  value Exotel uses for "actually connected" (`completed` in the code)
  wasn't independently confirmed against your account - if callbacks that
  clearly connected keep getting retried anyway, check `Calls.json` for
  that CallSid's real `Status` and adjust the comparison in
  `getCallStatus_`/`connectCall_` in `Code.gs`.
- Agents in `EXOTEL_FROM_NUMBERS` are rung one at a time, not
  simultaneously, and each one now takes ~25+ seconds (ring time + the
  status check above) before moving to the next - so a full pass through
  an 8-agent list can take a few minutes in the worst case where nobody
  answers. Order the list with your most-likely-available agent first, and
  keep the list short enough that a full pass stays well under Apps
  Script's 6-minute execution limit.
