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
  WebCommand,
  WebConfirmationRequest,
  WebDialog,
  WebModel,
  WebTool,
  WebToolCall,
  WebUsage,
} from '../protocol.js';
import { renderMarkdown } from './markdown.js';

/** One entry in the transcript. */
type Entry =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'agent'; id: string; text: string; streaming: boolean }
  | { kind: 'thought'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      call: WebToolCall;
      output?: string;
      truncated?: boolean;
      outputKind?: 'diff';
    }
  | { kind: 'notice'; id: string; text: string; isError: boolean };

let counter = 0;
const nextId = () => `entry-${++counter}`;

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
    'none' | 'settings' | 'commands' | 'dialog'
  >('none');
  const [dialog, setDialog] = useState<WebDialog | undefined>(undefined);
  const [theme, setTheme] = useState<'light' | 'dark'>('light');
  const [error, setError] = useState<string | undefined>();

  const socketRef = useRef<WebSocket | undefined>(undefined);
  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    document.documentElement.dataset['theme'] = theme;
  }, [theme]);

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
        setUsage(undefined);
        break;
      case 'user_message':
        setEntries((prev) => [
          ...prev,
          { kind: 'user', id: nextId(), text: event.text },
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
        setEntries((prev) => [
          ...prev,
          { kind: 'thought', id: nextId(), text: event.text },
        ]);
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
              toolEntry.output = existing.output;
              toolEntry.truncated = existing.truncated;
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

  const send = useCallback((request: ClientRequest) => {
    const socket = socketRef.current;
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify(request));
    }
  }, []);

  const submit = useCallback(
    (text: string) => {
      const trimmed = text.trim();
      if (!trimmed) {
        return;
      }
      if (trimmed.startsWith('/') || trimmed.startsWith('?')) {
        send({ type: 'command', text: trimmed });
      } else {
        send({ type: 'prompt', text: trimmed });
      }
      setInput('');
    },
    [send],
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
      if (entry.kind === 'agent' || entry.kind === 'thought') {
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
                  <div className="bubble user-bubble">{entry.text}</div>
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
                <details className="row thought" key={entry.id}>
                  <summary>Thinking</summary>
                  <div
                    className="markdown"
                    dangerouslySetInnerHTML={{
                      __html: html.get(entry.id) ?? '',
                    }}
                  />
                </details>
              );
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

          {busy && (
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

        <div className="composer">
          <div className="composer-inner">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={onKeyDown}
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
        </div>
      </div>
    </div>
  );
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

/** A tool call, with its output collapsible. */
const ToolCallView: React.FC<{
  call: WebToolCall;
  output?: string;
  truncated?: boolean;
  outputKind?: 'diff';
}> = ({ call, output, truncated, outputKind }) => {
  const [open, setOpen] = useState(false);
  const status = call.status;
  // The file a diff refers to, so the browser can offer to open it.
  const diffPath = useMemo(() => {
    if (outputKind !== 'diff' || !output) {
      return undefined;
    }
    const match = /^---\s*(.+)$/m.exec(output);
    return match?.[1]?.trim();
  }, [output, outputKind]);
  return (
    <div className={`tool-call ${status}`}>
      <button className="tool-header" onClick={() => setOpen(!open)}>
        <span className="tool-icon">
          {status === 'completed' ? '✓' : status === 'failed' ? '✕' : '⋯'}
        </span>
        <span className="tool-name">{call.title}</span>
        <span className="tool-status">{status}</span>
        {call.durationMs !== undefined && (
          <span className="tool-duration">{call.durationMs}ms</span>
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
          {Object.keys(call.args).length > 0 && (
            <pre className="tool-args">
              {JSON.stringify(call.args, null, 2)}
            </pre>
          )}
          {output &&
            (outputKind === 'diff' ? (
              <div className="tool-output diff">
                {output.split('\n').map((line, index) => (
                  <span
                    className={
                      line.startsWith('+')
                        ? 'line-add'
                        : line.startsWith('-')
                          ? 'line-del'
                          : undefined
                    }
                    key={index}
                  >
                    {line}
                    {'\n'}
                  </span>
                ))}
              </div>
            ) : (
              <pre className="tool-output">{output}</pre>
            ))}
          {truncated && <div className="tool-truncated">Output truncated.</div>}
          {output && <CopyButton text={output} label="Copy output" />}
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
