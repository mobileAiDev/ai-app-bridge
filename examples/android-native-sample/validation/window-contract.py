#!/usr/bin/env python3
"""Exercise real sample windows through the public CLI; inspect app counters independently."""
import argparse
import json
import pathlib
import subprocess
import time

parser = argparse.ArgumentParser()
parser.add_argument('--serial', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--cli', nargs='+', default=['ai-app-bridge'])
parser.add_argument('--port', type=int, default=17835)
parser.add_argument('--expect-bug', action='store_true')
args = parser.parse_args()
directory = pathlib.Path(args.output).resolve()
directory.mkdir(parents=True, exist_ok=True)
package = 'io.github.mobileaidev.aiappbridge.sample'
sequence = 0


def call(command, **options):
    global sequence
    command_line = args.cli + [command, '--serial', args.serial, '--package-name', package, '--feedback', 'off']
    if command in ['status', 'tree', 'tap-native', 'input-text']:
        command_line += ['--port', str(args.port)]
    for key, value in options.items():
        command_line += ['--' + key.replace('_', '-'), json.dumps(value, ensure_ascii=False) if isinstance(value, dict) else str(value)]
    result = subprocess.run(command_line, capture_output=True, text=True, timeout=35)
    value = json.loads(result.stdout)['value']
    sequence += 1
    (directory / f'{sequence:02}-{command}.json').write_text(json.dumps(value, ensure_ascii=False, indent=2))
    return value


def nodes(node):
    yield node
    for child in node.get('children', []):
        yield from nodes(child)


def has_text(tree, text):
    return any(node.get('text') == text and node.get('effectiveVisible') for window in tree.get('windows', [])
               for node in nodes(window.get('root', {})))


def observe(predicate):
    deadline = time.monotonic() + 15
    while True:
        tree = call('tree')
        assert tree.get('ok'), tree
        if predicate(tree):
            return tree
        assert time.monotonic() < deadline, 'Expected window state did not appear'
        time.sleep(.15)


def tap(description=None, text=None):
    result = call('tap-native', selector={'contentDescription': description} if description else {'text': text})
    assert result.get('ok') and result.get('dispatched') is True, result
    return result


def rejected(result, error):
    assert result.get('ok') is False and result.get('error') == error and result.get('dispatched') is False, result


def state(label):
    result = subprocess.run(['adb', '-s', args.serial, 'shell', 'run-as', package, 'cat', 'files/window-contract-fixture.json'],
                            capture_output=True, text=True, timeout=10)
    assert result.returncode == 0, result.stderr
    value = json.loads(result.stdout)
    (directory / f'state-{label}.json').write_text(json.dumps(value, indent=2))
    return value


def screenshot(label):
    result = subprocess.run(['adb', '-s', args.serial, 'exec-out', 'screencap', '-p'], capture_output=True, timeout=15)
    assert result.returncode == 0 and result.stdout.startswith(b'\x89PNG'), result.stderr
    (directory / f'{label}.png').write_bytes(result.stdout)


launch = call('launch-activity', activity=package + '.debugbridge.WindowContractFixtureActivity')
assert launch.get('ok'), launch
observe(lambda tree: has_text(tree, 'Window Contract Fixture'))
status = call('status')
assert status.get('ok') and status.get('app', {}).get('packageName') == package, status
initial = state('initial')
assert initial['backgroundClicks'] == initial['confirmClicks'] == 0, initial
tap('window_open_dialog')
observe(lambda tree: has_text(tree, 'Window Dialog'))
screenshot('dialog')
dialog_state = state('dialog')
assert dialog_state['dialogSharesActivityToken'] is True, dialog_state
assert dialog_state['dialogSharesApplicationWindowToken'] is False, dialog_state

if args.expect_bug:
    rejected(call('tap-native', selector={'text': 'Choice'}), 'native_selector_ambiguous')
    rejected(call('tap-native', selector={'contentDescription': 'window_dialog_confirm'}), 'native_selector_not_found')
    observe(lambda tree: has_text(tree, 'Window Dialog'))
    final = state('bug-reproduced')
    assert final['backgroundClicks'] == final['dialogClicks'] == final['confirmClicks'] == 0, final
    report = {'ok': True, 'baselineBugReproduced': True, 'serial': args.serial, 'state': final}
else:
    tap(text='Choice')
    result = call('input-text', selector={'contentDescription': 'window_dialog_input'}, text='window-0914')
    assert result.get('ok'), result
    tap('window_dialog_popup')
    observe(lambda tree: has_text(tree, 'Window Popup'))
    screenshot('dialog-popup')
    rejected(call('tap-native', selector={'contentDescription': 'window_background_choice_0'}), 'native_selector_not_found')
    rejected(call('input-text', selector={'contentDescription': 'window_dialog_input'}, text='must-not-write'), 'native_selector_not_found')
    tap(text='Choice')
    observe(lambda tree: has_text(tree, 'Window Dialog') and not has_text(tree, 'Window Popup'))
    tap('window_dialog_confirm')
    observe(lambda tree: not has_text(tree, 'Window Dialog'))
    saved = state('saved')
    assert saved['backgroundClicks'] == 0 and saved['dialogClicks'] == saved['confirmClicks'] == saved['popupClicks'] == 1, saved
    assert saved['savedInput'] == 'window-0914', saved
    tap('window_open_popup')
    observe(lambda tree: has_text(tree, 'Window Popup'))
    tap(text='Choice')
    observe(lambda tree: not has_text(tree, 'Window Popup'))
    tap('window_open_dialog')
    reopened = observe(lambda tree: has_text(tree, 'Window Dialog'))
    assert any(node.get('contentDescription') == 'window_dialog_input' and node.get('text') == 'window-0914'
               for window in reopened['windows'] for node in nodes(window['root'])), reopened
    result = call('input-text', selector={'contentDescription': 'window_dialog_input'}, text='cancelled-edit')
    assert result.get('ok'), result
    tap('window_dialog_cancel')
    observe(lambda tree: not has_text(tree, 'Window Dialog'))
    tap('window_open_child')
    observe(lambda tree: tree.get('activity', '').endswith('WindowContractChildActivity'))
    screenshot('child')
    tap(text='Choice')
    observe(lambda tree: tree.get('activity', '').endswith('WindowContractFixtureActivity'))
    final = state('final')
    assert final['backgroundClicks'] == 0 and final['dialogClicks'] == final['confirmClicks'] == final['childReturns'] == 1, final
    assert final['popupClicks'] == 2 and final['savedInput'] == 'window-0914', final
    assert final['dialogOpen'] is False and final['popupOpen'] is False, final
    screenshot('final')
    report = {'ok': True, 'baselineBugReproduced': False, 'serial': args.serial, 'state': final}
(directory / 'report.json').write_text(json.dumps(report, indent=2))
print(json.dumps(report, ensure_ascii=False))
