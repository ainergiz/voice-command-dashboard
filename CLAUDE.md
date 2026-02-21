# Voice Command Dashboard - Contributor Notes

This file is the fast context for anyone changing this codebase.

## What This App Does

Captures live microphone audio in the browser, transcribes it with Mistral realtime STT, and extracts domain-agnostic meeting intelligence in a Cloudflare Durable Object agent.

The output is not limited to tasks. It can include decisions, risks, questions, dependencies, constraints, etc.

## Architecture

- Worker entrypoint: `src/index.ts`
- Core Durable Object: `src/agents/session-agent.ts`
- SQLite helpers: `src/agents/session-agent-sql.ts`
- Fast + deep extraction engine: `src/services/task-extractor.ts`
- STT provider abstraction: `src/providers/stt.ts`
- LLM provider abstraction: `src/providers/llm.ts`
- Canonical contracts: `src/types/session.ts`
- Frontend state mirror: `src/dashboard/types.ts`

## Processing Model

Two-tier extraction:

1. Fast path (sentence-level)
- Triggered as finalized transcript sentences arrive
- Produces quick incremental updates for UI responsiveness

2. Deep path (full-context consolidation)
- Triggered periodically and on demand
- Uses full transcript context from SQLite (fallback: in-memory cache)
- Authoritative consolidation over items/relations/entities
- Emits explicit deep diffs (`added`, `modified`, `removed`)

## Deep Analysis (Phase 1)

Deep pass now uses tool-calling orchestration in `TaskExtractor.analyzeDeepWithTools(...)`:

- `apply_operations` tool:
  - upsert/delete items
  - merge duplicate items
  - upsert/delete relations
  - upsert/delete entities
  - upsert clarifications
  - update topics
- `finalize` tool:
  - marks draft as ready

If provider tool-calling is unavailable, agent falls back to legacy one-shot deep JSON parse.

Important:
- Deep destructive changes are applied immediately (no user approval gate).
- Undo exists for the last applied deep snapshot.

## State and Persistence

- Real-time state is kept in `SessionState` (`this.setState`).
- Transcript + artifacts are persisted in SQLite through upserts.
- Current persistence is upsert-based; removed artifacts are removed from live state but not hard-deleted from SQLite tables yet.

## WebSocket Contracts

Browser to agent:
- `start_session`
- `stop_session`
- `audio_chunk`
- `answer_clarification`
- `request_analysis`
- `undo_last_deep_run`

Agent to browser:
- `welcome`
- `transcript_interim`
- `transcript_final`
- `insights_update` (`source`, `changes`)
- `clarification_chunk`
- `session_status`
- `processing`
- `error`

Canonical source of truth: `src/types/session.ts`.

## Callable Methods

`SessionAgent` exposes:
- `runDeepNow()`
- `undoLastDeepRun()`

These are for SDK-style RPC clients. The current dashboard mostly uses raw websocket messages.

## Important Current Behavior

- Duplicate final transcript suppression exists in agent (`DUPLICATE_FINAL_WINDOW_MS`) to reduce repeated sentence artifacts.
- Date context is injected into fast/deep prompts to resolve relative dates.
- Item category `fact_claim` was intentionally removed.

## Config Notes

LLM provider default is Gemini in `src/config.ts`.

`wrangler.toml` uses:
- `[ai] binding = "AI"`
- `[ai] remote = true` to suppress local AI binding warning

## Development Commands

```bash
npm run dev
npm run dev:dashboard
npm run typecheck
npm run build
```

## If You Change Contracts

When changing message/state types:

1. Update backend contract: `src/types/session.ts`
2. Update frontend mirror: `src/dashboard/types.ts`
3. Update hook handling: `src/dashboard/hooks/useSessionAgent.ts`
4. Validate with:
   - `npm run typecheck`
   - `npm run build`
