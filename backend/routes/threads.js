require('dotenv').config();
const express = require('express');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { requireAuth, requireThreadAccess, requireThreadOwner } = require('../middleware/auth');
const { google } = require('googleapis');
const Groq = require('groq-sdk');

const router = express.Router();
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// ─── Gmail send helper ────────────────────────────────────────────────────────
function getOAuth2Client(tokens) {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
  client.setCredentials(tokens);
  return client;
}

function buildRawEmail({ from, fromName, to, toName, subject, body, messageId, inReplyTo, references }) {
  const boundary = `mf_${Date.now()}`;
  const plain = body.replace(/<[^>]+>/g, '').trim();
  const html = `<html><body style="font-family:Georgia,serif;font-size:15px;line-height:1.7;color:#1a1a1a;max-width:600px;margin:0 auto;padding:20px">${body.replace(/\n/g, '<br>')}</body></html>`;

  const lines = [
    `From: "${fromName}" <${from}>`,
    `To: "${toName || to}" <${to}>`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    inReplyTo  ? `In-Reply-To: ${inReplyTo}`  : null,
    references ? `References: ${references}`   : null,
    `List-Unsubscribe: <mailto:unsubscribe@${from.split('@')[1]}?subject=unsubscribe>`,
    `List-Unsubscribe-Post: List-Unsubscribe=One-Click`,
    `X-Mailer: MailFlow/1.0`,
  ].filter(Boolean).join('\r\n');

  const raw = [
    lines, '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=UTF-8', '',
    plain, '',
    `--${boundary}`,
    'Content-Type: text/html; charset=UTF-8', '',
    html, '',
    `--${boundary}--`,
  ].join('\r\n');

  return Buffer.from(raw).toString('base64url');
}

async function sendEmail(user, { to, toName, subject, body, inReplyTo, references, gmailThreadId }) {
  const tokens = JSON.parse(user.gmail_token);
  const auth = getOAuth2Client(tokens);
  const gmail = google.gmail({ version: 'v1', auth });
  const from = tokens.email || user.email;
  const messageId = `<mf-${Date.now()}-${Math.random().toString(36).slice(2)}@${from.split('@')[1]}>`;

  const raw = buildRawEmail({
    from, fromName: process.env.FROM_NAME || user.name,
    to, toName, subject, body, messageId,
    inReplyTo: inReplyTo || null,
    references: references || null,
  });

  const params = { userId: 'me', requestBody: { raw } };
  if (gmailThreadId) params.requestBody.threadId = gmailThreadId;

  const res = await gmail.users.messages.send(params);
  return { gmailMsgId: res.data.id, gmailThreadId: res.data.threadId, messageId };
}

// ─── Groq AI helpers ──────────────────────────────────────────────────────────
async function generateDraft({ threadMessages, contactName, contactEmail, agentName }) {
  const transcript = threadMessages.map(m => {
    const side = m.role === 'inbound' ? contactName : `${agentName} (you)`;
    return `[${side}]\n${m.body}`;
  }).join('\n\n---\n\n');

  const response = await groq.chat.completions.create({
    model: 'llama-3.3-70b-versatile',
    max_tokens: 600,
    messages: [
      {
        role: 'system',
        content: `You are ${agentName}, a professional outreach agent replying to ${contactName} (${contactEmail}).
Be warm, concise, and human — never robotic or salesy.
Write ONLY the reply body. No subject line. No "Subject:". Keep under 150 words unless detail is needed.
Do not add a sign-off — it will be appended automatically.`,
      },
      {
        role: 'user',
        content: `Thread so far:\n\n${transcript}\n\nWrite a reply to ${contactName}'s latest message.`,
      },
    ],
  });

  const draft = response.choices[0]?.message?.content?.trim() || '';
  return `${draft}\n\nBest,\n${agentName}`;
}

async function shouldEscalate({ contactName, latestMessage }) {
  try {
    const response = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 80,
      messages: [
        {
          role: 'system',
          content: 'Respond ONLY with valid JSON, no markdown, no backticks: {"escalate": true or false, "reason": "one sentence"}. Escalate if: frustration or complaints, pricing negotiation, legal or compliance questions, or explicit request to speak to a human.',
        },
        {
          role: 'user',
          content: `Contact: ${contactName}\nMessage: ${latestMessage}`,
        },
      ],
    });
    const text = response.choices[0]?.message?.content?.trim() || '{"escalate":false,"reason":""}';
    return JSON.parse(text);
  } catch {
    return { escalate: false, reason: '' };
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// List threads
router.get('/api/threads', requireAuth, (req, res) => {
  const userId = req.user.id;
  const threads = db.prepare(`
    SELECT t.*, c.name as contact_name, c.email as contact_email,
           u.name as owner_name, cu.name as claimed_by_name,
           (SELECT COUNT(*) FROM messages m WHERE m.thread_id = t.id) as message_count,
           (SELECT m.body FROM messages m WHERE m.thread_id = t.id ORDER BY m.sent_at DESC LIMIT 1) as last_message_preview
    FROM threads t
    JOIN contacts c ON c.id = t.contact_id
    JOIN users u ON u.id = t.owner_id
    LEFT JOIN users cu ON cu.id = t.claimed_by
    WHERE t.owner_id = ? OR t.claimed_by = ?
    ORDER BY t.updated_at DESC
  `).all(userId, userId);

  res.json({
    threads: threads.map(t => ({
      ...t,
      last_message_preview: t.last_message_preview?.slice(0, 80),
    })),
  });
});

// Get thread detail
router.get('/api/threads/:threadId', requireAuth, requireThreadAccess, (req, res) => {
  const contact  = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.thread.contact_id);
  const messages = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY sent_at ASC').all(req.thread.id);
  res.json({ thread: req.thread, contact, messages });
});

