import { Agent, callable } from "agents";
import type { Connection, ConnectionContext } from "agents";
import type { Env } from "../config";
import { buildConfig } from "../config";
import type {
  ClientMessage,
  DashboardMessage,
  InsightChange,
  MeetingEntity,
  MeetingItem,
  MeetingRelation,
  SessionState,
  TranscriptEntry,
} from "../types/session";
import { INITIAL_SESSION_STATE } from "../types/session";
import { createLLMProvider } from "../providers/llm";
import type { WorkersAIBinding } from "../providers/llm";
import { createSTTProvider } from "../providers/stt";
import type { STTProvider } from "../providers/stt";
import { TaskExtractor } from "../services/task-extractor";
import { SentenceDetector } from "../services/sentence-detector";
import {
  getFullTranscript,
  initSessionTables,
  insertTranscript,
  upsertClarification,
  upsertMeetingEntity,
  upsertMeetingItem,
  upsertMeetingRelation,
} from "./session-agent-sql";

const MAX_RECENT_TRANSCRIPT = 80;
const DUPLICATE_FINAL_WINDOW_MS = 2_500;

type DeepApplyPayload = {
  items: MeetingItem[];
  relations: MeetingRelation[];
  entities: MeetingEntity[];
  topics: string[];
  clarifications: SessionState["clarifications"];
  changes: InsightChange[];
};

type DeepSnapshot = Omit<DeepApplyPayload, "changes">;

export class SessionAgent extends Agent<Env, SessionState> {
  static options = { hibernate: false };

  initialState: SessionState = INITIAL_SESSION_STATE;

  private stt: STTProvider | null = null;
  private extractor: TaskExtractor | null = null;
  private sentenceDetector: SentenceDetector | null = null;
  private tablesInitialized = false;
  private processingQueue: Promise<void> = Promise.resolve();
  private sentencesSinceLastDeep = 0;
  private deepAnalysisTimer: ReturnType<typeof setInterval> | null = null;
  private interimText = "";
  private recentTranscriptCache: TranscriptEntry[] = [];
  private transcriptCounter = 0;
  private lastFinalTranscript: { text: string; timestamp: number } | null = null;
  private lastAppliedDeepSnapshot: DeepSnapshot | null = null;

  private ensureTables(): void {
    if (this.tablesInitialized) return;
    initSessionTables(this.sql.bind(this) as Parameters<typeof initSessionTables>[0]);
    this.tablesInitialized = true;
  }

  private getExtractor(): TaskExtractor {
    if (this.extractor) return this.extractor;
    const config = buildConfig(this.env);

    const fast = createLLMProvider(
      config.llm,
      config.llm.fastModel,
      this.env.AI as unknown as WorkersAIBinding | undefined
    );
    const deep = createLLMProvider(
      config.llm,
      config.llm.deepModel,
      this.env.AI as unknown as WorkersAIBinding | undefined
    );

    this.extractor = new TaskExtractor(fast, deep);
    return this.extractor;
  }

  onConnect(connection: Connection, _ctx: ConnectionContext): void {
    this.ensureTables();
    this.sendTo(connection, {
      type: "welcome",
      state: {
        ...this.state,
        recentTranscript: this.recentTranscriptCache,
      },
    });
  }

  onMessage(connection: Connection, message: string | ArrayBuffer): void {
    if (typeof message !== "string") return;

    try {
      const parsed = JSON.parse(message) as ClientMessage;
      this.handleClientMessage(connection, parsed);
    } catch (err) {
      console.error("Failed to parse client message:", err);
      this.sendTo(connection, {
        type: "error",
        message: "Invalid message format",
      });
    }
  }

  onClose(_connection: Connection): void {
    const remaining = [...this.getConnections()];
    if (remaining.length === 0 && this.state.status === "recording") {
      this.stopRecording();
    }
  }

