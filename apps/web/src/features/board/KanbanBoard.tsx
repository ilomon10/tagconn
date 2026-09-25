import { useMemo } from 'react';
import type { Task, TaskStatus } from '@tagconn/shared';
import { useFloorTasks, useNow, useRoleLookup } from '../../lib/hooks';
import { elapsed } from '../../lib/format';
import { useOfficeStore } from '../../stores/officeStore';
import { Badge, Dot, cx } from '../../components/ui';

const COLUMNS: { id: TaskStatus; label: string; accent: string }[] = [
  { id: 'todo', label: 'To do', accent: 'border-t-ink-400' },
  { id: 'doing', label: 'Doing', accent: 'border-t-sky-400' },
  { id: 'review', label: 'Review', accent: 'border-t-fuchsia-400' },
  { id: 'done', label: 'Done', accent: 'border-t-emerald-400' },
  { id: 'failed', label: 'Failed', accent: 'border-t-red-500' },
];

function TaskCard({ task, now }: { task: Task; now: number }) {
  const lookup = useRoleLookup();
  const assignee = useOfficeStore((s) => (task.assigneeAgentId ? s.agents[task.assigneeAgentId] : undefined));
  const role = lookup(task.role ?? assignee?.role);
  return (
    <li className="rounded-md border border-ink-700 bg-ink-800 p-2.5 shadow-sm">
      <p className="text-xs leading-snug text-ink-100">{task.title}</p>
      <div className="mt-2 flex items-center gap-1.5 text-[10px] text-ink-400">
        {(task.role || assignee) && (
          <>
            <Dot color={role.color} className="size-2" />
            <span className="truncate">{role.title}</span>
          </>
        )}
        <Badge className="bg-ink-700 text-ink-400">{task.source}</Badge>
        <span className="ml-auto shrink-0 font-pixel">{elapsed(task.createdAt, now)}</span>
      </div>
    </li>
  );
}

export function KanbanBoard() {
  const tasks = useFloorTasks();
  const now = useNow(5000);
  const byStatus = useMemo(() => {
    const m = new Map<TaskStatus, Task[]>(COLUMNS.map((c) => [c.id, []]));
    for (const t of tasks) m.get(t.status)?.push(t);
    for (const list of m.values()) list.sort((a, b) => b.updatedAt - a.updatedAt);
    return m;
  }, [tasks]);

  return (
    <div className="grid h-full grid-cols-5 gap-3 overflow-x-auto p-4">
      {COLUMNS.map((c) => {
        const list = byStatus.get(c.id) ?? [];
        return (
          <section key={c.id} className={cx('flex min-h-0 min-w-44 flex-col rounded-lg border border-t-2 border-ink-700 bg-ink-850', c.accent)}>
            <header className="flex items-center justify-between px-3 py-2">
              <h2 className="text-xs font-semibold">{c.label}</h2>
              <span className="rounded bg-ink-700 px-1.5 text-[10px] text-ink-300">{list.length}</span>
            </header>
            <ul className="min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
              {list.map((t) => (
                <TaskCard key={t.id} task={t} now={now} />
              ))}
              {list.length === 0 && <li className="py-6 text-center text-[11px] text-ink-400">—</li>}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
