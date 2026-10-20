/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ClientRequest,
  ServerEvent,
  WebAttachment,
  WebCommand,
  WebConfirmationRequest,
  WebDialog,
  WebGeneratedFile,
  WebModel,
  WebSessionSummary,
  WebTool,
  WebToolCall,
  WebUsage,
} from '../protocol.js';
import { renderMarkdown } from './markdown.js';
import {
  MAX_ATTACHMENT_SIZE,
  formatSize,
  shouldAutoExpand,
} from './display.js';

/** One entry in the transcript. */
type Entry =
  | { kind: 'user'; id: string; text: string; attachments?: WebAttachment[] }
  | { kind: 'agent'; id: string; text: string; streaming: boolean }
  | {
      /**
       * The model's reasoning. It stays where it happened in the
       * transcript and fills itself in as the reasoning arrives.
       */
      kind: 'thought';
      id: string;
      text: string;
      /** Whether the reasoning is still being written. */
      live: boolean;
    }
  | {
      kind: 'tool';
      id: string;
      call: WebToolCall;
      output?: string;
      truncated?: boolean;
      outputKind?: 'diff';
    }
  | {
      /** A document the agent wrote, offered for preview. */
      kind: 'file';
      id: string;
      file: WebGeneratedFile;
    }
  | { kind: 'notice'; id: string; text: string; isError: boolean };

/**
 * A file the user picked, before it is sent.
 *
 * An image is kept in the browser as a data URL so it can be previewed
 * and sent inline; any other file is uploaded to the server, which stores
 * it on disk and hands back its path.
 */
interface PendingAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** A preview of an image, as a data URL. */
  preview?: string;
  /** The uploaded file, once the server has it. */
  uploaded?: WebAttachment;
  /** Set while the file is being uploaded. */
  uploading?: boolean;
  /** Why the file could not be attached. */
  failed?: string;
  /** How many files a folder holds. */
  fileCount?: number;
}

let counter = 0;
const nextId = () => `entry-${++counter}`;

/** How many files a folder may hold before it is refused. */
const MAX_FOLDER_FILES = 200;

/** Reads a file as a data URL. */
function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/** Whether the server answered an upload with an attachment. */
function isAttachment(value: unknown): value is WebAttachment {
  return (
    typeof value === 'object' &&
    value !== null &&
    'name' in value &&
    typeof value.name === 'string' &&
    'path' in value &&
    typeof value.path === 'string'
  );
}

/**
 * Copies a table so a spreadsheet can take it.
 *
 * Spreadsheets understand a block of tab-separated rows, and richer
 * targets understand the table's own markup, so both go on the clipboard
 * when the browser allows it.
 */
/**
 * Copies text the old way, for when the clipboard API refuses.
 *
 * The modern API needs the document to be focused and the permission to
 * be granted; a click on a page normally has both, but not always (an
 * embedded frame, a browser that is strict about it). A hidden textarea
 * and the old copy command still work there.
 */
function copyWithTextarea(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.top = '-1000px';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  }
  area.remove();
  return copied;
}

/** Puts text on the clipboard, whichever way works. */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    if (copyWithTextarea(text)) {
      return;
    }
    throw new Error('The clipboard refused the copy.');
  }
}

async function copyTable(table: HTMLTableElement): Promise<void> {
  const rows = [...table.rows].map((row) =>
    [...row.cells]
      .map((cell) => (cell.innerText ?? '').replace(/\s+/g, ' ').trim())
      .join('\t'),
  );
  const tsv = rows.join('\n');
  const rich = table.outerHTML;

  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/plain': new Blob([tsv], { type: 'text/plain' }),
          'text/html': new Blob([rich], { type: 'text/html' }),
        }),
      ]);
      return;
    } catch {
      // Fall back to plain text below.
    }
  }
  await copyText(tsv);
}

