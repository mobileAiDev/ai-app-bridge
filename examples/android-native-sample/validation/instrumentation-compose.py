"""Python Script chapter using the same public Instrumentation executor."""
from time import perf_counter, sleep

def main(ctx):
    checks, actions = [], []
    started = perf_counter()
    def call(args):
        reply = ctx.call('android-executor', {**ctx.inputs['identity'], **args})
        assert reply['ok'] and reply['result'].get('ok') is not False, str(reply)
        return reply['result']
    def observe(engine='compose'):
        return call({'operation': 'observe', 'engine': engine})['observation']
    def node(observation, tag):
        nodes = [n for n in observation['nodes'] if n.get('tag') == tag]
        assert len(nodes) == 1, str(nodes)
        return nodes[0]
    def act(kind, tag, **fields):
        before = observe()
        start = perf_counter()
        result = call({'operation': 'act', 'snapshotId': before['snapshotId'],
                       'actionId': 'compose-regression-' + str(len(actions)),
                       'action': {'type': kind, 'nodeId': node(before, tag)['nodeId'], **fields}})
        actions.append({'type': kind, 'tag': tag, 'elapsedMs': (perf_counter() - start) * 1000,
                        'mechanism': result['action']['mechanism']})
    def check(name, passed, actual=None):
        checks.append({'name': name, 'passed': bool(passed), 'actual': actual})
    try:
        deadline = perf_counter() + 5
        initial = observe()
        while not any(n.get('tag') == 'counter' for n in initial['nodes']) and perf_counter() < deadline:
            sleep(0.1)
            initial = observe()
        check('Compose 初始状态', node(initial, 'counter')['text'] == ['Counter: 0'])
        for unused in range(3):
            act('click', 'increment')
        check('Compose 连续点击与状态重组', node(observe(), 'counter')['text'] == ['Counter: 3'])
        act('composeInput', 'name', text='商品 A')
        check('Compose 输入与关联文本更新', node(observe(), 'selected')['text'] == ['Selected: 商品 A'])
        act('composeReplaceText', 'name', text='Python 中文商品 42.50')
        check('Compose 中文替换', node(observe(), 'name')['editableText'] == 'Python 中文商品 42.50')
        uia = observe('uiautomator')
        check('UI Automator 独立回读 Compose 页面', any(n.get('text') == 'Selected: Python 中文商品 42.50' for n in uia['nodes']))
        act('composeClearText', 'name')
        check('Compose 清空与回读', node(observe(), 'name')['editableText'] == '')
        return {'ok': all(c['passed'] for c in checks), 'chapter': 'compose', 'language': 'python',
                'checks': checks, 'actions': actions, 'elapsedMs': (perf_counter() - started) * 1000}
    except Exception as error:
        return {'ok': False, 'chapter': 'compose', 'checks': checks, 'actions': actions,
                'elapsedMs': (perf_counter() - started) * 1000, 'error': str(error)}
