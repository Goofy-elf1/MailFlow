require('dotenv').config();
const express = require('express');
const { v4: uuid } = require('uuid');
const { google } = require('googleapis');
const db = require('../db');

const router = express.Router();

// ─── Build OAuth2 client ──────────────────────────────────────────────────────
function getOAuth2Client(tokens = null) {
  const client = new google.auth.OAuth2(
    process.env.GMAIL_CLIENT_ID,
    process.env.GMAIL_CLIENT_SECRET,
    process.env.GMAIL_REDIRECT_URI
  );
  if (tokens) client.setCredentials(tokens);
  return client;
}

// ─── Step 1: Redirect to Google ───────────────────────────────────────────────
router.get('/auth/google', (req, res) => {
  const client = getOAuth2Client();
  const url = client.generateAuthUrl({
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
  res.redirect(url);
});

// ─── Step 2: Handle OAuth callback ───────────────────────────────────────────
router.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.redirect('/?error=oauth_denied');

  try {
    const client = getOAuth2Client();
    const { tokens } = await client.getToken(code);
    client.setCredentials(tokens);

    // Get user profile
    const oauth2 = google.oauth2({ version: 'v2', auth: client });
    const { data: profile } = await oauth2.userinfo.get();

    // Upsert user
    const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(profile.email);
    let userId;

    if (existing) {
      db.prepare('UPDATE users SET name = ?, gmail_token = ? WHERE id = ?')
        .run(profile.name, JSON.stringify({ ...tokens, email: profile.email }), existing.id);
      userId = existing.id;
    } else {
      userId = uuid();
      db.prepare('INSERT INTO users (id, email, name, gmail_token) VALUES (?, ?, ?, ?)')
        .run(userId, profile.email, profile.name, JSON.stringify({ ...tokens, email: profile.email }));
    }

    req.session.userId = userId;
    res.redirect('/');
  } catch (err) {
    console.error('OAuth error:', err.message);
    res.redirect('/?error=oauth_failed');
  }
});

// ─── Current user ─────────────────────────────────────────────────────────────
router.get('/api/me', (req, res) => {
  if (!req.session?.userId) return res.json({ user: null });
  const user = db.prepare('SELECT id, email, name FROM users WHERE id = ?').get(req.session.userId);
  res.json({ user: user || null });
});

router.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

module.exports = router;