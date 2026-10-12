const labels = { stable: 'Кузьмич', nightly: 'Кузьмич Nightly', experimental3: 'Кузьмич Experimental 3', development: 'Кузьмич Development' };

export function applicationIconName(channel) {
  if (!Object.hasOwn(labels, channel)) throw new Error('Unknown application channel.');
  return 'kuzmich.ico';
}

export function applicationBuildIdentity(channel) {
  if (!['stable', 'nightly', 'experimental3'].includes(channel)) throw new Error('Unknown packaged application channel.');
  return {
    productName: labels[channel],
    executableName: channel === 'stable' ? 'Codex Desk' : 'Kuzmich',
    iconName: applicationIconName(channel),
  };
}

export function applicationShortcutName(productName) {
  return `${Object.values(labels).includes(productName) ? productName : 'Кузьмич'}.lnk`;
}

/** Disposable test windows must not replace Windows' registered production shortcut. */
export function applicationIdentity(channel, testPid) {
  if (!Object.hasOwn(labels, channel)) throw new Error('Unknown application channel.');
  if (testPid !== undefined && (!Number.isSafeInteger(testPid) || testPid <= 0)) throw new Error('Invalid test process.');
  return {
    name: testPid === undefined ? labels[channel] : `Кузьмич Test ${testPid}`,
    appId: testPid === undefined ? `local.codex.desk.${channel}` : `local.codex.desk.test.${testPid}`,
  };
}

export function applicationWindowAppearance(channel) {
  if (!Object.hasOwn(labels, channel)) throw new Error('Неизвестный канал приложения.');
  const channelLabel = { stable: 'Release', nightly: 'Nightly', experimental3: 'Experimental 3', development: 'Development' }[channel];
  return {
    title: 'Кузьмич — ' + channelLabel,
    backgroundColor: channel === 'nightly' || channel === 'experimental3' ? '#171A19' : '#101311',
  };
}
