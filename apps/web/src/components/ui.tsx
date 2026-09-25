import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'ghost' | 'danger' | 'subtle';
const variants: Record<Variant, string> = {
  primary: 'bg-cozy text-ink-950 hover:brightness-110 font-semibold',
  subtle: 'bg-ink-700 text-ink-100 hover:bg-ink-600',
  ghost: 'text-ink-300 hover:text-ink-100 hover:bg-ink-800',
  danger: 'bg-red-900/60 text-red-100 hover:bg-red-800',
};

export function Button({ variant = 'subtle', className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  return (
    <button
      type="button"
      className={cx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-40', variants[variant], className)}
      {...rest}
    />
  );
}

/** Full width unless the caller sets its own width. */
const width = (className?: string) => (className && /(^|\s)w-/.test(className) ? className : cx('w-full', className));
const field = 'rounded-md border border-ink-600 bg-ink-900 px-2 py-1 text-xs text-ink-100 placeholder:text-ink-400 focus:border-cozy focus:outline-none';

export const Input = ({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) => <input className={cx(field, width(className))} {...rest} />;
export const Select = ({ className, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) => <select className={cx(field, 'pr-6', width(className))} {...rest} />;
export const Textarea = ({ className, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement>) => (
  <textarea className={cx(field, 'w-full font-pixel leading-relaxed', className)} {...rest} />
);

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-ink-100">
      <input type="checkbox" className="size-3.5 accent-[#f5c07a]" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Field({ label, hint, badge, children }: { label: ReactNode; hint?: ReactNode; badge?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="flex items-center gap-2 text-[11px] font-medium tracking-wide text-ink-300">
        {label}
        {badge}
      </span>
      {children}
      {hint && <span className="block text-[10px] text-ink-400">{hint}</span>}
    </label>
  );
}

export function Badge({ children, color, className }: { children: ReactNode; color?: string; className?: string }) {
  return (
    <span
      className={cx('inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium leading-none', className ?? 'bg-ink-700 text-ink-300')}
      style={color ? { backgroundColor: `${color}33`, color } : undefined}
    >
      {children}
    </span>
  );
}

export function Dot({ color, className }: { color: string; className?: string }) {
  return <span className={cx('inline-block size-2.5 shrink-0 rounded-full ring-1 ring-black/40', className)} style={{ backgroundColor: color }} />;
}

export function Panel({ title, actions, children, className }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cx('rounded-lg border border-ink-700 bg-ink-850', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-ink-700 px-3 py-2">
          <h2 className="text-xs font-semibold tracking-wide text-ink-100">{title}</h2>
          <div className="flex items-center gap-1.5">{actions}</div>
        </header>
      )}
      {children}
    </section>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="p-6 text-center text-xs text-ink-400">{children}</div>;
}

export { cx };
