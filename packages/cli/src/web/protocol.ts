/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wire protocol between the CLI's web server and the browser client.
 *
 * The server pushes `ServerEvent`s down the socket and reads `ClientRequest`s
 * back. Both directions are plain JSON so the client can be a single-file
 * bundle with no protocol library.
 */

/** A tool call as it is reported to the browser. */
export interface WebToolCall {
  callId: string;
  name: string;
  /** Short human-readable label, e.g. "Read file". */
  title: string;
  /** Tool arguments, already JSON-safe. */
  args: Record<string, unknown>;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled';
  /** The tool's kind, used to pick an icon in the client. */
  kind?: string;
  /** How long the call took, in milliseconds, once it has finished. */
  durationMs?: number;
}

/** A confirmation the agent is waiting on before continuing. */
export interface WebConfirmationRequest {
  id: string;
  title: string;
  /** The full prompt text to show the user. */
  details: string;
  /** The choices the user may pick, e.g. ['Yes', 'No', 'Always allow']. */
  options: string[];
  /** The tool call this confirmation belongs to, when there is one. */
  callId?: string;
}

/**
 * A dialog the terminal would open with Ink, rendered natively in the
 * browser instead.
 */
export type WebDialogKind =
  | 'settings'
  | 'model'
  | 'theme'
  | 'auth'
  | 'editor'
  | 'privacy'
  | 'permissions'
  | 'sessionBrowser'
  | 'voice-model'
  | 'agentConfig';

/** A dialog pushed to the browser. */
export interface WebDialog {
  kind: WebDialogKind;
  title: string;
  /** The options to choose from, for the pick-one dialogs. */
  options?: Array<{ label: string; value: string; description?: string }>;
  /** The extra payload the dialog needs, e.g. an agent definition. */
  props?: Record<string, unknown>;
}

/** Token accounting for the current turn. */
export interface WebUsage {
  input: number;
  output: number;
  cached: number;
  thought: number;
  total: number;
  limit?: number;
}

/** A model the user may switch to. */
export interface WebModel {
  id: string;
  label: string;
}

/** A slash command the user may run, with its description. */
export interface WebCommand {
  name: string;
  description: string;
  /** True for the built-in commands; false for user/workspace/extension ones. */
  builtIn: boolean;
}

/** A tool the agent may call. */
export interface WebTool {
  name: string;
  description: string;
}

/**
 * A file the user attached to a message.
 *
 * The browser sends the content inline, because the agent runs on the same
 * machine as the browser and the model accepts inline data.
 */
export interface WebAttachment {
  /** The file's name, shown to the model and to the user. */
  name: string;
  /** The file's MIME type. */
  mimeType: string;
  /** The file's size in bytes. */
  size: number;
  /**
   * The content, base64 encoded. Only images carry their bytes; other
   * files are referenced by path instead, so a large document is not
   * copied through the socket.
   */
  data?: string;
  /** The absolute path of a file that already lives on disk. */
  path?: string;
  /** A folder the user attached, rather than a single file. */
  kind?: 'file' | 'folder';
  /** How many files a folder holds. */
  fileCount?: number;
}

/** A file the agent wrote, offered to the browser as a preview. */
export interface WebGeneratedFile {
  /** The file's name, e.g. "reports/q3.pdf". */
  name: string;
  /** The absolute path on disk. */
  path: string;
  /** What kind of document it is. */
  kind: 'pdf' | 'document' | 'presentation' | 'spreadsheet' | 'other';
  /** Whether the server can turn it into something the browser shows. */
  previewable: boolean;
}

/** Events pushed from the server to the browser. */
export type ServerEvent =
  | {
      type: 'session_started';
      sessionId: string;
      cwd: string;
      model: string;
      models: WebModel[];
      commands: WebCommand[];
      tools: WebTool[];
      /** The current approval mode, e.g. 'default' or 'yolo'. */
      approvalMode: string;
    }
  | {
      type: 'user_message';
      text: string;
      timestamp: number;
      /** The files that came with the message. */
      attachments?: WebAttachment[];
    }
  | { type: 'agent_message'; text: string; streaming: boolean }
  | { type: 'agent_thought'; text: string }
  | { type: 'tool_call'; toolCall: WebToolCall }
  | {
      type: 'tool_progress';
      callId: string;
      /** The output so far, for a tool that is still running. */
      output: string;
      /** A short note about what the tool is doing. */
      message?: string;
    }
  | {
      type: 'tool_output';
      callId: string;
      output: string;
      truncated: boolean;
      kind?: 'diff';
    }
  | {
      /** A document the agent wrote, ready to preview or open. */
      type: 'file_created';
      file: WebGeneratedFile;
    }
  | { type: 'confirmation_request'; request: WebConfirmationRequest }
  | { type: 'confirmation_resolved'; id: string; confirmed: boolean }
  | { type: 'dialog'; dialog: WebDialog }
  | { type: 'dialog_closed' }
  | { type: 'command_result'; text: string; isError: boolean }
  | { type: 'history_item'; item: unknown }
  | { type: 'usage'; usage: WebUsage }
  | { type: 'turn_started' }
  | { type: 'turn_ended'; cancelled: boolean }
  | { type: 'settings_changed' }
  | {
      /** The approval mode changed, possibly from the browser itself. */
      type: 'approval_mode';
      mode: string;
    }
  | { type: 'error'; message: string; stack?: string }
  | { type: 'info'; message: string };

/** Requests sent from the browser to the server. */
export type ClientRequest =
  | {
      type: 'prompt';
      text: string;
      /** The files the user attached to this message. */
      attachments?: WebAttachment[];
    }
  | { type: 'cancel' }
  | { type: 'command'; text: string }
  | { type: 'confirmation_response'; id: string; confirmed: boolean }
  | {
      type: 'set_setting';
      scope: 'User' | 'Workspace';
      key: string;
      value: unknown;
    }
  | { type: 'list_settings' }
  | { type: 'set_model'; model: string }
  | {
      /**
       * How much the agent may do without asking: 'default' asks, 'auto_edit'
       * edits files on its own, 'yolo' does anything.
       */
      type: 'set_approval_mode';
      mode: string;
    }
  | { type: 'dialog_choice'; kind: string; value: string }
  | { type: 'dialog_closed' }
  | { type: 'new_session' }
  | { type: 'list_sessions' }
  | { type: 'resume_session'; sessionId: string };

/** The shape returned for `list_settings`. */
export interface WebSettingsEntry {
  key: string;
  label: string;
  description: string;
  category: string;
  type: string;
  default: unknown;
  /** The effective value, after merging every scope. */
  value: unknown;
  /** Which scope the effective value came from, or 'default'. */
  source: string;
  /** The allowed values, for enum settings. */
  options?: ReadonlyArray<{ label: string; value: string | number }>;
  requiresRestart: boolean;
}

/** The shape returned for `list_sessions`. */
export interface WebSessionSummary {
  id: string;
  /** Human-readable timestamp, already formatted for display. */
  timestamp: string;
  /** The first user message of the session, trimmed for display. */
  summary: string;
}