  private handleClientMessage(_connection: Connection, msg: ClientMessage): void {
    switch (msg.type) {
      case "start_session":
        this.startRecording();
        break;
      case "stop_session":
        this.stopRecording();
        break;
      case "audio_chunk":
        if (this.stt && this.state.status === "recording") {
          const binary = atob(msg.data);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
          }
          this.stt.send(bytes.buffer);
        }
        break;
      case "answer_clarification":
        this.handleAnswerClarification(msg.id, msg.answer);
        break;
      case "request_analysis":
        this.processingQueue = this.processingQueue.then(() => this.runDeepAnalysis());
        break;
      case "undo_last_deep_run":
        this.undoLastDeepRun();
        break;
    }
  }

  private startRecording(): void {
    if (this.state.status === "recording") return;

    this.ensureTables();
    const sessionId = this.state.sessionId || `session-${Date.now()}`;

    this.setState({
      ...this.state,
      sessionId,
      status: "recording",
    });

    this.sentenceDetector = new SentenceDetector();
    this.sentencesSinceLastDeep = 0;
    this.interimText = "";
    this.lastFinalTranscript = null;

    this.initSTT();

    this.broadcastMessage({ type: "session_status", status: "recording" });

    this.deepAnalysisTimer = setInterval(() => {
      if (
        this.sentenceDetector &&
        this.sentenceDetector.timeSinceLastFlush > 15_000 &&
        this.sentencesSinceLastDeep > 0
      ) {
        const flushed = this.sentenceDetector.flush();
        if (flushed) {
          this.processingQueue = this.processingQueue.then(() =>
            this.processSentence(flushed, [])
          );
        }
        this.processingQueue = this.processingQueue.then(() =>
          this.runDeepAnalysis()
        );
      }
    }, 5_000);
  }

  private stopRecording(): void {
    if (this.state.status !== "recording") return;

    this.cleanupSTT();

    if (this.deepAnalysisTimer) {
      clearInterval(this.deepAnalysisTimer);
      this.deepAnalysisTimer = null;
    }

    if (this.sentenceDetector) {
      const flushed = this.sentenceDetector.flush();
      if (flushed) {
        this.processingQueue = this.processingQueue.then(() =>
          this.processSentence(flushed, [])
        );
      }
      this.processingQueue = this.processingQueue.then(() =>
        this.runDeepAnalysis()
      );
    }

    this.setState({
      ...this.state,
      status: "completed",
    });
    this.broadcastMessage({ type: "session_status", status: "completed" });
  }

  private initSTT(): void {
    const config = buildConfig(this.env);

    this.stt = createSTTProvider(
      config.stt,
      (text, isFinal) => {
        this.onTranscript(text, isFinal);
      },
      (error) => {
        console.error("STT error:", error);
        this.broadcastMessage({
          type: "error",
          message: `STT error: ${error.message}`,
        });
      }
    );

    this.stt.connect().catch((err) => {
      console.error("Failed to connect STT:", err);
      this.broadcastMessage({
        type: "error",
        message: "Failed to connect to speech recognition",
      });
    });
  }

  private cleanupSTT(): void {
    if (!this.stt) return;
    this.stt.close();
    this.stt = null;
  }

  private onTranscript(text: string, isFinal: boolean): void {
    const timestamp = Date.now();
    const normalizedText = text.trim();

    if (!isFinal) {
      if (!normalizedText) return;
      this.interimText = normalizedText;
      this.broadcastMessage({ type: "transcript_interim", text: normalizedText, timestamp });
      return;
    }

    if (!normalizedText) return;

    if (
      this.lastFinalTranscript &&
      this.lastFinalTranscript.text === normalizedText &&
      timestamp - this.lastFinalTranscript.timestamp <= DUPLICATE_FINAL_WINDOW_MS
    ) {
      return;
    }
    this.lastFinalTranscript = { text: normalizedText, timestamp };

    this.interimText = "";
    const transcriptId = `utt-${timestamp}-${++this.transcriptCounter}`;
    const entry: TranscriptEntry = {
      id: transcriptId,
      text: normalizedText,
      timestamp,
      isFinal: true,
    };

    this.recentTranscriptCache.push(entry);
    if (this.recentTranscriptCache.length > MAX_RECENT_TRANSCRIPT) {
      this.recentTranscriptCache.splice(
        0,
        this.recentTranscriptCache.length - MAX_RECENT_TRANSCRIPT
      );
    }

    insertTranscript(
      this.sql.bind(this) as Parameters<typeof insertTranscript>[0],
      this.state.sessionId,
      transcriptId,
      normalizedText,
      true,
      timestamp
    );

    this.broadcastMessage({
      type: "transcript_final",
      id: transcriptId,
      text: normalizedText,
      timestamp,
    });

    if (!this.sentenceDetector) return;

    const sentences = this.sentenceDetector.feed(normalizedText);
    for (const sentence of sentences) {
      this.processingQueue = this.processingQueue.then(() =>
        this.processSentence(sentence, [transcriptId])
      );
    }

    if (this.sentenceDetector.shouldTriggerDeep(this.sentencesSinceLastDeep)) {
      this.processingQueue = this.processingQueue.then(() =>
        this.runDeepAnalysis()
      );
    }
  }

  private async processSentence(sentence: string, sourceUtteranceIds: string[]): Promise<void> {
    this.broadcastMessage({ type: "processing", stage: "extracting" });

    try {
      const extractor = this.getExtractor();
      const recentContext = this.recentTranscriptCache
        .slice(-8)
        .map((entry) => entry.text)
        .join(" ");

      const result = await extractor.extractInsights(
        sentence,
        this.state.items,
        this.state.relations,
        this.state.entities,
        recentContext,
        sourceUtteranceIds
      );

      this.sentencesSinceLastDeep++;

      const mergedItems = mergeItems(this.state.items, result.newItems, result.modifiedItems);
      const mergedRelations = mergeRelations(this.state.relations, result.newRelations);
      const mergedEntities = mergeEntities(this.state.entities, result.newEntities);
      const topics = deriveTopics(mergedItems, [...this.state.topics, ...result.topics]);

      this.setState({
        ...this.state,
        items: mergedItems,
        relations: mergedRelations,
        entities: mergedEntities,
        topics,
        lastDeepChanges: [],
      });

      this.persistArtifacts(mergedItems, mergedRelations, mergedEntities, this.state.clarifications);
      this.broadcastInsightsUpdate(
        mergedItems,
        mergedRelations,
        mergedEntities,
        topics,
        "fast",
        []
      );
    } catch (err) {
      console.error("Fast extraction error:", err);
    }
  }

  private async runDeepAnalysis(): Promise<void> {
    if (this.state.items.length === 0 && this.recentTranscriptCache.length === 0) {
      return;
    }

    this.broadcastMessage({ type: "processing", stage: "analyzing" });
    this.sentencesSinceLastDeep = 0;

    try {
      const extractor = this.getExtractor();
      const rows = getFullTranscript(
        this.sql.bind(this) as Parameters<typeof getFullTranscript>[0],
        this.state.sessionId
      );
      const fullTranscript = rows.length > 0
        ? rows.map((row) => row.text).join(" ")
        : this.recentTranscriptCache.map((entry) => entry.text).join(" ");

      const previousClarificationIds = new Set(
        this.state.clarifications.map((clarification) => clarification.id)
      );

      let result;
      try {
        result = await extractor.analyzeDeepWithTools(
          fullTranscript,
          this.state.items,
          this.state.relations,
          this.state.entities,
          this.state.clarifications
        );
      } catch (toolErr) {
        console.error("Deep tool-loop failed, falling back to one-shot parse:", toolErr);
        let accumulated = "";
        for await (const chunk of extractor.analyzeDeep(
          fullTranscript,
          this.state.items,
          this.state.relations,
          this.state.entities,
          this.state.clarifications
        )) {
          accumulated += chunk;
        }
        result = extractor.parseDeepResult(
          accumulated,
          this.state.items,
          this.state.relations,
          this.state.entities
        );
      }

      const items = result.items;
      const relations = result.relations;
      const entities = result.entities;
      const topics = deriveTopics(items, result.topics);
      const deepChanges = computeDeepChanges(
        this.state.items,
        items,
        this.state.relations,
        relations,
        this.state.entities,
        entities
      );
      const clarifications = mergeClarifications(
        this.state.clarifications,
        result.clarifications
      );

      const payload: DeepApplyPayload = {
        items,
        relations,
        entities,
        topics,
        clarifications,
        changes: deepChanges,
      };

      this.applyDeepPayload(payload);

      for (const clarification of result.clarifications) {
        if (previousClarificationIds.has(clarification.id)) continue;
        const words = clarification.question.split(" ");
        let streamed = "";
        for (let i = 0; i < words.length; i++) {
          streamed += (i > 0 ? " " : "") + words[i];
          this.broadcastMessage({
            type: "clarification_chunk",
            id: clarification.id,
            text: streamed,
            done: i === words.length - 1,
          });
        }
      }
    } catch (err) {
      console.error("Deep analysis error:", err);
    }
  }

  @callable({ description: "Run deep analysis immediately." })
  async runDeepNow(): Promise<{ ok: true }> {
    this.processingQueue = this.processingQueue.then(() => this.runDeepAnalysis());
    await this.processingQueue;
    return { ok: true };
  }

  @callable({ description: "Undo the last applied deep-analysis update." })
  undoLastDeepRun(): { applied: boolean; message: string } {
    if (!this.lastAppliedDeepSnapshot) {
      return { applied: false, message: "No deep snapshot available to undo." };
    }

    const snapshot = this.lastAppliedDeepSnapshot;
    const undoChanges = computeDeepChanges(
      this.state.items,
      snapshot.items,
      this.state.relations,
      snapshot.relations,
      this.state.entities,
      snapshot.entities
    );

    this.setState({
      ...this.state,
      items: snapshot.items,
      relations: snapshot.relations,
      entities: snapshot.entities,
      topics: snapshot.topics,
      clarifications: snapshot.clarifications,
      lastDeepChanges: undoChanges,
    });

    this.persistArtifacts(
      snapshot.items,
      snapshot.relations,
      snapshot.entities,
      snapshot.clarifications
    );
    this.broadcastInsightsUpdate(
      snapshot.items,
      snapshot.relations,
      snapshot.entities,
      snapshot.topics,
      "deep",
      undoChanges
    );

    this.lastAppliedDeepSnapshot = null;
    return { applied: true, message: "Reverted to previous deep snapshot." };
  }

  private applyDeepPayload(payload: DeepApplyPayload): void {
    this.lastAppliedDeepSnapshot = cloneSnapshot(this.state);

    this.setState({
      ...this.state,
      items: payload.items,
      relations: payload.relations,
      entities: payload.entities,
      topics: payload.topics,
      clarifications: payload.clarifications,
      lastDeepChanges: payload.changes,
    });

    this.persistArtifacts(
      payload.items,
      payload.relations,
      payload.entities,
      payload.clarifications
    );
    this.broadcastInsightsUpdate(
      payload.items,
      payload.relations,
      payload.entities,
      payload.topics,
      "deep",
      payload.changes
    );
  }

  private persistArtifacts(
    items: MeetingItem[],
    relations: MeetingRelation[],
    entities: MeetingEntity[],
    clarifications: SessionState["clarifications"]
  ): void {
    const sql = this.sql.bind(this) as Parameters<typeof upsertMeetingItem>[0];
    for (const item of items) {
      upsertMeetingItem(sql, this.state.sessionId, item);
    }
    for (const relation of relations) {
      upsertMeetingRelation(sql, this.state.sessionId, relation);
    }
    for (const entity of entities) {
      upsertMeetingEntity(sql, this.state.sessionId, entity);
    }
    for (const clarification of clarifications) {
      upsertClarification(sql, this.state.sessionId, clarification);
    }
  }

  private handleAnswerClarification(id: string, answer: string): void {
    const existing = this.state.clarifications.find((clr) => clr.id === id);
    if (!existing) return;

    const updated = { ...existing, answer };
    const clarifications = this.state.clarifications.map((clr) =>
      clr.id === id ? updated : clr
    );

    this.setState({
      ...this.state,
      clarifications,
    });

    upsertClarification(
      this.sql.bind(this) as Parameters<typeof upsertClarification>[0],
      this.state.sessionId,
      updated
    );

    this.processingQueue = this.processingQueue.then(() => this.runDeepAnalysis());
  }

  private broadcastInsightsUpdate(
    items: MeetingItem[],
    relations: MeetingRelation[],
    entities: MeetingEntity[],
    topics: string[],
    source: "fast" | "deep",
    changes: InsightChange[]
  ): void {
    this.broadcastMessage({
      type: "insights_update",
      items,
      relations,
      entities,
      topics,
      source,
      changes,
    });
  }

  private sendTo(connection: Connection, message: DashboardMessage): void {
    connection.send(JSON.stringify(message));
  }

  private broadcastMessage(message: DashboardMessage): void {
    const data = JSON.stringify(message);
    for (const conn of this.getConnections()) {
      conn.send(data);
    }
  }
}

