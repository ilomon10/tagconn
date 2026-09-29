import { describe, expect, it } from 'vitest';
import type { LogLine, ServiceStatus } from '@tagconn/shared';
import { filterLogs, initialState, lightFor, MAX_LOG_LINES, reducer, visibleServices, idsToStop, activeIn } from './state';

const svc = (over: Partial<ServiceStatus> = {}): ServiceStatus => ({ id: 'server', state: 'running', since: 1, restarts: 0, ...over });
const line = (ts: number, service: LogLine['service'] = 'server'): LogLine => ({ service, ts, stream: 'stdout', line: `l${ts}` });

describe('reducer', () => {
  it('sets services and applies service.changed notifications', () => {
    let s = reducer(initialState, { type: 'services/set', services: [svc(), svc({ id: 'runner', state: 'stopped' })] });
    expect(s.services.runner?.state).toBe('stopped');
    s = reducer(s, { type: 'notify', payload: { method: 'service.changed', params: svc({ state: 'crashed', lastError: 'x' }) } });
    expect(s.services.server).toMatchObject({ state: 'crashed', lastError: 'x' });
  });

  it('appends log.line and caps the buffer', () => {
    let s = initialState;
    for (let i = 0; i < MAX_LOG_LINES + 5; i++) s = reducer(s, { type: 'notify', payload: { method: 'log.line', params: line(i) } });
    expect(s.logs).toHaveLength(MAX_LOG_LINES);
    expect(s.logs[0]?.ts).toBe(5);
  });

  it('ignores malformed or unknown notifications', () => {
    expect(reducer(initialState, { type: 'notify', payload: { method: 'log.line', params: { bad: 1 } } })).toBe(initialState);
    expect(reducer(initialState, { type: 'notify', payload: { method: 'other' } })).toBe(initialState);
    expect(reducer(initialState, { type: 'notify', payload: null })).toBe(initialState);
  });

  it('keeps live lines newer than the loaded tail', () => {
    const live = reducer(initialState, { type: 'notify', payload: { method: 'log.line', params: line(10) } });
    const s = reducer(live, { type: 'logs/set', lines: [line(1), line(5)] });
    expect(s.logs.map((l) => l.ts)).toEqual([1, 5, 10]);
  });

  it('tracks sidecar down/up', () => {
    const down = reducer(initialState, { type: 'sidecar/down', reason: 'exit 1', logs: ['a'] });
    expect(down.sidecarDown?.reason).toBe('exit 1');
    expect(reducer(down, { type: 'sidecar/up' }).sidecarDown).toBeNull();
  });
});

describe('helpers', () => {
  it('filters logs per service', () => {
    const ls = [line(1, 'server'), line(2, 'runner'), line(3, 'supervisor')];
    expect(filterLogs(ls, 'all')).toHaveLength(3);
    expect(filterLogs(ls, 'runner').map((l) => l.ts)).toEqual([2]);
  });
  it('maps states to lights', () => {
    expect(lightFor('running')).toBe('green');
    expect(lightFor('starting')).toBe('amber');
    expect(lightFor('crashed')).toBe('red');
    expect(lightFor('stopped')).toBe('grey');
    expect(lightFor('unavailable')).toBe('striped');
    expect(lightFor(undefined)).toBe('grey');
  });
  it('lists docker only in docker mode', () => {
    expect(visibleServices('native')).toEqual(['server', 'runner']);
    expect(visibleServices('docker')).toEqual(['docker', 'runner']);
  });
});

describe('stop sets', () => {
  it('stops every live service regardless of run mode', () => {
    const services = { server: svc(), docker: svc({ id: 'docker', state: 'stopped' }), runner: svc({ id: 'runner', state: 'crashed' }) };
    expect(idsToStop(services)).toEqual(['server', 'runner']);
    expect(idsToStop({ docker: svc({ id: 'docker' }) })).toContain('docker');
    expect(idsToStop({ docker: svc({ id: 'docker', state: 'unavailable' }) })).not.toContain('docker');
  });

  it('finds the active services of the mode being left', () => {
    const services = { server: svc(), runner: svc({ id: 'runner', state: 'stopped' }) };
    expect(activeIn('native', services)).toEqual(['server']);
    expect(activeIn('docker', services)).toEqual([]);
  });
});
