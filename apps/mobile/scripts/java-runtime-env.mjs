import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

const MIN_JAVA_MAJOR = 17;

export function resolveJavaRuntimeEnv(baseEnv = process.env) {
  const current = javaMajor(versionForJavaCommand('java', baseEnv));
  if (current >= MIN_JAVA_MAJOR) {
    const env = { ...baseEnv };
    if (baseEnv.JAVA_HOME) {
      const javaBin = join(baseEnv.JAVA_HOME, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      const homeMajor = javaMajor(versionForJavaCommand(javaBin, baseEnv));
      // Gradle prefers JAVA_HOME over PATH. Drop an unusable override so it uses
      // the supported PATH Java we just checked, without changing the parent env.
      if (!(homeMajor >= MIN_JAVA_MAJOR)) delete env.JAVA_HOME;
    }
    return env;
  }

  for (const javaHome of javaHomeCandidates(baseEnv)) {
    if (!javaHome) continue;
    const javaBin = join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
    if (!existsSync(javaBin)) continue;
    const major = javaMajor(versionForJavaCommand(javaBin, { ...baseEnv, JAVA_HOME: javaHome }));
    if (major < MIN_JAVA_MAJOR) continue;
    return {
      ...baseEnv,
      JAVA_HOME: javaHome,
      PATH: [join(javaHome, 'bin'), baseEnv.PATH].filter(Boolean).join(delimiter),
    };
  }

  return { ...baseEnv };
}

export function javaRuntimeDetail(env = resolveJavaRuntimeEnv()) {
  const version = versionForJavaCommand('java', env);
  const major = javaMajor(version);
  if (!Number.isFinite(major)) return 'java version unavailable';
  return `Java ${major}${env.JAVA_HOME ? ` at ${env.JAVA_HOME}` : ''}`;
}

function javaHomeCandidates(env) {
  return [
    env.JAVA_HOME,
    env.ANDROID_STUDIO_JDK,
    ...(process.platform === 'win32' ? windowsAndroidStudioJavaHomes(env) : []),
    macJavaHome('17'),
    homebrewOpenJdk17Home('/opt/homebrew/opt/openjdk@17'),
    homebrewOpenJdk17Home('/usr/local/opt/openjdk@17'),
    brewPrefixOpenJdk17Home(),
  ].filter(uniqueTruthy);
}

function windowsAndroidStudioJavaHomes(env) {
  return [
    env.ANDROID_STUDIO_HOME ? join(env.ANDROID_STUDIO_HOME, 'jbr') : null,
    env.ProgramFiles ? join(env.ProgramFiles, 'Android', 'Android Studio', 'jbr') : null,
    env['ProgramFiles(x86)'] ? join(env['ProgramFiles(x86)'], 'Android', 'Android Studio', 'jbr') : null,
    env.LOCALAPPDATA ? join(env.LOCALAPPDATA, 'Programs', 'Android Studio', 'jbr') : null,
  ];
}

function macJavaHome(version) {
  if (process.platform !== 'darwin') return null;
  const result = spawnSync('/usr/libexec/java_home', ['-v', version], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function homebrewOpenJdk17Home(prefix) {
  const bundledHome = join(prefix, 'libexec', 'openjdk.jdk', 'Contents', 'Home');
  if (existsSync(join(bundledHome, 'bin', 'java'))) return bundledHome;
  if (existsSync(join(prefix, 'bin', 'java'))) return prefix;
  return null;
}

function brewPrefixOpenJdk17Home() {
  const result = spawnSync('brew', ['--prefix', 'openjdk@17'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  return homebrewOpenJdk17Home(result.stdout.trim());
}

function versionForJavaCommand(command, env) {
  const result = spawnSync(command, ['-version'], { encoding: 'utf8', env });
  if (result.error || result.status !== 0) return '';
  return `${result.stderr}\n${result.stdout}`;
}

function javaMajor(versionOutput) {
  const match = versionOutput.match(/version "(?<version>\d+)(?:\.(?<minor>\d+))?/);
  if (!match?.groups) return Number.NaN;
  const major = Number.parseInt(match.groups.version, 10);
  if (major === 1 && match.groups.minor) return Number.parseInt(match.groups.minor, 10);
  return major;
}

function uniqueTruthy(value, index, array) {
  return !!value && array.indexOf(value) === index;
}
