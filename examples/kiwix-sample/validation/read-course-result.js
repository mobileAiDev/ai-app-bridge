// Read-only external oracle. JSON serialization materializes Vue's reactive
// objects before WebKit transports them; no grader, editor or store action runs.
(() => {
  const store = document.getElementById('app').__vue_app__.config.globalProperties.$pinia._s.get('main');
  return JSON.stringify({ schemaVersion: 'kiwix.course-result/v1', url: location.href,
    solution: store.solution, graded: store.challengeResult,
    passedDialog: store.challengePassedDialogActive, cheatMode: store.cheatMode });
})()
