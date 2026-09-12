"""Repeat the observed Memos task toggle, with an external persistence checkpoint.

Start on a filtered page containing exactly the requested memo, with one checked
and one unchecked task. All UI work uses public Bridge calls. The controller
checks SQLite at the pause and after restoration; this program never reads it.
"""
import time


ELEMENT_KEYS = ('elementId', 'tag', 'id', 'name', 'type', 'role', 'ariaLabel',
                'placeholder', 'href', 'text')


def main(ctx):
    marker = ctx.inputs['marker']
    verdicts = []

    def call(command, args):
        result = ctx.call(command, args)
        if result['ok'] is not True or result.get('ambiguous') is True:
            raise RuntimeError(f"{command}:{result.get('error')}")
        return result

    def read(selector):
        return call('web-dom', {'selector': selector})

    def check(name, observation, condition):
        verdict = ctx.assert_({'name': name, 'condition': condition,
                               'requiredEvidence': ['tree'], 'evidence': observation['evidence']})
        verdicts.append(verdict)
        if verdict['verdict'] != 'passed':
            raise RuntimeError(f"{name}:{verdict['verdict']}")

    def tasks(observation):
        return [node for node in observation['result']['dom']['controls']
                if node['role'] == 'checkbox' and node['visible']
                and node['interaction']['status'] == 'ready']

    def states(observation):
        return {node['elementId']: node['checked'] for node in tasks(observation)}

    def click(observation, element_id):
        matches = [node for node in tasks(observation) if node['elementId'] == element_id]
        if len(matches) != 1:
            raise RuntimeError('The original observed task is no longer uniquely actionable')
        node = matches[0]
        return call('web-click', {
            'selector': {'elementId': element_id},
            'expectedTarget': {'pageRef': observation['result']['pageRef'],
                               'element': {key: node[key] for key in ELEMENT_KEYS}},
        })

    def until(name, expected):
        deadline = time.monotonic() + 15
        while True:
            observation = read('article [role="checkbox"]')
            if states(observation) == expected:
                check(name, observation, True)
                return observation
            if time.monotonic() >= deadline:
                check(name, observation, False)
            time.sleep(0.2)

    article = read('article')
    articles = [node for node in article['result']['dom']['controls'] if node['visible']]
    check('exactly one filtered memo with the requested marker', article,
          len(articles) == 1 and marker in articles[0]['text'])
    observation = read('article [role="checkbox"]')
    original = states(observation)
    check('two actionable tasks, one checked and one unchecked', observation,
          len(original) == 2 and sum(value is True for value in original.values()) == 1
          and sum(value is False for value in original.values()) == 1)
    element_id = next(key for key, value in original.items() if value is False)
    checked = {key: True for key in original}
    click(observation, element_id)
    until('the same task is checked and its sibling stays checked', checked)
    decision = ctx.askAgent({'checkpoint': 'task-checked', 'marker': marker,
                             'elementId': element_id,
                             'instruction': 'Verify the checked state in SQLite, then answer {"restore":true}.'})
    if decision['restore'] is not True:
        raise RuntimeError('The persistence checkpoint did not authorize restoration')
    observation = read('article [role="checkbox"]')
    check('checked state still belongs to the original two tasks', observation, states(observation) == checked)
    click(observation, element_id)
    until('the original task states are restored', original)
    return {'marker': marker, 'elementId': element_id, 'assertionCount': len(verdicts), 'verdicts': verdicts}
