/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';
import { KeychainService } from './keychainService.js';

/**
 * A saved remote host the agent can reach.
 *
 * `password` and `sudoPassword` are never held here: they live in the OS
 * keychain under this profile's name and are read back only for the duration
 * of one connection.
 */
export interface SshProfile {
  /** The profile name, as typed at `/ssh-add` and used at `/ssh <name>`. */
  name: string;
  host: string;
  user: string;
  port: number;
  /** Absolute path to a private key, when the host authenticates by key. */
  identityFile?: string;
  /** Set when a sudo password was captured; absent means `sudo` is refused. */
  hasSudoPassword?: boolean;
}

export const DEFAULT_SSH_PORT = 22;

/**
 * Keychain service name for SSH secrets. Deliberately distinct from the OAuth
 * entry so listing either concern's secrets never mixes the two.
 */
const SSH_KEYCHAIN_SERVICE = 'Gemini CLI SSH Profiles';

/** Profile names index a keychain account, so they must stay addressable. */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

const PASSWORD_ACCOUNT = 'password';
const SUDO_ACCOUNT = 'sudo';

export function isValidSshProfileName(name: string): boolean {
  return PROFILE_NAME_PATTERN.test(name);
}

/**
 * The settings surface this service needs.
 *
 * Core cannot depend on the CLI's `LoadedSettings`, so the CLI passes an
 * adapter over it. Keeping the port this narrow is what lets the service stay
 * in core while the reads and writes keep settings' format-preserving logic.
 */
export interface SshProfileSettingsPort {
  /** The merged settings object holding `sshProfiles`. */
  read(): Record<string, unknown>;
  /** Writes `sshProfiles` into the user-scoped settings file. */
  writeProfiles(profiles: Record<string, unknown>): void;
}

/**
 * The on-disk shape of one saved profile. Parsed once at this boundary so the
 * rest of the codebase works with a named type rather than a record guard.
 */
const StoredProfileSchema = z.object({
  host: z.string().min(1),
  user: z.string().min(1),
  port: z.number().int().min(1).max(65535).default(DEFAULT_SSH_PORT),
  identityFile: z.string().optional(),
  hasSudoPassword: z.boolean().optional(),
});

const StoredProfilesSchema = z.record(z.string(), StoredProfileSchema);

/**
 * Reads and writes the SSH profile list.
 *
 * Non-secret fields (host, user, port, key path) live in the user-scoped
 * settings file alongside every other global entry; the two passwords live in
 * the OS keychain. A profile stays usable when the keychain has no entry for
 * it — it just authenticates by key.
 */
export class SshProfileService {
  private readonly keychain: KeychainService;

  constructor(private readonly settings: SshProfileSettingsPort) {
    this.keychain = new KeychainService(SSH_KEYCHAIN_SERVICE);
  }

  private activeProfileName?: string;

  /**
   * The profile `/ssh` last selected.
   *
   * Session state rather than stored state: it is what lets the agent call
   * `ssh_exec` without naming a profile every time, and it disappears with the
   * process so a new session never inherits a host the user did not pick.
   */
  getActiveProfile(): SshProfile | null {
    return this.activeProfileName ? this.get(this.activeProfileName) : null;
  }

  /** Returns the named profile and makes it the active one. */
  activate(name: string): SshProfile {
    const profile = this.get(name);
    if (!profile) {
      throw new Error(`No SSH profile named "${name}".`);
    }
    this.activeProfileName = name;
    return profile;
  }

  clearActiveProfile(): void {
    this.activeProfileName = undefined;
  }

