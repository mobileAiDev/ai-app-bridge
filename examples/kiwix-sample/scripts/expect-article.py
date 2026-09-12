"""Read-only article assertion for the intentional wrong-expectation run."""
import json
from pathlib import Path


def main(ctx):
    output = Path(ctx.inputs['outputDir'])
    output.mkdir(parents=False, exist_ok=False)
    read = ctx.call('ios-h5-dom')
    with (output / 'article.json').open('x') as file:
        json.dump(read, file, ensure_ascii=False, indent=2)
        file.write('\n')
    if read['ok'] is not True:
        raise RuntimeError(f"ios-h5-dom: {read.get('error')}")
    dom = read['result']['dom']
    verdict = ctx.assert_({
        'name': 'expected local article title and URL',
        'condition': dom['readyState'] == 'complete'
            and dom['title'] == ctx.inputs['expectedTitle']
            and dom['url'] == ctx.inputs['expectedURL'],
        'requiredEvidence': ['tree'], 'evidence': read['evidence'],
    })
    if verdict['verdict'] != 'passed':
        raise RuntimeError(f"expected local article title and URL: {verdict['verdict']}")
    return {'ok': True, 'checks': [verdict], 'artifacts': []}
