// -----------------------------------------------------------------------------
// Turn the `## [Unreleased]` section of CHANGELOG.md into the release section.
//
// Run by the Release workflow right after `npm version`, so the release commit
// carries a changelog that names the version it ships:
//
//   node .github/scripts/changelog-release.mjs <version> [date]
//
// - the content of `[Unreleased]` moves under `## [<version>] - <date>`;
// - an empty `## [Unreleased]` section is left on top for the next changes;
// - the comparison links at the bottom follow (`[Unreleased]` now compares
//   from the new tag, and `[<version>]` compares the previous tag with it).
//
// Nothing to move (no Unreleased content) still writes the version header, so
// a release is never missing from the history. A file without an Unreleased
// section is left untouched.
// -----------------------------------------------------------------------------

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Roll the Unreleased section of a Keep a Changelog document.
 * @param {string} text current CHANGELOG.md content
 * @param {string} version released version, e.g. 2.1.0
 * @param {string} date release date, YYYY-MM-DD
 * @returns {string} the new content (unchanged when there is no Unreleased section)
 */
export function rollChangelog(text, version, date) {
  const heading = '## [Unreleased]';
  const start = text.indexOf(heading);
  if (start === -1 || text.includes(`## [${version}]`)) {
    return text;
  }
  const bodyStart = start + heading.length;
  const nextSection = text.indexOf('\n## [', bodyStart);
  const linksStart = text.search(/\n\[Unreleased\]: /);
  const bodyEnd = [nextSection, linksStart].filter((i) => i !== -1).sort((a, b) => a - b)[0];
  const end = bodyEnd ?? text.length;
  const body = text.slice(bodyStart, end).trim();

  const released = body
    ? `## [${version}] - ${date}\n\n${body}\n`
    : `## [${version}] - ${date}\n\n- Maintenance release, no functional change.\n`;
  let result = `${text.slice(0, start)}${heading}\n\n${released}${text.slice(end)}`;

  // [Unreleased]: <repo>/compare/vX...HEAD  or  <repo>/commits/main
  result = result.replace(
    /^\[Unreleased\]: (\S+?)\/(?:compare\/(\S+?)\.\.\.HEAD|commits\/\S+)$/m,
    (_line, repo, previous) =>
      `[Unreleased]: ${repo}/compare/v${version}...HEAD\n` +
      (previous
        ? `[${version}]: ${repo}/compare/${previous}...v${version}`
        : `[${version}]: ${repo}/releases/tag/v${version}`),
  );
  return result;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const [version, date = new Date().toISOString().slice(0, 10)] = process.argv.slice(2);
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error('Usage: node .github/scripts/changelog-release.mjs <x.y.z> [YYYY-MM-DD]');
    process.exit(1);
  }
  const file = 'CHANGELOG.md';
  writeFileSync(file, rollChangelog(readFileSync(file, 'utf8'), version, date));
}
