/**
 * Exotel missed-call auto-redial.
 *
 * Flow: your Exotel App Bazaar call flow has a Passthru applet wired into
 * the "No Answer" outcome of the Connect applet that handles your support
 * menu option (e.g. "press 2 for support"). That Passthru applet hits this
 * script's web app URL with the caller's number as a query param whenever
 * someone picks support and nobody in support answers. We queue that
 * number in a sheet and immediately queries Exotel's CCM Users API to see
 * which of EXOTEL_FROM_NUMBERS are actually live/available right now
 * (covers a shift team where not everyone's on duty at once), then tries
 * Connect Call against just those, in turn, bridging the caller to
 * whichever agent answers first. If nobody's free, a time-driven trigger
 * retries every 5 minutes, capped at MAX_ATTEMPTS, only within business
 * hours.
 *
 * This intentionally does NOT use Exotel's ExoPhone-level "Missed Call
 * Settings" - that only fires when the whole number goes unanswered, not
 * when a caller reaches the IVR menu but a specific option (support) fails
 * to connect. See README.md for how to wire the Passthru applet.
 *
 * All secrets/config live in Script Properties (Project Settings > Script
 * Properties) - see README.md for the full list and setup steps.
 */

const SHEET_NAME = 'Callbacks';
const RAW_LOG_SHEET_NAME = 'RawWebhookLogs';
const SHEET_HEADERS = ['phone', 'missed_at', 'attempts', 'status', 'last_attempt_at', 'call_sid'];

function getConfig_() {
  const p = PropertiesService.getScriptProperties();
  const cfg = {
    sid: p.getProperty('EXOTEL_SID'),
    apiKey: p.getProperty('EXOTEL_API_KEY'),
    apiToken: p.getProperty('EXOTEL_API_TOKEN'),
    subdomain: p.getProperty('EXOTEL_SUBDOMAIN') || 'api.exotel.com',
    callerId: p.getProperty('EXOTEL_CALLER_ID'),
    fromNumbers: (p.getProperty('EXOTEL_FROM_NUMBERS') || '')
      .split(',')
      .map((n) => n.trim())
      .filter(Boolean),
    webhookSecret: p.getProperty('WEBHOOK_SHARED_SECRET') || '',
    maxAttempts: Number(p.getProperty('MAX_ATTEMPTS') || 3),
    businessStart: p.getProperty('BUSINESS_HOURS_START') || '09:00',
    businessEnd: p.getProperty('BUSINESS_HOURS_END') || '19:00',
    timezone: p.getProperty('TIMEZONE') || Session.getScriptTimeZone(),
  };
  const required = {
    EXOTEL_SID: cfg.sid,
    EXOTEL_API_KEY: cfg.apiKey,
    EXOTEL_API_TOKEN: cfg.apiToken,
    EXOTEL_CALLER_ID: cfg.callerId,
  };
  const missing = Object.keys(required).filter((k) => !required[k]);
  if (missing.length) {
    throw new Error('Missing required script properties: ' + missing.join(', '));
  }
  if (cfg.fromNumbers.length === 0) {
    throw new Error('EXOTEL_FROM_NUMBERS script property is empty - set a comma-separated list of agent numbers');
  }
  return cfg;
}

function getSheet_(name, headers) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(name);
  if (!sheet) {
    sheet = ss.insertSheet(name);
    if (headers) sheet.appendRow(headers);
  }
  return sheet;
}

/**
 * Entry points the Passthru applet hits (deploy as a Web App). Exotel's
 * Passthru applet URL is configured by you (see README.md), so we don't
 * need to guess field names - it's whatever query params you put in the
 * applet's URL template, e.g. "?phone={CallFrom}&callsid={CallSid}".
 * Wired to handle both GET and POST since the exact HTTP method Passthru
 * uses wasn't confirmed while building this (couldn't reach Exotel's docs
 * site from this environment) - check RawWebhookLogs after your first test
 * call to confirm which one actually arrives.
 */
function doGet(e) {
  return handleIncoming_(e);
}

function doPost(e) {
  return handleIncoming_(e);
}

