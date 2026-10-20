/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import {
  Logger,
  Storage,
  debugLogger,
  type AgentLoopContext,
  type Config,
} from '@google/gemini-cli-core';
import {
  SettingScope,
  type LoadableSettingScope,
  type LoadedSettings,
} from '../config/settings.js';
import { CommandService } from '../services/CommandService.js';
import { BuiltinCommandLoader } from '../services/BuiltinCommandLoader.js';
import { FileCommandLoader } from '../services/FileCommandLoader.js';
import { McpPromptLoader } from '../services/McpPromptLoader.js';
import { SkillCommandLoader } from '../services/SkillCommandLoader.js';
import { SlashCommandResolver } from '../services/SlashCommandResolver.js';
import { parseSlashCommand } from '../utils/commands.js';
import {
  getAllSettingKeys,
  getSettingDefinition,
} from '../utils/settingsUtils.js';
import type { SlashCommand, CommandContext } from '../ui/commands/types.js';
import type {
  ClientRequest,
  ServerEvent,
  WebCommand,
  WebDialog,
  WebModel,
  WebSessionSummary,
  WebSettingsEntry,
  WebTool,
} from './protocol.js';
import { WebSession } from './webSession.js';
import { WebConfirmationBroker, createWebUI } from './webUi.js';
import { INDEX_HTML, CLIENT_JS, CLIENT_CSS } from './_client-assets.js';

const DEFAULT_PORT = 7777;
const MAX_PORT_RETRIES = 10;

/**
 * The terminal passes the `Config` as the agent context, because `Config`
 * carries everything an `AgentLoopContext` needs.
 */
function toAgentLoopContext(config: Config): AgentLoopContext {
  // The two interfaces describe the same runtime object; the cast is the
  // only way to say so without changing the core types.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
  return config as unknown as AgentLoopContext;
}

/** The title shown for each of the terminal's dialogs. */
const DIALOG_TITLES: Record<string, string> = {
  settings: 'Settings',
  model: 'Select a model',
  theme: 'Select a theme',
  auth: 'Authentication',
  editor: 'Editor',
  privacy: 'Privacy notice',
  permissions: 'Permissions',
  sessionBrowser: 'Browse sessions',
  'voice-model': 'Voice model',
  agentConfig: 'Agent configuration',
};

/** How the browser talks to the server. */
export interface WebServerOptions {
  config: Config;
  settings: LoadedSettings;
  cwd: string;
  port?: number;
  host?: string;
  /** Called once the server is listening. */
  onListening?: (url: string) => void;
}

/**
 * The local web server that fronts the agent.
 *
 * It serves the client bundle, streams agent events over a WebSocket, and
 * accepts the user's prompts and command invocations on the same socket.
 */
export class WebServer {
  private server: http.Server | undefined;
  private wss: WebSocketServer | undefined;
  private session: WebSession | undefined;
  private broker: WebConfirmationBroker | undefined;
  private port = DEFAULT_PORT;
  private readonly host: string;
  private commands: SlashCommand[] = [];
  private readonly clients = new Set<(event: ServerEvent) => void>();
  private readonly sockets = new Set<WebSocket>();

  constructor(private readonly options: WebServerOptions) {
    this.host = options.host ?? '127.0.0.1';
    this.port = options.port ?? DEFAULT_PORT;
  }

  /** The commands the browser can offer, with their descriptions. */
  private async loadCommands(): Promise<SlashCommand[]> {
    const controller = new AbortController();
    try {
      const service = await CommandService.create(
        [
          new BuiltinCommandLoader(this.options.config),
          new SkillCommandLoader(this.options.config),
          new McpPromptLoader(this.options.config),
          new FileCommandLoader(this.options.config),
        ],
        controller.signal,
      );
      return SlashCommandResolver.resolve([...service.getCommands()])
        .finalCommands;
    } catch (error) {
      debugLogger.warn('web: failed to load commands:', error);
      return [];
    }
  }

  /** The models the user may pick. */
  private listModels(): WebModel[] {
    const service = this.options.config.getModelConfigService?.();
    if (!service) {
      return [];
    }
    try {
      return service
        .getAvailableModelOptions({})
        .filter((option) => option.tier === 'auto')
        .map((option) => ({ id: option.modelId, label: option.name }));
    } catch (error) {
      debugLogger.warn('web: failed to list models:', error);
      return [];
    }
  }

