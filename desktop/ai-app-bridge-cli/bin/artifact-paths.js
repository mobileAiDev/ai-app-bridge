const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { requestDirectory } = require('./shared-kernel/request-context');

const artifactDirectoryName = 'ai_app_bridge_artifacts';
const generatedArtifactRetention = 20;
const generatedArtifactMaxAgeMs = 24 * 60 * 60 * 1000;
const generatedArtifactMaxBytes = 64 * 1024 * 1024;

function defaultArtifactDirectory(options = {}) {
  const cwd = path.resolve(options.cwd || requestDirectory());
  const gitRoot = gitOutput(cwd, ['rev-parse', '--show-toplevel']);
  if (!gitRoot) {
    return path.join(cwd, 'build', artifactDirectoryName);
  }

  for (const projectRoot of projectRoots(cwd, gitRoot)) {
    for (const directory of artifactDirectoryCandidates(projectRoot)) {
      if (isGitIgnored(gitRoot, directory)) {
        return directory;
      }
    }
  }

  const gitDirectory = gitOutput(cwd, ['rev-parse', '--absolute-git-dir']);
  return path.join(gitDirectory || path.join(gitRoot, '.git'), artifactDirectoryName);
}

function defaultArtifactPath(prefix, extension, options = {}) {
  const directory = path.resolve(options.artifactDir || defaultArtifactDirectory({ cwd: options.cwd }));
  const suffix = [
    artifactTimestamp(options.now || new Date()),
    String(options.pid || process.pid),
    options.randomSuffix || Math.random().toString(36).slice(2, 8),
  ].join('-');
  const name = `${sanitizeArtifactName(prefix)}-${suffix}.${sanitizeArtifactExtension(extension)}`;
  return path.join(directory, name);
}

async function pruneGeneratedArtifacts(options = {}) {
  const keep = positiveIntegerOption(options.keep, generatedArtifactRetention);
  const maxAgeMs = nonNegativeNumberOption(options.maxAgeMs, generatedArtifactMaxAgeMs);
  const maxBytes = nonNegativeNumberOption(options.maxBytes, generatedArtifactMaxBytes);
  const nowMs = finiteNumberOption(options.nowMs, Date.now());
  const result = {
    keep,
    maxAgeMs,
    maxBytes,
    matched: 0,
    deleted: 0,
    deletedExpired: 0,
    deletedForCount: 0,
    deletedForBytes: 0,
    bytesBefore: 0,
    bytesAfter: 0,
  };
  const directory = path.resolve(options.directory || requestDirectory());
  const prefix = sanitizeArtifactName(options.prefix || 'artifact');
  const extension = sanitizeArtifactExtension(options.extension || 'bin');
  const currentPath = options.currentPath ? path.resolve(options.currentPath) : '';
  const pattern = new RegExp(`^${escapeRegExp(prefix)}-\\d{8}-\\d{6}-\\d{3}-\\d+-[a-z0-9]+\\.${escapeRegExp(extension)}$`);

  let entries;
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    return { ...result, error: firstErrorLine(error) };
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !pattern.test(entry.name)) continue;
    const filePath = path.join(directory, entry.name);
    try {
      const stat = await fs.promises.stat(filePath);
      files.push({
        name: entry.name,
        path: path.resolve(filePath),
        mtimeMs: stat.mtimeMs,
        size: stat.size,
      });
    } catch (_) {
      // Ignore files that disappear while pruning.
    }
  }

  result.matched = files.length;
  result.bytesBefore = files.reduce((total, file) => total + file.size, 0);
  result.bytesAfter = result.bytesBefore;
  files.sort((left, right) => (right.mtimeMs - left.mtimeMs) || right.name.localeCompare(left.name));

  const keepSet = new Set();
  let retainedBytes = 0;
  const current = files.find((file) => file.path === currentPath);
  if (current) {
    keepSet.add(current.path);
    retainedBytes += current.size;
  }

  const deletionReasons = new Map();
  const expiresBeforeMs = nowMs - maxAgeMs;
  for (const file of files) {
    if (keepSet.has(file.path)) continue;
    if (file.mtimeMs < expiresBeforeMs) {
      deletionReasons.set(file.path, 'expired');
      continue;
    }
    if (keepSet.size >= keep) {
      deletionReasons.set(file.path, 'count');
      continue;
    }
    if (retainedBytes + file.size > maxBytes) {
      deletionReasons.set(file.path, 'bytes');
      continue;
    }
    keepSet.add(file.path);
    retainedBytes += file.size;
  }

  for (const file of files) {
    const reason = deletionReasons.get(file.path);
    if (!reason) continue;
    try {
      await fs.promises.rm(file.path, { force: true });
      result.deleted += 1;
      result.bytesAfter -= file.size;
      if (reason === 'expired') result.deletedExpired += 1;
      if (reason === 'count') result.deletedForCount += 1;
      if (reason === 'bytes') result.deletedForBytes += 1;
    } catch (_) {
      // Pruning is best-effort and should not make screenshot capture fail.
    }
  }
  result.overBudgetBytes = Math.max(0, result.bytesAfter - maxBytes);
  return result;
}

