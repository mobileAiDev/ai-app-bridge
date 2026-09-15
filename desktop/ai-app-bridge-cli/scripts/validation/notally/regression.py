"""Python independently interprets the same plan and calls the public executor."""
import json
import time
import traceback


def main(ctx):
    plan = ctx.inputs['plan']
    run_id = ctx.inputs['runId']
    steps = json.loads(json.dumps(plan['steps'], ensure_ascii=False).replace('@RUN@', run_id))
    now = lambda: int(time.time() * 1000)
    result = dict(language='python', planVersion=plan['version'], runId=run_id,
                  ok=False, startedAtMs=now(), steps=[], phases=[], actions=0, assertions=0)
    identity = None
    current_phase = None

    def save():
        with open(ctx.inputs['output'], 'w') as stream:
            json.dump(result, stream, ensure_ascii=False, indent=2)

    def call(args):
        reply = ctx.call('android-executor', {'feedback': 'off', **args})
        if not reply['ok'] or reply['result'].get('ok') is False:
            raise RuntimeError(str(reply))
        return reply['result']

    def observe(engine):
        return call({**identity, 'operation': 'observe', 'engine': engine})['observation']

    def matches(node, selector, observation):
        for key, value in selector.items():
            if key == 'within':
                parents = [n for n in observation['nodes'] if matches(n, value, observation)]
                if len(parents) != 1:
                    return False
                parent = node
                while parent and parent['nodeId'] != parents[0]['nodeId']:
                    parent = next((n for n in observation['nodes'] if n['nodeId'] == parent.get('parentId')), None)
                if parent is None:
                    return False
            elif key == 'id':
                expected = value if ':' in value else ctx.inputs['target']['packageName'] + ':id/' + value
                if node.get('resourceId') != expected:
                    return False
            elif key == 'classSuffix':
                if not (node.get('className') or '').endswith(value):
                    return False
            elif key == 'textContains':
                if not isinstance(node.get('text'), str) or value not in node['text']:
                    return False
            elif node.get(key) != value:
                return False
        return True

    def selected(observation, selector):
        return [n for n in observation['nodes'] if matches(n, selector, observation)]

    def act(observation, kind, node, fields, index):
        action = {'type': kind, **({'nodeId': node['nodeId']} if node is not None else {}), **fields}
        reply = call({**identity, 'operation': 'act', 'snapshotId': observation['snapshotId'],
                      'actionId': f'{run_id}-{index}-{result["actions"]}', 'action': action})
        result['actions'] += 1
        return reply['action']

    try:
        opened = call(dict(operation='open', serial=ctx.inputs['target']['serial'], packageName=ctx.inputs['target']['packageName'],
                           instrumentation=ctx.inputs['target']['packageName'] + '.test/androidx.test.runner.AndroidJUnitRunner',
                           testClass='io.github.mobileaidev.aiappbridge.generated.BridgeSessionTest',
                           activity='com.philkes.notallyx.presentation.activity.main.MainActivity',
                           leaseMs=1800000, timeoutMs=45000))
        identity = dict(serial=ctx.inputs['target']['serial'], packageName=ctx.inputs['target']['packageName'],
                        sessionId=opened['sessionId'], runtimeEpoch=opened['runtimeEpoch'])
        result['identity'] = identity
        result['flowStartedAtMs'] = now()
        for index, step in enumerate(steps):
            if step['phase'] != current_phase:
                current_phase = step['phase']
                result['phases'].append(dict(name=current_phase, startedAtMs=now(), firstStep=index))
                ctx.progress(dict(phase=current_phase, step=index, total=len(steps)))
            record = dict(index=index, phase=step['phase'], name=step['name'], operation=step['op'], startedAtMs=now())
            result['steps'].append(record)
            engine = step.get('engine', 'espresso')
            deadline = now() + step.get('timeoutMs', 7000)
            scrolls = 0
            while True:
                observation = observe(engine)
                found = selected(observation, step['selector']) if 'selector' in step else []
                if 'selector' not in step or len(found) == step.get('count', 1):
                    break
                if now() >= deadline:
                    result['failureObservation'] = observation
                    raise RuntimeError(f'Selector count {len(found)} at {index}: {step}')
                if step.get('seek') and scrolls < 10:
                    boxes = selected(observation, {'id': 'MainListView', 'visible': True})
                    assert len(boxes) == 1
                    act(observation, 'swipeDown', boxes[0], {}, index)
                    scrolls += 1
                else:
                    time.sleep(0.1)
            if step['op'] == 'assert':
                result['assertions'] += 1
                record['actual'] = found
            elif step['op'] == 'action':
                node = found[0] if found else None
                if step.get('scroll') is True and node is not None and not node['visible']:
                    act(observation, 'scrollTo', node, {}, index)
                    observation = observe(engine)
                    found = selected(observation, step['selector'])
                    if len(found) != 1 or not found[0]['visible']:
                        raise RuntimeError('Scroll did not reveal exact target')
                    node = found[0]
                record['mechanism'] = act(observation, step['action'], node, step.get('fields', {}), index)
            else:
                raise RuntimeError('Unknown plan operation ' + step['op'])
            record['passed'] = True
            record['elapsedMs'] = now() - record['startedAtMs']
            save()
        result['flowElapsedMs'] = now() - result['flowStartedAtMs']
        result['finalObservation'] = observe('espresso')
        result['ok'] = True
    except Exception:
        result['error'] = traceback.format_exc()
        if identity is not None and 'failureObservation' not in result:
            try:
                result['failureObservation'] = observe('espresso')
            except Exception as error:
                result['observationError'] = str(error)
    finally:
        if identity is not None:
            try:
                result['close'] = call({**identity, 'operation': 'close', 'timeoutMs': 30000})
            except Exception as error:
                result['ok'] = False
                result['closeError'] = str(error)
        result['elapsedMs'] = now() - result['startedAtMs']
        save()
    return result