function cloneSnapshot(state: SessionState): DeepSnapshot {
  return {
    items: state.items.map((item) => ({
      ...item,
      coOwners: [...item.coOwners],
      tags: [...item.tags],
      sourceUtteranceIds: [...item.sourceUtteranceIds],
      metadata: { ...item.metadata },
    })),
    relations: state.relations.map((relation) => ({ ...relation })),
    entities: state.entities.map((entity) => ({
      ...entity,
      aliases: [...entity.aliases],
    })),
    topics: [...state.topics],
    clarifications: state.clarifications.map((clarification) => ({
      ...clarification,
      relatedItemIds: [...clarification.relatedItemIds],
    })),
  };
}

function mergeItems(
  existing: MeetingItem[],
  newItems: MeetingItem[],
  modifiedItems: MeetingItem[]
): MeetingItem[] {
  const byId = new Map(existing.map((item) => [item.id, item]));

  for (const item of modifiedItems) {
    byId.set(item.id, item);
  }

  for (const item of newItems) {
    const duplicate = [...byId.values()].find((current) => itemFingerprint(current) === itemFingerprint(item));
    if (!duplicate) {
      byId.set(item.id, item);
      continue;
    }
    byId.set(duplicate.id, {
      ...duplicate,
      summary: duplicate.summary || item.summary,
      details: duplicate.details || item.details,
      owner: duplicate.owner || item.owner,
      dueDate: duplicate.dueDate || item.dueDate,
      confidence: Math.max(duplicate.confidence, item.confidence),
      evidence: duplicate.evidence || item.evidence,
      sourceUtteranceIds: uniqueStrings([
        ...duplicate.sourceUtteranceIds,
        ...item.sourceUtteranceIds,
      ]),
      tags: uniqueStrings([...duplicate.tags, ...item.tags]),
      coOwners: uniqueStrings([...duplicate.coOwners, ...item.coOwners]),
      metadata: { ...duplicate.metadata, ...item.metadata },
    });
  }

  return [...byId.values()].sort((a, b) => {
    const priorityDiff = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityDiff !== 0) return priorityDiff;
    return b.confidence - a.confidence;
  });
}

