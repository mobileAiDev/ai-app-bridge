const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const artifactDirectoryName = 'ai_app_bridge_artifacts';

function defaultArtifactDirectory(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const gitRoot = gitOutput(cwd, ['rev-parse', '--show-toplevel']);
  if (!gitRoot) {
    return path.join(cwd, 'build', artifactDirectoryName);
  }

  for (const directory of artifactDirectoryCandidates(gitRoot)) {
    if (isGitIgnored(gitRoot, directory)) {
      return directory;
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

module.exports = {
  artifactDirectoryCandidates,
  artifactTimestamp,
  defaultArtifactDirectory,
  defaultArtifactPath,
  sanitizeArtifactExtension,
  sanitizeArtifactName,
};
