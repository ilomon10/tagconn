import { describe, expect, it } from 'vitest';
import { applyRunEvent, assertProjectDirAllowed, emptyAccumulator, isProjectDirAllowed } from '../receptionist.validate.js';
import { HttpError } from '../../../core/http/index.js';

describe('receptionist.validate: isProjectDirAllowed / assertProjectDirAllowed (pure, realpath-free)', () => {
  it('exact match and a proper subdirectory are allowed', () => {
    expect(isProjectDirAllowed('/home/user/projects/foo', ['/home/user/projects/foo'])).toBe(true);
    expect(isProjectDirAllowed('/home/user/projects/foo/src', ['/home/user/projects/foo'])).toBe(true);
  });

  it('a sibling directory that merely shares a prefix string is NOT allowed (no naive startsWith)', () => {
    expect(isProjectDirAllowed('/home/user/projects/foobar', ['/home/user/projects/foo'])).toBe(false);
  });

  it('a directory outside every allowed root is refused', () => {
    expect(isProjectDirAllowed('/etc/passwd', ['/home/user/projects/foo'])).toBe(false);
    expect(isProjectDirAllowed('/home/user/projects/other', ['/home/user/projects/foo'])).toBe(false);
  });

  it('normalizes trailing slashes and .. segments on both sides before comparing (no fs access)', () => {
    expect(isProjectDirAllowed('/home/user/projects/foo/../foo/src', ['/home/user/projects/foo/'])).toBe(true);
  });

  it('assertProjectDirAllowed throws HttpError(403) when refused, and nothing when allowed', () => {
    expect(() => assertProjectDirAllowed('/etc', ['/home/user/projects'])).toThrow(HttpError);
    expect(() => assertProjectDirAllowed('/etc', ['/home/user/projects'])).toThrow(/outside/i);
    expect(() => assertProjectDirAllowed('/home/user/projects/foo', ['/home/user/projects'])).not.toThrow();
  });
});

describe('receptionist.validate: applyRunEvent (assistant text/tool accumulation)', () => {
  it('appends partial text deltas, and does not double-count the matching non-partial block', () => {
    let acc = emptyAccumulator();
    acc = applyRunEvent(acc, { kind: 'text', partial: true, text: 'Hel' });
    acc = applyRunEvent(acc, { kind: 'text', partial: true, text: 'lo' });
    acc = applyRunEvent(acc, { kind: 'text', partial: false, text: 'Hello' }); // the completed block; deltas already covered it
    expect(acc.text).toBe('Hello');
  });

  it('appends a non-partial block directly when no deltas preceded it (partial messages disabled)', () => {
    let acc = emptyAccumulator();
    acc = applyRunEvent(acc, { kind: 'text', partial: false, text: 'Hi there' });
    expect(acc.text).toBe('Hi there');
  });

  it('collects tool_use calls as {name, preview}', () => {
    let acc = emptyAccumulator();
    acc = applyRunEvent(acc, { kind: 'tool_use', toolUseId: 't1', name: 'Read', inputPreview: 'README.md' });
    expect(acc.tools).toEqual([{ name: 'Read', preview: 'README.md' }]);
  });

  it('a result event with text replaces the accumulated text with the authoritative final answer', () => {
    let acc = emptyAccumulator();
    acc = applyRunEvent(acc, { kind: 'text', partial: true, text: 'draft...' });
    acc = applyRunEvent(acc, { kind: 'result', subtype: 'success', isError: false, text: 'Final answer.' });
    expect(acc.text).toBe('Final answer.');
  });

  it('a result event with no text leaves the accumulated text untouched', () => {
    let acc = emptyAccumulator();
    acc = applyRunEvent(acc, { kind: 'text', partial: true, text: 'kept' });
    acc = applyRunEvent(acc, { kind: 'result', subtype: 'success', isError: false });
    expect(acc.text).toBe('kept');
  });

  it('notice and tool_result events are no-ops on the accumulator', () => {
    const acc = emptyAccumulator();
    expect(applyRunEvent(acc, { kind: 'notice', level: 'info', message: 'hi' })).toEqual(acc);
    expect(applyRunEvent(acc, { kind: 'tool_result', toolUseId: 't1', isError: false, preview: 'ok' })).toEqual(acc);
  });
});
