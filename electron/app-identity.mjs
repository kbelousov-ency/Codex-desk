const labels = { stable: 'Codex Desk', nightly: 'Codex Desk Nightly', development: 'Codex Desk Development' };

/** Disposable test windows must not replace Windows' registered production shortcut. */
export function applicationIdentity(channel, testPid) {
  if (!Object.hasOwn(labels, channel)) throw new Error('Unknown application channel.');
  if (testPid !== undefined && (!Number.isSafeInteger(testPid) || testPid <= 0)) throw new Error('Invalid test process.');
  return {
    name: testPid === undefined ? labels[channel] : `Codex Desk Test ${testPid}`,
    appId: testPid === undefined ? `local.codex.desk.${channel}` : `local.codex.desk.test.${testPid}`,
  };
}
