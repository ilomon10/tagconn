import { beforeEach, describe, expect, it } from 'vitest';
import type { ReceptionistConversation, ReceptionistMessage } from '@tagconn/shared';
import { conversationList, useReceptionistStore } from './receptionistStore';

const conversation = (id: string, over: Partial<ReceptionistConversation> = {}): ReceptionistConversation => ({
  id,
  title: 'New conversation',
  scope: 'general',
  messageCount: 0,
  busy: false,
  createdAt: 1,
  updatedAt: 1,
  ...over,
});

const message = (id: string, conversationId: string, over: Partial<ReceptionistMessage> = {}): ReceptionistMessage => ({
  id,
  conversationId,
  role: 'assistant',
  text: '',
  createdAt: 1,
  ...over,
});

describe('receptionistStore', () => {
  beforeEach(() => {
    useReceptionistStore.getState().clear();
  });

  it('setConversations replaces the whole map, indexed by id', () => {
    useReceptionistStore.getState().setConversations([conversation('c1'), conversation('c2')]);
    expect(Object.keys(useReceptionistStore.getState().conversations).sort()).toEqual(['c1', 'c2']);
    expect(useReceptionistStore.getState().conversationsLoaded).toBe(true);
    useReceptionistStore.getState().setConversations([conversation('c3')]);
    expect(Object.keys(useReceptionistStore.getState().conversations)).toEqual(['c3']);
  });

  it('upsertConversation inserts and replaces by id, reflecting a busy flip', () => {
    useReceptionistStore.getState().upsertConversation(conversation('c1', { busy: false }));
    expect(useReceptionistStore.getState().conversations.c1?.busy).toBe(false);
    useReceptionistStore.getState().upsertConversation(conversation('c1', { busy: true, updatedAt: 2 }));
    expect(useReceptionistStore.getState().conversations.c1?.busy).toBe(true);
    expect(useReceptionistStore.getState().conversations.c1?.updatedAt).toBe(2);
    expect(Object.keys(useReceptionistStore.getState().conversations)).toEqual(['c1']);
  });

  it('removeConversation drops the conversation and its messages, and is a no-op for unknown ids', () => {
    useReceptionistStore.getState().setConversations([conversation('c1'), conversation('c2')]);
    useReceptionistStore.getState().setMessages('c1', [message('m1', 'c1')]);
    useReceptionistStore.getState().removeConversation('c1');
    expect(Object.keys(useReceptionistStore.getState().conversations)).toEqual(['c2']);
    expect(useReceptionistStore.getState().messages.c1).toBeUndefined();
    useReceptionistStore.getState().removeConversation('nope');
    expect(Object.keys(useReceptionistStore.getState().conversations)).toEqual(['c2']);
  });

  it('setMessages stores them sorted by createdAt', () => {
    useReceptionistStore.getState().setMessages('c1', [message('m2', 'c1', { createdAt: 20 }), message('m1', 'c1', { createdAt: 10 })]);
    expect(useReceptionistStore.getState().messages.c1?.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  describe('upsertMessage', () => {
    it('appends a new message keyed by role+run (streaming upsert replaces the same id in place)', () => {
      useReceptionistStore.getState().upsertMessage(message('user-1', 'c1', { role: 'user', text: 'hi', createdAt: 1 }));
      useReceptionistStore.getState().upsertMessage(message('asst-1', 'c1', { role: 'assistant', text: '', status: 'queued', createdAt: 2 }));
      expect(useReceptionistStore.getState().messages.c1?.map((m) => m.id)).toEqual(['user-1', 'asst-1']);

      // The assistant message streams: same id, growing text and a changing status — replaced in
      // place, never duplicated.
      useReceptionistStore.getState().upsertMessage(message('asst-1', 'c1', { role: 'assistant', text: 'Hel', status: 'running', createdAt: 2 }));
      useReceptionistStore
        .getState()
        .upsertMessage(message('asst-1', 'c1', { role: 'assistant', text: 'Hello there', status: 'succeeded', createdAt: 2 }));

      const msgs = useReceptionistStore.getState().messages.c1 ?? [];
      expect(msgs).toHaveLength(2);
      expect(msgs.find((m) => m.id === 'asst-1')?.text).toBe('Hello there');
      expect(msgs.find((m) => m.id === 'asst-1')?.status).toBe('succeeded');
    });

    it('bounds the in-memory list: pushing past `max` drops the oldest, keeping the most recent', () => {
      for (let i = 0; i < 5; i++) {
        useReceptionistStore.getState().upsertMessage(message(`m${i}`, 'c1', { createdAt: i }), 3);
      }
      const msgs = useReceptionistStore.getState().messages.c1 ?? [];
      expect(msgs).toHaveLength(3);
      expect(msgs.map((m) => m.id)).toEqual(['m2', 'm3', 'm4']);
    });

    it('keeps conversations independent of one another', () => {
      useReceptionistStore.getState().upsertMessage(message('a', 'c1'));
      useReceptionistStore.getState().upsertMessage(message('b', 'c2'));
      expect(useReceptionistStore.getState().messages.c1?.map((m) => m.id)).toEqual(['a']);
      expect(useReceptionistStore.getState().messages.c2?.map((m) => m.id)).toEqual(['b']);
    });
  });

  it('conversationList sorts most-recently-updated first', () => {
    useReceptionistStore.getState().setConversations([conversation('c1', { updatedAt: 1 }), conversation('c2', { updatedAt: 5 }), conversation('c3', { updatedAt: 3 })]);
    expect(conversationList(useReceptionistStore.getState().conversations).map((c) => c.id)).toEqual(['c2', 'c3', 'c1']);
  });
});