function mergeRelations(existing: MeetingRelation[], incoming: MeetingRelation[]): MeetingRelation[] {
  const byKey = new Map<string, MeetingRelation>();
  for (const relation of existing) {
    byKey.set(relationFingerprint(relation), relation);
  }
  for (const relation of incoming) {
    const key = relationFingerprint(relation);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, relation);
      continue;
    }
    byKey.set(key, {
      ...current,
      confidence: Math.max(current.confidence, relation.confidence),
      rationale: current.rationale || relation.rationale,
      evidence: current.evidence || relation.evidence,
    });
  }
  return [...byKey.values()];
}

function mergeEntities(existing: MeetingEntity[], incoming: MeetingEntity[]): MeetingEntity[] {
  const byKey = new Map<string, MeetingEntity>();
  for (const entity of existing) {
    byKey.set(entityFingerprint(entity), entity);
  }
  for (const entity of incoming) {
    const key = entityFingerprint(entity);
    const current = byKey.get(key);
    if (!current) {
      byKey.set(key, entity);
      continue;
    }
    byKey.set(key, {
      ...current,
      aliases: uniqueStrings([...current.aliases, ...entity.aliases]),
      evidence: current.evidence || entity.evidence,
      confidence: Math.max(current.confidence, entity.confidence),
    });
  }
  return [...byKey.values()];
}