// ─── DELETE thread (owner only) ───────────────────────────────────────────────
router.delete('/api/threads/:threadId', requireAuth, requireThreadOwner, (req, res) => {
  const threadId = req.params.threadId;
  // Delete messages first, then access grants, then thread
  db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId);
  db.prepare('DELETE FROM thread_access WHERE thread_id = ?').run(threadId);
  db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);
  res.json({ ok: true });
});

// ─── BULK SEND (up to 100 emails at once) ────────────────────────────────────
// Accepts: { contacts: [{email, name, company}], subject, body, delayMs }
// Sends with a delay between each to avoid Gmail rate limits
// Supports {{name}} and {{company}} placeholders in subject/body
router.post('/api/bulk-send', requireAuth, async (req, res) => {
  const { contacts, subject, body, delayMs = 2000 } = req.body;

  if (!contacts?.length)      return res.status(400).json({ error: 'No contacts provided' });
  if (contacts.length > 100)  return res.status(400).json({ error: 'Max 100 contacts per bulk send' });
  if (!subject || !body)      return res.status(400).json({ error: 'Subject and body are required' });

  // Respond immediately — processing happens async
  // Stream progress back via server-sent events would be ideal but for simplicity
  // we process and return a summary
  const results = { sent: [], failed: [] };

  for (let i = 0; i < contacts.length; i++) {
    const contact = contacts[i];

    // Replace placeholders
    const personalizedSubject = subject
      .replace(/\{\{name\}\}/gi, contact.name || contact.email.split('@')[0])
      .replace(/\{\{company\}\}/gi, contact.company || '');

    const personalizedBody = body
      .replace(/\{\{name\}\}/gi, contact.name || contact.email.split('@')[0])
      .replace(/\{\{company\}\}/gi, contact.company || '');

    try {
      // Upsert contact
      let dbContact = db.prepare('SELECT * FROM contacts WHERE email = ?').get(contact.email);
      if (!dbContact) {
        const cid = uuid();
        db.prepare('INSERT INTO contacts (id,email,name,company) VALUES (?,?,?,?)')
          .run(cid, contact.email, contact.name || contact.email.split('@')[0], contact.company || '');
        dbContact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
      }

      // Send email
      const sent = await sendEmail(req.user, {
        to: dbContact.email,
        toName: dbContact.name,
        subject: personalizedSubject,
        body: personalizedBody,
      });

      // Create thread
      const threadId = uuid();
      db.prepare(`INSERT INTO threads (id,gmail_thread_id,contact_id,owner_id,subject,status,ai_mode) VALUES (?,?,?,?,?,'ai',1)`)
        .run(threadId, sent.gmailThreadId, dbContact.id, req.user.id, personalizedSubject);

      db.prepare(`INSERT INTO thread_access (thread_id,user_id,role) VALUES (?,?,'owner')`)
        .run(threadId, req.user.id);

      db.prepare(`INSERT INTO messages (id,thread_id,gmail_msg_id,role,from_name,from_email,body,message_id_header) VALUES (?,?,?,'outbound-ai',?,?,?,?)`)
        .run(uuid(), threadId, sent.gmailMsgId, req.user.name, req.user.email, personalizedBody, sent.messageId);

      results.sent.push({ email: contact.email, threadId });

      // Delay between sends to avoid Gmail rate limits (skip delay on last email)
      if (i < contacts.length - 1) {
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
    } catch (err) {
      console.error(`Bulk send failed for ${contact.email}:`, err.message);
      results.failed.push({ email: contact.email, error: err.message });
    }
  }

  res.json({
    ok: true,
    total: contacts.length,
    sent: results.sent.length,
    failed: results.failed.length,
    failures: results.failed,
  });
});

// Claim thread
router.post('/api/threads/:threadId/claim', requireAuth, requireThreadOwner, (req, res) => {
  db.prepare(`UPDATE threads SET status='human', claimed_by=?, updated_at=strftime('%s','now') WHERE id=?`)
    .run(req.user.id, req.params.threadId);
  res.json({ ok: true, claimedBy: req.user.name });
});

// Release back to AI
router.post('/api/threads/:threadId/release', requireAuth, requireThreadOwner, (req, res) => {
  db.prepare(`UPDATE threads SET status='ai', claimed_by=NULL, ai_mode=1, updated_at=strftime('%s','now') WHERE id=?`)
    .run(req.params.threadId);
  res.json({ ok: true });
});

// Toggle AI mode
router.post('/api/threads/:threadId/toggle-ai', requireAuth, requireThreadOwner, (req, res) => {
  const { aiMode } = req.body;
  db.prepare(`UPDATE threads SET ai_mode=?, status=?, updated_at=strftime('%s','now') WHERE id=?`)
    .run(aiMode ? 1 : 0, aiMode ? 'ai' : 'human', req.params.threadId);
  res.json({ ok: true, aiMode });
});

// Send reply
router.post('/api/threads/:threadId/reply', requireAuth, requireThreadAccess, async (req, res) => {
  const { body, role } = req.body;
  const thread  = req.thread;
  const contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(thread.contact_id);
  const lastMsg = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY sent_at DESC LIMIT 1').get(thread.id);
  const allIds  = db.prepare('SELECT message_id_header FROM messages WHERE thread_id = ? AND message_id_header IS NOT NULL ORDER BY sent_at ASC').all(thread.id);
  const refs    = allIds.map(m => m.message_id_header).join(' ');

  try {
    const sent = await sendEmail(req.user, {
      to: contact.email, toName: contact.name,
      subject: `Re: ${thread.subject}`,
      body, inReplyTo: lastMsg?.message_id_header || null,
      references: refs || null,
      gmailThreadId: thread.gmail_thread_id,
    });

    db.prepare(`
      INSERT INTO messages (id,thread_id,gmail_msg_id,role,from_name,from_email,body,message_id_header,references_header,in_reply_to)
      VALUES (?,?,?,?,?,?,?,?,?,?)
    `).run(
      uuid(), thread.id, sent.gmailMsgId,
      role || (thread.ai_mode ? 'outbound-ai' : 'outbound-human'),
      req.user.name, req.user.email, body,
      sent.messageId, refs, lastMsg?.message_id_header || null
    );

    db.prepare(`UPDATE threads SET updated_at=strftime('%s','now') WHERE id=?`).run(thread.id);
    res.json({ ok: true });
  } catch (err) {
    console.error('Send error:', err.message);
    res.status(500).json({ error: 'Failed to send', detail: err.message });
  }
});

// Generate AI draft
router.post('/api/threads/:threadId/draft', requireAuth, requireThreadAccess, async (req, res) => {
  const contact  = db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.thread.contact_id);
  const messages = db.prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY sent_at ASC').all(req.thread.id);

  try {
    const draft = await generateDraft({
      threadMessages: messages,
      contactName: contact.name,
      contactEmail: contact.email,
      agentName: req.user.name,
    });

    const latestInbound = [...messages].reverse().find(m => m.role === 'inbound');
    const escalation = latestInbound
      ? await shouldEscalate({ contactName: contact.name, latestMessage: latestInbound.body })
      : { escalate: false, reason: '' };

    res.json({ draft, escalation });
  } catch (err) {
    console.error('Draft error:', err.message);
    res.status(500).json({ error: 'Failed to generate draft', detail: err.message });
  }
});

