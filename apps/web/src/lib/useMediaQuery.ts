import { useEffect, useState } from 'react';

/** Live `window.matchMedia` result (false where unavailable, e.g. tests). */
export function useMediaQuery(query: string): boolean {
  const get = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia(query).matches : false);
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);
  return matches;
}

/** Wide, tall viewport: the roster docks as a side column. Below this it becomes a bottom tray. */
export const ROSTER_DOCK_QUERY = '(min-width: 1024px) and (min-height: 501px)';
