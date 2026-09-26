import type { RunEventEnvelope } from '@tagconn/shared';
import { renderMarkdown } from '../../lib/markdown';
import { Badge, cx } from '../../components/ui';
import { sumRunUsage } from './usage';

/**
 * Live transcript (docs/design/runner-and-helpdesk.md section 3: "the live transcript (text, tool
 * chips, collapsed results)"). Every `assistant`/`result` text run goes through `renderMarkdown`
 * (§3 "Markdown"): the model's output is untrusted, so nothing here uses `dangerouslySetInnerHTML`.
 */
export function Transcript({ events }: { events: RunEventEnvelope[] }) {
  if (events.length === 0) return <p className="text-xs text-ink-400">No events yet.</p>;
  return (
    <ol className="space-y-2">
      {events.map((e) => (
        <li key={e.seq}>
          <TranscriptLine env={e} />
        </li>
      ))}
    </ol>
  );
}

function TranscriptLine({ env }: { env: RunEventEnvelope }) {
  const { event } = env;
  switch (event.kind) {
    case 'init':
      return (
        <p className="text-[11px] text-ink-500">
          Session started — model {event.model ?? '?'}, {event.tools.length} tool{event.tools.length === 1 ? '' : 's'} available.
        </p>
      );
    case 'text':
      return (
        <div className={cx('rounded-md border border-ink-700 bg-ink-800 px-3 py-2 text-xs text-ink-100', event.partial && 'opacity-70')}>
          {renderMarkdown(event.text)}
        </div>
      );
    case 'tool_use':
      return (
        <div className="flex items-start gap-2 text-[11px] text-ink-300">
          <Badge className="bg-sky-900/60 text-sky-200">{event.name}</Badge>
          <span className="truncate font-pixel">{event.inputPreview}</span>
        </div>
      );
    case 'tool_result':
      return (
        <div className={cx('rounded border px-2 py-1 text-[11px]', event.isError ? 'border-red-800 bg-red-950/30 text-red-200' : 'border-ink-700 bg-ink-850 text-ink-400')}>
          <span className="font-pixel">{event.preview}</span>
        </div>
      );
    case 'result':
      return (
        <div className={cx('rounded-md border px-3 py-2 text-xs', event.isError ? 'border-red-800 bg-red-950/30 text-red-100' : 'border-emerald-800 bg-emerald-950/30 text-emerald-100')}>
          <p className="mb-1 font-semibold">{event.subtype}</p>
          {event.text && <div className="mb-1">{renderMarkdown(event.text)}</div>}
          <div className="flex flex-wrap gap-2 text-[10px] opacity-80">
            {event.durationMs !== undefined && <span>{(event.durationMs / 1000).toFixed(1)}s</span>}
            {event.numTurns !== undefined && <span>{event.numTurns} turns</span>}
            {event.costUsd !== undefined && <span>${event.costUsd.toFixed(3)}</span>}
            {event.usage && <span>{sumRunUsage(event.usage)} tok</span>}
          </div>
        </div>
      );
    case 'notice': {
      const tone = event.level === 'error' ? 'text-red-300' : event.level === 'warn' ? 'text-amber-300' : 'text-ink-500';
      return <p className={cx('text-[11px]', tone)}>⚠ {event.message}</p>;
    }
    default:
      return null;
  }
}
