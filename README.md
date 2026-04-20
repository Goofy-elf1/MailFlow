# MailFlow 📬

> AI + Human hybrid email automation — switch between AI and human control anytime, per conversation.

MailFlow is a full-stack email automation client that lets you manage client conversations with a WhatsApp-style UI. Toggle between AI auto-responses and human takeover on any thread, with full privacy isolation between agents.

---

## Features

### 🤖 AI + Human Hybrid Mode
- Toggle AI on/off per conversation using a built-in toggle button
- When AI is enabled, it automatically sends emails to clients without manual intervention
- Any human agent can take over a conversation instantly — AI hands off cleanly
- AI responses are clearly tagged with an **AI** label in the chat UI

### 🔒 Privacy-First Architecture
- Only the assigned agent can view and respond to their conversation thread
- Chat history is invisible to other agents — complete session isolation
- No cross-agent data leakage across concurrent active sessions

### 📋 Client Listing & Chat UI
- A new client entry is automatically created when a conversation is started
- WhatsApp-style scrollable chat interface with full message history
- AI and human messages are visually differentiated with labels

### 📧 Bulk Email Support
- Send to 100+ recipients simultaneously
- All outbound emails are sent from your authenticated Google account

### 🔗 Gmail API Integration
- Login with your personal or company Google account
- All emails sent and received are routed through your authenticated Gmail account

### 🧠 Flexible LLM Support
- Powered by Groq API out of the box
- Architected to swap to any other LLM provider with minimal code changes
- AI is prompt-engineered to respond in a consistent, professional tone

---

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | HTML, CSS, JavaScript |
| Backend | Node.js |
| Email | Gmail API (Google OAuth) |
| AI | Groq API (swappable) |
| Deployment | Railway |

---

## Getting Started

### Prerequisites
- Node.js 18+
- A Google account with Gmail API enabled
- A Groq API key (or any other LLM provider key)

### 1. Clone the repo

```bash
git clone https://github.com/Goofy-elf1/MailFlow.git
cd MailFlow
```

### 2. Install dependencies

```bash
npm install
```

### 3. Set up environment variables

Create a `.env` file in the root:

```env
GROQ_API_KEY=your_groq_api_key
GOOGLE_CLIENT_ID=your_google_client_id
GOOGLE_CLIENT_SECRET=your_google_client_secret
GOOGLE_REDIRECT_URI=http://localhost:3000/auth/callback
SESSION_SECRET=your_session_secret
```

### 4. Enable Gmail API

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create a new project
3. Enable the **Gmail API**
4. Create OAuth 2.0 credentials
5. Add your redirect URI

### 5. Run the app

```bash
npm start
```

Visit `http://localhost:3000`

---

## Switching LLM Providers

MailFlow uses Groq by default but is built to be provider-agnostic. To switch providers:

1. Replace the Groq client initialization in `backend/` with your preferred provider's SDK
2. Update your `.env` with the new API key
3. Adjust the model name in the AI config

Tested providers: Groq (Llama 3). Compatible with: OpenAI, Anthropic, Mistral, and any OpenAI-compatible API.

---

## Deployment

MailFlow is configured for Railway deployment out of the box via `railway.json` and `Procfile`.

```bash
# Install Railway CLI
npm i -g @railway/cli

# Login and deploy
railway login
railway up
```

---

## How It Works

1. **Login** with your Google account — all emails are sent from this address
2. **Start a conversation** — a client entry is created automatically
3. **Toggle AI mode** — AI handles replies automatically when enabled
4. **Take over anytime** — click the toggle to switch to human mode and respond manually
5. **Bulk send** — use the bulk mail option to reach 100+ clients at once

---

## License

MIT — use freely, contribute back.
