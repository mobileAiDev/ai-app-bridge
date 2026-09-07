'use strict';

async function openMoviesAndPlay(ctx, labels) {
  await callOk(ctx, 'tap', { tapX: 540, tapY: 2292 });
  await callOk(ctx, 'screenshot', {});
  await callOk(ctx, 'tap', { tapX: 540, tapY: 780 });
  await callOk(ctx, 'wait-text', { targetText: labels.mediaItem, timeoutSec: 10 });
  await callOk(ctx, 'tap', { tapX: 540, tapY: 616 });
}

async function main(ctx) {
  const labels = ctx.inputs.labels;
  await callOk(ctx, 'launch-app', { activity: '.StartActivity' });
  await callOk(ctx, 'screenshot', {});
  await callOk(ctx, 'screenshot', {});
  await callOk(ctx, 'tap', { tapX: 540, tapY: 2292 });
  await callOk(ctx, 'screenshot', {});
  await callOk(ctx, 'tap', { tapX: 240, tapY: 1340 });
  await callOk(ctx, 'wait-text', { targetText: labels.emptyDirectory, timeoutSec: 8 });
  await callOk(ctx, 'tap-uia-text', { text: labels.emptyDirectory });
  await callOk(ctx, 'wait-text', { targetText: labels.emptyOrNoResult, timeoutSec: 8 });
  const empty = await callOk(ctx, 'uia-tree', { compact: true, textFilter: labels.emptyOrNoResult, maxNodes: 16 });
  const emptyShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'empty-directory',
    predicateSummary: 'frozen empty-directory label is in the compact uia tree',
    condition: JSON.stringify(empty.result).includes(labels.emptyOrNoResult),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: emptyShot.evidence,
  });
  await callOk(ctx, 'tap', { tapX: 84, tapY: 204 });
  await callOk(ctx, 'wait-text', { targetText: labels.internalStorage, timeoutSec: 8 });
  await callOk(ctx, 'tap', { tapX: 84, tapY: 204 });
  await openMoviesAndPlay(ctx, labels);
  await callOk(ctx, 'tap', { tapX: 800, tapY: 684 });
  await callOk(ctx, 'tap', { tapX: 975, tapY: 2274 });
  await callOk(ctx, 'screenshot', {});
  const fileDump = await callOk(ctx, 'uia-tree', { compact: true, textFilter: labels.mediaFile, maxNodes: 16 });
  const playerDump = await callOk(ctx, 'uia-tree', { compact: true, textFilter: labels.player, maxNodes: 16 });
  const playerShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'player-visible',
    predicateSummary: 'Movies compact UIA shows the fixture file and 音频播放器 after play then pause',
    condition: JSON.stringify(fileDump.result).includes(labels.mediaFile) && JSON.stringify(playerDump.result).includes(labels.player),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: playerShot.evidence,
  });
  await callOk(ctx, 'tap', { tapX: 84, tapY: 204 });
  await callOk(ctx, 'tap', { tapX: 972, tapY: 2292 });
  await callOk(ctx, 'tap', { tapX: 282, tapY: 432 });
  await callOk(ctx, 'wait-text', { targetText: labels.settingsRestore, timeoutSec: 8 });
  await callOk(ctx, 'tap-uia-text', { text: labels.settingsRestore, exact: true });
  await callOk(ctx, 'tap-uia-text', { text: labels.settingsRestore, exact: true });
  const settings = await callOk(ctx, 'uia-tree', { compact: true, textFilter: labels.settingsRestore, maxNodes: 16 });
  const settingsShot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'settings-restored',
    predicateSummary: 'frozen settings-restore row is in the compact uia tree after toggle restore',
    condition: JSON.stringify(settings.result).includes(labels.settingsRestore),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: settingsShot.evidence,
  });
  await callOk(ctx, 'tap', { tapX: 84, tapY: 204 });
  await ctx.checkpoint('vlc-acceptance', { done: true });
  return { passed: true };
}

async function callOk(ctx, command, args) {
  const result = await ctx.call(command, args);
  if (!result || result.ok === false) {
    throw new Error(result && result.error ? result.error : command);
  }
  return result;
}

module.exports = { main };
