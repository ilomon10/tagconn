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

/** A phone, either way up (portrait is narrow, landscape is short): the party bar collapses to a pill and the status card to one row. */
export const PHONE_QUERY = '(max-width: 639px), (max-height: 500px)';
