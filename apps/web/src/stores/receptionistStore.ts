import { create } from 'zustand';
import type { ReceptionistConversation, ReceptionistMessage } from '@tagconn/shared';
import type { OfficeSocket } from '../lib/socket';

/**
 * Receptionist conversations and messages (W3, docs/design/runner-and-helpdesk.md §4.1). Domain data
 * only — panel open/close and "which conversation is active" UI state lives in
 * `features/receptionist/uiStore.ts` (same split as `stores/heroStore.ts` vs `features/heroes/store.ts`).
 *
 * Not wired into `lib/connection.ts`'s `wireLive()` (unlike `registerHeroEvents`): `receptionist:*`
 * push events only ever reach the admin room, and only matter while the panel is open, so
 * `ReceptionistPanel` registers/unregisters `registerReceptionistEvents` itself on mount/unmount
 * instead of this store's owner (this file) reaching into a module it doesn't own.
 */

function emptyMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

function cloneMap<T>(base: Record<string, T>): Record<string, T> {
  return Object.assign(emptyMap<T>(), base);
}

/** Defensive client-side cap on how many messages one conversation keeps in memory, independent of
 *  the server's own `receptionist.maxMessagesPerConversation` bound (which only prunes storage, not
 *  whatever this store has already accumulated from a long stream of pushes). Generous enough that a
 *  real conversation never hits it in practice. */
export const DEFAULT_MAX_MESSAGES = 500;

export const getConversation = (conversations: Record<string, ReceptionistConversation>, id: string): ReceptionistConversation | undefined =>
  Object.hasOwn(conversations, id) ? conversations[id] : undefined;

export interface ReceptionistState {
  conversations: Record<string, ReceptionistConversation>;
  conversationsLoaded: boolean;
  /** conversationId -> messages, oldest first. */
  messages: Record<string, ReceptionistMessage[]>;

  setConversations(list: ReceptionistConversation[]): void;
  upsertConversation(c: ReceptionistConversation): void;
  removeConversation(id: string): void;
  setMessages(conversationId: string, list: ReceptionistMessage[]): void;
  upsertMessage(m: ReceptionistMessage, max?: number): void;
  /** Resets everything (panel close in demo mode, or leaving the whole feature). */
  clear(): void;
}

export const useReceptionistStore = create<ReceptionistState>()((set) => ({
  conversations: emptyMap(),
  conversationsLoaded: false,
  messages: emptyMap(),

  setConversations: (list) => {
    const conversations = emptyMap<ReceptionistConversation>();
    for (const c of list) conversations[c.id] = c;
    set({ conversations, conversationsLoaded: true });
  },

  upsertConversation: (c) =>
    set((s) => {
      const conversations = cloneMap(s.conversations);
      conversations[c.id] = c;
      return { conversations };
    }),

  removeConversation: (id) =>
    set((s) => {
      const changed = Object.hasOwn(s.conversations, id) || Object.hasOwn(s.messages, id);
      if (!changed) return {};
      const conversations = cloneMap(s.conversations);
      delete conversations[id];
      const messages = cloneMap(s.messages);
      delete messages[id];
      return { conversations, messages };
    }),

  setMessages: (conversationId, list) =>
    set((s) => {
      const messages = cloneMap(s.messages);
      messages[conversationId] = [...list].sort((a, b) => a.createdAt - b.createdAt);
      return { messages };
    }),

  // A turn's assistant message is upserted repeatedly as text streams in (§4.1): same id, growing
  // `text`/`tools`/`status` each time — this replaces it in place rather than appending a duplicate.
  upsertMessage: (m, max = DEFAULT_MAX_MESSAGES) =>
    set((s) => {
      const existing = s.messages[m.conversationId] ?? [];
      const i = existing.findIndex((e) => e.id === m.id);
      let next: ReceptionistMessage[];
      if (i === -1) {
        next = [...existing, m].sort((a, b) => a.createdAt - b.createdAt);
      } else {
        next = [...existing];
        next[i] = m;
      }
      if (next.length > max) next = next.slice(next.length - max);
      const messages = cloneMap(s.messages);
      messages[m.conversationId] = next;
      return { messages };
    }),

  clear: () => set({ conversations: emptyMap(), conversationsLoaded: false, messages: emptyMap() }),
}));

/** Conversations sorted most-recently-updated first, for the conversation list. */
export function conversationList(conversations: Record<string, ReceptionistConversation>): ReceptionistConversation[] {
  return Object.values(conversations).sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Wires the three admin-room push events into this store. NOT called automatically (see the header
 * comment above) — `ReceptionistPanel` calls this on mount and calls the returned cleanup on unmount.
 */
export function registerReceptionistEvents(socket: OfficeSocket): () => void {
  const onConversation = (c: ReceptionistConversation) => useReceptionistStore.getState().upsertConversation(c);
  const onRemoved = (id: string) => useReceptionistStore.getState().removeConversation(id);
  const onMessage = (m: ReceptionistMessage) => useReceptionistStore.getState().upsertMessage(m);
  socket.on('receptionist:conversation', onConversation);
  socket.on('receptionist:conversationRemoved', onRemoved);
  socket.on('receptionist:message', onMessage);
  return () => {
    socket.off('receptionist:conversation', onConversation);
    socket.off('receptionist:conversationRemoved', onRemoved);
    socket.off('receptionist:message', onMessage);
  };
}