function mergeClarifications(
  existing: SessionState["clarifications"],
  incoming: SessionState["clarifications"]
): SessionState["clarifications"] {
  const byId = new Map(existing.map((clr) => [clr.id, clr]));
  for (const clr of incoming) {
    const current = byId.get(clr.id);
    if (!current) {
      byId.set(clr.id, clr);
      continue;
    }
    byId.set(clr.id, {
      ...current,
      question: current.question || clr.question,
      context: current.context || clr.context,
      answer: current.answer ?? clr.answer,
      relatedItemIds: uniqueStrings([...current.relatedItemIds, ...clr.relatedItemIds]),
    });
  }
  return [...byId.values()];
}

function deriveTopics(items: MeetingItem[], extraTopics: string[]): string[] {
  return uniqueStrings([
    ...extraTopics,
    ...items.map((item) => item.category),
    ...items.flatMap((item) => item.tags),
  ]);
}

function priorityRank(priority: MeetingItem["priority"]): number {
  switch (priority) {
    case "critical":
      return 0;
    case "high":
      return 1;
    case "medium":
      return 2;
    case "low":
      return 3;
    case "none":
      return 4;
    default:
      return 5;
  }
}

function itemFingerprint(item: MeetingItem): string {
  return `${item.itemType}|${item.title.trim().toLowerCase()}`;
}