  /** The tools the agent may call. */
  private listTools(): WebTool[] {
    const registry = this.options.config.getToolRegistry?.();
    if (!registry) {
      return [];
    }
    const tools = registry.getAllTools();
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description ?? '',
    }));
  }

  /** The settings the browser may edit, with their current values. */
  private listSettings(): WebSettingsEntry[] {
    const settings = this.options.settings;
    const merged: Record<string, unknown> = { ...settings.merged };
    const entries: WebSettingsEntry[] = [];
    for (const key of getAllSettingKeys()) {
      const definition = getSettingDefinition(key);
      if (!definition) {
        continue;
      }
      entries.push({
        key,
        label: definition.label ?? key,
        description: definition.description ?? '',
        category: definition.category ?? 'General',
        type: definition.type,
        default: definition.default,
        value: merged[key],
        source: this.settingSource(key),
        options: definition.options,
        requiresRestart: definition.requiresRestart ?? false,
      });
    }
    return entries;
  }

  /** Which scope a setting's effective value came from. */
  private settingSource(key: string): string {
    const settings = this.options.settings;
    const scopes: LoadableSettingScope[] = [
      SettingScope.Workspace,
      SettingScope.User,
    ];
    for (const scope of scopes) {
      const file: Record<string, unknown> = {
        ...settings.forScope(scope).settings,
      };
      if (key in file) {
        return scope;
      }
    }
    return 'default';
  }

  /** Starts listening. Resolves with the URL once it is up. */
  async start(): Promise<string> {
    if (this.server) {
      return this.url();
    }

    this.commands = await this.loadCommands();

    this.server = http.createServer((req, res) => {
      void this.handleHttp(req, res);
    });

    this.wss = new WebSocketServer({ server: this.server, path: '/ws' });

    this.wss.on('connection', (socket: WebSocket) => {
      void this.handleSocket(socket);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        if (error.code === 'EADDRINUSE') {
          if (this.port - DEFAULT_PORT >= MAX_PORT_RETRIES) {
            reject(
              new Error(
                `Web UI: all ports ${DEFAULT_PORT}-${this.port} are in use`,
              ),
            );
            return;
          }
          this.port++;
          this.server?.listen(this.port, this.host, () => {
            this.server?.removeListener('error', onError);
            resolve();
          });
          return;
        }
        reject(error);
      };
      this.server?.once('error', onError);
      this.server?.listen(this.port, this.host, () => {
        this.server?.removeListener('error', onError);
        // Port 0 asks the OS for a free port; report the one we got.
        const address = this.server?.address();
        if (address && typeof address === 'object') {
          this.port = address.port;
        }
        resolve();
      });
    });

    const url = this.url();
    this.options.onListening?.(url);
    return url;
  }

  /** The URL the browser should open. */
  url(): string {
    return `http://${this.host}:${this.port}`;
  }

  async stop(): Promise<void> {
    await this.session?.dispose();
    this.session = undefined;
    // The WebSocketServer only finishes closing once every client is gone,
    // so drop the connections first; otherwise Ctrl+C would hang while the
    // browser is still open.
    for (const socket of this.sockets) {
      try {
        socket.terminate();
      } catch {
        // The socket may already be gone.
      }
    }
    this.sockets.clear();
    this.wss?.close();
    this.wss = undefined;
    await new Promise<void>((resolve) => {
      if (!this.server) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
      this.server = undefined;
    });
  }

  private async handleHttp(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    // The client is served from this server, so cross-origin access is
    // unnecessary and would let arbitrary pages reach the agent.
    const origin = req.headers.origin;
    if (origin && origin !== this.url()) {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('Forbidden');
      return;
    }

    const path = (req.url ?? '/').split('?')[0];

    if (path === '/' || path === '/index.html') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(INDEX_HTML);
      return;
    }
    if (path === '/assets/main.css') {
      res.writeHead(200, {
        'Content-Type': 'text/css; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(CLIENT_CSS);
      return;
    }
    if (path === '/assets/main.js') {
      res.writeHead(200, {
        'Content-Type': 'application/javascript; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      res.end(CLIENT_JS);
      return;
    }
    if (path === '/api/settings') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.listSettings()));
      return;
    }
    if (path === '/api/commands') {
      const commands: WebCommand[] = this.commands.map((command) => ({
        name: command.name,
        description: command.description,
        builtIn: command.kind === 'built-in',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(commands));
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  }

  private handleSocket(socket: WebSocket): void {
    const send = (event: ServerEvent) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
      }
    };
    this.clients.add(send);
    this.sockets.add(socket);

    const announce = async () => {
      try {
        const session = await this.ensureSession();
        session.addClient({ send });

        send({
          type: 'session_started',
          sessionId: session.sessionId,
          cwd: this.options.cwd,
          model: this.options.config.getModel(),
          models: this.listModels(),
          commands: this.commands.map((command) => ({
            name: command.name,
            description: command.description,
            builtIn: command.kind === 'built-in',
          })),
          tools: this.listTools(),
          approvalMode: this.options.config.getApprovalMode(),
        });

        socket.on('message', (data) => {
          void this.handleRequest(session, send, data.toString());
        });
      } catch (error) {
        debugLogger.error('web: failed to start a session:', error);
        send({
          type: 'error',
          message:
            error instanceof Error
              ? `The session could not be started: ${error.message}`
              : 'The session could not be started.',
        });
      }
    };

    socket.on('close', () => {
      this.clients.delete(send);
      this.sockets.delete(socket);
    });

    void announce();
  }

  private async ensureSession(): Promise<WebSession> {
    if (this.session) {
      return this.session;
    }
    const send = (event: ServerEvent) => {
      this.clients.forEach((client) => client(event));
    };
    this.broker = new WebConfirmationBroker(send);
    this.session = new WebSession(
      this.options.config,
      this.options.settings,
      this.options.cwd,
    );
    return this.session;
  }

  private async handleRequest(
    session: WebSession,
    send: (event: ServerEvent) => void,
    raw: string,
  ): Promise<void> {
    let request: ClientRequest;
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
        throw new Error('not a request');
      }
      // The shape is checked per case below.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion
      request = parsed as ClientRequest;
    } catch {
      send({ type: 'error', message: 'Malformed request' });
      return;
    }

    try {
      switch (request.type) {
        case 'prompt':
          await session.send(request.text);
          break;
        case 'cancel':
          await session.cancel();
          break;
        case 'command':
          send({ type: 'turn_started' });
          try {
            await this.runCommand(session, send, request.text);
          } finally {
            // A command does not go through the agent loop, so the turn it
            // opened has to be closed here.
            send({ type: 'turn_ended', cancelled: false });
          }
          break;
        case 'confirmation_response':
          this.broker?.resolve(request.id, request.confirmed);
          break;
        case 'set_setting':
          this.setSetting(request.scope, request.key, request.value);
          send({ type: 'settings_changed' });
          break;
        case 'list_settings':
          send({
            type: 'info',
            message: JSON.stringify(this.listSettings()),
          });
          break;
        case 'set_model':
          this.options.config.setModel(request.model);
          break;
        case 'dialog_choice':
          await this.applyDialogChoice(request.kind, request.value);
          break;
        case 'dialog_closed':
          break;
        case 'new_session':
          send({
            type: 'info',
            message: 'A new session starts with the next prompt.',
          });
          break;
        case 'list_sessions':
          send({
            type: 'info',
            message: JSON.stringify(await this.listSessions()),
          });
          break;
        case 'resume_session':
          send({
            type: 'info',
            message:
              'Resuming a session is not supported from the browser yet; use --resume on the command line.',
          });
          break;
        default:
          send({ type: 'error', message: 'Unknown request' });
      }
    } catch (error) {
      send({
        type: 'error',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /** Writes a setting to the requested scope and persists it. */
  private setSetting(
    scope: 'User' | 'Workspace',
    key: string,
    value: unknown,
  ): void {
    this.options.settings.setValue(
      scope === 'User' ? SettingScope.User : SettingScope.Workspace,
      key,
      value,
    );
  }

  /** Runs a slash command the way the terminal does. */
  private async runCommand(
    session: WebSession,
    send: (event: ServerEvent) => void,
    text: string,
  ): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed.startsWith('/') && !trimmed.startsWith('?')) {
      send({ type: 'error', message: 'Not a command' });
      return;
    }

    const { commandToExecute, args } = parseSlashCommand(
      trimmed,
      this.commands,
    );
    if (!commandToExecute) {
      send({ type: 'error', message: `Unknown command: ${trimmed}` });
      return;
    }
    if (!commandToExecute.action) {
      send({ type: 'error', message: `Command has no action: ${trimmed}` });
      return;
    }

    const ui = createWebUI((event) => send(event), this.broker!);

    const gitService = await session.config.getGitService();
    const logger = new Logger(
      this.options.config.getSessionId(),
      this.options.config.storage ?? new Storage(this.options.cwd),
    );
    const context: CommandContext = {
      invocation: { raw: trimmed, name: commandToExecute.name, args },
      services: {
        // The config carries the agent context the terminal passes, so the
        // commands that read the tool registry or the model work here too.
        agentContext: toAgentLoopContext(this.options.config),
        settings: this.options.settings,
        git: gitService,
        logger,
      },
      ui,
      session: {
        stats: {
          sessionId: this.options.config.getSessionId(),
          sessionStartTime: new Date(),
          metrics: {
            models: {},
            tools: {
              totalCalls: 0,
              totalSuccess: 0,
              totalFail: 0,
              totalDurationMs: 0,
              totalDecisions: {
                accept: 0,
                reject: 0,
                modify: 0,
                auto_accept: 0,
              },
              byName: {},
            },
            files: {
              totalLinesAdded: 0,
              totalLinesRemoved: 0,
            },
          },
          lastPromptTokenCount: 0,
          promptCount: 0,
        },
        sessionShellAllowlist: new Set<string>(),
      },
    };

    const result = await commandToExecute.action(context, args);
    if (result?.type === 'message') {
      send({
        type: 'command_result',
        text: result.content,
        isError: result.messageType === 'error',
      });
    } else if (result?.type === 'tool') {
      await session.send(String(result.postSubmitPrompt ?? result.toolName));
    } else if (result?.type === 'dialog') {
      // The terminal would open an Ink dialog here; the browser gets the
      // same choice as a panel.
      send({
        type: 'dialog',
        dialog: await this.buildDialog(result.dialog, result.props),
      });
    }
  }

  /** Applies the choice the user made in one of the dialogs. */
  private async applyDialogChoice(kind: string, value: string): Promise<void> {
    switch (kind) {
      case 'model':
        this.options.config.setModel(value);
        break;
      case 'theme': {
        const { themeManager } = await import('../ui/themes/theme-manager.js');
        themeManager.setActiveTheme(value);
        break;
      }
      default:
        // The remaining dialogs have no browser-side equivalent; the value is
        // reported so the user knows the choice was received.
        break;
    }
  }

  /**
   * Builds the browser-side counterpart of one of the terminal's dialogs.
   *
   * The settings dialog is the important one: the browser edits the settings
   * directly, so it needs no options. The pick-one dialogs become a list of
   * choices the user can click.
   */
  private async buildDialog(
    kind: string,
    props?: Record<string, unknown>,
  ): Promise<WebDialog> {
    const title =
      typeof props?.['title'] === 'string'
        ? props['title']
        : (DIALOG_TITLES[kind] ?? 'Dialog');

    switch (kind) {
      case 'settings':
        return { kind: 'settings', title };
      case 'model': {
        const service = this.options.config.getModelConfigService?.();
        const options = service
          ? service.getAvailableModelOptions({}).map((option) => ({
              label: option.name,
              value: option.modelId,
              description: option.description,
            }))
          : [];
        return { kind: 'model', title, options };
      }
      case 'theme': {
        const { themeManager } = await import('../ui/themes/theme-manager.js');
        return {
          kind: 'theme',
          title,
          options: themeManager
            .getAllThemes()
            .map((theme) => ({ label: theme.name, value: theme.name })),
        };
      }
      case 'auth':
        return { kind: 'auth', title };
      case 'editor':
        return { kind: 'editor', title };
      case 'privacy':
        return { kind: 'privacy', title };
      case 'permissions':
        return { kind: 'permissions', title };
      case 'sessionBrowser':
        return { kind: 'sessionBrowser', title };
      case 'voice-model':
        return { kind: 'voice-model', title };
      case 'agentConfig':
        return { kind: 'agentConfig', title, props };
      default:
        return { kind: 'settings', title };
    }
  }

  /** The sessions stored on disk. */
  private async listSessions(): Promise<WebSessionSummary[]> {
    const { SessionSelector } = await import('../utils/sessionUtils.js');
    const { Storage } = await import('@google/gemini-cli-core');
    const selector = new SessionSelector(new Storage(this.options.cwd));
    const sessions = await selector.listSessions();
    return sessions.slice(0, 50).map((session) => ({
      id: session.id,
      timestamp: new Date(session.lastUpdated).toLocaleString(),
      summary: (session.firstUserMessage ?? '').slice(0, 80),
    }));
  }
}
