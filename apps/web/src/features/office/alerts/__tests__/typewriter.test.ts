import { describe, expect, it } from 'vitest';
import { typewriterDone, typewriterText } from '../typewriter';

describe('typewriter', () => {
  it('reveals by elapsed time', () => {
    expect(typewriterText('hello', 0, 30, false)).toBe('');
    expect(typewriterText('hello world', 100, 30, false)).toBe('hel');
    expect(typewriterText('hi', 10_000, 30, false)).toBe('hi');
    expect(typewriterDone('hello', 100, 30, false)).toBe(false);
    expect(typewriterDone('hello', 200, 30, false)).toBe(true);
  });
  it('reduced shows everything', () => {
    expect(typewriterText('hello', 0, 30, true)).toBe('hello');
    expect(typewriterDone('hello', 0, 30, true)).toBe(true);
  });
  it('does not split emoji', () => {
    expect(typewriterText('💥ab', 40, 30, false)).toBe('💥');
    expect(typewriterText('💥ab', 70, 30, false)).toBe('💥a');
  });
  it('negative elapsed is empty', () => {
    expect(typewriterText('abc', -5, 30, false)).toBe('');
  });
});
