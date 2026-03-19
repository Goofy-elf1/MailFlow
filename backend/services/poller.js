require('dotenv').config();
const { google } = require('googleapis');
const { v4: uuid } = require('uuid');
const db = require('../db');

// ─── Get OAuth2 client for a user ─────────────────────────────────────────────
function getOAuth2Client(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
  client.setCredentials(tokens);
  // Auto-save refreshed tokens
  client.on('tokens', (newTokens) => {
    const merged = { ...tokens, ...newTokens };
    db.prepare('UPDATE users SET gmail_token = ? WHERE email = ?')
      .run(JSON.stringify(merged), tokens.email);
  });
  return client;
}

// ─── Extract plain text body from Gmail message payload ───────────────────────
function extractBody(payload) {
  if (!payload) return '';

  // Direct body
  if (payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  // Multipart — prefer text/plain
  if (payload.parts) {
    const plain = payload.parts.find(p => p.mimeType === 'text/plain');
    if (plain?.body?.data) {
      return Buffer.from(plain.body.data, 'base64').toString('utf-8');
    }
    // Fallback to html
    const html = payload.parts.find(p => p.mimeType === 'text/html');
    if (html?.body?.data) {
      return Buffer.from(html.body.data, 'base64').toString('utf-8')
        .replace(/<[^>]+>/g, '') // strip HTML tags
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .trim();
    }
    // Recurse into nested parts
    for (const part of payload.parts) {
      const body = extractBody(part);
      if (body) return body;
    }
  }

  return '';
}

// ─── Fetch inbound replies for all threads owned by a user ────────────────────
async function fetchInboundReplies(user) {
  const tokens = JSON.parse(user.gmail_token);
  const auth = getOAuth2Client(tokens);
  const gmail = google.gmail({ version: 'v1', auth });

  // Get all threads this user owns
  const threads = db.prepare(
    'SELECT * FROM threads WHERE owner_id = ? AND gmail_thread_id IS NOT NULL'
  ).all(user.id);

  let newCount = 0;

  for (const thread of threads) {
    try {
      // Get all messages in this Gmail thread
      const res = await gmail.users.threads.get({
        userId: 'me',
        id: thread.gmail_thread_id,
        format: 'full',
      });

      const gmailMessages = res.data.messages || [];

      for (const msg of gmailMessages) {
        // Skip if we already have this message
        const existing = db.prepare(
          'SELECT id FROM messages WHERE gmail_msg_id = ?'
        ).get(msg.id);
        if (existing) continue;

        const headers = {};
        (msg.payload?.headers || []).forEach(h => {
          headers[h.name.toLowerCase()] = h.value;
        });

        const fromHeader = headers['from'] || '';
        const fromEmail  = fromHeader.match(/<(.+)>/)?.[1] || fromHeader;
        const fromName   = fromHeader.match(/^"?([^"<]+)"?\s*</)?.[1]?.trim() || fromEmail;

        // Only save messages NOT sent by us (inbound)
        const userEmail = tokens.email || user.email;
        if (fromEmail.toLowerCase() === userEmail.toLowerCase()) continue;

        const body = extractBody(msg.payload);
        if (!body.trim()) continue;

        // Save inbound message
        db.prepare(`
          INSERT INTO messages (id, thread_id, gmail_msg_id, role, from_name, from_email, body, message_id_header, in_reply_to, references_header)
          VALUES (?, ?, ?, 'inbound', ?, ?, ?, ?, ?, ?)
        `).run(
          uuid(),
          thread.id,
          msg.id,
          fromName,
          fromEmail,
          body.trim(),
          headers['message-id'] || null,
          headers['in-reply-to'] || null,
          headers['references'] || null
        );

        // Update thread timestamp and mark as having inbound
        db.prepare(`
          UPDATE threads SET updated_at = strftime('%s','now'), is_primary = 1 WHERE id = ?
        `).run(thread.id);

        newCount++;
        console.log(`📨 New reply in thread "${thread.subject}" from ${fromEmail}`);
      }
    } catch (err) {
      // Thread may have been deleted or access revoked — skip silently
      if (!err.message?.includes('404')) {
        console.error(`Poll error for thread ${thread.id}:`, err.message);
      }
    }
  }

  return newCount;
}

// ─── Poll all users ───────────────────────────────────────────────────────────
async function pollAllUsers() {
  const users = db.prepare(
    'SELECT * FROM users WHERE gmail_token IS NOT NULL'
  ).all();

  let total = 0;
  for (const user of users) {
    try {
      const count = await fetchInboundReplies(user);
      total += count;
    } catch (err) {
      console.error(`Poll failed for user ${user.email}:`, err.message);
    }
  }

  if (total > 0) console.log(`✅ Fetched ${total} new inbound message(s)`);
}

// ─── Start polling loop ───────────────────────────────────────────────────────
function startPoller(intervalMs = 60000) {
  console.log(`🔄 Inbound reply poller started (every ${intervalMs / 1000}s)`);

  // Run immediately on start
  pollAllUsers().catch(console.error);

  // Then on interval
  setInterval(() => {
    pollAllUsers().catch(console.error);
  }, intervalMs);
}

module.exports = { startPoller, pollAllUsers, fetchInboundReplies };
