import type { NpcContent } from '../types';

/** M13 guild NPC skins, one per NpcKind. Every line <= 48 chars. */
export const GUILD_NPCS: NpcContent = {
  skins: {
    janitor: {
      name: 'Broom Goblin', title: 'Sweeper', color: 0x7fa04a, costume: { robe: 0x5a6b34, hat: 'hood', staff: 'mop', trim: 0xb5895a },
      lines: ['Sweep, sweep, mind the gold.', 'Who spilled the potion?', 'Goblins clean, nobody thanks.'], sound: 'mop', jingle: 0,
    },
    courier: {
      name: 'Messenger', title: 'Courier', color: 0xd8a85a, costume: { robe: 0x7a5a2c, hat: 'cap', staff: 'parcel', trim: 0xe8c070 },
      lines: ['Urgent scroll for the Guild Master!', 'Sign here, adventurer.', 'Rain, hail or dragon, I deliver.'], jingle: 1,
    },
    'plant-waterer': {
      name: 'Herbalist', title: 'Gardener', color: 0x5fb87a, costume: { robe: 0x3f7a4a, cloak: 0x2c5a38, hat: 'hood', staff: 'watering-can', trim: 0xa8e0a0 },
      lines: ['Drink up, my darlings.', 'This one blooms by moonlight.', 'Never water the screaming one.'], jingle: 2,
    },
    guest: {
      name: 'Merchant', title: 'Traveller', color: 0xe0a040, costume: { robe: 0x8a4a2c, cloak: 0x5a2c1c, hat: 'fedora', hatColor: 0x5a2c1c, trim: 0xe8c070 },
      lines: ['Rare wares, fair prices!', 'A discount for guild members!', 'Magic beans, only three gold.'], jingle: 3,
    },
    police: {
      name: 'Town Guard', title: 'Watch', color: 0x8aa0c8, costume: { robe: 0x4a5a7a, cloak: 0x2c3a5a, hat: 'helm', hatColor: 0x8a94a6, staff: 'shield', trim: 0xe6ecf5 },
      lines: ['Halt! Guild inspection.', 'Move along, nothing to see.', 'Any dragons on the premises?'], sound: 'whistle', jingle: 1,
    },
    'cia-agent': {
      name: 'Inquisitor', title: 'Secret Order', color: 0x6a6a7a, costume: { robe: 0x22222c, cloak: 0x14141c, hat: 'fedora', hatColor: 0x14141c, staff: 'clipboard', trim: 0x8a8aa0, shades: true },
      lines: ['We are watching, quietly.', 'This scroll never existed.', 'Nobody saw the Inquisitor.'], jingle: 2,
    },
    'sales-dog': {
      name: 'Wolf', title: 'Wild Beast', color: 0x9a9aa8, creature: 'wolf',
      lines: ['Awoo! Buy a bone?', 'Grr... pet me. Please.', 'Woof! Good deals, big teeth.'], sound: 'bark', jingle: 3,
    },
    monster: {
      name: 'Slime', title: 'Dungeon Pest', color: 0x5fd07a, creature: 'slime',
      lines: ['Blorp!', 'Splurt... squish...', 'Glub glub, hungry for loot.'], sound: 'slime', jingle: 0,
    },
    'office-cat': {
      name: 'Familiar', title: 'Guild Cat', color: 0xb98ae0, creature: 'familiar',
      lines: ['Mrrp. Warm hearth, mine now.', 'Purr... a mage left me here.', 'Mew. Fish tribute accepted.'], sound: 'meow', jingle: 1,
    },
  },
};