function handleIncoming_(e) {
  logRawWebhook_(e);

  const cfg = getConfig_();
  if (cfg.webhookSecret) {
    const provided = (e.parameter && e.parameter.secret) || '';
    if (provided !== cfg.webhookSecret) {
      return ContentService.createTextOutput('forbidden').setMimeType(ContentService.MimeType.TEXT);
    }
  }

  const phone = extractCallerNumber_(e);
  if (!phone) {
    return ContentService.createTextOutput('ignored: no caller number found')
      .setMimeType(ContentService.MimeType.TEXT);
  }

  // Safety net: if this Passthru ever fires on a call that actually got
  // answered (e.g. it's wired to a branch shared with other logging, or
  // the wrong outcome entirely), never queue a callback for it - that
  // would mean auto-redialing a customer who was already helped, which is
  // worse than doing nothing. Only proceed when the dial leg genuinely
  // did not complete.
  const dialStatus = ((e.parameter && e.parameter.DialCallStatus) || '').toLowerCase();
  if (dialStatus === 'completed') {
    logIgnored_(phone, dialStatus, 'DialCallStatus was completed - call was already answered');
    return ContentService.createTextOutput('ignored: call was answered, no callback needed')
      .setMimeType(ContentService.MimeType.TEXT);
  }

  enqueueAndAttempt_(phone);
  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

function logIgnored_(phone, dialStatus, reason) {
  const sheet = getSheet_('IgnoredWebhookHits', ['received_at', 'phone', 'dial_status', 'reason']);
  sheet.appendRow([new Date(), phone, dialStatus, reason]);
}

/**
 * Reads the caller's number from the query param you named in the
 * Passthru applet's URL. Configure that URL with "phone={CallFrom}" (see
 * README.md) so this always matches "phone" - the fallback candidates only
 * exist in case you (or a future flow change) used a different name.
 */
function extractCallerNumber_(e) {
  const params = e.parameter || {};
  const candidates = ['phone', 'CallFrom', 'From', 'Caller', 'caller_number', 'from'];
  for (const key of candidates) {
    if (params[key]) return normalizePhone_(params[key]);
  }
  if (e.postData && e.postData.type === 'application/json') {
    try {
      const body = JSON.parse(e.postData.contents);
      for (const key of candidates) {
        if (body[key]) return normalizePhone_(body[key]);
      }
    } catch (err) {
      // not JSON, ignore
    }
  }
  return null;
}

function normalizePhone_(raw) {
  return String(raw).trim();
}

function logRawWebhook_(e) {
  const sheet = getSheet_(RAW_LOG_SHEET_NAME, ['received_at', 'parameters', 'post_body']);
  sheet.appendRow([
    new Date(),
    JSON.stringify(e.parameter || {}),
    e.postData ? e.postData.contents : '',
  ]);
}

function enqueueAndAttempt_(phone) {
  const sheet = getSheet_(SHEET_NAME, SHEET_HEADERS);
  const data = sheet.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    const rowPhone = data[i][0];
    const status = data[i][3];
    if (rowPhone === phone && status === 'pending') {
      return; // already queued and not yet exhausted/connected
    }
  }
  sheet.appendRow([phone, new Date(), 0, 'pending', '', '']);
  attemptCallback_(sheet, sheet.getLastRow());
}

function isWithinBusinessHours_(cfg) {
  const current = Utilities.formatDate(new Date(), cfg.timezone, 'HH:mm');
  return current >= cfg.businessStart && current <= cfg.businessEnd;
}

function attemptCallback_(sheet, rowIndex) {
  const cfg = getConfig_();
  const row = sheet.getRange(rowIndex, 1, 1, SHEET_HEADERS.length).getValues()[0];
  const phone = row[0];
  const attempts = row[2];
  const status = row[3];

  if (status !== 'pending') return;
  if (attempts >= cfg.maxAttempts) {
    sheet.getRange(rowIndex, 4).setValue('exhausted');
    return;
  }
  if (!isWithinBusinessHours_(cfg)) return; // left pending, retried next cycle

  const result = huntAndConnect_(cfg, phone);
  const newAttempts = attempts + 1;
  sheet.getRange(rowIndex, 3).setValue(newAttempts);
  sheet.getRange(rowIndex, 5).setValue(new Date());

  if (result.ok && result.connected) {
    sheet.getRange(rowIndex, 4).setValue('connected');
    sheet.getRange(rowIndex, 6).setValue(result.callSid || '');
  } else {
    sheet.getRange(rowIndex, 4).setValue(newAttempts >= cfg.maxAttempts ? 'exhausted' : 'pending');
    if (result.callSid) sheet.getRange(rowIndex, 6).setValue(result.callSid);
  }
}

