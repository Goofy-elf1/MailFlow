require('dotenv').config();
const { google } = require('googleapis');
const db = require('../db');

// ─── OAuth2 Client ────────────────────────────────────────────────────────────
function getOAuth2Client(tokens = null) {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
  if (tokens) client.setCredentials(tokens);
  return client;
}

function getAuthUrl() {
  const client = getOAuth2Client();
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/userinfo.email',
      'https://www.googleapis.com/auth/userinfo.profile',
    ],
  });
}

async function exchangeCode(code) {
  const client = getOAuth2Client();
  const { tokens } = await client.getToken(code);
  return tokens;
}

// ─── Get Gmail client for a user ─────────────────────────────────────────────
function getGmailClient(user) {
  const tokens = JSON.parse(user.gmail_token);
  const auth = getOAuth2Client(tokens);
  // Auto-refresh tokens and persist them
  auth.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    db.prepare('UPDATE users SET gmail_token = ? WHERE id = ?')
      .run(JSON.stringify(merged), user.id);
  });
  return google.gmail({ version: 'v1', auth });
}

// ─── Build RFC 2822 raw email with deliverability best practices ──────────────
function buildRawEmail({ from, fromName, to, toName, subject, body, messageId, inReplyTo, references }) {
  const boundary = `--_mf_${Date.now()}_boundary`;

  // Plain-text version (critical for spam filters — always include)
  const plainText = body.replace(/<[^>]+>/g, '').trim();

  const headers = [
    `From: "${fromName}" <${from}>`,
    `To: "${toName || to}" <${to}>`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    // Thread chaining headers
    inReplyTo ? `In-Reply-To: ${inReplyTo}` : null,
    references ? `References: ${references}` : null,
    // Deliverability headers
    `List-Unsubscribe: <mailto:unsubscribe@${from.split('@')[1]}?subject=unsubscribe>`,
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
    `X-Mailer: MailFlow/1.0`,
    `Precedence: bulk`,
  ].filter(Boolean).join('\r\n');

  const rawEmail = [
    headers,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    plainText,
    '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: quoted-printable',
    '',
    `<html><body style="font-family:Georgia,serif;font-size:15px;line-height:1.7;color:#1a1a1a;max-width:600px;margin:0 auto;padding:20px">${body.replace(/\n/g, '<br>')}</body></html>`,
    '',
    `--${boundary}--`,
  ].join('\r\n');

  return Buffer.from(rawEmail).toString('base64url');
}

// ─── Send an email via Gmail API ──────────────────────────────────────────────
async function sendEmail(user, { to, toName, subject, body, inReplyTo, references, gmailThreadId }) {
  const gmail = getGmailClient(user);
  const from = JSON.parse(user.gmail_token).email || user.email;
  const messageId = `<mf-${Date.now()}-${Math.random().toString(36).slice(2)}@${from.split('@')[1]}>`;

  const raw = buildRawEmail({
    from,
    fromName: process.env.FROM_NAME || user.name,
    to,
    toName,
    subject,
    body,
    messageId,
    inReplyTo: inReplyTo || null,
    references: references || null,
  });

  const params = { userId: 'me', requestBody: { raw } };
  if (gmailThreadId) params.requestBody.threadId = gmailThreadId;

  const res = await gmail.users.messages.send(params);

  return {
    gmailMsgId: res.data.id,
    gmailThreadId: res.data.threadId,
    messageId, // the RFC 2822 Message-ID we generated
  };
}

// ─── Fetch new inbound messages for a thread ──────────────────────────────────
async function fetchThreadMessages(user, gmailThreadId) {
  const gmail = getGmailClient(user);
  const res = await gmail.users.threads.get({
    userId: 'me',
    id: gmailThreadId,
    format: 'full',
  });

  return res.data.messages.map(msg => {
    const headers = {};
    (msg.payload?.headers || []).forEach(h => { headers[h.name.toLowerCase()] = h.value; });

    const bodyData = msg.payload?.parts?.find(p => p.mimeType === 'text/plain')?.body?.data
      || msg.payload?.body?.data || '';
    const body = Buffer.from(bodyData, 'base64').toString('utf-8');

    return {
      gmailMsgId: msg.id,
      from: headers['from'] || '',
      subject: headers['subject'] || '',
      body,
      messageId: headers['message-id'],
      inReplyTo: headers['in-reply-to'],
      references: headers['references'],
      date: headers['date'],
    };
  });
}

module.exports = { getAuthUrl, exchangeCode, sendEmail, fetchThreadMessages };