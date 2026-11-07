import { randomUUID } from 'node:crypto';
import type { RptCursor } from '../rpt/rptReader.js';

/**
 * MCP 클라이언트 종류. cli 는 명령 하나를 처리하고 끝나는 짧은 세션이다.
 * 데몬은 cli 세션을 따로 세고 더 빨리 치운다.
 */
export type SessionTransport = 'relay' | 'remote-http' | 'standalone' | 'cli';

/**
 * Mutable state that belongs to one MCP client session. Shared game/runtime
 * services must never be closed when this context is aborted.
 */
export interface SessionContext {
  id: string;
  shortId: string;
  transport: SessionTransport;
  connectedAt: number;
  lastActivityAt: number;
  lastExecCursor: RptCursor | null;
  abortController: AbortController;
}

export interface SessionSummary {
  id: string;
  shortId: string;
  transport: SessionTransport;
  connectedAt: number;
  lastActivityAt: number;
}

export interface SessionSnapshot {
  total: number;
  byTransport: Record<SessionTransport, number>;
  sessions: SessionSummary[];
}

export interface SessionsView {
  snapshot(): SessionSnapshot;
}

export function createSessionContext(
  transport: SessionTransport,
  id = randomUUID(),
  now = Date.now(),
): SessionContext {
  return {
    id,
    shortId: id.replaceAll('-', '').slice(0, 8),
    transport,
    connectedAt: now,
    lastActivityAt: now,
    lastExecCursor: null,
    abortController: new AbortController(),
  };
}

export function summarizeSession(session: SessionContext): SessionSummary {
  return {
    id: session.id,
    shortId: session.shortId,
    transport: session.transport,
    connectedAt: session.connectedAt,
    lastActivityAt: session.lastActivityAt,
  };
}
