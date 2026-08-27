// -----------------------------------------------------------------------------------------
// build:       changes to the build system or dependencies
// chore:       miscellaneous changes that do not touch the codebase itself
// ci:          changes to CI configuration and scripts
// docs:        documentation only
// feat:        a new capability
// fix:         a defect corrected — including a measurement that reverses a stated finding
// perf:        a change that improves performance
// refactor:    neither fixes a defect nor adds a capability
// style:       formatting only, no change in meaning
// test:        adding or correcting tests
// security:    addresses a vulnerability or hardens the codebase
// revert:      reverts a previous commit
// -----------------------------------------------------------------------------------------
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'header-max-length': [2, 'always', 108],
    'body-max-line-length': [2, 'always', 100],
    'footer-leading-blank': [1, 'always'],
    'body-leading-blank': [2, 'always'],
    'subject-empty': [2, 'never'],
    'type-empty': [2, 'never'],
    'subject-case': [0],
    'type-enum': [
      2,
      'always',
      [
        'build',
        'chore',
        'ci',
        'docs',
        'feat',
        'fix',
        'perf',
        'refactor',
        'revert',
        'style',
        'test',
        'security',
      ],
    ],
    // This repository's own addition: the scope list is closed, because a commit that fits
    // none of these is usually a commit doing two things.
    'scope-enum': [
      2,
      'always',
      [
        'ir',
        'warp',
        'compiler',
        'client',
        'kernel',
        'plan',
        'adapters',
        'bench',
        'weft',
        'create',
        'inspector',
        'docs',
        'demo',
        'spec',
        'deps',
        'repo',
        // `chore(release): v0.1.0`, written by scripts/release/release.mjs.
        'release',
      ],
    ],
    'scope-empty': [1, 'never'],
  },
}
