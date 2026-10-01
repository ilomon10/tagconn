import type { LifeContent } from '../types';

/** M13 office life, modern style (docs/design/office-life.md 3.2.7). Short lines (<= 48 chars). */
export const MODERN_LIFE: LifeContent = {
  activities: [
    { id: 'coffee-chat', requires: ['coffee-machine', 'counter'], cast: [2, 3], weight: 3, durationSec: [8, 14], pose: 'sip', emote: 'mug', lines: [
      'Is this the fourth cup or the fifth?',
      'The machine and I have an understanding.',
      'Decaf is just brown water with hope.',
      'Fresh pot, fresh bugs.',
    ] },
    { id: 'water-cooler-gossip', requires: ['water-cooler'], cast: [2, 3], weight: 3, durationSec: [8, 14], pose: 'chat', lines: [
      'Did you hear about the refactor?',
      'Which one? There are three.',
      'Standup ran forty minutes again.',
      'Rumor has it prod is "fine".',
    ] },
    { id: 'arcade', requires: ['arcade'], cast: [1, 2], weight: 2, durationSec: [8, 16], pose: 'play', emote: 'gamepad', lines: [
      'One more level, then back to work.',
      'New high score! Do not tell the PM.',
      'The boss fight is easier than code review.',
      'Insert coin to continue the sprint.',
    ] },
    { id: 'ping-pong', requires: ['ping-pong'], cast: [2, 2], weight: 2, durationSec: [8, 16], pose: 'play', emote: 'paddle', lines: [
      'Best of three? Loser fixes the flaky test.',
      'Spin serve!',
      'That was clearly out.',
      'Match point. No pressure.',
    ] },
    { id: 'foosball', requires: ['foosball'], cast: [2, 4], weight: 2, durationSec: [8, 16], pose: 'play', emote: 'ball', lines: [
      'Goal! Pay up.',
      'Spin the rods, not the facts!',
      'Defense wins tickets.',
      'Who unplugged my striker?',
    ] },
    { id: 'board-game', requires: ['board-game-table'], cast: [2, 4], weight: 2, durationSec: [10, 18], pose: 'play', emote: 'dice', lines: [
      'Roll for initiative.',
      'You cannot trade the longest road.',
      'The rulebook says otherwise.',
      'Just one more turn, I promise.',
    ] },
    { id: 'stretch', requires: [], cast: [1, 1], weight: 2, durationSec: [5, 8], pose: 'stretch', emote: 'spark', lines: [
      'Stretch break. Spine is deprecated.',
      'Ten squats, then one more ticket.',
      'My back sounds like a keyboard.',
    ] },
    { id: 'phone-call', requires: [], cast: [1, 1], weight: 2, durationSec: [6, 10], pose: 'phone', emote: 'phone', lines: [
      'Yes, this could have been an email.',
      'Can you hear me now? Hello?',
      'I will circle back on that.',
      'You are on mute. Still on mute.',
    ] },
    { id: 'water-a-plant', requires: ['plant'], cast: [1, 1], weight: 1, durationSec: [5, 8], pose: 'water', emote: 'can', lines: [
      'Grow, little fern, grow.',
      'You are the only one who listens.',
      'Photosynthesis looks so relaxing.',
    ] },
    { id: 'sofa-nap', requires: ['sofa'], cast: [1, 1], weight: 1, durationSec: [8, 14], pose: 'nap', emote: 'zz', lines: [
      'Just resting my eyes...',
      'Wake me when the build is green.',
      'Five minutes. Maybe ten.',
    ] },
    { id: 'whiteboard-doodle', requires: ['board'], cast: [1, 1], weight: 1, durationSec: [6, 10], pose: 'doodle', emote: 'pencil', lines: [
      'Boxes and arrows. Pure architecture.',
      'Is that a database or a cloud?',
      'It makes sense on the whiteboard.',
    ] },
  ],
  kickoff: {
    invite: ['Kickoff in the meeting room!', 'Team, kickoff time. Bring coffee.', 'Gather round, new project incoming!'],
    fetch: ['Hey, kickoff is starting!', 'We are waiting on you.', 'Join us, the slides are loaded.'],
    dawdle: ['Coming! One sec.', 'Just finishing this line.', 'On my way, I swear.'],
    talk: ['Goals: ship it. Scope: yes.', 'Who owns the risky part?', 'Let us timebox this.', 'I have a question about scope.'],
    close: ['Great, go build it!', 'Notes will follow. Probably.', 'Meeting adjourned. Back to it!'],
  },
  standup: {
    invite: ['Standup in the meeting room!', 'Quick standup, five minutes. Promise.', 'Standup time, everyone up!'],
    fetch: ['Standup is starting!', 'Hey, we are doing standup.', 'Come on, you are up first.'],
    dawdle: ['Be right there!', 'Saving my work.', 'Mute me, I am coming.'],
    talk: ['Yesterday: tests. Today: more tests.', 'No blockers. Only vibes.', 'Blocked on review, as always.', 'Same as yesterday, but better.'],
    close: ['Thanks all, go ship!', 'Short and sweet. Nice.', 'Standup done. Coffee next?'],
  },
};
