/**
 * Every type appears in the changelog, not only feat and fix. The default preset hides most
 * of them, which produces a changelog reading as though nothing else happened — and in this
 * repository a docs or test commit is frequently the substantive one.
 */
module.exports = {
  types: [
    { type: 'feat', section: '✨ Features' },
    { type: 'fix', section: '🐛 Bug Fixes' },
    { type: 'perf', hidden: false, section: '⚡️ Performance Improvements' },
    { type: 'refactor', hidden: false, section: '♻️ Code Refactoring' },
    { type: 'docs', hidden: false, section: '📝 Documentation' },
    { type: 'test', hidden: false, section: '✅ Testing' },
    { type: 'build', hidden: false, section: '📦 Build & Dependencies' },
    { type: 'ci', hidden: false, section: '🔧 CI/CD' },
    { type: 'chore', hidden: false, section: '🚚 Chores' },
    { type: 'style', hidden: false, section: '💄 Styling' },
    { type: 'security', hidden: false, section: '🔒 Security' },
    { type: 'revert', hidden: false, section: '⏪ Reverts' },
  ],
}
