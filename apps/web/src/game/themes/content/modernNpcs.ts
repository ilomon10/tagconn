import type { NpcContent } from '../types';

/** M13 NPC skins, modern style (docs/design/office-life.md 3.5.2). Short lines (<= 48 chars). */
export const MODERN_NPCS: NpcContent = {
  skins: {
    janitor: { name: 'Janitor', title: 'Night Shift', color: 0x5a8fb0, costume: { robe: 0x4a6a80, hat: 'hardhat', hatColor: 0xe0b020, staff: 'mop' }, jingle: 0, sound: 'mop', lines: [
      'Mind the wet floor.', 'Who spilled coffee again?', 'Nobody thanks the janitor.', 'Sweeping up yesterday\'s bugs.',
    ] },
    courier: { name: 'Courier', title: 'Delivery', color: 0xd08a3a, costume: { robe: 0xb06a2a, hat: 'cap', hatColor: 0xb06a2a, staff: 'parcel' }, jingle: 1, lines: [
      'Package for... somebody!', 'Sign here, please.', 'Special delivery!', 'Fragile. Like the build.',
    ] },
    'plant-waterer': { name: 'Plant Carer', title: 'Green Team', color: 0x5aa05a, costume: { robe: 0x4a8a4a, hat: 'cap', hatColor: 0x3a6a3a, staff: 'watering-can' }, jingle: 2, lines: [
      'Time for a drink, little fern.', 'Photosynthesis is a team effort.', 'Overwatering is a lifestyle.',
    ] },
    guest: { name: 'Guest', title: 'Visitor', color: 0x9a8ac0, costume: { robe: 0x7a6aa8, staff: 'clipboard' }, jingle: 3, lines: [
      'Nice office! Where is the snack bar?', 'I am just here for the demo.', 'Is this the right floor?', 'Hi! I have a meeting. I think.',
    ] },
    police: { name: 'Police', title: 'Officer', color: 0x3a5a9a, costume: { robe: 0x2a4a8a, hat: 'police-cap', hatColor: 0x1a2a5a }, jingle: 0, sound: 'whistle', lines: [
      'Nobody move. Just checking the build.', 'Report of noise. It was the printer.', 'Step away from the vending machine.',
    ] },
    'cia-agent': { name: 'CIA Agent', title: 'Undercover', color: 0x30303a, costume: { robe: 0x20202a, hat: 'fedora', hatColor: 0x15151c, shades: true }, jingle: 1, lines: [
      'Nothing to see here. Move along.', 'I am definitely just a plumber.', 'Your repo is... interesting.', 'This line is secure. Probably.',
    ] },
    'sales-dog': { name: 'Sales Dog', title: 'Account Exec', color: 0xc8955a, creature: 'dog', jingle: 2, sound: 'bark', lines: [
      'Woof! Have you heard of our synergy?', 'Bark! Q4 looks paw-sitive.', 'Woof woof! Let us circle back.',
    ] },
    monster: { name: 'Bug Monster', title: 'Production', color: 0x6aa04a, creature: 'monster', jingle: 3, sound: 'roar', lines: [
      'RAAAWR! Works on my machine!', 'GRAAH! I live in prod now.', 'ROAR! Fear the null pointer!',
    ] },
    'office-cat': { name: 'Office Cat', title: 'Morale', color: 0xd0b890, creature: 'cat', jingle: 0, sound: 'meow', lines: [
      'Meow.', 'Mrrrow. Feed me.', 'Purr... this keyboard is warm.', 'Meow? Sitting on the sofa now.',
    ] },
  },
};
