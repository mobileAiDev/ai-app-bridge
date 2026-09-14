"""Python equivalent of memos-flow.js, using public Bridge calls only.

The independent SQLite oracle runs after this Script and never supplies UI
success signals. Inputs use a unique marker and the same full-content contract.
"""
import json
from pathlib import Path
import time
from urllib.parse import urlparse


ELEMENT_KEYS = ('elementId', 'tag', 'id', 'name', 'type', 'role', 'ariaLabel',
                'placeholder', 'href', 'text')


def main(ctx):
    marker = ctx.inputs['marker']
    verdicts = []

    def call(command, args=None):
        result = ctx.call(command, {} if args is None else args)
        if result['ok'] is not True or result.get('ambiguous') is True:
            raise RuntimeError(f"{command}:{result.get('error')}")
        return result

    def read(selector=None):
        return call('web-dom', {} if selector is None else {'selector': selector})

    def controls(observation):
        return [node for node in observation['result']['dom']['controls'] if node['visible']]

    def one(observation, predicate, label):
        nodes = [node for node in controls(observation) if predicate(node)]
        if len(nodes) != 1:
            raise RuntimeError(f'{label}:expected one observed control, received {len(nodes)}')
        return nodes[0]

    def act(observation, node, command, args=None):
        return call(command, {
            'selector': {'elementId': node['elementId']},
            'expectedTarget': {'pageRef': observation['result']['pageRef'],
                               'element': {key: node[key] for key in ELEMENT_KEYS}},
            **({} if args is None else args),
        })

    def check(name, observation, condition):
        verdict = ctx.assert_({'name': name, 'condition': condition,
                               'requiredEvidence': ['tree'], 'evidence': observation['evidence']})
        verdicts.append(verdict)
        if verdict['verdict'] != 'passed':
            raise RuntimeError(f"{name}:{verdict['verdict']}:{verdict.get('reason')}")

    def until(name, selector, predicate):
        deadline = time.monotonic() + 15
        while True:
            observation = read(selector)
            if predicate(observation):
                check(name, observation, True)
                return observation
            if time.monotonic() >= deadline:
                raise RuntimeError(f'{name}:observed state deadline')
            time.sleep(0.2)

    def button(text):
        def ready(value):
            nodes = [node for node in controls(value) if node['text'] == text]
            return len(nodes) == 1 and nodes[0]['interaction']['status'] == 'ready'
        observation = until(f'{text} is ready', None, ready)
        return act(observation, one(observation, lambda node: node['text'] == text, text), 'web-click')

    observation = read()
    if urlparse(observation['result']['dom']['url']).path == '/auth':
        credentials = json.loads(Path(ctx.inputs['credentialsPath']).read_text())
        act(observation, one(observation, lambda node: node['id'] == 'signin-username', 'username'),
            'web-input', {'value': credentials['username']})
        observation = read()
        act(observation, one(observation, lambda node: node['id'] == 'signin-password', 'password'),
            'web-input', {'value': credentials['password']})
        button('Sign in')
        observation = until('authenticated home', None,
                            lambda value: urlparse(value['result']['dom']['url']).path == '/')
    if ctx.inputs.get('negativeOnly') is True:
        check('wrong memo content must fail', observation, marker in observation['result']['dom']['bodyText'])
        return {'verdicts': verdicts}

    observation = until('home editor is ready', None, lambda value: any(
        node['role'] == 'textbox' and node['editable'] and node['interaction']['status'] == 'ready'
        for node in controls(value)))
    check('fresh marker is absent before create', observation, marker not in observation['result']['dom']['bodyText'])
    act(observation, one(observation, lambda node: node['role'] == 'textbox' and node['editable'], 'home editor'),
        'web-input', {'value': ctx.inputs['content']})
    button('Save')
    until('created memo is rendered as an article', 'article',
          lambda value: any(marker in node['text'] for node in controls(value)))

    observation = read()
    search = lambda node: node['tag'] == 'input' and node['placeholder'] == 'Search memos...'
    act(observation, one(observation, search, 'search'), 'web-input', {'value': marker})
    observation = read()
    act(observation, one(observation, search, 'search'), 'web-key', {'key': 'Enter'})
    until('search isolates the created memo', 'article',
          lambda value: len(controls(value)) == 1 and marker in controls(value)[0]['text'])

    def open_menu():
        article = read('article button')
        return act(article, one(article, lambda node: node['tag'] == 'button', 'memo menu'), 'web-click')

    open_menu()
    button('Edit')
    observation = read()
    editor = one(observation, lambda node: node['role'] == 'textbox' and node['editable'] and marker in node['text'],
                 'existing memo editor')
    check('existing editor contains original content', observation,
          marker in editor['text'] and '牛奶 2 瓶' in editor['text'])
    act(observation, editor, 'web-input', {'value': ctx.inputs['editedContent']})
    observation = read()
    act(observation, one(observation, lambda node: node['tag'] == 'button' and node['text'] == 'Save' and not node['disabled'],
                         'enabled edit Save'), 'web-click')
    until('edited memo is rendered', 'article', lambda value: len(controls(value)) == 1
          and 'Script edit verified' in controls(value)[0]['text'])

    open_menu()
    button('Delete')
    observation = read()
    check('delete requires confirmation', observation,
          any(node['text'] == 'Cancel' for node in controls(observation))
          and any(node['text'] == 'Delete' for node in controls(observation)))
    button('Cancel')
    observation = until('cancelled delete retains the memo', None,
                        lambda value: marker in value['result']['dom']['bodyText'] and not any(
                            node['tag'] == 'button' and node['text'] == 'Cancel' for node in controls(value)))
    check('final edited business content is visible', observation,
          'Script edit verified' in observation['result']['dom']['bodyText'])
    return {'marker': marker, 'verdicts': verdicts, 'assertionCount': len(verdicts)}
