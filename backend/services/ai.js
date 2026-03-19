require('dotenv').config();
const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ─── Generate a reply draft from thread history ───────────────────────────────
async function generateDraft({ threadMessages, contactName, contactEmail, agentName, subject }) {
  // Build a clean thread transcript for Claude
  const transcript = threadMessages.map(msg => {
    const side = msg.role === 'inbound' ? `${contactName} (${contactEmail})` : `${agentName} (you)`;
    return `[${side}]\n${msg.body}`;
  }).join('\n\n---\n\n');

  const systemPrompt = `You are ${agentName}, a professional sales/outreach agent.
You are replying to an email thread with ${contactName} (${contactEmail}).
Your tone is warm, concise, helpful, and human — never robotic or salesy.
Write ONLY the reply body — no subject line, no "Subject:", no preamble.
Do not add any sign-off — it will be appended automatically.
Keep replies under 150 words unless the question requires more detail.
Never use bullet points unless explicitly listing items requested by the contact.`;

  const userPrompt = `Here is the full email thread so far:\n\n${transcript}\n\n---\n\nWrite a reply to ${contactName}'s latest message. Be natural and address their specific points.`;

  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 600,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const draft = response.content[0]?.text?.trim() || '';

  // Auto-append sign-off
  return `${draft}\n\nBest,\n${agentName}`;
}

// ─── Classify whether AI should auto-reply or escalate to human ──────────────
async function shouldEscalate({ threadMessages, contactName, latestMessage }) {
  const response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 50,
    system: `You are a classifier. Respond with ONLY a JSON object: {"escalate": true/false, "reason": "one sentence"}.
Escalate to human if: the contact expresses frustration, asks for custom pricing/negotiation, mentions legal/compliance topics, explicitly asks to speak to a human, or the situation seems highly sensitive.`,
    messages: [{
      role: 'user',
      content: `Contact: ${contactName}\nLatest message: ${latestMessage}\n\nShould this be escalated to a human agent?`
    }],
  });

  try {
    return JSON.parse(response.content[0]?.text || '{"escalate":false}');
  } catch {
    return { escalate: false, reason: '' };
  }
}

module.exports = { generateDraft, shouldEscalate };