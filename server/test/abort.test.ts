import { test } from 'node:test';
import assert from 'node:assert/strict';
import { combineAbortSignals } from '../src/mcp/abort.js';

test('combineAbortSignals forwards session cancellation and disposes listeners safely', () => {
  const operation = new AbortController();
  const session = new AbortController();
  const combined = combineAbortSignals(operation.signal, session.signal);

  session.abort(new Error('session closed'));
  assert.equal(combined.signal.aborted, true);
  assert.match(String((combined.signal.reason as Error).message), /session closed/);
  combined.dispose();
  combined.dispose();
});

test('combineAbortSignals preserves an already-aborted operation reason', () => {
  const operation = new AbortController();
  operation.abort(new Error('killed'));
  const combined = combineAbortSignals(operation.signal, new AbortController().signal);
  assert.equal(combined.signal.aborted, true);
  assert.match(String((combined.signal.reason as Error).message), /killed/);
  combined.dispose();
});
