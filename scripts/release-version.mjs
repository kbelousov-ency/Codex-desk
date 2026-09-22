// Public Windows releases use stable SemVer only. Nightly is a separate channel
// of the same version and is distinguished by the existing content build ID.
export function assertReleaseVersion(version) {
  if (typeof version !== 'string' || !/^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/.test(version)) {
    throw new Error('Версия должна иметь вид MAJOR.MINOR.PATCH без префикса v, ведущих нулей и суффиксов.');
  }
  return version;
}

export function installerFilename(version, channel = 'stable') {
  assertReleaseVersion(version);
  if (!['stable', 'nightly'].includes(channel)) throw new Error('Неверный канал установщика.');
  return `Codex-Desk${channel === 'nightly' ? '-Nightly' : ''}-Setup-${version}.exe`;
}
