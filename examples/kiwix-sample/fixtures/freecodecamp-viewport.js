// Explicit test-fixture preparation for the pinned freeCodeCamp ZIM on iOS.
// Change only the fixed reader's height; preserve lesson code, tests and actions.
// Reapply after document navigation/reload, outside the timed business Script.
(() => {
  const lesson = 'zim://B237D3C6-4CE9-B57F-411A-3CCB8CC24367/index.html#/javascript-algorithms-and-data-structures/basic-javascript/cf1111c1c11feddfaeb3bdef';
  if (location.href !== lesson) throw new Error('Unexpected course document');
  const matches = document.querySelectorAll('.content[data-v-c1f2854f]');
  if (matches.length !== 1) throw new Error('Expected one pinned fixed course reader');
  const content = matches[0];
  if (getComputedStyle(content).position !== 'fixed' || content.style.height !== '') {
    throw new Error('Reader layout differs or fixture was already applied');
  }
  const before = content.getBoundingClientRect().height;
  function sizeReader() { content.style.height = `calc(${document.documentElement.clientHeight}px - 2.2rem)`; }
  addEventListener('resize', sizeReader);
  sizeReader();
  return { fixture: 'freecodecamp-reader-height/v1', before, after: content.getBoundingClientRect().height,
    viewportHeight: document.documentElement.clientHeight, changed: 'reader height only' };
})()
