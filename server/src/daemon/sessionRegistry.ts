import type {
  SessionContext,
  SessionSnapshot,
  SessionsView,
  SessionTransport,
} from '../mcp/session.js';
import { summarizeSession } from '../mcp/session.js';

const TRANSPORTS: SessionTransport[] = ['relay', 'remote-http', 'standalone', 'cli'];

/**
 * Process-wide, read-only-facing registry used by status tools and the daemon.
 * Transport and McpServer ownership stays in the daemon; this class only owns
 * the client-visible session contexts.
 */
export class SessionRegistry implements SessionsView {
  private readonly sessions = new Map<string, SessionContext>();

  add(session: SessionContext): void {
    if (this.sessions.has(session.id)) {
      throw new Error(`MCP session already exists: ${session.id}`);
    }
    this.sessions.set(session.id, session);
  }

  get(id: string): SessionContext | undefined {
    return this.sessions.get(id);
  }

  remove(id: string): SessionContext | undefined {
    const session = this.sessions.get(id);
    if (session) this.sessions.delete(id);
    return session;
  }

  touch(id: string, now = Date.now()): void {
    const session = this.sessions.get(id);
    if (session) session.lastActivityAt = now;
  }

  size(): number {
    return this.sessions.size;
  }

  values(): IterableIterator<SessionContext> {
    return this.sessions.values();
  }

  snapshot(): SessionSnapshot {
    const byTransport: Record<SessionTransport, number> = {
      relay: 0,
      'remote-http': 0,
      standalone: 0,
      cli: 0,
    };
    const sessions = [...this.sessions.values()]
      .map((session) => summarizeSession(session))
      .sort((a, b) => a.connectedAt - b.connectedAt);
    for (const session of sessions) {
      if (TRANSPORTS.includes(session.transport)) byTransport[session.transport] += 1;
    }
    return { total: sessions.length, byTransport, sessions };
  }
}
