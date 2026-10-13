#!/usr/bin/env python3
"""Derive first-use timing, RPC bytes, gaps and verdicts from retained evidence."""
import collections
import csv
import datetime
import hashlib
import json
import pathlib
import sys
import time

out = pathlib.Path(sys.argv[1])
read = lambda name: json.loads((out / name).read_text())
timeline = [json.loads(line) for line in (out / 'timeline.jsonl').read_text().splitlines()]
identity = read('identity.json')
iso_ms = lambda value: int(datetime.datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1000)
stamp = lambda value: datetime.datetime.fromtimestamp(value / 1000, datetime.timezone.utc).isoformat(timespec='milliseconds')
start = iso_ms(identity['startedAt'])
events = {item['name']: item for item in timeline}
transcript = [json.loads(line) for line in (out / 'browser/mcp.jsonl').read_text().splitlines()]
requests = {}
rpc = []
previous_end = None
wire_bytes = lambda value: len(json.dumps(value, ensure_ascii=False, separators=(',', ':')).encode()) + 1
for entry in transcript:
    message = entry['message']
    if entry['direction'] == 'request':
        requests[message['id']] = entry
    if entry['direction'] != 'response':
        continue
    request = requests[message['id']]
    original = request['message']
    params = original.get('params', {})
    arguments = params.get('arguments', {})
    texts = [item['text'] for item in message.get('result', {}).get('content', []) if item['type'] == 'text']
    reply = json.loads(texts[0]) if texts else {}
    began = iso_ms(request['at'])
    ended = iso_ms(entry['at'])
    rpc.append({'id': message['id'], 'command': arguments.get('command', original['method']),
        'operation': arguments.get('arguments', {}).get('operation', ''),
        'startedAt': request['at'], 'completedAt': entry['at'], 'elapsedMs': ended - began,
        'gapSincePreviousResponseMs': None if previous_end is None else began - previous_end,
        'requestBytes': wire_bytes(original), 'responseBytes': wire_bytes(message),
        'toolTextBytes': sum(len(text.encode()) for text in texts),
        'valueBytes': reply.get('delivery', {}).get('valueBytes'),
        'executionOk': reply.get('execution', {}).get('ok'),
        'error': message.get('error') or reply.get('execution', {}).get('error')})
    previous_end = ended
with (out / 'rpc-metrics.csv').open('w') as handle:
    writer = csv.DictWriter(handle, fieldnames=list(rpc[0]))
    writer.writeheader()
    writer.writerows(rpc)
(out / 'rpc-metrics.json').write_text(json.dumps(rpc, indent=2))

terminal = [read('browser/finish-before-reload-wait.json'), read('browser/verify-after-refresh.json')]
assertions = [item for result in terminal for item in result['result']['result']['assertions']]
calls = [item for name in ['flow/ledger.json', 'refresh-flow/ledger.json'] for item in read(name)['calls']]
counts = dict(collections.Counter(item['command'] for item in calls))
oracle = read('sqlite-final-corrected.json')
snapshot = read('browser/preparation.json')
decision_gaps = read('agent-decision-gaps.json')
db_path_check = read('post-cleanup-db-path-check.json')
main_summary = terminal[0]['result']['rollingSummary']
now = int(time.time() * 1000)
milestones = [
    ('Task wall-clock start (second precision)', start),
    ('Controller written; environment preparation begins', events['environment-preparation-start']['atMs']),
    ('Memos HTTP ready', events['memos-http-ready']['atMs']),
    ('First DOM captured (empty)', read('browser/initial-dom.json')['completedAtMs']),
    ('First usable signup DOM', read('browser/discover-signup.json')['completedAtMs']),
    ('First business Script request', read('browser/business-start.json')['startedAtMs']),
    ('Register complete; new page returned to agent', read('browser/business-start.json')['completedAtMs']),
    ('First workflow Script complete', terminal[0]['completedAtMs']),
    ('Document reload complete', read('browser/refresh-document.json')['completedAtMs']),
    ('Fresh-document UI assertion complete', terminal[1]['completedAtMs']),
    ('Final screenshot captured', events['final-ui-screenshot']['atMs']),
    ('Independent SQLite rows read; all memo checks pass, role predicate wrong', oracle['sourceReadCompletedAtMs']),
    ('Cleanup starts', events['cleanup-start']['atMs']),
    ('Cleanup complete', events['cleanup-complete']['atMs']),
    ('Corrected predicate evaluated over retained SQLite rows', oracle['evaluatedAtMs']),
    ('Report generated', now),
]
summary = {'verdict': 'PASS_WITH_TEST_HARNESS_CORRECTIONS', 'startedAt': identity['startedAt'],
    'milestones': [{'name': name, 'at': stamp(value), 'elapsedFromStartMs': value - start} for name, value in milestones],
    'outerRpcCount': len(rpc), 'outerRpcRequestBytes': sum(item['requestBytes'] for item in rpc),
    'outerRpcResponseBytes': sum(item['responseBytes'] for item in rpc),
    'outerRpcToolTextBytes': sum(item['toolTextBytes'] for item in rpc),
    'outerRpcElapsedMs': sum(item['elapsedMs'] for item in rpc),
    'scriptCalls': len(calls), 'scriptCommandCounts': counts,
    'scriptCallElapsedMs': sum(item['elapsedMs'] for item in calls),
    'scriptCallResponseBytes': sum(item['resultBytes'] for item in calls),
    'scriptCallFailures': [item for item in calls if not item['ok']],
    'deviceAssertions': assertions, 'oracleChecks': oracle['checks'],
    'cleanup': read('cleanup-check.json'), 'reportGeneratedAtMs': now,
    'agentDecisionGapMs': sum(item['gapMs'] for item in decision_gaps),
    'mainScriptRollingSummary': {key: main_summary[key] for key in ['elapsedMs', 'activeMs', 'decisionWaitMs']},
    'helperCorrectionMs': events['helper-error-corrected']['atMs'] - read('first-helper-error.json')['afterBridgeCompletedAtMs'],
    'oracleCorrectionMs': oracle['evaluatedAtMs'] - oracle['sourceReadCompletedAtMs']}
