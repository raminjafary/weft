/**
 * Conventional Commits, with the scopes this repository actually has. The scope list is
 * closed on purpose: a commit that does not fit one of these is usually a commit that is
 * doing two things.
 */
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    'scope-enum': [
      2,
      'always',
      [
        'ir',
        'warp',
        'compiler',
        'client',
        'kernel',
        'bench',
        'spec',
        'deps',
        'repo',
      ],
    ],
    'scope-empty': [1, 'never'],
    'body-max-line-length': [2, 'always', 100],
    'subject-case': [2, 'always', ['sentence-case', 'lower-case']],
    'header-max-length': [2, 'always', 72],
  },
}
