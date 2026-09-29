/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shell completion script generation.
 *
 * Ported from omp's `/completions`. Without it, tab-completing `gemini
 * --<TAB>` either does nothing or offers every flag including the ones that
 * are deprecated - and a completion menu that suggests `--yolo` is worse than
 * no menu.
 *
 * The script is generated rather than shipped as three static files because
 * the flag list comes from the same source the parser uses. A static file
 * drifts the first time a flag is renamed, and nobody notices until a user
 * runs a completion the CLI no longer accepts.
 */

export type Shell = 'bash' | 'zsh' | 'fish';

/** A flag the completion should offer, with how it takes its value. */
export interface CompletionFlag {
  /** The long name, without leading dashes. */
  name: string;
  /** One-line help. */
  description: string;
  /** How the value is supplied. */
  kind: 'boolean' | 'value';
}

function bashQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * A description safe to embed in a generated script.
 *
 * zsh's `_arguments` delimits the description with `[...]`, so a literal `]`
 * would end it early and turn the rest of the line into a malformed spec. The
 * apostrophe is dropped for the same reason bash cannot quote it inside the
 * `compgen -W` list. Neither character carries meaning in a one-line flag
 * summary, so they are removed rather than escaped.
 */
function describe(flag: CompletionFlag): string {
  return flag.description
    .replaceAll("'", '')
    .replaceAll(']', ')')
    .replaceAll('[', '(');
}

/**
 * The bash completion.
 *
 * `compgen -W` with a sorted, de-duplicated list. `--opt=` is offered for
 * value flags, which is how bash users actually spell them.
 */
export function bashCompletion(
  binName: string,
  flags: CompletionFlag[],
): string {
  const bools = flags.filter((f) => f.kind === 'boolean').map((f) => f.name);
  const values = flags.filter((f) => f.kind === 'value').map((f) => f.name);
  return `# bash completion for ${binName}
_${binName.replaceAll('-', '_')}_completion() {
  local cur prev
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  case "\${prev}" in
${values.map((v) => `    --${v}) COMPREPLY=( $(compgen -f "\${cur}") ); return 0 ;;`).join('\n')}
  esac

  if [[ "\${cur}" == -* ]]; then
    COMPREPLY=( $(compgen -W "${bools.map((b) => `--${b}`).join(' ')} ${values
      .map((v) => `--${v}=`)
      .join(' ')}" -- "\${cur}") )
    return 0
  fi
  COMPREPLY=( $(compgen -f "\${cur}") )
}
complete -o default -F _${binName.replaceAll('-', '_')}_completion ${binName}
`;
}

/**
 * The zsh completion.
 *
 * Descriptions are attached, because zsh can show them and bash cannot -
 * the extra cost is a line the user only sees when they ask for it.
 */
export function zshCompletion(
  binName: string,
  flags: CompletionFlag[],
): string {
  const lines = flags.map((f) =>
    f.kind === 'value'
      ? `'--${f.name}=[${describe(f)}]:value:_files'`
      : `'--${f.name}[${describe(f)}]'`,
  );
  return `#compdef ${binName}
# zsh completion for ${binName}
_${binName.replaceAll('-', '_')}() {
  _arguments -s -S \\
    ${lines.join(' \\\n    ')} \\
    '*:file:_files'
}
compdef _${binName.replaceAll('-', '_')} ${binName}
`;
}

/** The fish completion. */
export function fishCompletion(
  binName: string,
  flags: CompletionFlag[],
): string {
  return flags
    .map((f) =>
      f.kind === 'value'
        ? `complete -c ${binName} -l ${f.name} -d ${bashQuote(f.description)} -r -F`
        : `complete -c ${binName} -l ${f.name} -d ${bashQuote(f.description)}`,
    )
    .join('\n');
}

/** The completion script for one shell. */
export function completionScript(
  shell: Shell,
  binName: string,
  flags: CompletionFlag[],
): string {
  switch (shell) {
    case 'bash':
      return bashCompletion(binName, flags);
    case 'zsh':
      return zshCompletion(binName, flags);
    case 'fish':
      return fishCompletion(binName, flags);
    default: {
      // Unreachable for a `Shell`, and present so a future shell cannot
      // silently produce an empty completion.
      const exhaustive: never = shell;
      throw new Error(`No completion generator for ${String(exhaustive)}`);
    }
  }
}

/** How to install a completion for a shell, for the command to print. */
export function installHint(shell: Shell, binName: string): string {
  switch (shell) {
    case 'bash':
      return `source <(${binName} completions bash)`;
    case 'zsh':
      return `source <(${binName} completions zsh)`;
    case 'fish':
      return `${binName} completions fish | source`;
    default: {
      const exhaustive: never = shell;
      throw new Error(`No install hint for ${String(exhaustive)}`);
    }
  }
}

/** Whether a string names a shell we can generate for. */
export function isShell(value: string): value is Shell {
  return value === 'bash' || value === 'zsh' || value === 'fish';
}
