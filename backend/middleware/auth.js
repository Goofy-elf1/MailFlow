const db = require('../db');

// ─── Require logged-in session ────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (!req.session?.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!user) return res.status(401).json({ error: 'User not found' });
  req.user = user;
  next();
}

// ─── Thread ownership gate ────────────────────────────────────────────────────
// Only the agent who STARTED the thread (owner) OR the agent who claimed it
// can see the full conversation. Everyone else gets a 403.
function requireThreadAccess(req, res, next) {
  const threadId = req.params.threadId || req.body.threadId;
  if (!threadId) return res.status(400).json({ error: 'threadId required' });

  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  const userId = req.user.id;

  if (thread.owner_id === userId) {
    req.thread = thread;
    return next();
  }

  if (thread.claimed_by === userId) {
    req.thread = thread;
    return next();
  }

  return res.status(403).json({
    error: 'Access denied',
    reason: 'Only the thread owner or the assigned agent can view this conversation.'
  });
}

// ─── Claim gate ───────────────────────────────────────────────────────────────
// Only the OWNER can claim/unclaim their own threads.
function requireThreadOwner(req, res, next) {
  const threadId = req.params.threadId || req.body.threadId;
  const thread = db.prepare('SELECT * FROM threads WHERE id = ?').get(threadId);
  if (!thread) return res.status(404).json({ error: 'Thread not found' });

  if (thread.owner_id !== req.user.id) {
    return res.status(403).json({
      error: 'Access denied',
      reason: 'Only the agent who started this thread can claim or modify it.'
    });
  }
  req.thread = thread;
  next();
}

module.exports = { requireAuth, requireThreadAccess, requireThreadOwner };
