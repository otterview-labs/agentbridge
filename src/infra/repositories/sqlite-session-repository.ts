import type { Logger } from 'pino';

import type { AgentType } from '../../domain/agent.js';
import type { SessionRecord, SessionStatus } from '../../domain/session.js';
import type {
  CreateSessionRecordInput,
  SessionRepository,
} from './session-repository.js';
import { DatabaseClient } from '../storage/database.js';

type SessionRow = {
  agent_type: AgentType;
  created_at: string;
  default_for_actor: number;
  id: number;
  last_active_at: string;
  last_output_digest: string | null;
  name: string;
  owner_actor_id: string | null;
  status: SessionStatus;
  tmux_session_name: string;
  tmux_window_name: string;
  updated_at: string;
  workspace_path: string;
};

export class SqliteSessionRepository implements SessionRepository {
  constructor(
    private readonly database: DatabaseClient,
    private readonly logger: Logger,
  ) {}

  async clearDefaultForActor(actorId: string): Promise<void> {
    this.database
      .prepare(
        `
        UPDATE codex_sessions
        SET default_for_actor = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE owner_actor_id = ?
        `,
      )
      .run(actorId);
  }

  async create(input: CreateSessionRecordInput): Promise<SessionRecord> {
    const statement = this.database.prepare(
      `
      INSERT INTO codex_sessions (
        name,
        agent_type,
        workspace_path,
        tmux_session_name,
        tmux_window_name,
        status,
        owner_actor_id,
        default_for_actor,
        last_output_digest
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
      `,
    );
    const row = statement.get(
      input.name,
      input.agentType,
      input.workspacePath,
      input.tmuxSessionName,
      input.tmuxWindowName,
      input.status,
      input.ownerActorId,
      input.defaultForActor ? 1 : 0,
      input.lastOutputDigest,
    ) as SessionRow;

    this.logger.debug({ name: input.name }, 'session created');
    return mapRow(row);
  }

  async findAll(): Promise<SessionRecord[]> {
    const rows = this.database
      .prepare(
        `
        SELECT *
        FROM codex_sessions
        ORDER BY datetime(updated_at) DESC, id DESC
        `,
      )
      .all() as SessionRow[];

    return rows.map(mapRow);
  }

  async findByName(name: string): Promise<SessionRecord | null> {
    const row = this.database
      .prepare(
        `
        SELECT *
        FROM codex_sessions
        WHERE name = ?
        LIMIT 1
        `,
      )
      .get(name) as SessionRow | undefined;

    return row ? mapRow(row) : null;
  }

  async findCurrentForActor(actorId: string): Promise<SessionRecord | null> {
    const row = this.database
      .prepare(
        `
        SELECT *
        FROM codex_sessions
        WHERE owner_actor_id = ?
          AND default_for_actor = 1
        LIMIT 1
        `,
      )
      .get(actorId) as SessionRow | undefined;

    return row ? mapRow(row) : null;
  }

  async rename(id: number, newName: string, tmuxWindowName: string): Promise<void> {
    this.database
      .prepare(
        `
        UPDATE codex_sessions
        SET name = ?,
            tmux_window_name = ?,
            updated_at = CURRENT_TIMESTAMP,
            last_active_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
      )
      .run(newName, tmuxWindowName, id);
  }

  async setDefaultForActor(id: number, actorId: string): Promise<void> {
    this.database
      .prepare(
        `
        UPDATE codex_sessions
        SET owner_actor_id = ?,
            default_for_actor = 1,
            updated_at = CURRENT_TIMESTAMP,
            last_active_at = CURRENT_TIMESTAMP
        WHERE id = ?
        `,
      )
      .run(actorId, id);
  }

  async updateDigest(id: number, digest: string | null): Promise<void> {
    this.database
      .prepare(
        `
        UPDATE codex_sessions
        SET last_output_digest = ?,
            updated_at = CURRENT_TIMESTAMP,
            last_active_at = CURRENT_TIMESTAMP
        WHERE id = ? AND last_output_digest IS NOT ?
        `,
      )
      .run(digest, id, digest);
  }

  async updateStatus(id: number, status: SessionStatus): Promise<void> {
    this.database
      .prepare(
        `
        UPDATE codex_sessions
        SET status = ?,
            updated_at = CURRENT_TIMESTAMP,
            last_active_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status != ?
        `,
      )
      .run(status, id, status);
  }
}

function mapRow(row: SessionRow): SessionRecord {
  return {
    agentType: row.agent_type,
    createdAt: row.created_at,
    defaultForActor: row.default_for_actor === 1,
    id: row.id,
    lastActiveAt: row.last_active_at,
    lastOutputDigest: row.last_output_digest,
    name: row.name,
    ownerActorId: row.owner_actor_id,
    status: row.status,
    tmuxSessionName: row.tmux_session_name,
    tmuxWindowName: row.tmux_window_name,
    updatedAt: row.updated_at,
    workspacePath: row.workspace_path,
  };
}
