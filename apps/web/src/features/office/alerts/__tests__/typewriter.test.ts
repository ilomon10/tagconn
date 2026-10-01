import { describe, expect, it } from 'vitest';
import { typewriterDone, typewriterText } from '../typewriter';

describe('typewriter', () => {
  it('reveals by elapsed time', () => {
    expect(typewriterText(Array.from('hello'), 0, 30, false)).toBe('');
    expect(typewriterText(Array.from('hello world'), 100, 30, false)).toBe('hel');
    expect(typewriterText(Array.from('hi'), 10_000, 30, false)).toBe('hi');
    expect(typewriterDone(Array.from('hello'), 100, 30, false)).toBe(false);
    expect(typewriterDone(Array.from('hello'), 200, 30, false)).toBe(true);
  });
  it('reduced shows everything', () => {
    expect(typewriterText(Array.from('hello'), 0, 30, true)).toBe('hello');
    expect(typewriterDone(Array.from('hello'), 0, 30, true)).toBe(true);
  });
  it('does not split emoji', () => {
    expect(typewriterText(Array.from('💥ab'), 40, 30, false)).toBe('💥');
    expect(typewriterText(Array.from('💥ab'), 70, 30, false)).toBe('💥a');
  });
  it('negative elapsed is empty', () => {
    expect(typewriterText(Array.from('abc'), -5, 30, false)).toBe('');
  });
});