// Create single thread
router.post('/api/threads', requireAuth, async (req, res) => {
  const { contactEmail, contactName, contactCompany, subject, body } = req.body;

  let contact = db.prepare('SELECT * FROM contacts WHERE email = ?').get(contactEmail);
  if (!contact) {
    const cid = uuid();
    db.prepare('INSERT INTO contacts (id,email,name,company) VALUES (?,?,?,?)')
      .run(cid, contactEmail, contactName || contactEmail.split('@')[0], contactCompany || '');
    contact = db.prepare('SELECT * FROM contacts WHERE id = ?').get(cid);
  }

  try {
    const sent = await sendEmail(req.user, {
      to: contact.email, toName: contact.name, subject, body,
    });

    const threadId = uuid();
    db.prepare(`INSERT INTO threads (id,gmail_thread_id,contact_id,owner_id,subject,status,ai_mode) VALUES (?,?,?,?,?,'ai',1)`)
      .run(threadId, sent.gmailThreadId, contact.id, req.user.id, subject);

    db.prepare(`INSERT INTO thread_access (thread_id,user_id,role) VALUES (?,?,'owner')`)
      .run(threadId, req.user.id);

    db.prepare(`INSERT INTO messages (id,thread_id,gmail_msg_id,role,from_name,from_email,body,message_id_header) VALUES (?,?,?,'outbound-ai',?,?,?,?)`)
      .run(uuid(), threadId, sent.gmailMsgId, req.user.name, req.user.email, body, sent.messageId);

    res.json({ ok: true, threadId });
  } catch (err) {
    console.error('Create thread error:', err.message);
    res.status(500).json({ error: 'Failed to create thread', detail: err.message });
  }
});

module.exports = router;