'use strict';

async function openMoviesAndPlay(ctx, labels) {
  await callOk(ctx, 'tap', { tapX: 540, tapY: 2292 });
  await callOk(ctx, 'screenshot', {});
  await callOk(ctx, 'tap', { tapX: 540, tapY: 780 });
  await callOk(ctx, 'wait-text', { targetText: labels.mediaItem, timeoutSec: 10 });
  await callOk(ctx, 'tap', { tapX: 540, tapY: 616 });
}

async function pauseAndAssertPlayer(ctx, labels) {
  await callOk(ctx, 'tap', { tapX: 800, tapY: 684 });
  await callOk(ctx, 'tap', { tapX: 975, tapY: 2274 });
  await callOk(ctx, 'screenshot', {});
  const fileDump = await callOk(ctx, 'uia-tree', { compact: true, textFilter: labels.mediaFile, maxNodes: 16 });
  const playerDump = await callOk(ctx, 'uia-tree', { compact: true, textFilter: labels.player, maxNodes: 16 });
  const shot = await callOk(ctx, 'screenshot', {});
  await ctx.assert({
    name: 'player-visible',
    predicateSummary: 'Movies compact UIA shows the fixture file and 音频播放器 after play then pause',
    condition: JSON.stringify(fileDump.result).includes(labels.mediaFile) && JSON.stringify(playerDump.result).includes(labels.player),
    requiredEvidence: [],
    requireCoverage: 'complete',
    evidence: shot.evidence,
  });
}

async function main(ctx) {
  const labels = ctx.inputs.labels;
  await callOk(ctx, 'launch-app', { activity: '.StartActivity' });
  await callOk(ctx, 'screenshot', {});
  await callOk(ctx, 'screenshot', {});
  await openMoviesAndPlay(ctx, labels);
  await pauseAndAssertPlayer(ctx, labels);
  await ctx.checkpoint('vlc-core', { done: true });
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
