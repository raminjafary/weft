import { fragment } from 'weft'

/** A fragment with one hole. The smallest thing this framework compiles. */
export default fragment(({ label }: { label: string }) => <span class="pill">{label}</span>)
