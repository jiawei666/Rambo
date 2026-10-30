import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { extname, posix, win32 } from 'node:path';

export interface CommandEnvironmentOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
}

export interface TerminateProcessOptions {
  platform?: NodeJS.Platform;
  graceMs?: number;
  processGroup?: boolean;
}

export interface NpxInvocation {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

export interface CommandInvocationOptions {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  cwd?: string;
  exists?: (path: string) => boolean;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  return values.find(value => Boolean(value?.trim()));
}

function pathApi(platform: NodeJS.Platform): typeof posix {
  return platform === 'win32' ? win32 : posix;
}

export function pathDelimiter(platform: NodeJS.Platform = process.platform): string {
  return platform === 'win32' ? ';' : ':';
}

/**
 * Build a deliberately small child environment. Parent secrets are not
 * inherited; only operating-system essentials plus the caller's secret map.
 */
export function commandEnvironment(
  secretEnvironment: Record<string, string>,
  options: CommandEnvironmentOptions = {}
): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const source = options.environment ?? process.env;
  if (platform === 'win32') {
    const userProfile = firstNonEmpty(source.USERPROFILE, source.HOME, homedir());
    const temp = firstNonEmpty(source.TEMP, source.TMP, tmpdir());
    const base: NodeJS.ProcessEnv = {
      PATH: firstNonEmpty(source.PATH, source.Path) ?? 'C:\\Windows\\System32;C:\\Windows',
      SystemRoot: firstNonEmpty(source.SystemRoot, source.WINDIR) ?? 'C:\\Windows',
      WINDIR: firstNonEmpty(source.WINDIR, source.SystemRoot) ?? 'C:\\Windows',
      ComSpec: firstNonEmpty(source.ComSpec, source.COMSPEC) ?? 'C:\\Windows\\System32\\cmd.exe',
      PATHEXT: firstNonEmpty(source.PATHEXT) ?? '.COM;.EXE;.BAT;.CMD',
      USERPROFILE: userProfile,
      HOME: source.HOME ?? userProfile,
      HOMEDRIVE: source.HOMEDRIVE ?? (userProfile ? userProfile.slice(0, 2) : undefined),
      HOMEPATH: source.HOMEPATH ?? (userProfile ? userProfile.slice(2) : undefined),
      APPDATA: source.APPDATA,
      LOCALAPPDATA: source.LOCALAPPDATA,
      TEMP: temp,
      TMP: temp,
      TZ: source.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
    };
    return Object.fromEntries(
      Object.entries({ ...base, ...secretEnvironment })
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
    );
  }
  const base: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: source.HOME ?? homedir(),
    TMPDIR: source.TMPDIR ?? tmpdir(),
    LANG: source.LANG ?? 'zh_CN.UTF-8',
    TZ: source.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone
  };
  return { ...base, ...secretEnvironment };
}

export function terminateProcessTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  options: TerminateProcessOptions = {}
): void {
  if (!child.pid) {
    try {
      child.kill('SIGTERM');
    } catch {
      // A spawn failure may not have produced a process to terminate.
    }
    return;
  }
  const platform = options.platform ?? process.platform;
  const signal = (value: NodeJS.Signals) => {
    try {
      if (platform !== 'win32' && options.processGroup) process.kill(-child.pid!, value);
      else child.kill(value);
    } catch {
      // The process may have exited between timeout and signal delivery.
    }
  };
  if (platform === 'win32') {
    try {
      const systemRoot = firstNonEmpty(process.env.SystemRoot, process.env.WINDIR, 'C:\\Windows')!;
      const taskkill = win32.join(systemRoot, 'System32', 'taskkill.exe');
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true
      });
      killer.on('error', () => signal('SIGTERM'));
      killer.unref();
    } catch {
      signal('SIGTERM');
    }
    setTimeout(() => signal('SIGKILL'), options.graceMs ?? 500).unref();
    return;
  }
  signal('SIGTERM');
  setTimeout(() => signal('SIGKILL'), options.graceMs ?? 500).unref();
}

