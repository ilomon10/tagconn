import type { ReceptionistConversation, ReceptionistMessage } from '@tagconn/shared';

/**
 * A canned conversation shown at `/?demo=1` (no server, so nothing to ask). Mirrors what a real
 * general-scope turn looks like: a user question, a couple of read-only tool calls, and a finished
 * answer — enough to show streaming-complete chips and markdown rendering without wiring up a fake
 * socket.
 */
export const DEMO_CONVERSATION_ID = 'demo-conversation';

export const DEMO_CONVERSATION: ReceptionistConversation = {
  id: DEMO_CONVERSATION_ID,
  title: 'What does tagconn do?',
  scope: 'general',
  messageCount: 2,
  busy: false,
  createdAt: Date.now() - 60_000,
  updatedAt: Date.now() - 55_000,
};

export const DEMO_MESSAGES: ReceptionistMessage[] = [
  {
    id: 'demo-m1',
    conversationId: DEMO_CONVERSATION_ID,
    role: 'user',
    text: 'What is tagconn, in one paragraph?',
    createdAt: Date.now() - 60_000,
  },
  {
    id: 'demo-m2',
    conversationId: DEMO_CONVERSATION_ID,
    role: 'assistant',
    text: [
      'tagconn shows your Claude Code sessions and their subagents as characters in a 2D "Sims-style" office.',
      "It's an **observer**: Claude Code hooks POST events to a local server, which streams state to this",
      "browser over socket.io. There's no Anthropic API key involved here — I'm just reading `README.md` and",
      '`ROADMAP.md` to answer questions like this one.',
    ].join(' '),
    status: 'succeeded',
    tools: [
      { name: 'Read', preview: 'README.md' },
      { name: 'Read', preview: 'ROADMAP.md' },
    ],
    createdAt: Date.now() - 55_000,
  },
];
