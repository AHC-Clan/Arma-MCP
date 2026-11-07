import type { ExecRequestContext } from '../exec/execManager.js';
import type { RptCursor } from '../rpt/rptReader.js';
import type { Deps } from './deps.js';

/**
 * Build the private execution metadata shared by public and internal SQF calls.
 * Internal calls should leave `onRptCursor` omitted so they do not replace the
 * user's last `arma_exec` cursor.
 * `signal` defaults to the session signal. Tool handlers pass the session signal
 * combined with the request signal so that a cancelled call stops its exec.
 */
export function makeSessionExecContext(
  deps: Pick<Deps, 'rptSources' | 'session'>,
  onRptCursor: (cursor: RptCursor | null) => void = () => {},
  signal: AbortSignal = deps.session.abortController.signal,
): ExecRequestContext {
  const rptScope = deps.rptSources.resolve('auto');
  return {
    sessionId: deps.session.id,
    sessionShortId: deps.session.shortId,
    signal,
    onRptCursor,
    rptDir: rptScope.dir,
    rptRe: rptScope.re,
    rptSource: rptScope.source,
  };
}
