# Voice Command Dashboard


https://github.com/user-attachments/assets/2775c3e3-d8a1-4037-b458-2c9948fe3581



Real-time meeting intelligence dashboard that listens to conversations and extracts structured artifacts — decisions, action items, risks, dependencies, entities, and more.

**Try the demo:** Click "Play Demo" to hear a sample meeting and watch the system extract insights in real time.

## How It Works

```
Browser Mic / Demo Audio
        │
        ▼ PCM 16kHz via WebSocket
  ┌─────────────┐
  │ SessionAgent │  (Cloudflare Durable Object)
  │              │
  │  STT ────────┼──► Mistral Voxtral Realtime
  │              │
  │  Fast LLM ───┼──► Per-sentence extraction (low latency)
  │  Deep LLM ───┼──► Periodic consolidation (tool-calling loop)
  │              │
  │  SQLite ─────┼──► Full transcript + artifact persistence
  └──────┬───────┘
         │ WebSocket
         ▼
   React Dashboard
```

The system extracts items across 5 categories:

| Category | Item Types |
|---|---|
| **Actions** | action items, commitments, follow-ups |
| **Decisions** | decisions, approvals, objections, change requests |
| **Risks & Blockers** | risks, blockers, issues, constraints |
| **Planning** | dependencies, milestones, deadlines, requirements, metrics |
| **Open Threads** | open questions, answered questions, parking lot items |

Plus **relations** (depends_on, blocks, supersedes...), **entities** (people, teams, systems...), and **topics**.

## Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- A [Cloudflare](https://dash.cloudflare.com/) account (free tier works)
- API keys for at least one LLM provider + Mistral (for STT)

### 1. Clone and install

```bash
git clone https://github.com/YOUR_USERNAME/voice-command-dashboard.git
cd voice-command-dashboard
npm install
```

### 2. Set up API keys

```bash
# Login to Cloudflare
npx wrangler login

# Set required secrets
npx wrangler secret put MISTRAL_API_KEY     # Required for speech-to-text

# Set ONE of these depending on your LLM_PROVIDER:
npx wrangler secret put GEMINI_API_KEY      # If using gemini (default)
npx wrangler secret put ANTHROPIC_API_KEY   # If using anthropic
npx wrangler secret put OPENAI_API_KEY      # If using openai
```

For local development, create a `.dev.vars` file:

```
MISTRAL_API_KEY=your-mistral-key
GEMINI_API_KEY=your-gemini-key
```

### 3. Configure LLM provider (optional)

Edit `wrangler.toml` `[vars]` to change the LLM provider and models:

```toml
[vars]
LLM_PROVIDER = "gemini"                          # gemini | anthropic | openai | workers-ai
LLM_FAST_MODEL = "gemini-3-flash-preview"        # Fast per-sentence extraction
LLM_DEEP_MODEL = "gemini-3-flash-preview"        # Deep periodic consolidation
STT_PROVIDER = "mistral"
STT_MODEL = "voxtral-mini-transcribe-realtime-2602"
```

### 4. Deploy

```bash
npm run deploy
```

This builds the frontend with Vite and deploys everything (Worker + static assets) to Cloudflare. Your dashboard URL will be printed at the end.

### 5. Local development

```bash
npm run dev            # Wrangler dev server on :8787
npm run dev:dashboard  # Vite dev server on :5173 (proxies API to :8787)
```

Open `http://localhost:5173`.

## Tech Stack

- **Runtime:** Cloudflare Workers + Durable Objects
- **Agent SDK:** [`agents`](https://www.npmjs.com/package/agents) (WebSocket state sync, SQLite persistence)
- **STT:** Mistral Voxtral Realtime
- **LLM:** Gemini, Anthropic, OpenAI, or Workers AI (configurable)
- **Frontend:** React 19 + Vite 7 + AudioWorklet
- **Language:** TypeScript (strict)

## Deep Analysis

The deep analysis engine uses a tool-calling loop for structured edits:

- **`apply_operations`** — upsert/delete items, merge duplicates, manage relations and entities
- **`finalize`** — signal completion

This runs periodically over the full transcript and can also be triggered on-demand. Each deep run's changes can be undone.

If a provider doesn't support tool-calling, it falls back to single-shot JSON extraction.

## Demo Audio

A pre-recorded 3-minute meeting demo is included (`src/dashboard/public/demo-meeting.wav`). Click "Play Demo" in the UI to stream it through the full pipeline.

To regenerate the demo audio with different voices:

```bash
ELEVENLABS_API_KEY=your-key bash scripts/generate-demo.sh
```

## Scripts

| Command | Description |
|---|---|
| `npm run dev` | Start Wrangler dev server |
| `npm run dev:dashboard` | Start Vite dev server |
| `npm run build` | Build frontend + typecheck |
| `npm run typecheck` | TypeScript type checking |
| `npm run deploy` | Build + deploy to Cloudflare |

## License

MIT
