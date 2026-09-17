/**
 * Exotel missed-call auto-redial.
 *
 * Flow: Exotel POSTs to doPost() when a call to your support ExoPhone goes
 * unanswered. We queue the caller's number in a sheet and immediately try
 * Connect Call (rings your agent/hunt number first, bridges to the caller
 * once that leg answers). If nobody's free, a time-driven trigger retries
 * every 5 minutes, capped at MAX_ATTEMPTS, only within business hours.
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
    fromNumber: p.getProperty('EXOTEL_FROM_NUMBER'),
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
    EXOTEL_FROM_NUMBER: cfg.fromNumber,
  };
  const missing = Object.keys(required).filter((k) => !required[k]);
  if (missing.length) {
    throw new Error('Missing required script properties: ' + missing.join(', '));
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

/** Entry point Exotel's Missed Call webhook posts to (deploy as a Web App). */
function doPost(e) {
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

  enqueueAndAttempt_(phone);
  return ContentService.createTextOutput('ok').setMimeType(ContentService.MimeType.TEXT);
}

/**
 * Exotel's exact field name for the caller number on the missed-call
 * webhook isn't confirmed for your account/flow yet (couldn't reach
 * developer.exotel.com to verify while writing this). After the first real
 * missed call, check the RawWebhookLogs sheet and add the real field name
 * here if none of these candidates matched.
 */
function extractCallerNumber_(e) {
  const params = e.parameter || {};
  const candidates = ['CallFrom', 'From', 'Caller', 'caller_number', 'from'];
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

  const result = connectCall_(cfg, phone);
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
 * Calls Exotel's Connect Call API: rings cfg.fromNumber (your agent or hunt
 * group number) first, and bridges to `phone` only once that leg answers.
 * That answer/no-answer outcome IS the "is support free" check - no
 * separate agent-status polling needed.
 */
function connectCall_(cfg, phone) {
  const url = 'https://' + cfg.subdomain + '/v1/Accounts/' + cfg.sid + '/Calls/connect.json';
  const payload = {
    From: cfg.fromNumber,
    To: phone,
    CallerId: cfg.callerId,
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

  if (code >= 200 && code < 300) {
    const call = body.Call || {};
    return { ok: true, connected: call.Status !== 'failed', callSid: call.Sid };
  }
  return { ok: false, error: body };
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
