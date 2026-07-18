/**
 * Collects the files a turn's executor actually wrote and edits them into a
 * one-glance "N files changed, +X -Y" summary. This is a client seam (like the
 * Approver, the RunMirror, and the EvalLog): the writes land on the user's
 * machine through the WorkspaceToolHost whichever engine drives the loop, so
 * the tracker stays client-side and keeps working unchanged when a remote
 * engine is added.
 *
 * The tracker is a shared singleton handed to the ToolHost, but the summary is
 * per turn, so each turn opens a session - exactly like the ChatApprover. A
 * reported write is attributed to the most recently opened session; with a
 * shared ToolHost a call cannot be tied back to a specific request, so under
 * concurrent turns this is best-effort (the same documented limitation the
 * approver carries), which is fine for a stats line.
 */
import { lineDiff } from '../tools/diff';
import { ChangeReporter } from '../tools/types';

/** One file's net change over a turn: the first `before` seen and the latest `after`. */
interface TrackedFile {
  before: string;
  after: string;
}

/** The rolled-up change counts for a turn. */
export interface ChangeSummary {
  /** Files whose net change is non-empty (a rewrite back to identical is dropped). */
  files: number;
  added: number;
  removed: number;
}

/**
 * A turn's open collection handle: writes reported while it is the newest open
 * session land here. `summary()` folds them with `lineDiff`; `dispose()` ends
 * the session (idempotent).
 */
export interface ChangeSession {
  summary(): ChangeSummary;
  dispose(): void;
}

export class ChangeTracker implements ChangeReporter {
  /** Open sessions in open order; a report goes to the last (newest) one. */
  private readonly sessions: Array<{ id: number; files: Map<string, TrackedFile> }> = [];
  private nextSessionId = 0;

  /**
   * Begin collecting changes for a turn. Dispose the returned handle when the
   * turn ends (it is idempotent). While this is the newest open session, every
   * `report` lands in it.
   */
  openSession(): ChangeSession {
    const id = this.nextSessionId++;
    const files = new Map<string, TrackedFile>();
    this.sessions.push({ id, files });
    return {
      summary: () => this.summarize(files),
      dispose: () => {
        const index = this.sessions.findIndex((session) => session.id === id);
        if (index !== -1) {
          this.sessions.splice(index, 1);
        }
      },
    };
  }

  /**
   * Record a landed write. Keeps the first `before` and the latest `after` per
   * path, so a file written then edited in the same turn nets out to one entry
   * with the right delta rather than being double-counted.
   */
  report(path: string, before: string, after: string): void {
    const session = this.sessions[this.sessions.length - 1];
    if (!session) {
      // A write with no open change session (nothing is summing it): drop it.
      return;
    }
    const existing = session.files.get(path);
    if (existing) {
      existing.after = after;
    } else {
      session.files.set(path, { before, after });
    }
  }

  private summarize(files: Map<string, TrackedFile>): ChangeSummary {
    const summary: ChangeSummary = { files: 0, added: 0, removed: 0 };
    for (const { before, after } of files.values()) {
      const delta = lineDiff(before, after);
      if (delta.added === 0 && delta.removed === 0) {
        continue;
      }
      summary.files++;
      summary.added += delta.added;
      summary.removed += delta.removed;
    }
    return summary;
  }
}
