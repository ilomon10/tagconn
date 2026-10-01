import type { LifeContent } from '../types';

/** M13 guild idle life: tavern games, hearth naps and war councils. Every line <= 48 chars, pronoun-free. */
export const GUILD_LIFE: LifeContent = {
  activities: [
    {
      id: 'ale-at-the-bar', requires: ['coffee-machine', 'counter'], cast: [2, 3], weight: 3, durationSec: [12, 20],
      pose: 'sip', emote: 'mug',
      lines: ['One more ale, barkeep!', 'To the guild! Cheers!', 'This brew has a kick.', 'Put it on the guild tab.', 'Foam on the quest board again...'],
    },
    {
      id: 'well-gossip', requires: ['water-cooler'], cast: [2, 3], weight: 2, durationSec: [10, 18],
      pose: 'chat', emote: 'laugh',
      lines: ['Heard the dragon is just a big lizard.', 'The Archmage lost that hat again.', 'Rumour has it there is cake.', 'Whispers say the vault hums at night.', 'No spoilers, but the boss has three heads.'],
    },
    {
      id: 'darts', requires: ['arcade'], cast: [1, 2], weight: 3, durationSec: [12, 20],
      pose: 'play', emote: 'gamepad',
      lines: ['Bullseye! Pay up!', 'Aim for the goblin.', 'The wind took that one.', 'Double or nothing!', 'Steady hand, steady heart.'],
    },
    {
      id: 'arm-wrestling', requires: ['ping-pong'], cast: [2, 2], weight: 2, durationSec: [8, 14],
      pose: 'play', emote: 'paddle',
      lines: ['Show me that forge-arm!', 'Table is shaking, hold on!', 'Nngh... almost had it.', 'Best of three, no magic!', 'The crowd goes wild!'],
    },
    {
      id: 'dice', requires: ['foosball'], cast: [2, 4], weight: 3, durationSec: [12, 20],
      pose: 'play', emote: 'dice',
      lines: ['Snake eyes! Lucky night.', 'Roll for initiative!', 'The dice are loaded, surely.', 'Come on, seven!', 'Gold on the table, friends.'],
    },
    {
      id: 'cards', requires: ['board-game-table'], cast: [2, 4], weight: 2, durationSec: [14, 22],
      pose: 'play', emote: 'chess',
      lines: ['I call your bluff.', 'Three knights beat your pair.', 'Deal me in.', 'That card was up your sleeve.', 'The bard is cheating again.'],
    },
    {
      id: 'stretch', requires: [], cast: [1, 1], weight: 2, durationSec: [6, 10],
      pose: 'stretch',
      lines: ['Ah, these old bones...', 'Too long hunched over runes.', 'Stretch before the next quest.', 'Cracks like a dungeon door.'],
    },
    {
      id: 'sending-stone-call', requires: [], cast: [1, 1], weight: 2, durationSec: [8, 14],
      pose: 'phone', emote: 'phone',
      lines: ['Sending stone, do you read me?', 'Yes, the scroll arrived.', 'Tell the king we are busy.', 'Bad signal in the vault...'],
    },
    {
      id: 'tend-herbs', requires: ['plant'], cast: [1, 1], weight: 2, durationSec: [8, 14],
      pose: 'water', emote: 'can',
      lines: ['Grow, little mandrake.', 'Moonpetal needs more water.', 'Not that herb, that one bites.', 'Fine crop this season.'],
    },
    {
      id: 'hearth-nap', requires: ['sofa'], cast: [1, 1], weight: 2, durationSec: [12, 20],
      pose: 'nap', emote: 'zz',
      lines: ['Just a short rest...', 'Wake me at the next quest.', 'Zzz... dragons... zzz...', 'The hearth is so warm.'],
    },
    {
      id: 'rune-doodle', requires: ['board'], cast: [1, 1], weight: 2, durationSec: [8, 14],
      pose: 'doodle', emote: 'pencil',
      lines: ['This rune looks promising.', 'A map to nowhere, sketched.', 'Draw a dragon, add flames.', 'Wait, that glyph is upside down.'],
    },
  ],
  kickoff: {
    invite: ['War council in the great hall!', 'Gather round, a quest begins!', 'To the council table, all!'],
    fetch: ['Come along, the council awaits!', 'Sound the horn, someone is missing!', 'Leave the ale, quest time!'],
    dawdle: ['Coming, just one more sip!', 'Hold your horses, I am sharpening!', 'Be right there, polishing my staff.'],
    talk: ['We strike at dawn.', 'The map says north.', 'Who brings the healing potions?', 'Mind the traps in the dungeon.', 'Our party needs a plan.', 'Splitting up is never wise.'],
    close: ['Council adjourned. For glory!', 'To your posts, adventurers!', 'May fortune favour the guild!'],
  },
  standup: {
    invite: ['Morning muster at the table!', 'Roll call, adventurers!', 'Quick council before the quests!'],
    fetch: ['Muster time, hurry up!', 'The bell has rung, friend!', 'Everyone is waiting on you!'],
    dawdle: ['One moment, finishing a spell.', 'Coming, my boots are untied!', 'Almost done with this scroll.'],
    talk: ['Yesterday I slew a bug.', 'Today I brew more potions.', 'Blocked by a locked door.', 'Scrolls are nearly done.', 'Nothing to report, all quiet.', 'I need a hand with a rune.'],
    close: ['Muster over. Onward!', 'Back to the quests, all!', 'Dismissed, brave ones!'],
  },
};