export async function terminateProcessTreeAsync(
  child: ChildProcess,
  options: TerminateProcessOptions = {}
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  terminateProcessTree(child, options);
  await new Promise<void>(resolve => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.off('exit', finish);
      child.off('close', finish);
      resolve();
    };
    child.once('exit', finish);
    child.once('close', finish);
    timer = setTimeout(finish, (options.graceMs ?? 500) + 3_000);
  });
}

function executableCandidates(
  directory: string,
  name: string,
  platform: NodeJS.Platform,
  pathExt: string | undefined
): string[] {
  const api = pathApi(platform);
  if (platform !== 'win32') return [api.join(directory, name)];
  if (api.extname(name)) return [api.join(directory, name)];
  const extensions = (pathExt ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map(value => value.trim().toLocaleLowerCase('en-US'))
    .filter(Boolean);
  return [
    ...new Set([
      ...extensions.map(extension => api.join(directory, `${name}${extension}`)),
      api.join(directory, name)
    ])
  ];
}

export function findNpx(options: {
  platform?: NodeJS.Platform;
  environment?: NodeJS.ProcessEnv;
  home?: string;
  exists?: (path: string) => boolean;
} = {}): string | null {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const api = pathApi(platform);
  const home = options.home ?? environment.USERPROFILE ?? environment.HOME ?? homedir();
  const candidates = new Set<string>();
  const pathValue = firstNonEmpty(environment.PATH, environment.Path) ?? '';
  for (const directory of pathValue.split(pathDelimiter(platform)).filter(Boolean)) {
    const cleanDirectory = directory.trim().replace(/^"(.*)"$/u, '$1');
    if (!cleanDirectory) continue;
    for (const candidate of executableCandidates(
      cleanDirectory,
      'npx',
      platform,
      environment.PATHEXT
    )) {
      candidates.add(candidate);
    }
  }
  const directories = platform === 'win32'
    ? [
        firstNonEmpty(environment.APPDATA, api.join(home, 'AppData/Roaming')),
        api.join(firstNonEmpty(environment.APPDATA, api.join(home, 'AppData/Roaming'))!, 'npm'),
        firstNonEmpty(environment.ProgramFiles, 'C:\\Program Files'),
        api.join(firstNonEmpty(environment.ProgramFiles, 'C:\\Program Files')!, 'nodejs'),
        firstNonEmpty(environment['ProgramFiles(x86)'], 'C:\\Program Files (x86)'),
        api.join(firstNonEmpty(environment['ProgramFiles(x86)'], 'C:\\Program Files (x86)')!, 'nodejs'),
        firstNonEmpty(environment.LOCALAPPDATA, api.join(home, 'AppData/Local')),
        api.join(firstNonEmpty(environment.LOCALAPPDATA, api.join(home, 'AppData/Local'))!, 'Programs/nodejs'),
        api.join(firstNonEmpty(environment.LOCALAPPDATA, api.join(home, 'AppData/Local'))!, 'Volta/bin'),
        environment.NVM_HOME,
        environment.NVM_SYMLINK
      ]
    : [
        api.join(home, '.local/bin'),
        api.join(home, '.volta/bin'),
        api.join(home, '.asdf/shims'),
        api.join(home, '.nvm/versions/node/current/bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin'
      ];
  for (const directory of directories.filter((value): value is string => Boolean(value))) {
    for (const candidate of executableCandidates(directory, 'npx', platform, environment.PATHEXT)) {
      candidates.add(candidate);
    }
  }
  if (platform !== 'win32') {
    for (const nodeVersions of [
      api.join(home, '.nvm/versions/node'),
      api.join(home, '.local/share/fnm/node-versions')
    ]) {
      try {
        for (const version of readdirSync(nodeVersions).sort().reverse()) {
          for (const candidate of executableCandidates(
            api.join(nodeVersions, version, 'bin'),
            'npx',
            platform,
            environment.PATHEXT
          )) candidates.add(candidate);
          for (const candidate of executableCandidates(
            api.join(nodeVersions, version, 'installation/bin'),
            'npx',
            platform,
            environment.PATHEXT
          )) candidates.add(candidate);
        }
      } catch {
        // Optional Node version-manager directory.
      }
    }
  }
  const exists = options.exists ?? existsSync;
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate;
  }
  return null;
}

const CMD_META_CHARS = /([()\][%!^"`<>&|;, *?])/gu;

function escapeCmdCommand(value: string): string {
  return value.replace(CMD_META_CHARS, '^$1');
}

function escapeCmdArgument(value: string, doubleEscapeMetaChars = false): string {
  if (value === '') return '""';
  let escaped = value.replace(/(\\*)"/gu, '$1$1\\"');
  escaped = escaped.replace(/(\\*)$/u, '$1$1');
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META_CHARS, '^$1');
  return doubleEscapeMetaChars
    ? escaped.replace(CMD_META_CHARS, '^$1')
    : escaped;
}

function unquoteCommand(value: string): string {
  const trimmed = value.trim();
  return trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

function resolveWindowsCommand(
  executable: string,
  environment: NodeJS.ProcessEnv,
  cwd: string | undefined,
  exists: (path: string) => boolean
): string {
  const command = unquoteCommand(executable);
  if (!command) return command;
  const workingDirectory = cwd?.trim() || environment.USERPROFILE ||
    environment.HOME || homedir();
  const candidates: string[] = [];
  if (win32.isAbsolute(command) || /[\\/]/u.test(command)) {
    const base = win32.isAbsolute(command)
      ? command
      : win32.resolve(workingDirectory, command);
    candidates.push(...executableCandidates(
      win32.dirname(base),
      win32.basename(base),
      'win32',
      environment.PATHEXT
    ));
  } else {
    const directories = [
      win32.resolve(workingDirectory),
      ...(environment.PATH ?? environment.Path ?? '')
        .split(pathDelimiter('win32'))
        .map(value => value.trim().replace(/^"(.*)"$/u, '$1'))
        .filter(Boolean)
    ];
    for (const directory of new Set(directories)) {
      candidates.push(...executableCandidates(
        directory,
        command,
        'win32',
        environment.PATHEXT
      ));
    }
  }
  return candidates.find(exists) ?? command;
}

/**
 * Invoke a native executable or npm-style cmd shim without letting callers
 * concatenate untrusted shell strings. Windows command names are resolved
 * through cwd/PATH/PATHEXT before deciding whether cmd.exe is required.
 */
export function commandInvocation(
  executable: string,
  args: readonly string[],
  options: CommandInvocationOptions = {}
): NpxInvocation {
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const resolved = platform === 'win32'
    ? resolveWindowsCommand(
        executable,
        environment,
        options.cwd,
        options.exists ?? existsSync
      )
    : executable;
  const extension = win32.extname(resolved).toLocaleLowerCase('en-US');
  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    const command = firstNonEmpty(environment.ComSpec, environment.COMSPEC,
      'C:\\Windows\\System32\\cmd.exe')!;
    const commandLine = [
      escapeCmdCommand(resolved),
      ...args.map(value => escapeCmdArgument(
        value,
        /node_modules[\\/]\.bin[\\/][^\\/]+\.cmd$/iu.test(resolved)
      ))
    ].join(' ');
    return {
      command,
      args: ['/d', '/s', '/c', `"${commandLine}"`],
      windowsVerbatimArguments: true
    };
  }
  return { command: resolved, args: [...args] };
}

export function npxInvocation(
  executable: string,
  args: readonly string[],
  options: CommandInvocationOptions = {}
): NpxInvocation {
  return commandInvocation(executable, args, options);
}
