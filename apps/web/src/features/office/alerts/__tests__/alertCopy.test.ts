import { describe, expect, it } from 'vitest';
import { alertCopy } from '../alertCopy';
import type { AlertItem } from '../types';

const item = (kind: AlertItem['kind'], ids: string[], toolName?: string): AlertItem => ({ id: 'x', kind, agentIds: ids, createdAt: 0, shownAt: null, ...(toolName ? { toolName } : {}) });

describe('alertCopy', () => {
  it('single alerts', () => {
    expect(alertCopy(item('ask', ['a']), 'guild', ['Mira'])).toEqual({ icon: '❓', title: 'Mira asks for you' });
    expect(alertCopy(item('failure', ['a'], 'Bash'), 'modern', ['Mira']).title).toBe('Mira stumbled: Bash failed');
    expect(alertCopy(item('done', ['a']), 'guild', ['Mira'], 'ship it')).toEqual({ icon: '⚔', title: 'Quest complete!', body: 'Mira: ship it' });
    expect(alertCopy(item('done', ['a']), 'guild', ['Mira']).body).toBe('Mira');
  });
  it('coalesced alerts use the style crew word', () => {
    const ids = ['a', 'b', 'c'];
    expect(alertCopy(item('ask', ids), 'modern', []).title).toBe('3 teammates need you');
    expect(alertCopy(item('ask', ids), 'guild', []).title).toBe('3 heroes need you');
    expect(alertCopy(item('ask', ids), 'rift', []).title).toBe('3 crew need you');
  });
  it('clips and sanitizes untrusted text', () => {
    const long = 'x'.repeat(500);
    const body = alertCopy(item('done', ['a']), 'guild', ['Mira'], long).body!;
    expect(Array.from(body).length).toBeLessThanOrEqual(6 + 140);
    expect(body.endsWith('…')).toBe(true);
    const t = alertCopy(item('failure', ['a'], long), 'modern', ['Mira']).title;
    expect(Array.from(t).length).toBeLessThan(80);
    expect(alertCopy(item('ask', ['a']), 'modern', ['Mi\u202Era\n']).title).toBe('Mi ra asks for you');
  });
  it('coalesced failures do not name a tool', () => {
    expect(alertCopy(item('failure', ['a', 'b'], 'Bash'), 'modern', []).title).toBe('2 teammates stumbled');
  });
});

describe('alertCopy encounters', () => {
  const enc = (name: string): AlertItem => ({
    ...item('encounter', ['encounter:n1']),
    encounter: { npcId: 'n1', kind: 'monster', name, style: 'modern', projectId: 'p', at: 0 },
  });
  it('titles per style', () => {
    expect(alertCopy(enc('Slime'), 'modern', []).title).toBe('A wild Slime appeared!');
    expect(alertCopy(enc('Slime'), 'guild', []).title).toBe('A wild Slime blocks the hall!');
    expect(alertCopy(enc('Slime'), 'rift', []).title).toBe('Hostile Slime detected!');
    expect(alertCopy(enc('Slime'), 'rift', []).body).toBeTruthy();
  });
  it('clips a hostile name', () => {
    expect(alertCopy(enc('x'.repeat(500)), 'modern', []).title.length).toBeLessThan(80);
  });
});
