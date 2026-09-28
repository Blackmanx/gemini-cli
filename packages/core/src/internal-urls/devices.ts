/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The `xd://` device layer: a session-bound registry of virtual tools that
 * `read xd://` lists and `write xd://<device>` dispatches to.
 *
 * A device is addressed by name, never by path, so {@link isDeviceName} is
 * deliberately strict: no slashes, no dots, no colons, alphanumeric plus dash
 * and underscore. A real filename can never be mistaken for a device, and a
 * device name can never be mistaken for a path.
 */

/** Canonical prefix for virtual tool-device URLs. */
export const XD_URL_PREFIX = 'xd://';

/** Result of one device invocation. */
export interface DeviceResult {
  /** Value handed back to the model; shaped by the device's own schema. */
  content: unknown;
  /** True when the device ran but the operation failed. */
  isError?: boolean;
}

/** One mountable virtual tool. */
export interface DeviceDefinition {
  /** Canonical device name, as it appears after `xd://`. */
  name: string;
  /** One-line summary shown in the `read xd://` listing. */
  description: string;
  /** JSON schema for the args object `write xd://<device>` sends. */
  inputSchema: Record<string, unknown>;
  /** Run the device. Rejections surface as the write's error result. */
  run(args: Record<string, unknown>): Promise<DeviceResult>;
}

/** Device names are short, opaque tokens: no path, query or colon syntax. */
const DEVICE_NAME_RE = /^[A-Za-z0-9_-]+$/;

/**
 * Whether `name` can address a device. Conservative by construction: a name
 * with a slash, dot, colon or whitespace is not a device, so `read
 * ./report.final.ts` is never routed to the device layer.
 */
export function isDeviceName(name: string): boolean {
  return name.length > 0 && DEVICE_NAME_RE.test(name);
}

/** The set of devices a session has mounted under `xd://`. */
export class DeviceRegistry {
  readonly #devices = new Map<string, DeviceDefinition>();

  /** Mount a device, replacing any earlier device of the same name. */
  register(device: DeviceDefinition): void {
    this.#devices.set(device.name, device);
  }

  /** Whether `name` is mounted. */
  has(name: string): boolean {
    return this.#devices.has(name);
  }

  /** Every mounted device, in registration order. */
  list(): DeviceDefinition[] {
    return Array.from(this.#devices.values());
  }

  /** The mounted device called `name`, or `undefined`. */
  get(name: string): DeviceDefinition | undefined {
    return this.#devices.get(name);
  }
}

/** Width of the name column in the `read xd://` listing. */
const NAME_COLUMN = 14;

/** The text `read xd://` renders: a header, one row per device, and usage. */
export function deviceListing(registry: DeviceRegistry): string {
  const rows = registry
    .list()
    .map(
      (device) =>
        `${XD_URL_PREFIX}${device.name.padEnd(NAME_COLUMN)} ${device.description}`,
    );
  return [
    `${XD_URL_PREFIX} ${registry.list().length} mounted tool devices.`,
    ...rows,
    '',
    `Read ${XD_URL_PREFIX}<device> for its JSON schema; write the JSON args object to ${XD_URL_PREFIX}<device> to execute it.`,
  ].join('\n');
}
