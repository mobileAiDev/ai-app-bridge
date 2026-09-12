"""Python equivalent of the frozen Kiwix native/H5 bookmark business flow.

Baseline: Climate change is saved and its bookmark sheet is open. Selectors
come from the recorded 2026-09-11 Intents, with search result IDs bound afresh.
The external Core Data oracle is run separately after the App is stopped.
"""
import hashlib
import json
from pathlib import Path
import time


def flatten(node):
    if node is None:
        return []
    return [node] + [item for child in node.get('children', []) for item in flatten(child)]


def matches(read, label, kind):
    return [node for node in flatten(read['result']['source'])
            if node.get('isVisible') == '1' and node.get('label') == label
            and node.get('type') == kind]


def has(read, label, kind='Button'):
    return len(matches(read, label, kind)) == 1


def search_results(read, title):
    return [node for node in flatten(read['result']['source'])
            if node.get('type') == 'Button' and node.get('isVisible') == '1'
            and any(child.get('type') == 'StaticText' and child.get('label') == title
                    for child in node.get('children', []))]


def now_ms():
    return time.time_ns() // 1_000_000


def main(ctx):
    output = Path(ctx.inputs['outputDir'])
    session_id = ctx.inputs['wdaSessionId']
    if not session_id:
        raise ValueError('An explicit WDA session is required')
    output.mkdir(parents=False, exist_ok=False)
    sequence = 0
    checks, artifacts = [], []
    started_at_ms = now_ms()

    def write(name, value):
        with (output / name).open('x') as file:
            json.dump(value, file, ensure_ascii=False, indent=2)
            file.write('\n')

    def call(command, args=None, native=True):
        nonlocal sequence
        arguments = {'wdaSessionId': session_id} if native else {}
        if args is not None:
            arguments.update(args)
        read = ctx.call(command, arguments)
        sequence += 1
        write(f'{sequence:03d}-{command}.json', read)
        if read['ok'] is not True:
            raise RuntimeError(f'{command}: {json.dumps(read, ensure_ascii=False)}')
        return read

    def check(name, condition, read, stream='tree'):
        verdict = ctx.assert_({'name': name, 'condition': condition,
                              'requiredEvidence': [stream], 'evidence': read['evidence']})
        checks.append(verdict)
        if verdict['verdict'] != 'passed':
            raise RuntimeError(f"{name}: {verdict['verdict']}")

    def tap(label):
        return call('ios-tap-native', {'selector': {'label': label, 'type': 'Button'}})

    def wait_native(name, predicate):
        deadline = time.monotonic() + 15
        while True:
            read = call('ios-uia-tree')
            if predicate(read) or time.monotonic() >= deadline:
                break
            time.sleep(0.25)
        check(name, predicate(read), read)
        return read

    def page(title, article, body):
        deadline = time.monotonic() + 10
        while True:
            read = call('ios-h5-dom', native=False)
            dom = read['result']['dom']
            if (dom['readyState'] == 'complete' and dom['title'] == title
                    or time.monotonic() >= deadline):
                break
            time.sleep(0.25)
        check(f'{title}: actual local article title, URL and body',
              dom['readyState'] == 'complete' and dom['title'] == title
              and dom['url'] == f'zim://53293C1B-CED3-5244-564A-B40E435E2F0A/{article}'
              and body in dom['bodyText'] and not dom['bodyTextTruncated'], read)
        return read

    def screenshot(name):
        file = output / (name + '.png')
        read = call('ios-screenshot', {'outFile': str(file)}, native=False)
        sha256 = hashlib.sha256(file.read_bytes()).hexdigest()
        check(f'{name}: actual screenshot bytes',
              any(ref['stream'] == 'screenshot' and ref['sha256'] == sha256
                  for ref in read['evidence']['refs']), read, 'screenshot')
        artifacts.append({'name': name, 'path': str(file), 'sha256': sha256,
                          'evidence': read['evidence'],
                          'binding': 'separate capture after nearby tree/DOM; not atomic'})

    def sheet_closed(read):
        return (not has(read, 'Done') and not has(read, 'Bookmarks', 'StaticText')
                and has(read, 'Search', 'SearchField'))

    wait_native('baseline saved Climate change bookmark and removal control', lambda read:
                has(read, 'Climate change') and has(read, 'Remove Bookmark')
                and not has(read, 'Greenhouse gas'))
    tap('Remove Bookmark')
    wait_native('removing the existing bookmark leaves an empty list', lambda read:
                has(read, 'No bookmarks', 'StaticText') and has(read, 'Add Bookmark')
                and not has(read, 'Climate change'))
    tap('Done')
    wait_native('bookmark sheet closes before native search', sheet_closed)
    call('ios-input-native-text', {'selector': {'label': 'Search', 'type': 'SearchField'},
                                   'text': 'Climate change'})
    search = wait_native('native search returns the exact Climate change result Button', lambda read:
                         len(search_results(read, 'Climate change')) == 1
                         and any(node.get('value') == 'Climate change'
                                 for node in matches(read, 'Search', 'SearchField')))
    call('ios-tap-native', {'selector': {
        'elementId': search_results(search, 'Climate change')[0]['elementId'], 'type': 'Button'}})
    page('Climate change', 'Climate_change', 'climate change describes global warming')
    tap('Show Bookmarks')
    wait_native('unsaved article has an enabled Add Bookmark control', lambda read:
                has(read, 'No bookmarks', 'StaticText')
                and any(node.get('isEnabled') == '1' for node in matches(read, 'Add Bookmark', 'Button')))
    tap('Add Bookmark')
    wait_native('save publishes the real bookmark row and removal control', lambda read:
                has(read, 'Climate change') and has(read, 'Remove Bookmark')
                and not has(read, 'No bookmarks', 'StaticText'))
    screenshot('saved-climate-bookmark')
    tap('Done')
    wait_native('saved bookmark sheet closes', sheet_closed)
    call('ios-h5-click', {'selector': {'text': 'greenhouse gases', 'tag': 'a'}}, native=False)
    page('Greenhouse gas', 'Greenhouse_gas', 'Greenhouse gases (GHGs)')
    tap('Show Bookmarks')
    wait_native('second article is unsaved while the first bookmark remains', lambda read:
                has(read, 'Add Bookmark') and has(read, 'Climate change')
                and not has(read, 'Greenhouse gas') and not has(read, 'Remove Bookmark'))
    tap('Done')
    before_restart = wait_native('cancel closes the second article bookmark sheet', sheet_closed)
    screenshot('greenhouse-bookmark-cancelled')
    previous_process_id = before_restart['result']['session']['processId']
    call('ios-wda-session', {'operation': 'close'})
    call('ios-launch-app', {'terminateExisting': True}, native=False)
    created = call('ios-wda-session', {'operation': 'create'}, native=False)
    session_id = created['result']['session']['sessionId']
    after_restart = wait_native('real App restart has a new process and home bookmark control', lambda read:
                                read['result']['session']['processId'] != previous_process_id
                                and has(read, 'Show Bookmarks'))
    tap('Show Bookmarks')
    wait_native('saved bookmark survives restart and cancelled article is absent', lambda read:
                has(read, 'Climate change') and not has(read, 'Greenhouse gas')
                and not has(read, 'No bookmarks', 'StaticText'))
    screenshot('bookmarks-after-restart')
    tap('Climate change')
    page('Climate change', 'Climate_change', 'climate change describes global warming')
    screenshot('bookmark-reopens-actual-article')
    completed_at_ms = now_ms()
    result = {'ok': True, 'startedAtMs': started_at_ms, 'completedAtMs': completed_at_ms,
              'elapsedMs': completed_at_ms - started_at_ms, 'sessionId': session_id,
              'previousProcessId': previous_process_id,
              'processId': after_restart['result']['session']['processId'],
              'checks': checks, 'artifacts': artifacts,
              'scope': 'native bookmark removal/search/save, H5 navigation, cancel, real App restart and bookmark reopening; external Core Data verdict is recorded separately'}
    write('result.json', result)
    return result
