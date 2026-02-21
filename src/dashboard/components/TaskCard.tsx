import type { MeetingItem } from "../types";

interface TaskCardProps {
  item: MeetingItem;
  relationCount: number;
  onClick?: () => void;
}

export function TaskCard({ item, relationCount, onClick }: TaskCardProps) {
  return (
    <div className={`swim-card swim-card--${item.statusSignal}`} onClick={onClick}>
      <div className="swim-card__top">
        <span className={`swim-card__priority swim-card__priority--${item.priority}`}>
          {item.priority === "none" ? "\u00B7" : item.priority.charAt(0).toUpperCase()}
        </span>
        <span className="swim-card__type">{formatType(item.itemType)}</span>
        {item.statusSignal !== "new" && (
          <span className={`swim-card__signal swim-card__signal--${item.statusSignal}`}>
            {item.statusSignal}
          </span>
        )}
      </div>

      <div className="swim-card__title">{item.title}</div>

      {item.summary && (
        <div className="swim-card__summary">{item.summary}</div>
      )}

      <div className="swim-card__footer">
        {item.owner && <span className="swim-card__owner">{item.owner}</span>}
        {item.dueDate && <span className="swim-card__due">{formatDate(item.dueDate)}</span>}
        {relationCount > 0 && (
          <span className="swim-card__links">{relationCount} link{relationCount !== 1 ? "s" : ""}</span>
        )}
      </div>

      {item.tags.length > 0 && (
        <div className="swim-card__tags">
          {item.tags.slice(0, 3).map((tag) => (
            <span key={tag} className="swim-card__tag">{tag}</span>
          ))}
          {item.tags.length > 3 && (
            <span className="swim-card__tag swim-card__tag--more">+{item.tags.length - 3}</span>
          )}
        </div>
      )}
    </div>
  );
}

function formatType(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}
