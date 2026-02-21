// SQL initialization and query helpers for SessionAgent meeting intelligence data.

import type {
  ClarificationQuestion,
  MeetingEntity,
  MeetingItem,
  MeetingRelation,
} from "../types/session";

type SqlPrimitive = string | number | boolean | null;

export type SqlTagFn = <T = Record<string, SqlPrimitive>>(
  strings: TemplateStringsArray,
  ...values: SqlPrimitive[]
) => T[];

export function initSessionTables(sql: SqlTagFn): void {
  sql`
    CREATE TABLE IF NOT EXISTS transcript (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      text TEXT NOT NULL,
      is_final BOOLEAN DEFAULT FALSE,
      timestamp INTEGER NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  sql`
    CREATE TABLE IF NOT EXISTS meeting_items (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT DEFAULT '',
      details TEXT DEFAULT '',
      category TEXT DEFAULT 'general',
      priority TEXT DEFAULT 'medium',
      owner TEXT,
      co_owners TEXT DEFAULT '[]',
      due_date TEXT,
      status_signal TEXT DEFAULT 'new',
      sensitivity TEXT DEFAULT 'internal',
      tags TEXT DEFAULT '[]',
      speaker TEXT,
      evidence TEXT DEFAULT '',
      confidence REAL DEFAULT 0.7,
      source_utterance_ids TEXT DEFAULT '[]',
      metadata TEXT DEFAULT '{}',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  sql`
    CREATE TABLE IF NOT EXISTS item_relations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      relation_type TEXT NOT NULL,
      from_item_id TEXT NOT NULL,
      to_item_id TEXT NOT NULL,
      rationale TEXT DEFAULT '',
      evidence TEXT DEFAULT '',
      confidence REAL DEFAULT 0.7,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  sql`
    CREATE TABLE IF NOT EXISTS entities (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      name TEXT NOT NULL,
      aliases TEXT DEFAULT '[]',
      evidence TEXT DEFAULT '',
      confidence REAL DEFAULT 0.7,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  sql`
    CREATE TABLE IF NOT EXISTS clarifications (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      question TEXT NOT NULL,
      context TEXT DEFAULT '',
      answer TEXT,
      related_item_ids TEXT DEFAULT '[]',
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `;

  sql`CREATE INDEX IF NOT EXISTS idx_transcript_session ON transcript(session_id)`;
  sql`CREATE INDEX IF NOT EXISTS idx_items_session ON meeting_items(session_id)`;
  sql`CREATE INDEX IF NOT EXISTS idx_relations_session ON item_relations(session_id)`;
  sql`CREATE INDEX IF NOT EXISTS idx_entities_session ON entities(session_id)`;
  sql`CREATE INDEX IF NOT EXISTS idx_clarifications_session ON clarifications(session_id)`;
}

export interface TranscriptRow {
  id: string;
  session_id: string;
  text: string;
  is_final: boolean;
  timestamp: number;
  created_at: string;
}

export function insertTranscript(
  sql: SqlTagFn,
  sessionId: string,
  transcriptId: string,
  text: string,
  isFinal: boolean,
  timestamp: number
): void {
  sql`
    INSERT OR REPLACE INTO transcript (id, session_id, text, is_final, timestamp)
    VALUES (${transcriptId}, ${sessionId}, ${text}, ${isFinal}, ${timestamp})
  `;
}

export function getFullTranscript(sql: SqlTagFn, sessionId: string): TranscriptRow[] {
  return sql<TranscriptRow>`
    SELECT *
    FROM transcript
    WHERE session_id = ${sessionId} AND is_final = TRUE
    ORDER BY timestamp ASC
  `;
}

export function upsertMeetingItem(
  sql: SqlTagFn,
  sessionId: string,
  item: MeetingItem
): void {
  sql`
    INSERT OR REPLACE INTO meeting_items (
      id,
      session_id,
      item_type,
      title,
      summary,
      details,
      category,
      priority,
      owner,
      co_owners,
      due_date,
      status_signal,
      sensitivity,
      tags,
      speaker,
      evidence,
      confidence,
      source_utterance_ids,
      metadata,
      updated_at
    )
    VALUES (
      ${item.id},
      ${sessionId},
      ${item.itemType},
      ${item.title},
      ${item.summary},
      ${item.details},
      ${item.category},
      ${item.priority},
      ${item.owner},
      ${JSON.stringify(item.coOwners)},
      ${item.dueDate},
      ${item.statusSignal},
      ${item.sensitivity},
      ${JSON.stringify(item.tags)},
      ${item.speaker},
      ${item.evidence},
      ${item.confidence},
      ${JSON.stringify(item.sourceUtteranceIds)},
      ${JSON.stringify(item.metadata)},
      CURRENT_TIMESTAMP
    )
  `;
}

export function upsertMeetingRelation(
  sql: SqlTagFn,
  sessionId: string,
  relation: MeetingRelation
): void {
  sql`
    INSERT OR REPLACE INTO item_relations (
      id,
      session_id,
      relation_type,
      from_item_id,
      to_item_id,
      rationale,
      evidence,
      confidence,
      updated_at
    )
    VALUES (
      ${relation.id},
      ${sessionId},
      ${relation.relationType},
      ${relation.fromItemId},
      ${relation.toItemId},
      ${relation.rationale},
      ${relation.evidence},
      ${relation.confidence},
      CURRENT_TIMESTAMP
    )
  `;
}

export function upsertMeetingEntity(
  sql: SqlTagFn,
  sessionId: string,
  entity: MeetingEntity
): void {
  sql`
    INSERT OR REPLACE INTO entities (
      id,
      session_id,
      entity_type,
      name,
      aliases,
      evidence,
      confidence,
      updated_at
    )
    VALUES (
      ${entity.id},
      ${sessionId},
      ${entity.entityType},
      ${entity.name},
      ${JSON.stringify(entity.aliases)},
      ${entity.evidence},
      ${entity.confidence},
      CURRENT_TIMESTAMP
    )
  `;
}

export function upsertClarification(
  sql: SqlTagFn,
  sessionId: string,
  clr: ClarificationQuestion
): void {
  sql`
    INSERT OR REPLACE INTO clarifications (
      id,
      session_id,
      question,
      context,
      answer,
      related_item_ids,
      updated_at
    )
    VALUES (
      ${clr.id},
      ${sessionId},
      ${clr.question},
      ${clr.context},
      ${clr.answer},
      ${JSON.stringify(clr.relatedItemIds)},
      CURRENT_TIMESTAMP
    )
  `;
}