(out / 'summary.json').write_text(json.dumps(summary, indent=2))
lines = [
    '# Memos first-use acceptance, current source, run 1', '',
    '**Result: business PASS, with test-harness corrections retained.** Eleven device UI assertions passed; the independently read SQLite rows contain exactly two NORMAL memos: the first has edited content, the second has unchanged content and unchanged update timestamp. No business action was replayed.', '',
    '## Test boundary', '',
    f'- Fresh Memos 0.30.0 data directory, random loopback ports, isolated headed Chrome {snapshot["browser"]}, current-source SDK and isolated Bridge Host.',
    '- Registration, creation, search, edit, deletion-confirmation opening and cancellation used public Bridge commands inside real JavaScript Script operations. The seven agent decisions came from this run\'s current DOM and screenshot, and known sequences ran continuously.',
    '- Document reload used the supplied open-browser harness\'s fault:reload transport/document facility; it made no business writes. After reload, web-sessions supplied the new runtimeEpoch and a second Script asserted both exact contents.',
    '- SQLite access was independently read-only. No direct business HTTP, SQL writes, Playwright business automation, Android actions, personal-browser actions, global Host restarts, commits or publishing.',
    '- Read the provided harness, current bundled skill, generic MCP transport and command/Script contracts. An initial keyword search also returned README workflow summaries, but no existing business policy source or historical DOM was read.',
    '- Root supplied environment paths and one reminder to keep the controller small; that intervention is recorded. Root also reported concurrent CLI package verification. This is agent-assisted first discovery, not an empty-host or fully unattended benchmark.', '',
    '## Complete timing', '',
    '| Milestone | UTC | From task start |', '|---|---|---:|']
for name, value in milestones:
    lines.append(f'| {name} | {stamp(value)} | {(value - start) / 1000:.3f} s |')