function relationFingerprint(relation: MeetingRelation): string {
  return `${relation.relationType}|${relation.fromItemId}|${relation.toItemId}`;
}

function entityFingerprint(entity: MeetingEntity): string {
  return `${entity.entityType}|${entity.name.trim().toLowerCase()}`;
}

function computeDeepChanges(
  prevItems: MeetingItem[],
  nextItems: MeetingItem[],
  prevRelations: MeetingRelation[],
  nextRelations: MeetingRelation[],
  prevEntities: MeetingEntity[],
  nextEntities: MeetingEntity[]
): InsightChange[] {
  return [
    ...computeItemChanges(prevItems, nextItems),
    ...computeRelationChanges(prevRelations, nextRelations),
    ...computeEntityChanges(prevEntities, nextEntities),
  ];
}

function computeItemChanges(prevItems: MeetingItem[], nextItems: MeetingItem[]): InsightChange[] {
  const changes: InsightChange[] = [];
  const prevById = new Map(prevItems.map((item) => [item.id, item]));
  const nextById = new Map(nextItems.map((item) => [item.id, item]));

  for (const item of nextItems) {
    const prev = prevById.get(item.id);
    if (!prev) {
      changes.push({
        artifact: "item",
        changeType: "added",
        id: item.id,
        label: item.title,
        fields: [],
      });
      continue;
    }

    const changedFields = diffItemFields(prev, item);
    if (changedFields.length > 0) {
      changes.push({
        artifact: "item",
        changeType: "modified",
        id: item.id,
        label: item.title,
        fields: changedFields,
      });
    }
  }

  for (const item of prevItems) {
    if (!nextById.has(item.id)) {
      changes.push({
        artifact: "item",
        changeType: "removed",
        id: item.id,
        label: item.title,
        fields: [],
      });
    }
  }

  return changes;
}