  /** Returns every stored profile, sorted by name. */
  list(): SshProfile[] {
    const parsed = StoredProfilesSchema.safeParse(
      this.settings.read()['sshProfiles'],
    );
    if (!parsed.success) {
      return [];
    }
    return Object.entries(parsed.data)
      .map(([name, entry]) => ({ name, ...entry }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): SshProfile | null {
    return this.list().find((profile) => profile.name === name) ?? null;
  }

  /**
   * Persists a profile's non-secret fields.
   *
   * `hasSudoPassword` is not taken from the argument: it reflects keychain
   * state, which {@link setPasswords} owns. Carrying it forward from the
   * stored profile keeps a re-save from silently revoking sudo, while a profile
   * that never had one cannot claim it.
   */
  save(profile: Omit<SshProfile, 'hasSudoPassword'>): SshProfile {
    if (!isValidSshProfileName(profile.name)) {
      throw new Error(
        `Invalid SSH profile name "${profile.name}". Use letters, digits, dot, dash or underscore (max 64 characters).`,
      );
    }

    const candidate = StoredProfileSchema.parse({
      host: profile.host.trim(),
      user: profile.user.trim(),
      port: profile.port,
      identityFile: profile.identityFile?.trim() || undefined,
    });
    const hasSudoPassword = this.get(profile.name)?.hasSudoPassword === true;

    const stored = this.raw();
    stored[profile.name] = hasSudoPassword
      ? { ...candidate, hasSudoPassword: true }
      : candidate;
    this.settings.writeProfiles(stored);

    return {
      name: profile.name,
      ...candidate,
      ...(hasSudoPassword && { hasSudoPassword: true }),
    };
  }

  /**
   * Stores the passwords for a profile and keeps the stored sudo flag in step
   * with the keychain.
   *
   * Omitting `sudoPassword` clears any stored entry, which is what makes the
   * agent refuse `sudo` on that host; passing an empty string does the same,
   * so "no sudo here" is reachable without deleting the profile. Leaving it
   * undefined leaves the existing entry untouched, which is what lets
   * re-running `/ssh-add` to fix a host not silently revoke sudo.
   */
  async setPasswords(
    name: string,
    passwords: { password?: string; sudoPassword?: string },
  ): Promise<void> {
    await this.setOrDelete(`${name}/${PASSWORD_ACCOUNT}`, passwords.password);

    const sudoPassword =
      passwords.sudoPassword === undefined
        ? await this.getSudoPassword(name)
        : passwords.sudoPassword;
    await this.setOrDelete(
      `${name}/${SUDO_ACCOUNT}`,
      sudoPassword || undefined,
    );

    if (sudoPassword) {
      this.markSudoAvailable(name);
    }
  }

  /** Mirrors the keychain's sudo state into settings, so `/ssh` can show it. */
  private markSudoAvailable(name: string): void {
    const stored = this.raw();
    const entry = stored[name];
    if (typeof entry !== 'object' || entry === null) {
      return;
    }
    stored[name] = { ...entry, hasSudoPassword: true };
    this.settings.writeProfiles(stored);
  }

  getPassword(name: string): Promise<string | null> {
    return this.keychain.getPassword(`${name}/${PASSWORD_ACCOUNT}`);
  }

  getSudoPassword(name: string): Promise<string | null> {
    return this.keychain.getPassword(`${name}/${SUDO_ACCOUNT}`);
  }

  /** Removes a profile and both of its keychain entries. */
  async remove(name: string): Promise<void> {
    const stored = this.raw();
    delete stored[name];
    this.settings.writeProfiles(stored);

    await this.setOrDelete(`${name}/${PASSWORD_ACCOUNT}`, undefined);
    await this.setOrDelete(`${name}/${SUDO_ACCOUNT}`, undefined);
  }

  /**
   * Reports whether a usable password or key exists, so the UI can warn
   * before an agent call fails on authentication.
   */
  async hasAuthentication(profile: SshProfile): Promise<boolean> {
    if (profile.identityFile) {
      return true;
    }
    return (await this.getPassword(profile.name)) !== null;
  }

  private async setOrDelete(
    account: string,
    value: string | undefined,
  ): Promise<void> {
    if (value === undefined) {
      await this.keychain.deletePassword(account);
      return;
    }
    await this.keychain.setPassword(account, value);
  }

  private raw(): Record<string, unknown> {
    // Absent until the first /ssh-add, and a parse failure means the file was
    // edited by hand; both are treated as "no profiles yet" so one bad entry
    // cannot make every other command throw.
    const parsed = StoredProfilesSchema.safeParse(
      this.settings.read()['sshProfiles'],
    );
    return parsed.success ? { ...parsed.data } : {};
  }
}
