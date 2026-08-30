const assert = require('assert/strict');
const test = require('node:test');

const { requiredInputString: androidInputString } = require('../bin/ai-app-bridge');
const { requiredInputString: iosInputString } = require('../bin/ios-provider');

for (const [platform, requiredInputString] of [
  ['Android', androidInputString],
  ['iOS', iosInputString],
]) {
  test(`${platform} input accepts an empty string so agents can clear a field`, () => {
    assert.equal(requiredInputString('', 'text'), '');
    assert.equal(requiredInputString('内容', 'text'), '内容');
    assert.throws(() => requiredInputString(undefined, 'text'), /text is required/);
    assert.throws(() => requiredInputString(null, 'text'), /text is required/);
  });
}