/**
 * Exotel's Connect Call API only takes one agent number/SIP id in `From`
 * per call - it doesn't accept a group the way the in-flow Connect applet
 * does (that's a separate mechanism this API doesn't expose). To cover a
 * shift team where "not all agents are available at all times", we first
 * ask the CCM Users API which of EXOTEL_FROM_NUMBERS are actually live
 * ("available") right now, and only ring those, in order, stopping at the
 * first one that answers. If that live check itself fails (network/auth
 * error - not "nobody's available", a genuine business state we should
 * respect), we fall back to trying the full static list rather than doing
 * nothing.
 */
function huntAndConnect_(cfg, phone) {
  const availability = getAvailableAgentNumbers_(cfg);
  const candidates = availability.ok ? availability.numbers : cfg.fromNumbers.map(toE164_);

  if (availability.ok && candidates.length === 0) {
    return { ok: false, error: 'no agents currently available per CCM Users API' };
  }

  let lastResult = { ok: false, error: 'no agent numbers to try' };
  for (const agentNumber of candidates) {
    lastResult = connectCall_(cfg, agentNumber, phone);
    if (lastResult.ok && lastResult.connected) {
      return lastResult;
    }
  }
  return lastResult;
}

/**
 * Queries Exotel's CCM Users API for live device availability, filtered to
 * just the agents in EXOTEL_FROM_NUMBERS (an account can have many users;
 * we only care about our support team). Returns { ok: true, numbers: [...] }
 * with E.164 numbers of currently-available agents on success, or
 * { ok: false, numbers: [] } if the API call itself failed - that's a
 * different case from "API worked, nobody's available" (empty but ok:true),
 * which huntAndConnect_ treats as a real "try again later," not a fallback
 * trigger.
 */
function getAvailableAgentNumbers_(cfg) {
  const knownAgents = {};
  cfg.fromNumbers.forEach((n) => { knownAgents[toE164_(n)] = true; });

  const baseUrl = 'https://ccm-api.in.exotel.com/v2/accounts/' + cfg.sid + '/users?fields=devices&limit=50';
  const options = {
    method: 'get',
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(cfg.apiKey + ':' + cfg.apiToken),
    },
    muteHttpExceptions: true,
  };

  const available = [];
  let offset = 0;
  let pages = 0;

  try {
    while (pages < 5) {
      const response = UrlFetchApp.fetch(baseUrl + '&offset=' + offset, options);
      const rawText = response.getContentText();
      logAgentAvailability_(offset, response.getResponseCode(), rawText);

      if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
        return { ok: false, numbers: [] };
      }

      const body = JSON.parse(rawText);
      const users = body.response || [];
      users.forEach((entry) => {
        const devices = (entry.data && entry.data.devices) || [];
        devices.forEach((device) => {
          const contact = toE164_(device.contact_uri || '');
          const isAvailable = device.available === true || device.status === 'free';
          if (knownAgents[contact] && isAvailable) {
            available.push(contact);
          }
        });
      });

      const metadata = body.metadata || {};
      const total = metadata.total || 0;
      const count = metadata.count || users.length;
      offset += count;
      pages++;
      if (count === 0 || offset >= total) break;
    }
    return { ok: true, numbers: available };
  } catch (err) {
    return { ok: false, numbers: [] };
  }
}

function logAgentAvailability_(offset, responseCode, rawBody) {
  const sheet = getSheet_('AgentAvailabilityLog', ['checked_at', 'offset', 'response_code', 'raw_body']);
  sheet.appendRow([new Date(), offset, responseCode, rawBody]);
}

/**
 * Normalizes a phone number to E.164 (+91...). Exotel's own CCM Users API
 * stores device contact_uri in this format, and our Connect Call payloads
 * were previously sent with a leading-zero domestic format instead - a
 * plausible cause of the "invalid number" error reported when a redialed
 * call was answered. Unconfirmed until tested against CallDetailsLog, but
 * matching Exotel's own documented format is a reasonable fix to try.
 */
