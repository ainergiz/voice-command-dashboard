// --- Session and Meeting Intelligence Types ---

export type MeetingItemType =
  | "decision"
  | "action_item"
  | "commitment"
  | "question_open"
  | "question_answered"
  | "risk"
  | "blocker"
  | "issue"
  | "constraint"
  | "assumption"
  | "requirement"
  | "change_request"
  | "objection"
  | "approval"
  | "dependency"
  | "milestone"
  | "deadline"
  | "metric"
  | "follow_up"
  | "parking_lot"
  | "announcement";

export type ItemPriority = "critical" | "high" | "medium" | "low" | "none";
export type ItemStatusSignal = "new" | "updated" | "retracted" | "uncertain";
export type ItemSensitivity = "public" | "internal" | "restricted";

export type RelationType =
  | "supports"
  | "contradicts"
  | "supersedes"
  | "clarifies"
  | "duplicates"
  | "depends_on"
  | "blocks"
  | "assigned_to"
  | "approved_by"
  | "objected_by"
  | "relates_to_topic";

export type EntityType =
  | "person"
  | "organization"
  | "team"
  | "initiative"
  | "system"
  | "location"
  | "document"
  | "other";

export interface MeetingItem {
  id: string;
  itemType: MeetingItemType;
  title: string;
  summary: string;
  details: string;
  category: string;
  priority: ItemPriority;
  owner: string | null;
  coOwners: string[];
  dueDate: string | null;
  statusSignal: ItemStatusSignal;
  sensitivity: ItemSensitivity;
  tags: string[];
  speaker: string | null;
  evidence: string;
  confidence: number;
  sourceUtteranceIds: string[];
  metadata: Record<string, unknown>;
}

export interface MeetingRelation {
  id: string;
  relationType: RelationType;
  fromItemId: string;
  toItemId: string;
  rationale: string;
  evidence: string;
  confidence: number;
}

export interface MeetingEntity {
  id: string;
  entityType: EntityType;
  name: string;
  aliases: string[];
  evidence: string;
  confidence: number;
}

export interface InsightChange {
  artifact: "item" | "relation" | "entity";
  changeType: "added" | "modified" | "removed";
  id: string;
  label: string;
  fields: string[];
}

export interface TranscriptEntry {
  id: string;
  text: string;
  timestamp: number;
  isFinal: boolean;
}

export interface ClarificationQuestion {
  id: string;
  question: string;
  context: string;
  answer: string | null;
  relatedItemIds: string[];
}

export type SessionStatus = "idle" | "recording" | "paused" | "completed";

export interface SessionState {
  sessionId: string;
  status: SessionStatus;
  items: MeetingItem[];
  relations: MeetingRelation[];
  entities: MeetingEntity[];
  topics: string[];
  lastDeepChanges: InsightChange[];
  recentTranscript: TranscriptEntry[];
  clarifications: ClarificationQuestion[];
}

export const INITIAL_SESSION_STATE: SessionState = {
  sessionId: "",
  status: "idle",
  items: [],
  relations: [],
  entities: [],
  topics: [],
  lastDeepChanges: [],
  recentTranscript: [],
  clarifications: [],
};

// --- WebSocket Messages: DO → Browser ---

export type DashboardMessage =
  | { type: "welcome"; state: SessionState }
  | { type: "transcript_interim"; text: string; timestamp: number }
  | { type: "transcript_final"; id: string; text: string; timestamp: number }
  | {
      type: "insights_update";
      items: MeetingItem[];
      relations: MeetingRelation[];
      entities: MeetingEntity[];
      topics: string[];
      source: "fast" | "deep";
      changes: InsightChange[];
    }
  | { type: "clarification_chunk"; id: string; text: string; done: boolean }
  | { type: "session_status"; status: SessionStatus }
  | { type: "processing"; stage: string }
  | { type: "error"; message: string };

// --- WebSocket Messages: Browser → DO ---

export type ClientMessage =
  | { type: "audio_chunk"; data: string }
  | { type: "start_session" }
  | { type: "stop_session" }
  | { type: "answer_clarification"; id: string; answer: string }
  | { type: "request_analysis" }
  | { type: "undo_last_deep_run" };
