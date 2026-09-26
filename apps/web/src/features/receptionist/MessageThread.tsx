import { useEffect, useRef, useState } from 'react';
import type { ReceptionistMessage, ReceptionistToolCall } from '@tagconn/shared';
import { renderMarkdown } from '../../lib/markdown';
import { Button, Textarea, cx } from '../../components/ui';

function ToolChip({ tool }: { tool: ReceptionistToolCall }) {
  return (
    <span className="inline-flex items-center gap-1 rounded bg-ink-800 px-1.5 py-0.5 font-mono text-[10px] text-ink-300" title={tool.preview}>
      {tool.name}
    </span>
  );
}

const STATUS_LABEL: Partial<Record<NonNullable<ReceptionistMessage['status']>, string>> = {
  queued: 'Waiting for a runner…',
  dispatched: 'Starting…',
  running: 'Thinking…',
  failed: 'Failed',
  stopped: 'Stopped',
  timeout: 'Timed out',
  rejected: 'Rejected',
  lost: 'Connection lost',
};

function MessageBubble({ m }: { m: ReceptionistMessage }) {
  const mine = m.role === 'user';
  const busy = m.status && m.status !== 'succeeded' && !m.text;
  return (
    <div className={cx('flex', mine ? 'justify-end' : 'justify-start')}>
      <div className={cx('max-w-[85%] rounded-lg px-3 py-2 text-[13px] leading-relaxed', mine ? 'bg-cozy text-ink-950' : 'bg-ink-800 text-ink-100')}>
        {m.text ? (
          <div className={cx('prose-sm max-w-none', mine ? '[&_a]:text-ink-950' : '[&_a]:text-cozy')}>{renderMarkdown(m.text)}</div>
        ) : busy ? (
          <span className="text-ink-400">{m.status ? (STATUS_LABEL[m.status] ?? 'Working…') : 'Thinking…'}</span>
        ) : (
          <span className="text-ink-400">{STATUS_LABEL[m.status ?? 'failed'] ?? '(no answer)'}</span>
        )}
        {m.tools && m.tools.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {m.tools.map((t, i) => (
              <ToolChip key={i} tool={t} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function MessageThread({
  messages,
  busy,
  disabled,
  disabledReason,
  onSend,
  onStop,
  sendBusy,
  sendError,
}: {
  messages: ReceptionistMessage[];
  /** The conversation has a turn in flight (§4.1: "one turn at a time"). */
  busy: boolean;
  /** Sending is unavailable for a reason other than "busy" (runner offline, not admin, disabled). */
  disabled: boolean;
  disabledReason?: string;
  onSend: (text: string) => void;
  onStop: () => void;
  sendBusy: boolean;
  sendError: string | null;
}) {
  const [text, setText] = useState('');
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages.length, messages[messages.length - 1]?.text]);

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed || busy || disabled || sendBusy) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div ref={scrollRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3">
        {messages.length === 0 && <p className="text-xs text-ink-400">Ask the Receptionist anything — it can only read, never change, anything.</p>}
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} />
        ))}
      </div>
      <div className="border-t border-ink-700 p-2.5">
        {sendError && <p className="mb-1.5 text-[11px] text-red-300">{sendError}</p>}
        {disabled && disabledReason && <p className="mb-1.5 text-[11px] text-amber-300">{disabledReason}</p>}
        <div className="flex items-end gap-2">
          <Textarea
            rows={2}
            className="min-h-0"
            placeholder="Ask a question…"
            value={text}
            disabled={disabled || busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          {busy ? (
            <Button variant="danger" onClick={onStop}>
              Stop
            </Button>
          ) : (
            <Button variant="primary" disabled={disabled || !text.trim() || sendBusy} onClick={send}>
              Send
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