function toE164_(rawNumber) {
  const raw = String(rawNumber || '').trim();
  if (raw.startsWith('+')) return raw;
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.startsWith('0')) return '+91' + digits.slice(1);
  if (digits.length === 10) return '+91' + digits;
  return raw; // unrecognized format, pass through unchanged
}

/**
 * Calls Exotel's Connect Call API: rings `agentNumber` first, and bridges
 * to `phone` only once that leg answers. Placing the call returns almost
 * immediately (the ring/bridge happens asynchronously), so it does NOT by
 * itself tell us whether the customer actually answered the callback -
 * only that the request was accepted. We wait out a ring cycle and then
 * check the call's real final status before deciding connected vs retry,
 * otherwise a customer who doesn't pick up the callback (phone off, busy,
 * ignored) would get wrongly marked "connected" and never retried.
 */
function connectCall_(cfg, agentNumber, phone) {
  const url = 'https://' + cfg.subdomain + '/v1/Accounts/' + cfg.sid + '/Calls/connect.json';
  const payload = {
    From: toE164_(agentNumber),
    To: toE164_(phone),
    CallerId: toE164_(cfg.callerId),
  };
  const options = {
    method: 'post',
    payload: payload,
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(cfg.apiKey + ':' + cfg.apiToken),
    },
    muteHttpExceptions: true,
  };

  const response = UrlFetchApp.fetch(url, options);
  const code = response.getResponseCode();
  let body = {};
  try {
    body = JSON.parse(response.getContentText());
  } catch (err) {
    // non-JSON error body, leave body = {}
  }

  if (code < 200 || code >= 300) {
    return { ok: false, error: body };
  }

  const call = body.Call || {};
  if (!call.Sid) {
    return { ok: false, error: body };
  }

  Utilities.sleep(25000); // let one ring cycle play out before checking the real outcome
  const finalStatus = getCallStatus_(cfg, call.Sid);
  return { ok: true, connected: finalStatus === 'completed', callSid: call.Sid, finalStatus: finalStatus };
}

/**
 * Fetches the call's current status from Exotel's Call Details API.
 * "completed" turned out NOT to reliably mean "the customer actually got
 * bridged to the agent" - real tests showed it marked "connected" on
 * callbacks the customer confirms did not actually connect. Rather than
 * guess again at which field/threshold (e.g. Duration) actually
 * distinguishes a real bridge from an agent-leg-only blip, this now logs
 * the FULL raw response to a CallDetailsLog sheet on every check, so the
 * next real test gives us evidence instead of another guess. Treat the
 * `connected` decision this returns as provisional until that log is
 * reviewed against what actually happened on a real call.
 */
function getCallStatus_(cfg, callSid) {
  const url = 'https://' + cfg.subdomain + '/v1/Accounts/' + cfg.sid + '/Calls/' + callSid + '.json';
  const options = {
    method: 'get',
    headers: {
      Authorization: 'Basic ' + Utilities.base64Encode(cfg.apiKey + ':' + cfg.apiToken),
    },
    muteHttpExceptions: true,
  };
  const response = UrlFetchApp.fetch(url, options);
  const rawText = response.getContentText();
  logCallDetails_(callSid, response.getResponseCode(), rawText);

  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    return 'unknown';
  }
  try {
    const body = JSON.parse(rawText);
    return (body.Call || {}).Status || 'unknown';
  } catch (err) {
    return 'unknown';
  }
}

function logCallDetails_(callSid, responseCode, rawBody) {
  const sheet = getSheet_('CallDetailsLog', ['checked_at', 'call_sid', 'response_code', 'raw_body']);
  sheet.appendRow([new Date(), callSid, responseCode, rawBody]);
}

/** Time-driven trigger target: retries every row still pending. */
function retryPendingCallbacks() {
  const sheet = getSheet_(SHEET_NAME, SHEET_HEADERS);
  const lastRow = sheet.getLastRow();
  for (let rowIndex = 2; rowIndex <= lastRow; rowIndex++) {
    if (sheet.getRange(rowIndex, 4).getValue() === 'pending') {
      attemptCallback_(sheet, rowIndex);
    }
  }
}

/** Run once manually from the Apps Script editor to install the 5-minute retry trigger. */
function createTimeTrigger() {
  ScriptApp.newTrigger('retryPendingCallbacks')
    .timeBased()
    .everyMinutes(5)
    .create();
}
