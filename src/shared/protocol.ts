/**
 * Shared protocol types — single source of truth for the CLI and the UI.
 * Keep this file dependency-free (imported by both Node and browser bundles).
 */

/** JSON payload Claude Code writes to the hook's stdin. */
export interface HookPayload {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  hook_event_name?: string
  tool_name?: string
  tool_input?: {
    plan?: string
    /** Newest versions (v2.1.221+) pass the plan file location directly. */
    planFilePath?: string
    allowedPrompts?: unknown
  }
}

/** Result of locating the plan content for this review. */
export type ResolvedPlan =
  | { source: 'file'; path: string; markdown: string }
  | { source: 'inline'; markdown: string }
  | { source: 'none' }

export interface ReviewMeta {
  planPath: string | null
  cwd: string
  sessionId: string
}

/** GET /api/review response. */
export interface ReviewPayload {
  plan: string
  meta: ReviewMeta
}

/** One annotation as serialized by the UI at decision time. */
export interface AnnotationOut {
  /** Live doc.textBetween(from, to), or createdExcerpt if orphaned. */
  excerpt: string
  comment: string
  orphaned: boolean
}

/**
 * Permission mode the session switches to after an approval, mirroring the
 * native plan-approval dialog's choices. Undefined = leave the session as is.
 */
export type ApprovalPermissionMode = 'auto' | 'acceptEdits' | 'default'

export const APPROVAL_PERMISSION_MODES: readonly ApprovalPermissionMode[] = [
  'auto',
  'acceptEdits',
  'default',
]

/** POST /api/decision request body. */
export interface DecisionRequest {
  action: 'approve' | 'request-changes'
  /** Present only when the content differs from the post-parse baseline. */
  editedMarkdown?: string
  annotations: AnnotationOut[]
  overallFeedback: string
  /** Approve only: post-approval permission mode; omit to keep the current. */
  permissionMode?: ApprovalPermissionMode
}

/**
 * Hook stdout envelopes.
 *
 * Caveat: documentation is ambiguous about (a) deny nesting and (b) whether
 * additionalContext is top-level or inside hookSpecificOutput. These types encode
 * our best reading; all construction lives in cli/feedback.ts so an empirical
 * correction (milestone M2) is a one-line change.
 */
export interface HookAllowOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest'
    decision: {
      behavior: 'allow'
      /**
       * Echo of tool_input (with `plan` swapped for the edited markdown when
       * the user edited). Claude Code >= 2.1.199 silently drops an allow for
       * ExitPlanMode when updatedInput is absent and falls back to the
       * built-in approval dialog.
       */
      updatedInput: Record<string, unknown>
      updatedPermissions?: Array<{
        type: 'setMode'
        mode: ApprovalPermissionMode
        destination: 'session'
      }>
    }
  }
  additionalContext?: string
}

export interface HookDenyOutput {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest'
    decision: { behavior: 'deny'; message: string }
  }
}

export type HookOutput = HookAllowOutput | HookDenyOutput

/** Header carrying the single-use review token on every /api request. */
export const TOKEN_HEADER = 'x-milkplan-token'

/** Token used by the Vite dev middleware when no #token= fragment is present. */
export const DEV_TOKEN = 'dev-token'
