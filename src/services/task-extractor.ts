// Two-tier meeting intelligence extraction from live voice transcripts.
// Fast path: per-sentence extraction for low-latency updates.
// Deep path: periodic consolidation for conflict resolution and richer structure.

import type { ChatMessage, LLMProvider, ToolDefinition } from "../providers/llm";
import type {
  ClarificationQuestion,
  EntityType,
  ItemPriority,
  ItemSensitivity,
  ItemStatusSignal,
  MeetingEntity,
  MeetingItem,
  MeetingItemType,
  MeetingRelation,
  RelationType,
} from "../types/session";

export interface FastExtractionResult {
  newItems: MeetingItem[];
  modifiedItems: MeetingItem[];
  newRelations: MeetingRelation[];
  newEntities: MeetingEntity[];
  topics: string[];
}

export interface DeepAnalysisResult {
  items: MeetingItem[];
  relations: MeetingRelation[];
  entities: MeetingEntity[];
  topics: string[];
  clarifications: ClarificationQuestion[];
}

const ITEM_TYPES: MeetingItemType[] = [
  "decision",
  "action_item",
  "commitment",
  "question_open",
  "question_answered",
  "risk",
  "blocker",
  "issue",
  "constraint",
  "assumption",
  "requirement",
  "change_request",
  "objection",
  "approval",
  "dependency",
  "milestone",
  "deadline",
  "metric",
  "follow_up",
  "parking_lot",
  "announcement",
];

const PRIORITIES: ItemPriority[] = ["critical", "high", "medium", "low", "none"];
const STATUS_SIGNALS: ItemStatusSignal[] = ["new", "updated", "retracted", "uncertain"];
const SENSITIVITY_LEVELS: ItemSensitivity[] = ["public", "internal", "restricted"];

const RELATION_TYPES: RelationType[] = [
  "supports",
  "contradicts",
  "supersedes",
  "clarifies",
  "duplicates",
  "depends_on",
  "blocks",
  "assigned_to",
  "approved_by",
  "objected_by",
  "relates_to_topic",
];

const ENTITY_TYPES: EntityType[] = [
  "person",
  "organization",
  "team",
  "initiative",
  "system",
  "location",
  "document",
  "other",
];

type ItemUpdates = Partial<{
  item_type: MeetingItemType;
  title: string;
  summary: string;
  details: string;
  category: string;
  priority: ItemPriority;
  owner: string | null;
  co_owners: string[];
  due_date: string | null;
  status_signal: ItemStatusSignal;
  sensitivity: ItemSensitivity;
  tags: string[];
  speaker: string | null;
  confidence: number;
  metadata: Record<string, unknown>;
  source_utterance_ids: string[];
}>;

type DeepMergePair = {
  primary_item_id: string;
  duplicate_item_id: string;
  rationale?: string;
};

type DeepOperationsInput = Partial<{
  upsert_items: Record<string, unknown>[];
  delete_item_ids: string[];
  merge_item_pairs: DeepMergePair[];
  upsert_relations: Record<string, unknown>[];
  delete_relation_ids: string[];
  upsert_entities: Record<string, unknown>[];
  delete_entity_ids: string[];
  upsert_clarifications: Record<string, unknown>[];
  topics: string[];
}>;

const DEEP_TOOL_MAX_STEPS = 8;

