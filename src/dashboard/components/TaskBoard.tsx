import type { MeetingEntity, MeetingItem, MeetingRelation, MeetingItemType } from "../types";
import { TaskCard } from "./TaskCard";

interface TaskBoardProps {
  items: MeetingItem[];
  relations: MeetingRelation[];
  entities: MeetingEntity[];
  onSelectItem?: (item: MeetingItem) => void;
}

interface SuperCategory {
  key: string;
  label: string;
  types: MeetingItemType[];
  accent: string;
}

const SUPER_CATEGORIES: SuperCategory[] = [
  {
    key: "actions",
    label: "Actions",
    types: ["action_item", "commitment", "follow_up"],
    accent: "var(--color-cat-actions)",
  },
  {
    key: "decisions",
    label: "Decisions",
    types: ["decision", "approval", "objection", "change_request"],
    accent: "var(--color-cat-decisions)",
  },
  {
    key: "risks",
    label: "Risks & Blockers",
    types: ["risk", "blocker", "issue", "constraint"],
    accent: "var(--color-cat-risks)",
  },
  {
    key: "planning",
    label: "Planning",
    types: ["dependency", "milestone", "deadline", "requirement", "assumption", "metric"],
    accent: "var(--color-cat-planning)",
  },
  {
    key: "open",
    label: "Open Threads",
    types: ["question_open", "question_answered", "parking_lot", "announcement"],
    accent: "var(--color-cat-open)",
  },
];

const PRIORITY_RANK: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  none: 4,
};

export function TaskBoard({ items, relations, entities, onSelectItem }: TaskBoardProps) {
  if (items.length === 0) {
    return (
      <div className="task-board__empty">
        No structured meeting items yet. Start speaking to extract decisions,
        actions, risks, questions, dependencies, and more.
      </div>
    );
  }

  const relationCounts = new Map<string, number>();
  for (const relation of relations) {
    relationCounts.set(
      relation.fromItemId,
      (relationCounts.get(relation.fromItemId) ?? 0) + 1
    );
    relationCounts.set(
      relation.toItemId,
      (relationCounts.get(relation.toItemId) ?? 0) + 1
    );
  }

  const grouped = new Map<string, MeetingItem[]>();
  for (const cat of SUPER_CATEGORIES) {
    grouped.set(cat.key, []);
  }

  for (const item of items) {
    for (const cat of SUPER_CATEGORIES) {
      if (cat.types.includes(item.itemType)) {
        grouped.get(cat.key)!.push(item);
        break;
      }
    }
  }

  return (
    <div className="swim-board">
      {SUPER_CATEGORIES.map((cat) => {
        const catItems = grouped.get(cat.key) ?? [];
        if (catItems.length === 0) return null;

        const sorted = [...catItems].sort(
          (a, b) =>
            (PRIORITY_RANK[a.priority] ?? 4) - (PRIORITY_RANK[b.priority] ?? 4) ||
            b.confidence - a.confidence
        );

        return (
          <section
            className="swim-lane"
            key={cat.key}
            style={{ "--lane-accent": cat.accent } as React.CSSProperties}
          >
            <header className="swim-lane__header">
              <div className="swim-lane__accent" />
              <h3 className="swim-lane__title">{cat.label}</h3>
              <span className="swim-lane__count">{sorted.length}</span>
            </header>
            <div className="swim-lane__track">
              {sorted.map((item) => (
                <TaskCard
                  key={item.id}
                  item={item}
                  relationCount={relationCounts.get(item.id) ?? 0}
                  onClick={() => onSelectItem?.(item)}
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
