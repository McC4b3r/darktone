import type { ReactNode } from "react";

interface EmptyStateProps {
  title: string;
  body: string;
  action?: ReactNode;
}

export function EmptyState({ title, body, action }: EmptyStateProps) {
  return (
    <section className="empty-state">
      <p className="eyebrow">Library</p>
      <h2>{title}</h2>
      <p>{body}</p>
      {action}
    </section>
  );
}