const DEEP_TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: "apply_operations",
    description:
      "Apply structured edits to the current meeting draft. Use this for add/update/delete/merge operations.",
    parameters: {
      type: "object",
      properties: {
        upsert_items: { type: "array", items: { type: "object" } },
        delete_item_ids: { type: "array", items: { type: "string" } },
        merge_item_pairs: {
          type: "array",
          items: {
            type: "object",
            properties: {
              primary_item_id: { type: "string" },
              duplicate_item_id: { type: "string" },
              rationale: { type: "string" },
            },
            required: ["primary_item_id", "duplicate_item_id"],
          },
        },
        upsert_relations: { type: "array", items: { type: "object" } },
        delete_relation_ids: { type: "array", items: { type: "string" } },
        upsert_entities: { type: "array", items: { type: "object" } },
        delete_entity_ids: { type: "array", items: { type: "string" } },
        // upsert_clarifications: { type: "array", items: { type: "object" } },
        topics: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
  {
    name: "finalize",
    description: "Finish consolidation when draft is coherent. Optionally provide final topics.",
    parameters: {
      type: "object",
      properties: {
        topics: { type: "array", items: { type: "string" } },
      },
      additionalProperties: false,
    },
  },
];

export class TaskExtractor {
  private fast: LLMProvider;
  private deep: LLMProvider;

  constructor(fast: LLMProvider, deep: LLMProvider) {
    this.fast = fast;
    this.deep = deep;
  }

  async extractInsights(
    sentence: string,
    existingItems: MeetingItem[],
    existingRelations: MeetingRelation[],
    existingEntities: MeetingEntity[],
    recentContext: string,
    sourceUtteranceIds: string[]
  ): Promise<FastExtractionResult> {
    const dateContext = getDateContext();
    const existingItemsSummary = existingItems
      .map(
        (item) =>
          `- [${item.id}] (${item.itemType}) "${item.title}" | owner=${item.owner ?? "none"} | due=${item.dueDate ?? "none"} | priority=${item.priority} | status_signal=${item.statusSignal}`
      )
      .join("\n");

    const existingRelationsSummary = existingRelations
      .slice(-30)
      .map((rel) => `- [${rel.id}] ${rel.fromItemId} ${rel.relationType} ${rel.toItemId}`)
      .join("\n");

    const existingEntitiesSummary = existingEntities
      .slice(-40)
      .map((entity) => `- [${entity.id}] (${entity.entityType}) ${entity.name}`)
      .join("\n");

    const result = await this.fast.complete({
      system: `You extract structured meeting intelligence from spoken transcripts.

Reference date context: ${dateContext}

Return ONLY valid JSON, no markdown.

Goals:
- Capture decisions, commitments, actions, risks, blockers, questions, dependencies, changes, metrics, and follow-ups.
- Be domain-agnostic: never assume this is a software/tech meeting.
- Track reversals and superseding updates when the speaker changes direction.
- Extract relations and named entities.
- Use modifications when an utterance updates an existing item rather than creating a new one.

Allowed item_type values:
${ITEM_TYPES.join(", ")}

Allowed relation_type values:
${RELATION_TYPES.join(", ")}

Allowed entity_type values:
${ENTITY_TYPES.join(", ")}

Allowed priority values:
${PRIORITIES.join(", ")}

Allowed status_signal values:
${STATUS_SIGNALS.join(", ")}

Allowed sensitivity values:
${SENSITIVITY_LEVELS.join(", ")}

Output schema:
{
  "new_items": [
    {
      "item_type": "string",
      "title": "string",
      "summary": "string",
      "details": "string",
      "category": "string",
      "priority": "critical|high|medium|low|none",
      "owner": "string|null",
      "co_owners": ["string"],
      "due_date": "ISO date|null",
      "status_signal": "new|updated|retracted|uncertain",
      "sensitivity": "public|internal|restricted",
      "tags": ["string"],
      "speaker": "string|null",
      "evidence": "exact quote",
      "confidence": 0.0,
      "metadata": {}
    }
  ],
  "modifications": [
    {
      "item_id": "existing item id",
      "updates": {
        "item_type": "string",
        "title": "string",
        "summary": "string",
        "details": "string",
        "category": "string",
        "priority": "critical|high|medium|low|none",
        "owner": "string|null",
        "co_owners": ["string"],
        "due_date": "ISO date|null",
        "status_signal": "new|updated|retracted|uncertain",
        "sensitivity": "public|internal|restricted",
        "tags": ["string"],
        "speaker": "string|null",
        "confidence": 0.0,
        "metadata": {}
      },
      "evidence": "exact quote"
    }
  ],
  "relations": [
    {
      "relation_type": "string",
      "from_item_id": "item-id|null",
      "to_item_id": "item-id|null",
      "from_title": "title to resolve|null",
      "to_title": "title to resolve|null",
      "rationale": "string",
      "evidence": "exact quote",
      "confidence": 0.0
    }
  ],
  "entities": [
    {
      "entity_type": "person|organization|team|initiative|system|location|document|other",
      "name": "string",
      "aliases": ["string"],
      "evidence": "exact quote",
      "confidence": 0.0
    }
  ],
  "topics": ["string"]
}

If nothing extractable is present, output empty arrays.`,
      messages: [
        {
          role: "user",
          content: `Recent context:\n${recentContext}\n\nExisting items:\n${existingItemsSummary || "(none)"}\n\nExisting relations:\n${existingRelationsSummary || "(none)"}\n\nExisting entities:\n${existingEntitiesSummary || "(none)"}\n\nUtterance:\n"${sentence}"`,
        },
      ],
      maxTokens: 1400,
      jsonMode: true,
      thinkingLevel: "minimal",
    });

    try {
      const parsed = JSON.parse(cleanJson(result)) as Record<string, unknown>;
      const newItems = ((parsed.new_items as Record<string, unknown>[] | undefined) ?? [])
        .map((raw) => this.toMeetingItem(raw, sentence, sourceUtteranceIds))
        .filter((item) => item.title.length > 0);

      const modifiedItems: MeetingItem[] = [];
      for (const mod of ((parsed.modifications as Record<string, unknown>[] | undefined) ?? [])) {
        const itemId = String(mod.item_id ?? "");
        if (!itemId) continue;
        const existing = existingItems.find((item) => item.id === itemId);
        if (!existing) continue;
        const updates = ((mod.updates ?? {}) as ItemUpdates) ?? {};
        const updated = this.applyUpdates(existing, updates, String(mod.evidence ?? sentence), sourceUtteranceIds);
        modifiedItems.push(updated);
      }

      const relationContext = [...existingItems, ...newItems, ...modifiedItems];
      const newRelations = ((parsed.relations as Record<string, unknown>[] | undefined) ?? [])
        .map((raw) => this.toRelation(raw, relationContext))
        .filter((rel): rel is MeetingRelation => rel !== null);

      const newEntities = ((parsed.entities as Record<string, unknown>[] | undefined) ?? [])
        .map((raw) => this.toEntity(raw, sentence))
        .filter((entity) => entity.name.length > 0);

      const topics = uniqueStrings([
        ...(((parsed.topics as string[] | undefined) ?? []).map(normalizeTopic)),
        ...newItems.map((item) => normalizeTopic(item.category)),
        ...modifiedItems.map((item) => normalizeTopic(item.category)),
      ]);

      return {
        newItems,
        modifiedItems,
        newRelations,
        newEntities,
        topics,
      };
    } catch (err) {
      console.error("Failed to parse fast extraction result:", err, result);
      return {
        newItems: [],
        modifiedItems: [],
        newRelations: [],
        newEntities: [],
        topics: [],
      };
    }
  }

  async analyzeDeepWithTools(
    allTranscript: string,
    existingItems: MeetingItem[],
    existingRelations: MeetingRelation[],
    existingEntities: MeetingEntity[],
    existingClarifications: ClarificationQuestion[]
  ): Promise<DeepAnalysisResult> {
    if (!this.deep.completeWithTools) {
      throw new Error("Deep model provider does not support tool calling");
    }

    const draft: DeepAnalysisResult = {
      items: existingItems.map((item) => ({
        ...item,
        coOwners: [...item.coOwners],
        tags: [...item.tags],
        sourceUtteranceIds: [...item.sourceUtteranceIds],
        metadata: { ...item.metadata },
      })),
      relations: existingRelations.map((rel) => ({ ...rel })),
      entities: existingEntities.map((entity) => ({
        ...entity,
        aliases: [...entity.aliases],
      })),
      topics: uniqueStrings([
        ...existingItems.map((item) => normalizeTopic(item.category)),
        ...existingItems.flatMap((item) => item.tags.map(normalizeTopic)),
      ]),
      clarifications: existingClarifications.map((clr) => ({
        ...clr,
        relatedItemIds: [...clr.relatedItemIds],
      })),
    };

    const messages: ChatMessage[] = [
      {
        role: "user",
        content: this.buildDeepToolUserContext(
          allTranscript,
          draft,
          existingClarifications
            .filter((clr) => clr.answer)
            .map((clr) => `Q: ${clr.question}\nA: ${clr.answer}`)
            .join("\n\n")
        ),
      },
    ];

    for (let step = 0; step < DEEP_TOOL_MAX_STEPS; step++) {
      const response = await this.deep.completeWithTools({
        system: this.buildDeepToolSystemPrompt(),
        messages,
        tools: DEEP_TOOL_DEFINITIONS,
        maxTokens: 2400,
        thinkingLevel: "high",
      });

      if (response.text.trim().length > 0) {
        messages.push({
          role: "assistant",
          content: response.text.trim().slice(0, 2000),
        });
      }

      if (response.toolCalls.length === 0) {
        messages.push({
          role: "user",
          content:
            "No tool call was received. Call apply_operations to edit the draft, or finalize when done.",
        });
        continue;
      }

      let finalized = false;
      for (const toolCall of response.toolCalls) {
        if (toolCall.name === "apply_operations") {
          const summary = this.applyDeepOperations(
            draft,
            ensureObject(toolCall.input) as DeepOperationsInput
          );
          messages.push({
            role: "user",
            content: `Tool result apply_operations: ${JSON.stringify(summary)}\nCurrent draft: ${summarizeDraft(draft)}`,
          });
          continue;
        }

        if (toolCall.name === "finalize") {
          const finalizeInput = ensureObject(toolCall.input);
          const topics = ensureStringArray(finalizeInput.topics).map(normalizeTopic);
          if (topics.length > 0) {
            draft.topics = uniqueStrings([...draft.topics, ...topics]);
          }
          messages.push({
            role: "user",
            content: `Tool result finalize: accepted. Final draft: ${summarizeDraft(draft)}`,
          });
          finalized = true;
          continue;
        }

        messages.push({
          role: "user",
          content: `Unknown tool "${toolCall.name}" ignored.`,
        });
      }

      if (finalized) break;
    }

    return this.finalizeDraftState(draft);
  }

  private buildDeepToolSystemPrompt(): string {
    const dateContext = getDateContext();
    return `You are a meeting intelligence consolidation engine.

Reference date context: ${dateContext}

You must maintain a canonical, domain-agnostic structure from a full meeting transcript.
Use tool calls to edit the draft until it is coherent.

Rules:
- Prefer updating/merging existing items over creating duplicates.
- Remove stale or contradicted artifacts when transcript support is gone.
- Resolve reversals with status_signal and relations (e.g. "supersedes", "contradicts").
- Keep only high-signal structure; do not keep noise.
- Clarifications should be specific unresolved questions that materially improve structure.
- Call "finalize" only when the draft is clean.`;
  }

  private buildDeepToolUserContext(
    allTranscript: string,
    draft: DeepAnalysisResult,
    answeredClarifications: string
  ): string {
    return `Full transcript:
${allTranscript}

Current draft snapshot:
${JSON.stringify(draft)}

Answered clarifications:
${answeredClarifications || "(none)"}

Use tools only:
- apply_operations for structured edits (upsert/delete/merge)
- finalize when done.`;
  }

  private applyDeepOperations(
    draft: DeepAnalysisResult,
    input: DeepOperationsInput
  ): Record<string, number> {
    let itemsAdded = 0;
    let itemsUpdated = 0;
    let itemsDeleted = 0;
    let itemsMerged = 0;
    let relationsAdded = 0;
    let relationsUpdated = 0;
    let relationsDeleted = 0;
    let entitiesAdded = 0;
    let entitiesUpdated = 0;
    let entitiesDeleted = 0;
    let clarificationsAdded = 0;
    let clarificationsUpdated = 0;

    for (const raw of ensureObjectArray(input.upsert_items)) {
      const action = this.upsertDraftItem(draft.items, raw);
      if (action === "added") itemsAdded++;
      if (action === "updated") itemsUpdated++;
    }

    for (const pairRaw of ensureObjectArray(input.merge_item_pairs)) {
      const pair = pairRaw as unknown as DeepMergePair;
      const merged = this.mergeDraftItems(
        draft,
        String(pair.primary_item_id ?? "").trim(),
        String(pair.duplicate_item_id ?? "").trim()
      );
      if (merged) itemsMerged++;
    }

    for (const itemId of ensureStringArray(input.delete_item_ids)) {
      const removed = removeItemById(draft, itemId);
      if (removed) itemsDeleted++;
    }

    for (const raw of ensureObjectArray(input.upsert_relations)) {
      const action = this.upsertDraftRelation(draft.relations, draft.items, raw);
      if (action === "added") relationsAdded++;
      if (action === "updated") relationsUpdated++;
    }

    for (const relationId of ensureStringArray(input.delete_relation_ids)) {
      const idx = draft.relations.findIndex((rel) => rel.id === relationId);
      if (idx >= 0) {
        draft.relations.splice(idx, 1);
        relationsDeleted++;
      }
    }

    for (const raw of ensureObjectArray(input.upsert_entities)) {
      const action = this.upsertDraftEntity(draft.entities, raw);
      if (action === "added") entitiesAdded++;
      if (action === "updated") entitiesUpdated++;
    }

    for (const entityId of ensureStringArray(input.delete_entity_ids)) {
      const idx = draft.entities.findIndex((entity) => entity.id === entityId);
      if (idx >= 0) {
        draft.entities.splice(idx, 1);
        entitiesDeleted++;
      }
    }

    // Clarifications disabled for now
    // for (const raw of ensureObjectArray(input.upsert_clarifications)) {
    //   const action = this.upsertDraftClarification(draft.clarifications, raw);
    //   if (action === "added") clarificationsAdded++;
    //   if (action === "updated") clarificationsUpdated++;
    // }

    const topics = ensureStringArray(input.topics).map(normalizeTopic);
    if (topics.length > 0) {
      draft.topics = uniqueStrings([...draft.topics, ...topics]);
    }

    return {
      itemsAdded,
      itemsUpdated,
      itemsDeleted,
      itemsMerged,
      relationsAdded,
      relationsUpdated,
      relationsDeleted,
      entitiesAdded,
      entitiesUpdated,
      entitiesDeleted,
      clarificationsAdded,
      clarificationsUpdated,
    };
  }

  private upsertDraftItem(
    items: MeetingItem[],
    raw: Record<string, unknown>
  ): "added" | "updated" | "ignored" {
    const rawId = String(raw.id ?? "").trim();
    const rawType = validateItemType(raw.item_type ?? raw.itemType);
    const rawTitle = String(raw.title ?? "").trim();
    const sourceIds = ensureStringArray(raw.source_utterance_ids ?? raw.sourceUtteranceIds);

    const indexById = rawId ? items.findIndex((item) => item.id === rawId) : -1;
    const indexBySemantic = indexById < 0
      ? items.findIndex(
          (item) =>
            item.itemType === rawType &&
            item.title.trim().toLowerCase() === rawTitle.toLowerCase()
        )
      : -1;
    const index = indexById >= 0 ? indexById : indexBySemantic;

    if (index >= 0) {
      const existing = items[index];
      const updated = this.applyUpdates(
        existing,
        raw as ItemUpdates,
        String(raw.evidence ?? existing.evidence),
        sourceIds
      );
      items[index] = { ...updated, id: existing.id };
      return "updated";
    }

    const created = this.toMeetingItem(raw, "", sourceIds);
    if (!created.title) return "ignored";
    items.push(created);
    return "added";
  }

  private upsertDraftRelation(
    relations: MeetingRelation[],
    items: MeetingItem[],
    raw: Record<string, unknown>
  ): "added" | "updated" | "ignored" {
    const candidate = this.toRelation(raw, items, true);
    if (!candidate) return "ignored";

    const rawId = String(raw.id ?? "").trim();
    const indexById = rawId ? relations.findIndex((rel) => rel.id === rawId) : -1;
    const indexBySemantic = indexById < 0
      ? relations.findIndex(
          (rel) =>
            rel.relationType === candidate.relationType &&
            rel.fromItemId === candidate.fromItemId &&
            rel.toItemId === candidate.toItemId
        )
      : -1;
    const index = indexById >= 0 ? indexById : indexBySemantic;

    if (index >= 0) {
      relations[index] = { ...candidate, id: relations[index].id };
      return "updated";
    }

    relations.push(candidate);
    return "added";
  }

  private upsertDraftEntity(
    entities: MeetingEntity[],
    raw: Record<string, unknown>
  ): "added" | "updated" | "ignored" {
    const entity = this.toEntity(raw, "");
    if (!entity.name) return "ignored";

    const rawId = String(raw.id ?? "").trim();
    const byId = rawId ? entities.findIndex((existing) => existing.id === rawId) : -1;
    const bySemantic = byId < 0
      ? entities.findIndex(
          (existing) =>
            existing.entityType === entity.entityType &&
            existing.name.trim().toLowerCase() === entity.name.trim().toLowerCase()
        )
      : -1;
    const index = byId >= 0 ? byId : bySemantic;

    if (index >= 0) {
      const existing = entities[index];
      entities[index] = {
        ...existing,
        ...entity,
        id: existing.id,
        aliases: uniqueStrings([...existing.aliases, ...entity.aliases]),
      };
      return "updated";
    }

    entities.push(entity);
    return "added";
  }

  private upsertDraftClarification(
    clarifications: ClarificationQuestion[],
    raw: Record<string, unknown>
  ): "added" | "updated" | "ignored" {
    const id = String(raw.id ?? "").trim();
    const question = String(raw.question ?? "").trim();
    const context = String(raw.context ?? "").trim();
    const answer = raw.answer === undefined ? null : toNullableString(raw.answer);
    const relatedItemIds = ensureStringArray(raw.related_item_ids ?? raw.relatedItemIds);

    if (!question) return "ignored";

    const byId = id ? clarifications.findIndex((clr) => clr.id === id) : -1;
    const byQuestion = byId < 0
      ? clarifications.findIndex(
          (clr) => clr.question.trim().toLowerCase() === question.toLowerCase()
        )
      : -1;
    const index = byId >= 0 ? byId : byQuestion;

    if (index >= 0) {
      const existing = clarifications[index];
      clarifications[index] = {
        ...existing,
        question,
        context: context || existing.context,
        answer: answer ?? existing.answer,
        relatedItemIds: uniqueStrings([
          ...existing.relatedItemIds,
          ...relatedItemIds,
        ]),
      };
      return "updated";
    }

    clarifications.push({
      id: id || `clr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      question,
      context,
      answer,
      relatedItemIds,
    });
    return "added";
  }

  private mergeDraftItems(
    draft: DeepAnalysisResult,
    primaryItemId: string,
    duplicateItemId: string
  ): boolean {
    if (!primaryItemId || !duplicateItemId || primaryItemId === duplicateItemId) return false;

    const primaryIndex = draft.items.findIndex((item) => item.id === primaryItemId);
    const duplicateIndex = draft.items.findIndex((item) => item.id === duplicateItemId);
    if (primaryIndex < 0 || duplicateIndex < 0) return false;

    const primary = draft.items[primaryIndex];
    const duplicate = draft.items[duplicateIndex];

    draft.items[primaryIndex] = {
      ...primary,
      summary: primary.summary || duplicate.summary,
      details: primary.details || duplicate.details,
      owner: primary.owner || duplicate.owner,
      dueDate: primary.dueDate || duplicate.dueDate,
      confidence: Math.max(primary.confidence, duplicate.confidence),
      evidence: primary.evidence || duplicate.evidence,
      coOwners: uniqueStrings([...primary.coOwners, ...duplicate.coOwners]),
      tags: uniqueStrings([...primary.tags, ...duplicate.tags]),
      sourceUtteranceIds: uniqueStrings([
        ...primary.sourceUtteranceIds,
        ...duplicate.sourceUtteranceIds,
      ]),
      metadata: { ...duplicate.metadata, ...primary.metadata },
    };

    for (const relation of draft.relations) {
      if (relation.fromItemId === duplicateItemId) relation.fromItemId = primaryItemId;
      if (relation.toItemId === duplicateItemId) relation.toItemId = primaryItemId;
    }

    for (const clarification of draft.clarifications) {
      clarification.relatedItemIds = clarification.relatedItemIds.map((id) =>
        id === duplicateItemId ? primaryItemId : id
      );
      clarification.relatedItemIds = uniqueStrings(clarification.relatedItemIds);
    }

    draft.items.splice(duplicateIndex, 1);
    draft.relations = draft.relations.filter(
      (rel) => rel.fromItemId !== rel.toItemId
    );
    return true;
  }

  private finalizeDraftState(draft: DeepAnalysisResult): DeepAnalysisResult {
    const items = draft.items
      .filter((item) => item.title.trim().length > 0)
      .sort((a, b) => {
        const priorityDiff = priorityRank(a.priority) - priorityRank(b.priority);
        if (priorityDiff !== 0) return priorityDiff;
        return b.confidence - a.confidence;
      });

    const itemIds = new Set(items.map((item) => item.id));

    const relationByKey = new Map<string, MeetingRelation>();
    for (const relation of draft.relations) {
      if (!itemIds.has(relation.fromItemId) || !itemIds.has(relation.toItemId)) continue;
      if (relation.fromItemId === relation.toItemId) continue;
      relationByKey.set(
        `${relation.relationType}|${relation.fromItemId}|${relation.toItemId}`,
        relation
      );
    }
    const relations = [...relationByKey.values()];

    const entityByKey = new Map<string, MeetingEntity>();
    for (const entity of draft.entities) {
      if (!entity.name.trim()) continue;
      const key = `${entity.entityType}|${entity.name.trim().toLowerCase()}`;
      const current = entityByKey.get(key);
      if (!current) {
        entityByKey.set(key, entity);
        continue;
      }
      entityByKey.set(key, {
        ...current,
        aliases: uniqueStrings([...current.aliases, ...entity.aliases]),
        confidence: Math.max(current.confidence, entity.confidence),
        evidence: current.evidence || entity.evidence,
      });
    }
    const entities = [...entityByKey.values()];

    const clarifications = draft.clarifications
      .filter((clr) => clr.question.trim().length > 0)
      .map((clr) => ({
        ...clr,
        relatedItemIds: clr.relatedItemIds.filter((id) => itemIds.has(id)),
      }))
      .slice(0, 8);

    const topics = uniqueStrings([
      ...draft.topics.map(normalizeTopic),
      ...items.map((item) => normalizeTopic(item.category)),
      ...items.flatMap((item) => item.tags.map(normalizeTopic)),
    ]);

    return {
      items,
      relations,
      entities,
      topics,
      clarifications,
    };
  }

  async *analyzeDeep(
    allTranscript: string,
    existingItems: MeetingItem[],
    existingRelations: MeetingRelation[],
    existingEntities: MeetingEntity[],
    existingClarifications: ClarificationQuestion[]
  ): AsyncGenerator<string> {
    const dateContext = getDateContext();
    const itemsSummary = existingItems
      .map(
        (item) =>
          `- [${item.id}] (${item.itemType}) "${item.title}" | ${item.priority} | ${item.statusSignal} | cat=${item.category} | due=${item.dueDate ?? "none"}`
      )
      .join("\n");

    const relationsSummary = existingRelations
      .map((rel) => `- [${rel.id}] ${rel.fromItemId} ${rel.relationType} ${rel.toItemId}`)
      .join("\n");

    const entitiesSummary = existingEntities
      .map((entity) => `- [${entity.id}] (${entity.entityType}) ${entity.name}`)
      .join("\n");

    const answeredClarifications = existingClarifications
      .filter((clr) => clr.answer)
      .map((clr) => `Q: ${clr.question}\nA: ${clr.answer}`)
      .join("\n\n");

    yield* this.deep.stream({
      system: `You are a meeting intelligence consolidation engine.

Reference date context: ${dateContext}

Given the full transcript and current extracted state, produce a clean canonical structure:
- Merge duplicates.
- Resolve contradictions and reversals (use "supersedes" / "contradicts").
- Preserve useful uncertainty by setting status_signal="uncertain" where needed.
- Keep the output domain-agnostic.
- Treat your output as a full replacement snapshot of meeting intelligence, not a delta.
- You may revise previous titles/summaries/owners/dates/categories/priorities.
- You may retract stale items by setting status_signal="retracted".
- Do not keep outdated artifacts unless the transcript still supports them.

Output ONLY JSON:
{
  "items": [
    {
      "id": "existing-or-new-id",
      "item_type": "string",
      "title": "string",
      "summary": "string",
      "details": "string",
      "category": "string",
      "priority": "critical|high|medium|low|none",
      "owner": "string|null",
      "co_owners": ["string"],
      "due_date": "ISO date|null",
      "status_signal": "new|updated|retracted|uncertain",
      "sensitivity": "public|internal|restricted",
      "tags": ["string"],
      "speaker": "string|null",
      "evidence": "transcript quote",
      "confidence": 0.0,
      "source_utterance_ids": ["utt-id"],
      "metadata": {}
    }
  ],
  "relations": [
    {
      "id": "existing-or-new-id",
      "relation_type": "supports|contradicts|supersedes|clarifies|duplicates|depends_on|blocks|assigned_to|approved_by|objected_by|relates_to_topic",
      "from_item_id": "item-id",
      "to_item_id": "item-id",
      "rationale": "string",
      "evidence": "quote",
      "confidence": 0.0
    }
  ],
  "entities": [
    {
      "id": "existing-or-new-id",
      "entity_type": "person|organization|team|initiative|system|location|document|other",
      "name": "string",
      "aliases": ["string"],
      "evidence": "quote",
      "confidence": 0.0
    }
  ],
  "topics": ["string"]
}`,
      messages: [
        {
          role: "user",
          content: `Full transcript:\n${allTranscript}\n\nExisting items:\n${itemsSummary || "(none)"}\n\nExisting relations:\n${relationsSummary || "(none)"}\n\nExisting entities:\n${entitiesSummary || "(none)"}\n\nAnswered clarifications:\n${answeredClarifications || "(none)"}`,
        },
      ],
      maxTokens: 5000,
      jsonMode: true,
      thinkingLevel: "high",
    });
  }

  parseDeepResult(
    accumulated: string,
    existingItems: MeetingItem[],
    existingRelations: MeetingRelation[],
    existingEntities: MeetingEntity[]
  ): DeepAnalysisResult {
    try {
      const parsed = JSON.parse(cleanJson(accumulated)) as Record<string, unknown>;
      const hasItems = Array.isArray(parsed.items);
      const hasRelations = Array.isArray(parsed.relations);
      const hasEntities = Array.isArray(parsed.entities);

      const parsedItems = ((parsed.items as Record<string, unknown>[] | undefined) ?? [])
        .map((raw) => {
          const rawId = String(raw.id ?? "").trim();
          const rawType = validateItemType(raw.item_type ?? raw.itemType);
          const rawTitle = String(raw.title ?? "").trim();
          const existingById = rawId
            ? existingItems.find((item) => item.id === rawId)
            : undefined;
          const existingBySemantics = !existingById
            ? findItemBySemanticKey(existingItems, rawType, rawTitle)
            : undefined;
          const base = existingById ?? existingBySemantics ?? this.toMeetingItem(raw, "", []);
          const normalized = this.applyUpdates(
            base,
            raw as ItemUpdates,
            String(raw.evidence ?? base.evidence),
            base.sourceUtteranceIds
          );
          return {
            ...normalized,
            id: existingById?.id || existingBySemantics?.id || rawId || normalized.id,
          };
        })
        .filter((item) => item.title.length > 0);

      const items = hasItems
        ? (parsedItems.length > 0 ? parsedItems : existingItems)
        : existingItems;

      const itemContext = items;
      const parsedRelations = ((parsed.relations as Record<string, unknown>[] | undefined) ?? [])
        .map((raw) => this.toRelation(raw, itemContext, true))
        .filter((rel): rel is MeetingRelation => rel !== null);

      const parsedEntities = ((parsed.entities as Record<string, unknown>[] | undefined) ?? [])
        .map((raw) => this.toEntity(raw, ""))
        .filter((entity) => entity.name.length > 0);

      const relations = hasRelations ? parsedRelations : existingRelations;
      const entities = hasEntities ? parsedEntities : existingEntities;

      const topics = uniqueStrings([
        ...(((parsed.topics as string[] | undefined) ?? []).map(normalizeTopic)),
        ...items.map((item) => normalizeTopic(item.category)),
      ]);

      // Clarifications disabled for now
      const clarifications: ClarificationQuestion[] = [];

      return {
        items,
        relations,
        entities,
        topics,
        clarifications,
      };
    } catch (err) {
      console.error("Failed to parse deep analysis result:", err);
      return {
        items: existingItems,
        relations: existingRelations,
        entities: existingEntities,
        topics: uniqueStrings(existingItems.map((item) => normalizeTopic(item.category))),
        clarifications: [],
      };
    }
  }

  private toMeetingItem(
    raw: Record<string, unknown>,
    fallbackEvidence: string,
    sourceUtteranceIds: string[]
  ): MeetingItem {
    const evidence = String(raw.evidence ?? fallbackEvidence).trim();
    const title = String(raw.title ?? "").trim();
    return {
      id: String(raw.id ?? `item-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
      itemType: validateItemType(raw.item_type ?? raw.itemType),
      title,
      summary: String(raw.summary ?? "").trim(),
      details: String(raw.details ?? "").trim(),
      category: normalizeTopic(String(raw.category ?? "general")),
      priority: validatePriority(raw.priority),
      owner: toNullableString(raw.owner),
      coOwners: ensureStringArray(raw.co_owners ?? raw.coOwners),
      dueDate: toNullableString(raw.due_date ?? raw.dueDate),
      statusSignal: validateStatusSignal(raw.status_signal ?? raw.statusSignal),
      sensitivity: validateSensitivity(raw.sensitivity),
      tags: ensureStringArray(raw.tags),
      speaker: toNullableString(raw.speaker),
      evidence,
      confidence: clampConfidence(raw.confidence),
      sourceUtteranceIds: ensureStringArray(raw.source_utterance_ids ?? raw.sourceUtteranceIds).length > 0
        ? ensureStringArray(raw.source_utterance_ids ?? raw.sourceUtteranceIds)
        : sourceUtteranceIds,
      metadata: ensureObject(raw.metadata),
    };
  }

  private applyUpdates(
    existing: MeetingItem,
    updates: ItemUpdates,
    evidence: string,
    fallbackSourceUtteranceIds: string[]
  ): MeetingItem {
    const sourceIds = ensureStringArray(updates.source_utterance_ids).length > 0
      ? ensureStringArray(updates.source_utterance_ids)
      : fallbackSourceUtteranceIds;

    return {
      ...existing,
      itemType: updates.item_type ? validateItemType(updates.item_type) : existing.itemType,
      title: updates.title ? String(updates.title).trim() : existing.title,
      summary: updates.summary !== undefined ? String(updates.summary).trim() : existing.summary,
      details: updates.details !== undefined ? String(updates.details).trim() : existing.details,
      category: updates.category !== undefined ? normalizeTopic(String(updates.category)) : existing.category,
      priority: updates.priority ? validatePriority(updates.priority) : existing.priority,
      owner: updates.owner !== undefined ? toNullableString(updates.owner) : existing.owner,
      coOwners: updates.co_owners !== undefined ? ensureStringArray(updates.co_owners) : existing.coOwners,
      dueDate: updates.due_date !== undefined ? toNullableString(updates.due_date) : existing.dueDate,
      statusSignal: updates.status_signal ? validateStatusSignal(updates.status_signal) : existing.statusSignal,
      sensitivity: updates.sensitivity ? validateSensitivity(updates.sensitivity) : existing.sensitivity,
      tags: updates.tags !== undefined ? ensureStringArray(updates.tags) : existing.tags,
      speaker: updates.speaker !== undefined ? toNullableString(updates.speaker) : existing.speaker,
      confidence: updates.confidence !== undefined ? clampConfidence(updates.confidence) : existing.confidence,
      evidence: evidence || existing.evidence,
      sourceUtteranceIds: uniqueStrings([...existing.sourceUtteranceIds, ...sourceIds]),
      metadata: updates.metadata !== undefined
        ? { ...existing.metadata, ...ensureObject(updates.metadata) }
        : existing.metadata,
    };
  }

  private toRelation(
    raw: Record<string, unknown>,
    items: MeetingItem[],
    preserveId = false
  ): MeetingRelation | null {
    const fromItemId = String(raw.from_item_id ?? raw.fromItemId ?? "").trim();
    const toItemId = String(raw.to_item_id ?? raw.toItemId ?? "").trim();
    const fromTitle = String(raw.from_title ?? raw.fromTitle ?? "").trim();
    const toTitle = String(raw.to_title ?? raw.toTitle ?? "").trim();

    const resolvedFrom = fromItemId || findItemIdByTitle(fromTitle, items);
    const resolvedTo = toItemId || findItemIdByTitle(toTitle, items);

    if (!resolvedFrom || !resolvedTo || resolvedFrom === resolvedTo) return null;

    return {
      id: preserveId
        ? String(raw.id ?? `rel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
        : `rel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      relationType: validateRelationType(raw.relation_type ?? raw.relationType),
      fromItemId: resolvedFrom,
      toItemId: resolvedTo,
      rationale: String(raw.rationale ?? "").trim(),
      evidence: String(raw.evidence ?? "").trim(),
      confidence: clampConfidence(raw.confidence),
    };
  }

  private toEntity(raw: Record<string, unknown>, fallbackEvidence: string): MeetingEntity {
    return {
      id: String(raw.id ?? `ent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
      entityType: validateEntityType(raw.entity_type ?? raw.entityType),
      name: String(raw.name ?? "").trim(),
      aliases: ensureStringArray(raw.aliases),
      evidence: String(raw.evidence ?? fallbackEvidence).trim(),
      confidence: clampConfidence(raw.confidence),
    };
  }
}

function validateItemType(value: unknown): MeetingItemType {
  return ITEM_TYPES.includes(value as MeetingItemType) ? (value as MeetingItemType) : "follow_up";
}

function validatePriority(value: unknown): ItemPriority {
  return PRIORITIES.includes(value as ItemPriority) ? (value as ItemPriority) : "medium";
}

function validateStatusSignal(value: unknown): ItemStatusSignal {
  return STATUS_SIGNALS.includes(value as ItemStatusSignal) ? (value as ItemStatusSignal) : "new";
}

function validateSensitivity(value: unknown): ItemSensitivity {
  return SENSITIVITY_LEVELS.includes(value as ItemSensitivity) ? (value as ItemSensitivity) : "internal";
}

function validateRelationType(value: unknown): RelationType {
  return RELATION_TYPES.includes(value as RelationType) ? (value as RelationType) : "relates_to_topic";
}

function validateEntityType(value: unknown): EntityType {
  return ENTITY_TYPES.includes(value as EntityType) ? (value as EntityType) : "other";
}

function clampConfidence(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value ?? 0.7);
  if (!Number.isFinite(n)) return 0.7;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function normalizeTopic(value: string): string {
  const normalized = value.trim().toLowerCase();
  return normalized || "general";
}

function toNullableString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function ensureStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => String(v).trim())
    .filter((v) => v.length > 0);
}

function ensureObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
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

function ensureObjectArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter(
    (entry): entry is Record<string, unknown> =>
      !!entry && typeof entry === "object" && !Array.isArray(entry)
  );
}

function summarizeDraft(draft: DeepAnalysisResult): string {
  const topItems = draft.items
    .slice(0, 8)
    .map((item) => `[${item.id}] ${item.title}`)
    .join("; ");
  return JSON.stringify({
    itemCount: draft.items.length,
    relationCount: draft.relations.length,
    entityCount: draft.entities.length,
    clarificationCount: draft.clarifications.length,
    topics: draft.topics.slice(0, 12),
    topItems,
  });
}

function removeItemById(draft: DeepAnalysisResult, itemId: string): boolean {
  const idx = draft.items.findIndex((item) => item.id === itemId);
  if (idx < 0) return false;

  draft.items.splice(idx, 1);
  draft.relations = draft.relations.filter(
    (rel) => rel.fromItemId !== itemId && rel.toItemId !== itemId
  );
  for (const clr of draft.clarifications) {
    clr.relatedItemIds = clr.relatedItemIds.filter((id) => id !== itemId);
  }
  return true;
}

function priorityRank(priority: ItemPriority): number {
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

function findItemIdByTitle(title: string, items: MeetingItem[]): string {
  if (!title) return "";
  const needle = title.toLowerCase();
  const exact = items.find((item) => item.title.toLowerCase() === needle);
  if (exact) return exact.id;
  const partial = items.find((item) => item.title.toLowerCase().includes(needle));
  if (partial) return partial.id;
  return "";
}

function findItemBySemanticKey(
  items: MeetingItem[],
  itemType: MeetingItemType,
  title: string
): MeetingItem | undefined {
  const normalizedTitle = title.trim().toLowerCase();
  if (!normalizedTitle) return undefined;
  return items.find(
    (item) =>
      item.itemType === itemType &&
      item.title.trim().toLowerCase() === normalizedTitle
  );
}

function cleanJson(text: string): string {
  let cleaned = text.trim();
  if (cleaned.startsWith("```")) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }
  return cleaned.trim();
}

function getDateContext(): string {
  const now = new Date();
  const isoDate = now.toISOString().slice(0, 10);
  const weekday = now.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  return `${isoDate} (${weekday}, UTC)`;
}
