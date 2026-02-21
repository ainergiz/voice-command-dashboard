import type { MeetingItem, MeetingRelation, MeetingEntity } from "../types";

interface ItemDrawerProps {
  item: MeetingItem;
  relations: MeetingRelation[];
  items: MeetingItem[];
  entities: MeetingEntity[];
  onClose: () => void;
}

export function ItemDrawer({ item, relations, items, entities, onClose }: ItemDrawerProps) {
  // Find relations involving this item
  const related = relations.filter(
    (r) => r.fromItemId === item.id || r.toItemId === item.id
  );

  // Resolve linked items
  const itemMap = new Map(items.map((i) => [i.id, i]));
  const linkedItems = related.map((r) => {
    const otherId = r.fromItemId === item.id ? r.toItemId : r.fromItemId;
    return { relation: r, other: itemMap.get(otherId) };
  });

  // Find mentioned entities by matching tags/evidence
  const relatedEntities = entities.filter(
    (e) =>
      item.tags.some((t) => t.toLowerCase() === e.name.toLowerCase()) ||
      item.evidence.toLowerCase().includes(e.name.toLowerCase())
  );

  return (
    <>
      <div className="drawer-backdrop" onClick={onClose} />
      <aside className="drawer">
        <header className="drawer__header">
          <div className="drawer__header-top">
            <span className={`swim-card__priority swim-card__priority--${item.priority}`}>
              {item.priority === "none" ? "\u00B7" : item.priority.charAt(0).toUpperCase()}
            </span>
            <span className="drawer__type">{formatType(item.itemType)}</span>
            <span className={`swim-card__signal swim-card__signal--${item.statusSignal}`}>
              {item.statusSignal}
            </span>
            <button className="drawer__close" onClick={onClose}>
              &times;
            </button>
          </div>
          <h2 className="drawer__title">{item.title}</h2>
        </header>

        <div className="drawer__body">
          {/* Summary & Details */}
          {item.summary && (
            <section className="drawer__section">
              <p className="drawer__text">{item.summary}</p>
            </section>
          )}
          {item.details && item.details !== item.summary && (
            <section className="drawer__section">
              <h4 className="drawer__label">Details</h4>
              <p className="drawer__text">{item.details}</p>
            </section>
          )}

          {/* Meta grid */}
          <section className="drawer__section">
            <div className="drawer__meta-grid">
              {item.owner && (
                <div className="drawer__meta-item">
                  <span className="drawer__meta-label">Owner</span>
                  <span className="drawer__meta-value">{item.owner}</span>
                </div>
              )}
              {item.coOwners.length > 0 && (
                <div className="drawer__meta-item">
                  <span className="drawer__meta-label">Co-owners</span>
                  <span className="drawer__meta-value">{item.coOwners.join(", ")}</span>
                </div>
              )}
              {item.dueDate && (
                <div className="drawer__meta-item">
                  <span className="drawer__meta-label">Due</span>
                  <span className="drawer__meta-value">{formatDate(item.dueDate)}</span>
                </div>
              )}
              <div className="drawer__meta-item">
                <span className="drawer__meta-label">Priority</span>
                <span className="drawer__meta-value">{item.priority}</span>
              </div>
              <div className="drawer__meta-item">
                <span className="drawer__meta-label">Category</span>
                <span className="drawer__meta-value">{item.category || "—"}</span>
              </div>
              <div className="drawer__meta-item">
                <span className="drawer__meta-label">Confidence</span>
                <span className="drawer__meta-value">{Math.round(item.confidence * 100)}%</span>
              </div>
              {item.speaker && (
                <div className="drawer__meta-item">
                  <span className="drawer__meta-label">Speaker</span>
                  <span className="drawer__meta-value">{item.speaker}</span>
                </div>
              )}
              <div className="drawer__meta-item">
                <span className="drawer__meta-label">Sensitivity</span>
                <span className="drawer__meta-value">{item.sensitivity}</span>
              </div>
            </div>
          </section>

          {/* Tags */}
          {item.tags.length > 0 && (
            <section className="drawer__section">
              <h4 className="drawer__label">Tags</h4>
              <div className="drawer__tags">
                {item.tags.map((tag) => (
                  <span key={tag} className="swim-card__tag">{tag}</span>
                ))}
              </div>
            </section>
          )}

          {/* Linked items */}
          {linkedItems.length > 0 && (
            <section className="drawer__section">
              <h4 className="drawer__label">Related Items</h4>
              <div className="drawer__links">
                {linkedItems.map(({ relation, other }) => (
                  <div key={relation.id} className="drawer__link">
                    <span className="drawer__link-type">{formatRelation(relation.relationType)}</span>
                    <span className="drawer__link-title">
                      {other ? other.title : "Unknown item"}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Entities */}
          {relatedEntities.length > 0 && (
            <section className="drawer__section">
              <h4 className="drawer__label">Entities</h4>
              <div className="drawer__entities">
                {relatedEntities.map((e) => (
                  <div key={e.id} className="drawer__entity">
                    <span className="drawer__entity-type">{e.entityType}</span>
                    <span className="drawer__entity-name">{e.name}</span>
                    {e.aliases.length > 0 && (
                      <span className="drawer__entity-aliases">({e.aliases.join(", ")})</span>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Evidence */}
          {item.evidence && (
            <section className="drawer__section">
              <h4 className="drawer__label">Evidence</h4>
              <p className="drawer__evidence">{item.evidence}</p>
            </section>
          )}
        </div>
      </aside>
    </>
  );
}

function formatType(value: string): string {
  return value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatRelation(value: string): string {
  return value.replace(/_/g, " ");
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
