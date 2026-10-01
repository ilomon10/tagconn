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
});