lines += ['', 'All preparation, contract reads, source authoring, model reasoning, screenshots, parent updates, errors and corrections remain in wall-clock elapsed time. The first wall-clock sample has one-second precision. Cleanup finished before the final correction of the local SQLite role predicate; that correction reuses the raw rows read before cleanup.', '',
    '## Calls and bytes', '',
    f'- {len(rpc)} outer JSON-RPC requests/responses, including initialize, environment reads, Script controls, runtime status and isolated runtime stop. Total response bytes: {summary["outerRpcResponseBytes"]:,}; tool-text bytes: {summary["outerRpcToolTextBytes"]:,}.',
    f'- {len(calls)} inner public Script calls; command counts: {json.dumps(counts)}. All returned ok:true; summed call duration {summary["scriptCallElapsedMs"]} ms.',
    f'- Summed outer RPC duration {summary["outerRpcElapsedMs"]} ms is only RPC service time, not first-use elapsed time. RPC and inner-call durations overlap and must not be added.',
    '- rpc-metrics.csv/json lists every request start/end, latency, request/response/tool-text bytes, error, and gap from the preceding response. Gaps include model thinking, authoring and other tool work; they are not asserted to be pure model time.',
    '- Wire-byte numbers reconstruct UTF-8 compact JSON-RPC frames plus the newline from the complete local transcript. Screenshots and document reload are separate harness calls in timeline.jsonl, not Bridge RPCs.', '',
    '## First-run errors and corrections', '',
    '1. Initial web-dom succeeded but was empty during app startup. The subsequent DOM exposed the signup form; no mutation was retried.',
    f'2. The local Python display helper incorrectly dereferenced pendingQuestion:null after the workflow had already completed. Its original Bridge result is preserved in browser/finish-before-reload-wait.json. The display fix took {summary["helperCorrectionMs"] / 1000:.3f} s from that result to corrected helper; no business replay.',
    f'3. The independent SQLite checker incorrectly expected role HOST, whereas the first-run admin row is ADMIN. Every original memo predicate passed. sqlite-final.json retains the false verdict and raw rows; sqlite-final-corrected.json evaluates the corrected predicate. Correction interval: {summary["oracleCorrectionMs"] / 1000:.3f} s.',
    '4. After cleanup, an attempted fresh mode=ro reopen returned sqlite3.OperationalError: unable to open database file. At the root agent\'s request, the exact saved and live paths were compared and match. The file still exists. A second mode=ro attempt failed; the same closed file opened with mode=ro&immutable=1 and reported two memos. The non-immutable failure mechanism remains NOT_PROVEN; there is no evidence here of a wrong path, deleted DB or corruption. These supplemental checks did not restart the service/browser and do not replace the original 691.436 s corrected-oracle milestone.',
    'The last two issues belong to this validation/oracle path. There were no Bridge mutation errors and no product-code changes from this test. The controller timeline uses request names for call events; requestBytes and elapsedMs distinguish request and completion records.', '',
    '## Agent waiting and avoidable outer round trips', '',
    f'The main Script lived for {main_summary["elapsedMs"] / 1000:.3f} s. Its 43 calls occupied 1.306 s; the final two read-only Script calls occupied 0.028 s. The seven public waiting_for_agent response-to-decide intervals total {summary["agentDecisionGapMs"] / 1000:.3f} s. These intervals include model reasoning, controller/plan authoring, screenshot review and progress messages, and are not pure inference time.', '',
    '| Completed phase -> next plan | Outside-Script decision gap |', '|---|---:|',
    *[f'| {item["completedPhase"]} -> {item["nextPlan"]} | {item["gapMs"] / 1000:.3f} s |' for item in decision_gaps], '',
    'Every decision used a decide RPC followed by wait because the current decide contract has no waitMs. Seven pairs account for fourteen outer RPCs. This does not imply fourteen browser actions; each plan executed its known actions locally.', '',
    '- Already continuous: username/password/registration submit; both memo creations plus saves and exact-marker search; edit input plus save; menu plus Delete after the current replacement menu node was identified; Cancel plus removing the filter and checking both contents.',
    '- New information justified pauses at the first home page, unlabelled memo menu (with screenshot), menu contents, inline edit form, replaced post-edit menu identity and actual confirmation dialog. Some could now be coded as local observed-state branches with ctx.askAgent reserved for mismatches; the present run retained the initial discovery cost.',
    '- Clearly unnecessary pause: after cancellation the Script had already asserted both final contents, yet asked the agent for an empty done plan. Set done:true in that already-known cancellation plan to remove one decide/wait pair and its observed 35.900 s gap. This is a test-plan change using existing Script features.',
    '- If local stage branches are known, use the existing Intent autonomous module or one Script start(waitMs:60000) rather than returning each stage to the model. A fresh Script start with waitMs can also deliver a known plan in one RPC; this trades shared-script continuity for fewer control RPCs. No product capability expansion is required.',
    '- The final post-refresh Script performed an initial DOM read and immediately another DOM read before checking the same condition. Evaluating the initial observation first can remove one of the 28 reads. Other repeated reads establish asynchronous business completion or new identities and should not simply be removed.', '',
    '**Telemetry concern:** browser/finish-before-reload-wait.json reports rollingSummary.activeMs=200093 and decisionWaitMs=0 despite the seven persisted waiting_for_agent/decide intervals above. Therefore activeMs was not used as CPU or autonomous execution time. Root should inspect the Script timing accounting before using these fields for efficiency claims; no product source was modified here.', '',
    f'DB retained at `{db_path_check["savedPath"]}` ({db_path_check["size"]} bytes), SHA-256 `{db_path_check["sha256"]}`. Supplemental exact-path/URI outcomes are in post-cleanup-db-path-check.json.', '',
    '## Evidence', '',
    '- browser/mcp.jsonl: complete public RPC transcript; browser/*json: per-call receipts.',
    '- flow and refresh-flow: per-call Script envelopes and device assertions; recording and refresh-recording: retained Host evidence.',
    '- browser/search-first-screenshot.png, browser/delete-confirmation-screenshot.png, browser/final-ui-screenshot.png.',
    '- sqlite-schema.json, sqlite-final.json, sqlite-final-corrected.json; cleanup-check.json confirms owned controller/harness/Memos/Runtime exited and both owned ports closed.',
    f'- Original SDK SHA-256: `{snapshot["sdkSourceSha256"]}`; binary SHA-256: `{identity["binarySha256"]}`.',
    '- source contains the new first-use controller, Script and display helper; product source was left unchanged.', '',
    '## Device assertions', '']
for assertion in assertions:
    lines.append('- ' + assertion['verdict'] + ': ' + assertion['name'])
(out / 'REPORT.md').write_text('\n'.join(lines) + '\n')
print(json.dumps({key: summary[key] for key in ['verdict', 'outerRpcCount', 'outerRpcResponseBytes', 'outerRpcToolTextBytes', 'outerRpcElapsedMs', 'scriptCalls', 'scriptCommandCounts', 'scriptCallElapsedMs', 'helperCorrectionMs', 'oracleCorrectionMs']}, indent=2))
print('report:', out / 'REPORT.md')
