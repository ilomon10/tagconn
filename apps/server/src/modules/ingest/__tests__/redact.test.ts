import { describe, expect, it } from 'vitest';
import { redactPayload } from '../redact.js';

const base = { session_id: 's1', hook_event_name: 'Notification', tool_use_id: 'tu1', agent_id: 'a1' };

describe('redactPayload', () => {
  it('never touches structural id fields', () => {
    const out = redactPayload({ ...base, message: 'hi' }, []);
    expect(out.session_id).toBe('s1');
    expect(out.tool_use_id).toBe('tu1');
    expect(out.agent_id).toBe('a1');
    expect(out.hook_event_name).toBe('Notification');
  });

  it('redacts a bearer token inside a Notification message', () => {
    const out = redactPayload({ ...base, message: 'your token is Bearer abc.def-token_123' }, []);
    expect(out.message).not.toContain('abc.def-token_123');
    expect(out.message).toContain('[redacted]');
  });

  it('redacts secrets hidden in an unknown passthrough key (z.looseObject)', () => {
    const out = redactPayload({ ...base, some_unknown_field: 'aws key AKIAABCDEFGHIJKLMNOP inline' }, []);
    expect(out.some_unknown_field).not.toContain('AKIAABCDEFGHIJKLMNOP');
  });

  it('redacts AWS keys, PEM blocks, JWTs, URL credentials, and mysql -p passwords', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIBogIBAAJ...\n-----END RSA PRIVATE KEY-----';
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const out = redactPayload(
      {
        ...base,
        message: `key AKIAABCDEFGHIJKLMNOP, url postgres://user:hunter2@host/db, jwt ${jwt}, cmd mysql -phunter2, pem below\n${pem}`,
      },
      [],
    );
    const msg = out.message as string;
    expect(msg).not.toContain('AKIAABCDEFGHIJKLMNOP');
    expect(msg).not.toContain('hunter2');
    expect(msg).toContain('postgres://user:[redacted]@host/db');
    expect(msg).not.toContain(jwt);
    expect(msg).not.toContain('MIIBogIBAAJ');
  });

  it('caps an oversized leaf string before scanning', () => {
    const huge = 'a'.repeat(70_000);
    const out = redactPayload({ ...base, message: huge }, []);
    const msg = out.message as string;
    expect(msg.length).toBeLessThan(70_000);
    expect(msg).toContain('…[truncated]');
  });

  it('still applies user-configured settings.ingest.redactPatterns', () => {
    const out = redactPayload({ ...base, message: 'classified-999' }, ['classified-\\d+']);
    expect(out.message).toBe('[redacted]');
  });
});