function computeRelationChanges(
  prevRelations: MeetingRelation[],
  nextRelations: MeetingRelation[]
): InsightChange[] {
  const changes: InsightChange[] = [];
  const prevByKey = new Map(prevRelations.map((rel) => [relationFingerprint(rel), rel]));
  const nextByKey = new Map(nextRelations.map((rel) => [relationFingerprint(rel), rel]));

  for (const rel of nextRelations) {
    const key = relationFingerprint(rel);
    const prev = prevByKey.get(key);
    if (!prev) {
      changes.push({
        artifact: "relation",
        changeType: "added",
        id: rel.id,
        label: `${rel.fromItemId} ${rel.relationType} ${rel.toItemId}`,
        fields: [],
      });
      continue;
    }

    const fields: string[] = [];
    if (prev.rationale !== rel.rationale) fields.push("rationale");
    if (prev.evidence !== rel.evidence) fields.push("evidence");
    if (prev.confidence !== rel.confidence) fields.push("confidence");
    if (fields.length > 0) {
      changes.push({
        artifact: "relation",
        changeType: "modified",
        id: rel.id,
        label: `${rel.fromItemId} ${rel.relationType} ${rel.toItemId}`,
        fields,
      });
    }
  }

  for (const rel of prevRelations) {
    const key = relationFingerprint(rel);
    if (!nextByKey.has(key)) {
      changes.push({
        artifact: "relation",
        changeType: "removed",
        id: rel.id,
        label: `${rel.fromItemId} ${rel.relationType} ${rel.toItemId}`,
        fields: [],
      });
    }
  }

  return changes;
}

function computeEntityChanges(
  prevEntities: MeetingEntity[],
  nextEntities: MeetingEntity[]
): InsightChange[] {
  const changes: InsightChange[] = [];
  const prevByKey = new Map(prevEntities.map((entity) => [entityFingerprint(entity), entity]));
  const nextByKey = new Map(nextEntities.map((entity) => [entityFingerprint(entity), entity]));

  for (const entity of nextEntities) {
    const key = entityFingerprint(entity);
    const prev = prevByKey.get(key);
    if (!prev) {
      changes.push({
        artifact: "entity",
        changeType: "added",
        id: entity.id,
        label: entity.name,
        fields: [],
      });
      continue;
    }

    const fields: string[] = [];
    if (JSON.stringify(prev.aliases) !== JSON.stringify(entity.aliases)) fields.push("aliases");
    if (prev.evidence !== entity.evidence) fields.push("evidence");
    if (prev.confidence !== entity.confidence) fields.push("confidence");
    if (fields.length > 0) {
      changes.push({
        artifact: "entity",
        changeType: "modified",
        id: entity.id,
        label: entity.name,
        fields,
      });
    }
  }

  for (const entity of prevEntities) {
    const key = entityFingerprint(entity);
    if (!nextByKey.has(key)) {
      changes.push({
        artifact: "entity",
        changeType: "removed",
        id: entity.id,
        label: entity.name,
        fields: [],
      });
    }
  }

  return changes;
}

function diffItemFields(prev: MeetingItem, next: MeetingItem): string[] {
  const changed: string[] = [];
  if (prev.itemType !== next.itemType) changed.push("itemType");
  if (prev.title !== next.title) changed.push("title");
  if (prev.summary !== next.summary) changed.push("summary");
  if (prev.details !== next.details) changed.push("details");
  if (prev.category !== next.category) changed.push("category");
  if (prev.priority !== next.priority) changed.push("priority");
  if (prev.owner !== next.owner) changed.push("owner");
  if (JSON.stringify(prev.coOwners) !== JSON.stringify(next.coOwners)) changed.push("coOwners");
  if (prev.dueDate !== next.dueDate) changed.push("dueDate");
  if (prev.statusSignal !== next.statusSignal) changed.push("statusSignal");
  if (prev.sensitivity !== next.sensitivity) changed.push("sensitivity");
  if (JSON.stringify(prev.tags) !== JSON.stringify(next.tags)) changed.push("tags");
  if (prev.speaker !== next.speaker) changed.push("speaker");
  if (prev.evidence !== next.evidence) changed.push("evidence");
  if (prev.confidence !== next.confidence) changed.push("confidence");
  if (JSON.stringify(prev.sourceUtteranceIds) !== JSON.stringify(next.sourceUtteranceIds)) {
    changed.push("sourceUtteranceIds");
  }
  if (JSON.stringify(prev.metadata) !== JSON.stringify(next.metadata)) changed.push("metadata");
  return changed;
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}