function projectRoots(cwd, gitRoot) {
  const roots = [];
  const resolvedGitRoot = path.resolve(gitRoot);
  let current = path.resolve(cwd);

  while (current === resolvedGitRoot || current.startsWith(`${resolvedGitRoot}${path.sep}`)) {
    if (isProjectRoot(current)) {
      roots.push(current);
    }
    if (current === resolvedGitRoot) {
      break;
    }
    current = path.dirname(current);
  }

  if (!roots.includes(resolvedGitRoot)) {
    roots.push(resolvedGitRoot);
  }
  return roots;
}

function isProjectRoot(directory) {
  return hasAny(directory, [
    'settings.gradle',
    'settings.gradle.kts',
    'build.gradle',
    'build.gradle.kts',
    'gradlew',
    'pubspec.yaml',
    'Package.swift',
    'package.json',
    'Cargo.toml',
  ]);
}

function artifactDirectoryCandidates(gitRoot) {
  const root = path.resolve(gitRoot);
  const candidates = [];

  if (hasAny(root, ['settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts', 'gradlew', 'pubspec.yaml'])) {
    candidates.push(path.join(root, 'build', artifactDirectoryName));
  }
  if (hasAny(root, ['Package.swift'])) {
    candidates.push(path.join(root, '.build', artifactDirectoryName));
  }
  if (hasAny(root, ['pubspec.yaml'])) {
    candidates.push(path.join(root, '.dart_tool', artifactDirectoryName));
  }
  if (hasAny(root, ['package.json'])) {
    candidates.push(path.join(root, 'node_modules', '.cache', artifactDirectoryName));
  }
  if (hasAny(root, ['Cargo.toml'])) {
    candidates.push(path.join(root, 'target', artifactDirectoryName));
  }

  candidates.push(
    path.join(root, 'build', artifactDirectoryName),
    path.join(root, '.build', artifactDirectoryName),
    path.join(root, '.dart_tool', artifactDirectoryName),
    path.join(root, 'node_modules', '.cache', artifactDirectoryName),
    path.join(root, 'target', artifactDirectoryName),
  );

  return [...new Set(candidates)];
}

function hasAny(root, fileNames) {
  return fileNames.some((fileName) => fs.existsSync(path.join(root, fileName)));
}

function isGitIgnored(gitRoot, directory) {
  const relative = path.relative(gitRoot, directory);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    return false;
  }
  try {
    execFileSync('git', ['-C', gitRoot, 'check-ignore', '-q', '--', relative], {
      stdio: 'ignore',
      timeout: 2000,
    });
    return true;
  } catch (_) {
    return false;
  }
}

function gitOutput(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    }).trim();
  } catch (_) {
    return '';
  }
}

function artifactTimestamp(date) {
  const value = date instanceof Date ? date : new Date(date);
  const pad = (number, size = 2) => String(number).padStart(size, '0');
  return [
    value.getUTCFullYear(),
    pad(value.getUTCMonth() + 1),
    pad(value.getUTCDate()),
    '-',
    pad(value.getUTCHours()),
    pad(value.getUTCMinutes()),
    pad(value.getUTCSeconds()),
    '-',
    pad(value.getUTCMilliseconds(), 3),
  ].join('');
}

function sanitizeArtifactName(value) {
  return String(value || 'artifact').replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '') || 'artifact';
}

function sanitizeArtifactExtension(value) {
  return sanitizeArtifactName(String(value || 'bin').replace(/^\.+/, '')) || 'bin';
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function firstErrorLine(error) {
  return String(error?.message || error || 'unknown error').split(/\r?\n/, 1)[0];
}

function positiveIntegerOption(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : fallback;
}

function nonNegativeNumberOption(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function finiteNumberOption(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

module.exports = {
  artifactDirectoryCandidates,
  artifactTimestamp,
  defaultArtifactDirectory,
  defaultArtifactPath,
  pruneGeneratedArtifacts,
  sanitizeArtifactExtension,
  sanitizeArtifactName,
};