const App: React.FC = () => {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [usage, setUsage] = useState<WebUsage | undefined>();
  const [commands, setCommands] = useState<WebCommand[]>([]);
  const [models, setModels] = useState<WebModel[]>([]);
  const [tools, setTools] = useState<WebTool[]>([]);
  const toolCount = tools.length;
  const [session, setSession] = useState<
    { id: string; cwd: string } | undefined
  >();
  const [pending, setPending] = useState<WebConfirmationRequest | undefined>();
  const [panel, setPanel] = useState<
    'none' | 'settings' | 'sessions' | 'commands' | 'dialog'
  >('none');
  const [sessions, setSessions] = useState<WebSessionSummary[]>([]);
  const [dialog, setDialog] = useState<WebDialog | undefined>(undefined);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [approvalMode, setApprovalMode] = useState('default');
  const [error, setError] = useState<string | undefined>();
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [dragging, setDragging] = useState(false);

  const socketRef = useRef<WebSocket | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  // Whether a turn is running, readable from the callbacks that cannot
  // depend on it.
  const busyRef = useRef(false);
  busyRef.current = busy;

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

  // The copy buttons inside code blocks are plain HTML in the rendered
  // markdown, so they are wired up here rather than by React.
  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }
    const onClick = (event: Event) => {
      const target = event.target;
      if (!(target instanceof HTMLElement)) {
        return;
      }
      const button = target.closest('.code-copy, .table-copy');
      if (!(button instanceof HTMLButtonElement)) {
        return;
      }
      const done = (copied: boolean) => {
        const label = button.dataset['label'] ?? button.textContent ?? 'Copy';
        button.dataset['label'] = label;
        button.textContent = copied ? 'Copied' : 'Copy failed';
        button.classList.toggle('copied', copied);
        setTimeout(() => {
          button.textContent = label;
          button.classList.remove('copied');
        }, 1500);
      };

      // Which button it is says what to copy. Looking for a `code` element
      // inside the container is not enough: a table's cells often hold
      // inline code, and that is not what the reader asked for.
      if (button.classList.contains('table-copy')) {
        const table = button.closest('.table-wrap')?.querySelector('table');
        if (table instanceof HTMLTableElement) {
          void copyTable(table)
            .then(() => done(true))
            .catch(() => done(false));
        }
        return;
      }

      const code = button.closest('pre')?.querySelector('code');
      if (code?.textContent) {
        void copyText(code.textContent)
          .then(() => done(true))
          .catch(() => done(false));
      }
    };
    node.addEventListener('click', onClick);
    return () => node.removeEventListener('click', onClick);
  }, [entries]);

  useEffect(() => {
    const socket = new WebSocket(`ws://${location.host}/ws`);
    socketRef.current = socket;

    socket.onmessage = (event) => {
      let serverEvent: ServerEvent;
      try {
        const parsed: unknown = JSON.parse(String(event.data));
        if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
          return;
        }
        // The shape is checked per case below.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        serverEvent = parsed as ServerEvent;
      } catch {
        return;
      }
      handleServerEvent(serverEvent);
    };
    socket.onclose = () => {
      // The turn cannot finish if the connection is gone, so the spinner
      // stops rather than spinning forever.
      setBusy(false);
      setError('The connection to the CLI was closed.');
    };
    return () => {
      socket.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleServerEvent = useCallback((event: ServerEvent) => {
    switch (event.type) {
      case 'session_started':
        setSession({ id: event.sessionId, cwd: event.cwd });
        setCommands(event.commands);
        setModels(event.models);
        setTools(event.tools);
        setApprovalMode(event.approvalMode);
        setUsage(undefined);
        break;
      case 'approval_mode':
        setApprovalMode(event.mode);
        break;
      case 'sessions':
        setSessions(event.sessions);
        break;
      case 'session_resumed':
        // A loaded session replaces the transcript: it is the conversation
        // the agent now remembers.
        setEntries(
          event.messages.map((message) =>
            message.role === 'user'
              ? { kind: 'user', id: nextId(), text: message.text }
              : {
                  kind: 'agent',
                  id: nextId(),
                  text: message.text,
                  streaming: false,
                },
          ),
        );
        setUsage(undefined);
        setBusy(false);
        setPanel('none');
        break;
      case 'user_message':
        setEntries((prev) => [
          ...prev,
          {
            kind: 'user',
            id: nextId(),
            text: event.text,
            attachments: event.attachments,
          },
        ]);
        break;
      case 'agent_message':
        setEntries((prev) => {
          const last = prev[prev.length - 1];
          if (last && last.kind === 'agent' && last.streaming) {
            // The server sends the whole message each time, so replace it.
            const merged = {
              ...last,
              text: event.text,
              streaming: event.streaming,
            };
            return [...prev.slice(0, -1), merged];
          }
          return [
            ...prev,
            {
              kind: 'agent',
              id: nextId(),
              text: event.text,
              streaming: event.streaming,
            },
          ];
        });
        break;
      case 'agent_thought':
        // The reasoning fills one entry in place, the way the terminal
        // shows it, rather than a new block per chunk.
        setEntries((prev) => {
          const index = prev.findIndex(
            (entry) => entry.kind === 'thought' && entry.live,
          );
          if (index < 0) {
            return [
              ...prev,
              {
                kind: 'thought',
                id: nextId(),
                text: event.text,
                live: true,
              },
            ];
          }
          const existing = prev[index];
          if (existing.kind !== 'thought') {
            return prev;
          }
          const updated: Entry = {
            ...existing,
            text: existing.text
              ? `${existing.text}\n${event.text}`
              : event.text,
          };
          return [...prev.slice(0, index), updated, ...prev.slice(index + 1)];
        });
        break;
      case 'tool_call':
        setEntries((prev) => {
          const index = prev.findIndex(
            (entry) =>
              entry.kind === 'tool' &&
              entry.call.callId === event.toolCall.callId,
          );
          const toolEntry: Entry = {
            kind: 'tool',
            id: nextId(),
            call: event.toolCall,
          };
          if (index >= 0) {
            const existing = prev[index];
            if (existing.kind === 'tool') {
              // The entry keeps its id, so React does not remount it and
              // the box does not lose whether it was opened.
              toolEntry.id = existing.id;
              toolEntry.output = existing.output;
              toolEntry.truncated = existing.truncated;
              toolEntry.outputKind = existing.outputKind;
            }
            return [
              ...prev.slice(0, index),
              toolEntry,
              ...prev.slice(index + 1),
            ];
          }
          return [...prev, toolEntry];
        });
        break;
      case 'tool_progress':
        // The output of a tool that is still running; it replaces what is
        // shown so far, so the box reads as one live stream.
        setEntries((prev) =>
          prev.map((entry) =>
            entry.kind === 'tool' && entry.call.callId === event.callId
              ? { ...entry, output: event.output }
              : entry,
          ),
        );
        break;
      case 'file_created':
        setEntries((prev) => {
          const index = prev.findIndex(
            (entry) =>
              entry.kind === 'file' && entry.file.path === event.file.path,
          );
          if (index >= 0) {
            const existing = prev[index];
            const updated: Entry = {
              kind: 'file',
              id: existing.id,
              file: event.file,
            };
            return [...prev.slice(0, index), updated, ...prev.slice(index + 1)];
          }
          return [...prev, { kind: 'file', id: nextId(), file: event.file }];
        });
        break;
      case 'tool_output':
        setEntries((prev) =>
          prev.map((entry) =>
            entry.kind === 'tool' && entry.call.callId === event.callId
              ? {
                  ...entry,
                  output: event.output,
                  truncated: event.truncated,
                  outputKind: event.kind,
                }
              : entry,
          ),
        );
        break;
      case 'confirmation_request':
        setPending(event.request);
        break;
      case 'confirmation_resolved':
        setPending(undefined);
        break;
      case 'command_result':
        setEntries((prev) => [
          ...prev,
          {
            kind: 'notice',
            id: nextId(),
            text: event.text,
            isError: event.isError,
          },
        ]);
        break;
      case 'history_item': {
        // Commands report their output as history items; show them.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
        const item = event.item as { type?: string; text?: string } | undefined;
        if (item?.text) {
          const notice: Entry = {
            kind: 'notice',
            id: nextId(),
            text: item.text,
            isError: item.type === 'error',
          };
          setEntries((prev) => [...prev, notice]);
        }
        break;
      }
      case 'dialog':
        setDialog(event.dialog);
        setPanel('dialog');
        break;
      case 'dialog_closed':
        setDialog(undefined);
        setPanel((current) => (current === 'dialog' ? 'none' : current));
        break;
      case 'usage':
        setUsage(event.usage);
        break;
      case 'turn_started':
        setBusy(true);
        break;
      case 'turn_ended':
        setBusy(false);
        // Nothing is running any more, so a tool that was still going was
        // cut short: its clock stops and it says so, instead of counting
        // up forever as if it were still working.
        setEntries((prev) =>
          prev.map((entry) => {
            if (
              entry.kind === 'tool' &&
              (entry.call.status === 'executing' ||
                entry.call.status === 'pending')
            ) {
              return {
                ...entry,
                call: { ...entry.call, status: 'cancelled' },
              };
            }
            if (entry.kind === 'thought' && entry.live) {
              return { ...entry, live: false };
            }
            return entry;
          }),
        );
        break;
      case 'settings_changed':
        break;
      case 'error':
        setError(event.message);
        break;
      case 'info':
        setEntries((prev) => [
          ...prev,
          { kind: 'notice', id: nextId(), text: event.message, isError: false },
        ]);
        break;
      default:
        break;
    }
  }, []);

  // Keep the transcript pinned to the bottom as it grows.
  useEffect(() => {
    const node = transcriptRef.current;
    if (node) {
      node.scrollTop = node.scrollHeight;
    }
  }, [entries]);

  // Whether the reasoning is on screen, which replaces the waiting dots.
  const hasLiveThought = entries.some(
    (entry) => entry.kind === 'thought' && entry.live,
  );

  // How long the turn has been running, so a slow answer can be told apart
  // from a stuck one.
  const turnElapsed = useElapsed(busy);

  const send = useCallback((request: ClientRequest) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(request));
    }
  }, []);

  /**
   * Attaches the files the user picked.
   *
   * An image is kept inline so the model sees it directly; anything else
   * is uploaded to the server, which writes it to disk so the agent can
   * read it with its own tools.
   */
  const attachFiles = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files);
    if (list.length === 0) {
      return;
    }

    for (const file of list) {
      const id = nextId();
      const isImage = file.type.startsWith('image/');

      if (file.size > MAX_ATTACHMENT_SIZE) {
        setAttachments((prev) => [
          ...prev,
          {
            id,
            name: file.name,
            mimeType: file.type || 'application/octet-stream',
            size: file.size,
            failed: `Too large (${formatSize(file.size)}).`,
          },
        ]);
        continue;
      }

      if (isImage) {
        try {
          const preview = await readAsDataUrl(file);
          const base64 = preview.slice(preview.indexOf(',') + 1);
          setAttachments((prev) => [
            ...prev,
            {
              id,
              name: file.name,
              mimeType: file.type,
              size: file.size,
              preview,
              uploaded: {
                name: file.name,
                mimeType: file.type,
                size: file.size,
                data: base64,
              },
            },
          ]);
        } catch {
          setAttachments((prev) => [
            ...prev,
            {
              id,
              name: file.name,
              mimeType: file.type,
              size: file.size,
              failed: 'The image could not be read.',
            },
          ]);
        }
        continue;
      }

      // Not an image: upload it so the agent can read it from disk.
      setAttachments((prev) => [
        ...prev,
        {
          id,
          name: file.name,
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          uploading: true,
        },
      ]);

      void (async () => {
        try {
          const response = await fetch(
            `/api/upload?name=${encodeURIComponent(file.name)}`,
            {
              method: 'POST',
              headers: {
                'Content-Type': file.type || 'application/octet-stream',
              },
              body: file,
            },
          );
          const body: unknown = await response.json();
          if (!response.ok || !isAttachment(body)) {
            throw new Error(
              body && typeof body === 'object' && 'error' in body
                ? String(body.error)
                : 'The upload failed.',
            );
          }
          setAttachments((prev) =>
            prev.map((item) =>
              item.id === id
                ? { ...item, uploading: false, uploaded: body }
                : item,
            ),
          );
        } catch (uploadError) {
          setAttachments((prev) =>
            prev.map((item) =>
              item.id === id
                ? {
                    ...item,
                    uploading: false,
                    failed:
                      uploadError instanceof Error
                        ? uploadError.message
                        : 'The upload failed.',
                  }
                : item,
            ),
          );
        }
      })();
    }
  }, []);

  /**
   * Attaches a folder, keeping its shape.
   *
   * The browser does not tell a page where a folder lives, so the files
   * are uploaded under their own relative paths and the agent is handed
   * the folder that holds them.
   */
  const attachFolder = useCallback(async (files: FileList | File[]) => {
    const list = Array.from(files).filter((file) => file.size > 0);
    if (list.length === 0) {
      return;
    }
    if (list.length > MAX_FOLDER_FILES) {
      setError(
        `That folder holds ${list.length} files; at most ${MAX_FOLDER_FILES} can be attached.`,
      );
      return;
    }

    const id = nextId();
    const first = list[0];
    const relative = first.webkitRelativePath || first.name;
    const rootName = relative.split('/')[0] ?? first.name;

    setAttachments((prev) => [
      ...prev,
      {
        id,
        name: rootName,
        mimeType: 'inode/directory',
        size: list.reduce((total, file) => total + file.size, 0),
        uploading: true,
      },
    ]);

    try {
      let folderPath: string | undefined;
      for (const file of list) {
        if (file.size > MAX_ATTACHMENT_SIZE) {
          continue;
        }
        const path = file.webkitRelativePath || file.name;
        const parts = path.split('/');
        const directory = parts.slice(0, -1).join('/');
        const query = new URLSearchParams({ name: parts.at(-1) ?? file.name });
        if (directory) {
          query.set('dir', directory);
        }
        const response = await fetch(`/api/upload?${query.toString()}`, {
          method: 'POST',
          headers: {
            'Content-Type': file.type || 'application/octet-stream',
          },
          body: file,
        });
        if (!response.ok) {
          const body: unknown = await response.json().catch(() => undefined);
          throw new Error(
            body && typeof body === 'object' && 'error' in body
              ? String(body.error)
              : 'The folder could not be uploaded.',
          );
        }
        const body: unknown = await response.json();
        if (isAttachment(body) && body.path && folderPath === undefined) {
          const normalized = body.path.replace(/\\/g, '/');
          folderPath = `${normalized.slice(0, normalized.length - path.length - 1)}/${rootName}`;
        }
      }

      setAttachments((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                uploading: false,
                fileCount: list.length,
                uploaded: {
                  name: rootName,
                  mimeType: 'inode/directory',
                  size: list.reduce((total, file) => total + file.size, 0),
                  path: folderPath,
                  kind: 'folder',
                  fileCount: list.length,
                },
              }
            : item,
        ),
      );
    } catch (uploadError) {
      setAttachments((prev) =>
        prev.map((item) =>
          item.id === id
            ? {
                ...item,
                uploading: false,
                failed:
                  uploadError instanceof Error
                    ? uploadError.message
                    : 'The folder could not be uploaded.',
              }
            : item,
        ),
      );
    }
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const submit = useCallback(
    (text: string) => {
      if (busyRef.current) {
        // Two turns at once would fight over the same agent. The turn has
        // to be stopped first.
        setError('Wait for the current turn to finish, or stop it first.');
        return;
      }
      const trimmed = text.trim();
      const ready = attachments.filter(
        (item): item is PendingAttachment & { uploaded: WebAttachment } =>
          item.uploaded !== undefined && !item.failed && !item.uploading,
      );
      if (!trimmed && ready.length === 0) {
        return;
      }
      if (trimmed === '/resume') {
        // The browser has a panel for this, so the terminal's picker is
        // not what the user wants to see.
        setPanel('sessions');
        send({ type: 'list_sessions' });
        setInput('');
        return;
      }
      if (trimmed.startsWith('/') || trimmed.startsWith('?')) {
        send({ type: 'command', text: trimmed });
      } else {
        send({
          type: 'prompt',
          text: trimmed,
          attachments: ready.map((item) => item.uploaded),
        });
      }
      setInput('');
      setAttachments([]);
    },
    [attachments, send],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        submit(input);
      }
    },
    [input, submit],
  );

  const confirm = useCallback(
    (confirmed: boolean) => {
      if (pending) {
        send({
          type: 'confirmation_response',
          id: pending.id,
          confirmed,
        });
        setPending(undefined);
      }
    },
    [pending, send],
  );

  // Rendered markdown, keyed by entry id so it stays aligned with the
  // transcript regardless of which kinds of entry came before it.
  const html = useMemo(() => {
    const map = new Map<string, string>();
    for (const entry of entries) {
      if (entry.kind === 'agent') {
        map.set(entry.id, renderMarkdown(entry.text));
      }
    }
    return map;
  }, [entries]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-left">
          <span className="logo" aria-hidden="true">
            ✦
          </span>
          <div>
            <div className="title">Gemini CLI</div>
            {session && (
              <div className="subtitle">
                {session.cwd}
                {toolCount > 0 && ` · ${toolCount} tools`}
              </div>
            )}
          </div>
        </div>
        <div className="topbar-right">
          <select
            className="mode-select"
            value={approvalMode}
            onChange={(event) => {
              const mode = event.target.value;
              setApprovalMode(mode);
              send({ type: 'set_approval_mode', mode });
            }}
            title="How much the agent may do without asking"
          >
            <option value="default">Ask before acting</option>
            <option value="autoEdit">Edit files freely</option>
            <option value="yolo">Do anything (YOLO)</option>
          </select>
          {models.length > 0 && (
            <select
              className="model-select"
              value=""
              onChange={(event) => {
                if (event.target.value) {
                  send({ type: 'set_model', model: event.target.value });
                }
              }}
            >
              <option value="">Change model…</option>
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                </option>
              ))}
            </select>
          )}
          <button
            className="icon-button"
            onClick={() => {
              if (panel === 'sessions') {
                setPanel('none');
                return;
              }
              setPanel('sessions');
              send({ type: 'list_sessions' });
            }}
            title="Sessions"
          >
            🕘
          </button>
          <button
            className="icon-button"
            onClick={() => setPanel(panel === 'settings' ? 'none' : 'settings')}
            title="Settings"
          >
            ⚙
          </button>
          <button
            className="icon-button"
            onClick={() => setTheme(theme === 'light' ? 'dark' : 'light')}
            title="Toggle theme"
          >
            {theme === 'light' ? '🌙' : '☀️'}
          </button>
        </div>
      </header>

      <div className="body">
        {panel === 'sessions' && (
          <SessionsPanel
            sessions={sessions}
            onClose={() => setPanel('none')}
            onResume={(sessionId) =>
              send({ type: 'resume_session', sessionId })
            }
            onNew={() => send({ type: 'new_session' })}
          />
        )}
        {panel === 'settings' && (
          <SettingsPanel
            onClose={() => setPanel('none')}
            onSave={(scope, key, value) =>
              send({ type: 'set_setting', scope, key, value })
            }
          />
        )}
        {panel === 'commands' && (
          <CommandsPanel commands={commands} onClose={() => setPanel('none')} />
        )}
        {panel === 'dialog' && dialog && (
          <DialogPanel
            dialog={dialog}
            onClose={() => {
              setPanel('none');
              setDialog(undefined);
              send({ type: 'dialog_closed' });
            }}
            onPick={(value) => {
              send({ type: 'dialog_choice', kind: dialog.kind, value });
              setPanel('none');
              setDialog(undefined);
            }}
            onSaveSetting={(scope, key, value) =>
              send({ type: 'set_setting', scope, key, value })
            }
          />
        )}

        <div className="transcript" ref={transcriptRef}>
          {entries.length === 0 && (
            <div className="empty">
              <div className="empty-logo">✦</div>
              <h1>How can I help?</h1>
              <p>
                Ask a question, or type <code>/</code> for commands and{' '}
                <code>/help</code> to get started.
              </p>
            </div>
          )}

          {entries.map((entry) => {
            if (entry.kind === 'user') {
              return (
                <div className="row user" key={entry.id}>
                  <div className="bubble user-bubble">
                    {entry.attachments && entry.attachments.length > 0 && (
                      <div className="user-attachments">
                        {entry.attachments.map((attachment) => (
                          <div
                            className="user-attachment"
                            key={`${attachment.name}-${attachment.size}`}
                          >
                            {attachment.mimeType.startsWith('image/') && (
                              <img
                                src={`data:${attachment.mimeType};base64,${attachment.data ?? ''}`}
                                alt={attachment.name}
                              />
                            )}
                            <span className="attachment-name">
                              {attachment.name}
                            </span>
                            <span className="attachment-size">
                              {formatSize(attachment.size)}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                    {entry.text}
                  </div>
                </div>
              );
            }
            if (entry.kind === 'agent') {
              return (
                <div className="row agent" key={entry.id}>
                  <div className="avatar" aria-hidden="true">
                    ✦
                  </div>
                  <div className="bubble agent-bubble">
                    <div
                      className="markdown"
                      dangerouslySetInnerHTML={{
                        __html: html.get(entry.id) ?? '',
                      }}
                    />
                    <CopyButton text={entry.text} />
                  </div>
                </div>
              );
            }
            if (entry.kind === 'thought') {
              return (
                <ThoughtView
                  key={entry.id}
                  text={entry.text}
                  live={entry.live}
                />
              );
            }
            if (entry.kind === 'file') {
              return <FileCard key={entry.id} file={entry.file} />;
            }
            if (entry.kind === 'tool') {
              return (
                <ToolCallView
                  key={entry.id}
                  call={entry.call}
                  output={entry.output}
                  truncated={entry.truncated}
                  outputKind={entry.outputKind}
                />
              );
            }
            return (
              <div
                className={`row notice ${entry.isError ? 'error' : ''}`}
                key={entry.id}
              >
                {entry.text}
              </div>
            );
          })}

          {busy && !hasLiveThought && (
            <div className="row agent">
              <div className="avatar" aria-hidden="true">
                ✦
              </div>
              <div className="bubble agent-bubble thinking">
                <span />
                <span />
                <span />
              </div>
            </div>
          )}
        </div>

        {error && (
          <div className="error-banner" role="alert">
            {error}
            <button onClick={() => setError(undefined)}>Dismiss</button>
          </div>
        )}

        {pending && (
          <div className="modal-backdrop">
            <div className="modal" role="dialog" aria-modal="true">
              <h2>{pending.title}</h2>
              <pre className="modal-body">{pending.details}</pre>
              <div className="modal-actions">
                <button
                  className="button primary"
                  onClick={() => confirm(true)}
                >
                  {pending.options[0] ?? 'Yes'}
                </button>
                <button className="button" onClick={() => confirm(false)}>
                  {pending.options[1] ?? 'No'}
                </button>
              </div>
            </div>
          </div>
        )}

        <div
          className={`composer ${dragging ? 'dragging' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            if (event.dataTransfer?.files?.length) {
              void attachFiles(event.dataTransfer.files);
            }
          }}
        >
          {attachments.length > 0 && (
            <div className="attachments">
              {attachments.map((attachment) => (
                <div
                  className={`attachment ${attachment.failed ? 'failed' : ''}`}
                  key={attachment.id}
                  title={attachment.failed ?? attachment.name}
                >
                  {attachment.preview ? (
                    <img src={attachment.preview} alt={attachment.name} />
                  ) : (
                    <span className="attachment-icon" aria-hidden="true">
                      {attachment.uploading
                        ? '⋯'
                        : attachment.mimeType === 'inode/directory'
                          ? '🗂'
                          : '📄'}
                    </span>
                  )}
                  <div className="attachment-meta">
                    <span className="attachment-name">{attachment.name}</span>
                    <span className="attachment-size">
                      {attachment.failed ??
                        (attachment.uploading
                          ? 'Uploading…'
                          : attachment.uploaded?.kind === 'folder'
                            ? `${attachment.uploaded.fileCount ?? attachment.fileCount ?? 0} files · ${formatSize(attachment.size)}`
                            : formatSize(attachment.size))}
                    </span>
                  </div>
                  <button
                    className="attachment-remove"
                    onClick={() => removeAttachment(attachment.id)}
                    title="Remove"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="composer-inner">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              hidden
              onChange={(event) => {
                if (event.target.files?.length) {
                  void attachFiles(event.target.files);
                }
                // Allow picking the same file again.
                event.target.value = '';
              }}
            />
            <input
              ref={folderInputRef}
              type="file"
              hidden
              // A folder picker is a file picker that keeps the tree.
              // React does not know the attribute, so it is set as one.
              {...{ webkitdirectory: '', directory: '' }}
              onChange={(event) => {
                if (event.target.files?.length) {
                  void attachFolder(event.target.files);
                }
                event.target.value = '';
              }}
            />
            <button
              className="icon-button"
              title="Attach files"
              onClick={() => fileInputRef.current?.click()}
            >
              📎
            </button>
            <button
              className="icon-button"
              title="Attach a folder"
              onClick={() => folderInputRef.current?.click()}
            >
              🗂
            </button>
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData?.files ?? []);
                if (files.length > 0) {
                  event.preventDefault();
                  void attachFiles(files);
                }
              }}
              placeholder="Ask Gemini anything, or type / for commands"
              rows={1}
            />
            <div className="composer-actions">
              <button
                className="icon-button"
                title="Commands"
                onClick={() =>
                  setPanel(panel === 'commands' ? 'none' : 'commands')
                }
              >
                /
              </button>
              {busy ? (
                <button
                  className="send-button stop"
                  onClick={() => send({ type: 'cancel' })}
                >
                  ■
                </button>
              ) : (
                <button
                  className="send-button"
                  onClick={() => submit(input)}
                  disabled={!input.trim()}
                >
                  ↑
                </button>
              )}
            </div>
          </div>
          {usage && usage.total > 0 && (
            <div className="usage">
              {usage.input.toLocaleString()} in ·{' '}
              {usage.output.toLocaleString()} out
              {usage.cached > 0 && ` · ${usage.cached.toLocaleString()} cached`}
            </div>
          )}
          {busy && (
            <div className="usage">
              Working for {turnElapsed}s
              <button
                className="link-button"
                onClick={() => send({ type: 'cancel' })}
                title="Stop the turn"
              >
                Stop
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * A unified diff, shown the way a review tool shows one.
 *
 * The file header is dropped because the path is already above it, and
 * every line gets a gutter and a tinted row, which is what makes a diff
 * readable at a glance instead of a wall of coloured text.
 */
const DiffBlock: React.FC<{ text: string }> = ({ text }) => {
  const lines = text
    .split('\n')
    .filter((line) => !line.startsWith('--- ') && !line.startsWith('+++ '));
  const added = lines.filter((line) => line.startsWith('+')).length;
  const removed = lines.filter((line) => line.startsWith('-')).length;

  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-stat add">+{added}</span>
        <span className="diff-stat del">−{removed}</span>
      </div>
      <div className="diff-body">
        {lines.map((line, index) => {
          const kind = line.startsWith('+')
            ? 'add'
            : line.startsWith('-')
              ? 'del'
              : line.startsWith('@@')
                ? 'hunk'
                : 'context';
          const body = kind === 'add' || kind === 'del' ? line.slice(1) : line;
          return (
            <div className={`diff-line ${kind}`} key={index}>
              <span className="diff-gutter" aria-hidden="true">
                {kind === 'add' ? '+' : kind === 'del' ? '−' : ' '}
              </span>
              <span className="diff-text">{body.length > 0 ? body : ' '}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};

/**
 * A document the agent wrote.
 *
 * A PDF is shown in place, because the browser can render it. A Word,
 * PowerPoint or Excel file is turned into one by the server on the way,
 * so the preview is the same either way; the original is still one click
 * away.
 */
const FileCard: React.FC<{ file: WebGeneratedFile }> = ({ file }) => {
  const [open, setOpen] = useState(false);
  const src = `/api/preview?path=${encodeURIComponent(file.path)}`;
  const label =
    file.kind === 'pdf'
      ? 'PDF'
      : file.kind === 'document'
        ? 'Document'
        : file.kind === 'presentation'
          ? 'Presentation'
          : file.kind === 'spreadsheet'
            ? 'Spreadsheet'
            : 'File';

  return (
    <div className="row file-row">
      <div className="avatar file-avatar" aria-hidden="true">
        ▤
      </div>
      <div className="file-card">
        <div className="file-head">
          <span className="file-name" title={file.path}>
            {file.name}
          </span>
          <span className="file-kind">{label}</span>
          <button
            className="button"
            onClick={() => setOpen(!open)}
            title="Show the document in the transcript"
          >
            {open ? 'Hide' : 'Preview'}
          </button>
          <a
            className="button"
            href={src}
            target="_blank"
            rel="noreferrer"
            title="Open in a new tab"
          >
            Open
          </a>
        </div>
        {open && (
          <iframe
            className="file-preview"
            src={src}
            title={file.name}
            loading="lazy"
          />
        )}
      </div>
    </div>
  );
};

/**
 * Counts the seconds `active` has been true.
 *
 * It is what tells a long run from a stuck one: the clock keeps moving
 * even when nothing else does.
 */
const useElapsed = (active: boolean): number => {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active) {
      return;
    }
    const started = Date.now();
    setSeconds(0);
    const timer = setInterval(() => {
      setSeconds(Math.floor((Date.now() - started) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [active]);
  return seconds;
};

/** A button that copies a string to the clipboard. */
const CopyButton: React.FC<{ text: string; label?: string }> = ({
  text,
  label = 'Copy',
}) => {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="copy-button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      title="Copy to clipboard"
    >
      {copied ? '✓ Copied' : label}
    </button>
  );
};

/**
 * The model's reasoning.
 *
 * It fills itself in while the model is still thinking, and folds itself
 * away once it is over if it grew too long to read at a glance. The user
 * can open or close it whenever they want, and that choice sticks.
 */
const ThoughtView: React.FC<{ text: string; live: boolean }> = ({
  text,
  live,
}) => {
  const [open, setOpen] = useState(true);
  const touched = useRef(false);

  useEffect(() => {
    if (touched.current) {
      return;
    }
    if (live) {
      setOpen(true);
      return;
    }
    setOpen(shouldAutoExpand(text));
  }, [live, text]);

  if (!text) {
    return null;
  }

  return (
    <div className="row thought-row">
      <button
        className="thought-header"
        onClick={() => {
          touched.current = true;
          setOpen(!open);
        }}
      >
        <span className="thought-chevron">{open ? '▾' : '▸'}</span>
        <span className="thought-label">
          {live ? 'Thinking' : 'Thought about'}
        </span>
        {!open && (
          <span className="thought-preview">
            {text.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 90)}
          </span>
        )}
      </button>
      {open && (
        <div className="thought-body">
          <div
            className="markdown"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
          />
        </div>
      )}
    </div>
  );
};

/**
 * A tool call.
 *
 * The output is shown straight away when it is short enough to read at a
 * glance, and folded away when it is not, so a long shell run does not
 * push everything else off the screen. The arguments have their own
 * toggle: they are what the tool was asked to do, which is rarely worth
 * reading twice.
 */
const ToolCallView: React.FC<{
  call: WebToolCall;
  output?: string;
  truncated?: boolean;
  outputKind?: 'diff';
}> = ({ call, output, truncated, outputKind }) => {
  const status = call.status;
  const isRunning = status === 'executing' || status === 'pending';
  // The clock keeps running while the tool works, so a long run is not
  // mistaken for a stuck one.
  const elapsed = useElapsed(isRunning);

  // Whether the user has opened or closed the box themselves. Once they
  // have, the automatic behaviour leaves it alone.
  const touched = useRef(false);
  const [open, setOpen] = useState(false);
  const [showArgs, setShowArgs] = useState(false);

  // While the tool runs its output streams in, so the box stays open; once
  // it is done the output is shown if it is short enough to read at a
  // glance, and folded away if it is not.
  useEffect(() => {
    if (touched.current) {
      return;
    }
    if (isRunning) {
      setOpen(true);
      return;
    }
    if (output !== undefined) {
      setOpen(shouldAutoExpand(output));
    }
  }, [isRunning, output]);

  // The file a diff refers to, so the browser can offer to open it.
  const diffPath = useMemo(() => {
    if (outputKind !== 'diff' || !output) {
      return undefined;
    }
    const match = /^---\s*(.+)$/m.exec(output);
    return match?.[1]?.trim();
  }, [output, outputKind]);

  const hasArgs = Object.keys(call.args).length > 0;
  const argCount = Object.keys(call.args).length;

  return (
    <div className={`tool-call ${status}`}>
      <button
        className="tool-header"
        onClick={() => {
          touched.current = true;
          setOpen(!open);
        }}
      >
        <span className="tool-icon">
          {status === 'completed'
            ? '✓'
            : status === 'failed'
              ? '✕'
              : status === 'cancelled'
                ? '–'
                : '⋯'}
        </span>
        <span className="tool-name">{call.title}</span>
        <span className="tool-status">{status}</span>
        {isRunning ? (
          <span className="tool-duration">{elapsed}s</span>
        ) : (
          call.durationMs !== undefined && (
            <span className="tool-duration">{call.durationMs}ms</span>
          )
        )}
        <span className="tool-chevron">{open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="tool-detail">
          {diffPath && (
            <div className="tool-path" title={diffPath}>
              {diffPath}
              <CopyButton text={diffPath} label="Copy path" />
            </div>
          )}
          {output !== undefined &&
            (outputKind === 'diff' ? (
              <DiffBlock text={output} />
            ) : (
              <pre className="tool-output">{output}</pre>
            ))}
          {isRunning && output === undefined && (
            <div className="tool-running">Running… {elapsed}s</div>
          )}
          {truncated && <div className="tool-truncated">Output truncated.</div>}
          <div className="tool-footer">
            {hasArgs && (
              <button
                className="tool-args-toggle"
                onClick={() => setShowArgs(!showArgs)}
              >
                {showArgs ? '▾' : '▸'} {argCount}{' '}
                {argCount === 1 ? 'argument' : 'arguments'}
              </button>
            )}
            {output !== undefined && (
              <CopyButton text={output} label="Copy output" />
            )}
          </div>
          {showArgs && (
            <pre className="tool-args">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
};

/** The settings panel, backed by the settings API. */
interface SettingsEntry {
  key: string;
  label: string;
  description: string;
  category: string;
  type: string;
  default: unknown;
  value: unknown;
  source: string;
  options?: ReadonlyArray<{ label: string; value: string | number }>;
  requiresRestart: boolean;
}

/**
 * The sessions stored on disk.
 *
 * The terminal has the same list behind `/resume`; here a click loads the
 * conversation into the agent and shows it again.
 */
const SessionsPanel: React.FC<{
  sessions: WebSessionSummary[];
  onClose: () => void;
  onResume: (sessionId: string) => void;
  onNew: () => void;
}> = ({ sessions, onClose, onResume, onNew }) => (
  <aside className="panel">
    <div className="panel-header">
      <h2>Sessions</h2>
      <button className="icon-button" onClick={onClose} title="Close">
        ✕
      </button>
    </div>
    <div className="panel-controls">
      <button className="button primary" onClick={onNew}>
        New chat
      </button>
    </div>
    <div className="panel-body">
      {sessions.length === 0 && (
        <div className="panel-empty">No sessions in this folder.</div>
      )}
      {sessions.map((session) => (
        <button
          className="session-row"
          key={session.id}
          onClick={() => onResume(session.id)}
          title={`Load this session (${session.id})`}
        >
          <span className="session-summary">{session.summary}</span>
          <span className="session-meta">
            {session.timestamp}
            {session.messageCount !== undefined &&
              ` · ${session.messageCount} msgs`}
          </span>
        </button>
      ))}
    </div>
  </aside>
);

const SettingsPanel: React.FC<{
  onClose: () => void;
  onSave: (scope: 'User' | 'Workspace', key: string, value: unknown) => void;
}> = ({ onClose, onSave }) => {
  const [settings, setSettings] = useState<SettingsEntry[]>([]);
  const [filter, setFilter] = useState('');
  const [category, setCategory] = useState('All');

  useEffect(() => {
    void fetch('/api/settings')
      .then((response) => response.json())
      .then((data: SettingsEntry[]) => setSettings(data))
      .catch(() => setSettings([]));
  }, []);

  const categories = useMemo(
    () => ['All', ...Array.from(new Set(settings.map((s) => s.category)))],
    [settings],
  );

  const visible = useMemo(
    () =>
      settings.filter(
        (setting) =>
          (category === 'All' || setting.category === category) &&
          (!filter ||
            setting.key.toLowerCase().includes(filter.toLowerCase()) ||
            setting.label.toLowerCase().includes(filter.toLowerCase())),
      ),
    [settings, category, filter],
  );

  return (
    <aside className="panel">
      <div className="panel-header">
        <h2>Settings</h2>
        <button className="icon-button" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="panel-controls">
        <input
          className="search"
          placeholder="Search settings…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        <select
          className="category"
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          {categories.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </div>
      <div className="panel-body">
        {visible.map((setting) => (
          <SettingRow key={setting.key} setting={setting} onSave={onSave} />
        ))}
        {visible.length === 0 && (
          <div className="panel-empty">No settings match.</div>
        )}
      </div>
    </aside>
  );
};

const SettingRow: React.FC<{
  setting: SettingsEntry;
  onSave: (scope: 'User' | 'Workspace', key: string, value: unknown) => void;
}> = ({ setting, onSave }) => {
  const [value, setValue] = useState<unknown>(setting.value);

  const commit = (next: unknown) => {
    setValue(next);
    onSave('User', setting.key, next);
  };

  return (
    <div className="setting-row">
      <div className="setting-head">
        <span className="setting-label">{setting.label}</span>
        {setting.source !== 'default' && (
          <span className="setting-source">{setting.source}</span>
        )}
        {setting.requiresRestart && (
          <span className="setting-restart">restart</span>
        )}
      </div>
      {setting.description && (
        <div className="setting-description">{setting.description}</div>
      )}
      {setting.type === 'boolean' ? (
        <input
          type="checkbox"
          checked={Boolean(value)}
          onChange={(event) => commit(event.target.checked)}
        />
      ) : setting.type === 'enum' && setting.options ? (
        <select
          value={String(value ?? '')}
          onChange={(event) => commit(event.target.value)}
        >
          {setting.options.map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label}
            </option>
          ))}
        </select>
      ) : setting.type === 'number' ? (
        <input
          type="number"
          value={Number(value ?? 0)}
          onChange={(event) => commit(Number(event.target.value))}
        />
      ) : setting.type === 'object' || setting.type === 'array' ? (
        <JsonSettingEditor value={value} onCommit={(next) => commit(next)} />
      ) : (
        <input
          type="text"
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => setValue(event.target.value)}
          onBlur={() => commit(value)}
        />
      )}
    </div>
  );
};

/**
 * Edits a structured setting.
 *
 * Object and array settings hold nested configuration, so they are edited as
 * JSON rather than as text.
 */
const JsonSettingEditor: React.FC<{
  value: unknown;
  onCommit: (value: unknown) => void;
}> = ({ value, onCommit }) => {
  const [text, setText] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [invalid, setInvalid] = useState(false);

  return (
    <>
      <textarea
        className="json-editor"
        rows={4}
        value={text}
        spellCheck={false}
        onChange={(event) => {
          setText(event.target.value);
          try {
            JSON.parse(event.target.value);
            setInvalid(false);
          } catch {
            setInvalid(true);
          }
        }}
        onBlur={() => {
          if (invalid) {
            return;
          }
          try {
            onCommit(JSON.parse(text));
          } catch {
            // The value is not valid JSON; leave the setting untouched.
          }
        }}
      />
      {invalid && <div className="setting-invalid">Not valid JSON.</div>}
    </>
  );
};

/**
 * The browser's counterpart of one of the terminal's dialogs.
 *
 * The settings dialog is handled by the settings panel, which edits the
 * values directly; the pick-one dialogs become a list of choices.
 */
const DialogPanel: React.FC<{
  dialog: WebDialog;
  onClose: () => void;
  onPick: (value: string) => void;
  onSaveSetting: (
    scope: 'User' | 'Workspace',
    key: string,
    value: unknown,
  ) => void;
}> = ({ dialog, onClose, onPick, onSaveSetting }) => {
  if (dialog.kind === 'settings') {
    // The settings panel edits the values directly, so it needs no options.
    return <SettingsPanel onClose={onClose} onSave={onSaveSetting} />;
  }
  return (
    <aside className="panel">
      <div className="panel-header">
        <h2>{dialog.title}</h2>
        <button className="icon-button" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="panel-body">
        {(dialog.options ?? []).map((option) => (
          <button
            className="command-row choice"
            key={option.value}
            onClick={() => onPick(option.value)}
          >
            <code>{option.label}</code>
            {option.description && <span>{option.description}</span>}
          </button>
        ))}
        {(dialog.options ?? []).length === 0 && (
          <div className="panel-empty">
            This dialog has nothing to choose from in the browser.
          </div>
        )}
      </div>
    </aside>
  );
};

/** The list of available commands. */
const CommandsPanel: React.FC<{
  commands: WebCommand[];
  onClose: () => void;
}> = ({ commands, onClose }) => {
  const [filter, setFilter] = useState('');
  const visible = commands.filter(
    (command) =>
      !filter ||
      command.name.toLowerCase().includes(filter.toLowerCase()) ||
      command.description.toLowerCase().includes(filter.toLowerCase()),
  );
  return (
    <aside className="panel">
      <div className="panel-header">
        <h2>Commands</h2>
        <button className="icon-button" onClick={onClose}>
          ✕
        </button>
      </div>
      <div className="panel-controls">
        <input
          className="search"
          placeholder="Search commands…"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>
      <div className="panel-body">
        {visible.map((command) => (
          <div className="command-row" key={command.name}>
            <code>/{command.name}</code>
            <span>{command.description}</span>
          </div>
        ))}
      </div>
    </aside>
  );
};

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
