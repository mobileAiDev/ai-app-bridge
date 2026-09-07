'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { verifyFile } = require('./oracles');
const statuses = ['passed', 'failed', 'inconclusive', 'blocked', 'not_run'];
const countsOf = (rows) => Object.fromEntries(statuses.map((status) => [status, rows.filter((row) => row.verdict === status).length]));
const percent = (part, all) => all ? Number((100 * part / all).toFixed(2)) : 0;
function unique(rows, name) {
  if (!Array.isArray(rows) || rows.some((row) => typeof row.id !== 'string' || !row.id) || new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error(`${name}_unique_ids_required`);
}
function interval(value, label) {
  if (!value || !Number.isFinite(value.startedAtMs) || !Number.isFinite(value.finishedAtMs) || value.finishedAtMs < value.startedAtMs) throw new Error(`${label}_actual_timestamps_required`);
  return { ...value, wallMs: value.finishedAtMs - value.startedAtMs };
}

function buildReport({ inventory, scenarios, executions = [], oracleResults = [], timing, artifacts = [], identity, budgetMs = 600000 }) {
  const features = inventory?.features; const cases = scenarios?.scenarios;
  unique(features, 'inventory'); unique(cases, 'scenarios');
  if (!features.length || !cases.length) throw new Error('empty_frozen_scope');
  const ids = new Set(cases.map((row) => row.id)); const featureIds = new Set(features.map((row) => row.id));
  if (cases.some((row) => !featureIds.has(row.featureId))) throw new Error('unknown_scenario_feature');
  if (executions.some((row) => !ids.has(row.scenarioId)) || oracleResults.some((row) => !ids.has(row.scenarioId))) throw new Error('result_outside_frozen_scope');
  const matrix = scenarios.variantMatrix || [];
  unique(matrix, 'variants');
  if (matrix.some((row) => !ids.has(row.scenarioId))) throw new Error('unknown_variant_scenario');
  for (const row of [...executions, ...oracleResults]) if (row.variantId && !matrix.some((variant) => variant.id === row.variantId && variant.scenarioId === row.scenarioId)) throw new Error('result_outside_frozen_variant_scope');
  for (const scenario of cases) if (scenario.parameters?.variants?.length && !matrix.some((row) => row.scenarioId === scenario.id)) throw new Error('variant_matrix_required');
  function evaluate(scenario, variantId = null) {
    const attempts = executions.filter((row) => row.scenarioId === scenario.id && (row.variantId || null) === variantId).map((row) => ({ ...row }));
    const last = attempts.at(-1);
    const required = (scenario.oracles || []).map((oracle, index) => ({ ...oracle, id: oracle.id || `${scenario.id}:oracle:${index + 1}` }));
    const observations = oracleResults.filter((row) => row.scenarioId === scenario.id && (row.variantId || null) === variantId && (!last || row.attempt === last.attempt));
    const checks = required.map((oracle) => {
      const matches = observations.filter((row) => row.id === oracle.id);
      if (matches.length !== 1) return { id: oracle.id, kind: oracle.kind, verdict: 'inconclusive', reason: matches.length ? 'duplicate_oracle_result' : 'oracle_not_run' };
      const result = matches[0];
      if (result.source !== 'independent-host-business-oracle' || !['passed', 'failed', 'inconclusive'].includes(result.verdict)) return { id: oracle.id, kind: oracle.kind, verdict: 'inconclusive', reason: 'independent_oracle_required' };
      return { ...result, kind: oracle.kind };
    });
    let verdict;
    if (!last || last.executionStatus === 'not_run') verdict = 'not_run';
    else if (last.executionStatus === 'blocked') verdict = 'blocked';
    else if (last.executionStatus !== 'completed') verdict = ['failed', 'cancelled', 'timed_out'].includes(last.executionStatus) ? 'failed' : 'inconclusive';
    else if (!checks.length) verdict = 'inconclusive';
    else verdict = checks.some((row) => row.verdict === 'failed') ? 'failed' : checks.some((row) => row.verdict !== 'passed') ? 'inconclusive' : 'passed';
    return { id: variantId || scenario.id, scenarioId: scenario.id, variantId, featureId: scenario.featureId, name: scenario.name, priority: scenario.priority, layer: scenario.layer,
      executionClass: scenario.executionClass, environmentRequirements: scenario.environmentRequirements || [], verdict, attempts, checks,
      reason: last?.error || (verdict === 'not_run' ? 'frozen_case_not_executed' : verdict === 'inconclusive' && !checks.length ? 'no_independent_oracle_defined' : null) };
  }
  const variants = matrix.map((item) => ({ ...evaluate(cases.find((scenario) => scenario.id === item.scenarioId), item.id), variant: item.variant }));
  const rows = cases.map((scenario) => {
    const children = variants.filter((row) => row.scenarioId === scenario.id);
    if (!children.length) return evaluate(scenario);
    const verdict = children.every((row) => row.verdict === 'passed') ? 'passed' : children.some((row) => row.verdict === 'failed') ? 'failed'
      : children.some((row) => row.verdict === 'inconclusive') ? 'inconclusive' : children.some((row) => row.verdict === 'blocked') ? 'blocked' : 'not_run';
    return { id: scenario.id, featureId: scenario.featureId, name: scenario.name, priority: scenario.priority, layer: scenario.layer, verdict,
      attempts: children.flatMap((row) => row.attempts), checks: children.flatMap((row) => row.checks.map((check) => ({ ...check, variantId: row.variantId }))),
      variantIds: children.map((row) => row.id), reason: verdict === 'passed' ? null : 'all_frozen_variants_required' };
  });
  const featureRows = features.map((feature) => {
    const plannedIds = new Set(feature.scenarioIds || []);
    const children = rows.filter((row) => row.featureId === feature.id);
    if (children.some((row) => !plannedIds.has(row.id)) || [...plannedIds].some((id) => !children.some((row) => row.id === id))) throw new Error(`feature_scenario_mapping_mismatch:${feature.id}`);
    const verdict = !children.length ? 'not_run' : children.every((row) => row.verdict === 'passed') ? 'passed'
      : children.some((row) => row.verdict === 'failed') ? 'failed' : children.some((row) => row.verdict === 'inconclusive') ? 'inconclusive'
      : children.some((row) => row.verdict === 'blocked') ? 'blocked' : 'not_run';
    return { id: feature.id, name: feature.name, area: feature.area, verdict, scenarioIds: children.map((row) => row.id) };
  });
  const evidence = artifacts.map((artifact) => {
    try { verifyFile(artifact); return { ...artifact, verified: true, bytes: fs.statSync(artifact.path).size }; }
    catch (error) { return { ...artifact, verified: false, error: error.message }; }
  });
  const artifactIssues = [];
  for (const [role, key] of [['apk', 'apkSha256'], ['script', 'scriptSha256'], ['inventory', 'inventorySha256'], ['scenarios', 'scenariosSha256']]) {
    if (!/^[a-f0-9]{64}$/.test(identity?.[key] || '') || !evidence.some((file) => file.role === role && file.verified && file.sha256 === identity[key])) artifactIssues.push(`${role}_identity_evidence_missing`);
  }
  for (const [role, data] of [['inventory', inventory], ['scenarios', scenarios]]) {
    const file = evidence.find((item) => item.role === role && item.verified);
    if (file) {
      try { if (!isDeepStrictEqual(JSON.parse(fs.readFileSync(file.path, 'utf8')), data)) artifactIssues.push(`${role}_frozen_content_mismatch`); }
      catch { artifactIssues.push(`${role}_frozen_json_invalid`); }
    }
  }
  if (evidence.some((file) => !file.verified)) artifactIssues.push('artifact_integrity_failure');
  const regression = interval(timing?.regression, 'regression');
  const times = { construction: (timing.construction || []).map((row) => interval(row, 'construction')),
    installation: (timing.installation || []).map((row) => interval(row, 'installation')), regression,
    model: timing.model || { measured: false, wallMs: null, tokens: null, reason: 'no_actual_model_measurement' } };
  const scenarioCounts = countsOf(rows); const featureCounts = countsOf(featureRows);
  const atomicRows = [...rows.filter((row) => !row.variantIds), ...variants];
  const atomicCounts = countsOf(atomicRows);
  const atomicExecuted = atomicRows.filter((row) => row.attempts.some((attempt) => !['blocked', 'not_run'].includes(attempt.executionStatus))).length;
  const executed = rows.filter((row) => row.attempts.some((attempt) => !['blocked', 'not_run'].includes(attempt.executionStatus))).length;
  const complete = rows.every((row) => row.verdict === 'passed') && featureRows.every((row) => row.verdict === 'passed');
  const withinBudget = regression.wallMs <= budgetMs;
  return { schemaVersion: 'aab.notallyx.regression-report/v1', ok: complete && withinBudget && artifactIssues.length === 0,
    identity, frozenScope: { inventorySource: inventory.source, scenarioSource: scenarios.source },
    coverage: { scenarios: { total: rows.length, executed, ...scenarioCounts, executedPercent: percent(executed, rows.length), passedPercent: percent(scenarioCounts.passed, rows.length) },
      variants: { total: variants.length, ...countsOf(variants), passedPercent: percent(variants.filter((row) => row.verdict === 'passed').length, variants.length) },
      atomicCases: { total: atomicRows.length, executed: atomicExecuted, ...atomicCounts, executedPercent: percent(atomicExecuted, atomicRows.length), passedPercent: percent(atomicCounts.passed, atomicRows.length) },
      features: { total: featureRows.length, ...featureCounts, passedPercent: percent(featureCounts.passed, featureRows.length) } },
    acceptance: { fullFrozenScopePassed: complete, withinBudget, budgetMs, artifactIntegrityPassed: artifactIssues.length === 0, artifactIssues },
    timing: times, features: featureRows, scenarios: rows, variants, artifacts: evidence,
    notes: ['Execution completion is not business acceptance.', 'Blocked and unexecuted cases remain in the frozen denominator.', 'Construction and installation are reported separately from fixed regression.', 'Oracle result files are trusted Host assessment outputs, not Script self-reports.'] };
}

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
function writeReport(report, out) {
  out = path.resolve(out); fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  const c = report.coverage;
  const html = `<!doctype html><meta charset="utf-8"><title>NotallyX regression</title><style>body{font:16px system-ui;max-width:1100px;margin:32px auto;padding:16px}table{border-collapse:collapse;width:100%}td,th{padding:10px;border:1px solid #ccc;text-align:left}.passed{color:#16743a}.failed{color:#b00020}code{overflow-wrap:anywhere}</style><h1>NotallyX 回归 ${report.ok ? '通过' : '未通过'}</h1><p>功能 ${c.features.passed}/${c.features.total}；用例通过 ${c.scenarios.passed}/${c.scenarios.total}；已执行 ${c.scenarios.executed}/${c.scenarios.total}；变体 ${c.variants.passed}/${c.variants.total}；原子覆盖槽 ${c.atomicCases.passed}/${c.atomicCases.total}；回归 ${(report.timing.regression.wallMs / 1000).toFixed(3)} 秒。</p><p>APK <code>${escape(report.identity?.apkSha256)}</code><br>Script <code>${escape(report.identity?.scriptSha256)}</code></p><table><tr><th>用例</th><th>功能</th><th>结果</th><th>独立 oracle</th><th>原因</th></tr>${report.scenarios.map((row) => `<tr><td>${escape(row.id)} ${escape(row.name)}</td><td>${escape(row.featureId)}</td><td class="${escape(row.verdict)}">${escape(row.verdict)}</td><td>${row.checks.map((check) => `${escape(check.id)}: ${escape(check.verdict)}`).join('<br>')}</td><td>${escape(row.reason)}</td></tr>`).join('')}</table><h2>证据文件</h2><ul>${report.artifacts.map((file) => `<li>${escape(file.role)}：${escape(file.path)}<br><code>${escape(file.sha256)}</code> ${file.verified ? 'hash verified' : escape(file.error)}</li>`).join('')}</ul><p>完整原始结果及分阶段时间见 report.json。未运行及环境阻塞均保留分母。</p>`;
  fs.writeFileSync(path.join(out, 'report.html'), html, { flag: 'wx' });
  return { jsonPath: path.join(out, 'report.json'), htmlPath: path.join(out, 'report.html') };
}
module.exports = { buildReport, writeReport };
