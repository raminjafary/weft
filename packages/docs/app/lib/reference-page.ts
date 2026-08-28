import type { Block } from '../fragments/docs/page.tsx'
import type { Cell } from '../fragments/docs/table.tsx'
import type { ProvProps } from '../fragments/docs/prov.tsx'
import { bespoke, cell, figure, heading, note, option, prose, table } from './blocks.ts'
import { docHtml, docParagraphs, type Field } from './declared.ts'
import { conventionNotes, conventionRows, DIRECTORIES, directoryAnchor, groupOfPath } from './conventions.ts'
import { EXAMPLES } from './examples.ts'
import { bindable, implemented, ports } from './ports.ts'
import { onThisPage } from './rails.ts'
import { escapeHtml } from './escape.ts'
import {
  anchorOf,
  BY_ID,
  defaultsFor,
  fieldCount,
  groupDeclaration,
  REFERENCES,
  referenceIds,
  type Group,
  type Reference,
} from './reference.ts'

/**
 * The reference section, as blocks.
 *
 * Every page here has the same four movements — what this is, a whole file to copy, a summary
 * table, then one entry per field — and they are in that order because it is the order somebody
 * uses them in. The table is for the reader who knows the name and wants the default; the entries
 * are for the reader who does not know the name yet, which is why the outline column lists every
 * one of them.
 */

const REPO = 'https://github.com/raminjafary/weft/blob/main'

/** `'app'` is the default; `(config.documents?.shared ? 3600 : 0)` is a rule, not a value. */
function fallbackOf(defaults: Map<string, string>, path: string): string {
  const found = defaults.get(path)
  if (!found) return '—'
  return /\bconfig[.?]/.test(found) ? 'derived' : found
}

function memberRows(defaults: Map<string, string>, field: Field): Cell[][] {
  return field.members.map((member) => [
    cell.code(`${member.name}${member.optional ? '?' : ''}`),
    cell.code(member.type),
    defaults.size
      ? codeOrDash(fallbackOf(defaults, `${field.name}.${member.name}`))
      : cell.hint(member.optional ? 'optional' : 'required'),
  ])
}

function codeOrDash(text: string): Cell {
  return text === '—' ? cell.hint(text) : cell.code(text)
}

/**
 * A field with no doc comment of its own.
 *
 * Said rather than left blank, and said the same way the API page says it: the type and the file
 * are what the page can honestly show, and a sentence invented here would be a sentence nothing
 * checks. Every one of these is a doc comment somebody could write in the framework, and writing
 * it there is what puts it here.
 */
const UNDOCUMENTED =
  'No doc comment on the declaration. The type and the default above are all this page can ' +
  'honestly show — and a sentence invented here would be one nothing checks.'

function entriesOf(reference: Reference, group: Group): Block[] {
  const declaration = groupDeclaration(group)
  const defaults = defaultsFor(reference)
  const scoped = group.prefix ? new Map<string, string>() : defaults
  return declaration.fields.map((field) => {
    const paragraphs = docParagraphs(field.doc)
    const id = anchorOf(group, field)
    return option({
      name: field.name,
      id,
      type: field.type,
      // A required field has no default by definition, and the chip beside its name says so
      // already. `Default: required` is a row that answers a different question than it asks.
      fallback: scoped.size ? fallbackOf(scoped, field.name) : '—',
      required: !field.optional,
      paragraphs: paragraphs.length ? paragraphs : [docHtml(UNDOCUMENTED)],
      members: memberRows(scoped, field),
      example: EXAMPLES[`${reference.id}.${id}`] ?? '',
    })
  })
}

function summaryOf(reference: Reference, group: Group): Block {
  const declaration = groupDeclaration(group)
  const defaults = defaultsFor(reference)
  const scoped = group.prefix ? new Map<string, string>() : defaults
  const headers = scoped.size ? ['Option', 'Type', 'Default'] : ['Field', 'Type', 'Required']
  return table(
    headers,
    declaration.fields.map((field) => [
      cell.codeLink(field.name, `#${anchorOf(group, field)}`),
      cell.code(field.type),
      scoped.size
        ? codeOrDash(fallbackOf(scoped, field.name))
        : field.optional
          ? cell.hint('optional')
          : cell.text('required'),
    ]),
  )
}

/** Where the interface lives, as a line under its summary table. */
function sourceLine(group: Group): Block {
  const declaration = groupDeclaration(group)
  return prose(
    `<span class="hint">Read from <a href="${REPO}/${escapeHtml(group.file)}"><code>${escapeHtml(
      group.file,
    )}</code></a> · <code>${escapeHtml(declaration.name)}</code></span>`,
  )
}

function declarationBody(reference: Reference): Block[] {
  const blocks: Block[] = [
    prose(...reference.opening),
    figure(reference.example.lang, reference.example.code, reference.example.caption),
  ]

  for (const group of reference.groups) {
    const declaration = groupDeclaration(group)
    blocks.push(heading(group.title, groupAnchor(group)))
    if (group.note) blocks.push(prose(group.note))
    else if (declaration.doc) blocks.push(prose(...docParagraphs(declaration.doc)))
    blocks.push(summaryOf(reference, group), sourceLine(group), ...entriesOf(reference, group))
  }
  return blocks
}

export function groupAnchor(group: Group): string {
  return group.prefix ? `group-${group.prefix}` : 'options'
}

function directoriesBody(reference: Reference): Block[] {
  const rows = conventionRows()
  const blocks: Block[] = [
    prose(...reference.opening),
    figure(reference.example.lang, reference.example.code, reference.example.caption),
    heading('Every path the framework knows', 'paths'),
    table(
      ['Path', 'What it is'],
      rows.map((row) => [cell.code(row.path), cell.text(row.what)]),
    ),
    prose(...conventionNotes().map((text) => docHtml(text))),
    note(
      'why',
      'A page that is not in app/routes/ does not exist',
      'A convention is only worth having if it is the single source of the route table, so nothing ' +
        'downstream of the file tree may add a route. There is no router to register with and no ' +
        'plugin hook that can add one.',
    ),
  ]

  for (const directory of DIRECTORIES) {
    const inside = rows.filter((row) => groupOfPath(row.path) === directory.path)
    blocks.push(heading(directory.path, directoryAnchor(directory.path)), prose(directory.what))
    if (inside.length) {
      blocks.push(
        table(
          ['Path', 'What it is'],
          inside.map((row) => [cell.code(row.path), cell.text(row.what)]),
        ),
      )
    }
  }

  blocks.push(
    heading('What a file may say', 'declares'),
    prose(
      'The tree above says where a file goes. What it may <em>declare</em> is the rest of this section: ' +
        '<a href="/reference/route"><code>defineRoute</code></a> for a <code>.data.ts</code>, ' +
        '<a href="/reference/intent"><code>defineIntent</code></a> for a module under ' +
        '<code>app/intents/</code>, ' +
        '<a href="/reference/renderable"><code>defineRenderable</code></a> for one under ' +
        '<code>app/renderables/</code>, and ' +
        '<a href="/reference/config"><code>weft.config.ts</code></a> for the deployment around all of it.',
    ),
  )
  return blocks
}

function portsBody(reference: Reference): Block[] {
  const all = ports()
  const blocks: Block[] = [
    prose(...reference.opening),
    figure(reference.example.lang, reference.example.code, reference.example.caption),
    heading('Every port', 'every'),
    prose(
      `<span class="hint">${all.length} declared · ${implemented()} with an implementation in ` +
        `<code>@weftjs/adapters</code> · ${bindable()} a deployment can bind from ` +
        `<code>weft.config.ts</code>. Counted from the source, not stated.</span>`,
    ),
    table(
      ['Port', 'Config key', 'What implements it'],
      all.map((port) => [
        cell.codeLink(port.name, `#${port.name.toLowerCase()}`),
        port.key ? cell.codeLink(port.key, `/reference/config#${port.key}`) : cell.hint('front door'),
        port.implementations.length
          ? cell.code(port.implementations.map((one) => one.name).join(', '))
          : cell.hint('the kernel’s own'),
      ]),
    ),
    note(
      'why',
      'A port with no config key is not unreachable',
      'Some are configured through a shape rather than by binding one: flag axes are the flags option, ' +
        'executors are the executors map, and the scheduler, the renderer and the transport are the ' +
        'front door’s to choose. A config key means a deployment may replace the implementation ' +
        'outright, which is a stronger thing than being able to configure it.',
    ),
  ]

  for (const port of all) {
    const bound = port.key
      ? `Bound with <a href="/reference/config#${escapeHtml(port.key)}"><code>${escapeHtml(
          port.key,
        )}</code></a> in <code>weft.config.ts</code>.`
      : 'Bound by the front door. A deployment does not name this one.'
    blocks.push(
      heading(port.name, port.name.toLowerCase()),
      prose(
        port.doc ? docHtml(port.doc) : 'No doc comment on the declaration.',
        `<span class="hint">${bound}</span>`,
      ),
      port.implementations.length
        ? table(
            ['In @weftjs/adapters', 'What it is', 'Source'],
            port.implementations.map((one) => [
              cell.code(one.name),
              cell.text(one.summary || '—'),
              cell.link(one.file.replace('packages/adapters/src/', ''), `${REPO}/${one.file}`),
            ]),
          )
        : prose(
            '<span class="hint">Nothing in <code>@weftjs/adapters</code> returns one: the kernel’s own ' +
              'implementation is the only one, and a deployment that wants another writes it.</span>',
          ),
    )
  }
  return blocks
}

/** The body of one reference page. */
export function referenceBody(id: string): Block[] {
  const reference = BY_ID[id]
  if (!reference) {
    return [
      prose(
        `No such reference. Known: ${REFERENCES.map(
          (one) => `<a href="/reference/${one.id}"><code>${escapeHtml(one.label)}</code></a>`,
        ).join(', ')}.`,
      ),
    ]
  }
  const body =
    reference.kind === 'directories'
      ? directoriesBody(reference)
      : reference.kind === 'ports'
        ? portsBody(reference)
        : declarationBody(reference)

  return [...body, ...sequence(reference)]
}

/**
 * Previous and next, at the foot of the page.
 *
 * The guide has had this since it was a sequence; the reference is one too — the six pages are in
 * the order somebody meets them, from the folder to the file to the deployment — and a reader who
 * finishes one should not have to go back to the rail to find the next.
 */
function sequence(reference: Reference): Block[] {
  const at = REFERENCES.indexOf(reference)
  const previous = REFERENCES[at - 1]
  const next = REFERENCES[at + 1]
  if (!previous && !next) return []
  const links = [
    previous ? `<a class="prev" href="/reference/${previous.id}">← ${escapeHtml(previous.label)}</a>` : '',
    next ? `<a class="next" href="/reference/${next.id}">${escapeHtml(next.label)} →</a>` : '',
  ].join('')
  return [bespoke(`<nav class="sequence">${links}</nav>`)]
}

/** The section index: what each page is, and how many fields it documents. */
export function referenceIndexBody(): Block[] {
  return [
    prose(
      'Every entry — the type, the default, the sentence explaining it — is read out of the source that ' +
        'implements it. A field added to the framework appears here in the same commit; a field removed ' +
        'disappears; a default changed changes on the page that quotes it.',
      'This is the half the guide is not. The guide explains a mechanism and shows the two fields that ' +
        'make the point, which is the right thing to read first and the wrong thing to have open beside ' +
        'a config file at four in the afternoon.',
    ),
    table(
      ['Reference', 'What it is', 'Fields'],
      REFERENCES.map((reference) => [
        cell.link(reference.label, `/reference/${reference.id}`),
        cell.text(reference.blurb),
        reference.kind === 'declaration'
          ? cell.text(String(fieldCount(reference)))
          : reference.kind === 'ports'
            ? cell.text(String(ports().length))
            : cell.text(String(conventionRows().length)),
      ]),
    ),
    note(
      'why',
      'Why none of this is written by hand',
      'A hand-written reference is a second copy of the surface, and a second copy drifts — silently, ' +
        'and in the direction that makes the documentation wrong rather than merely old. The test walks ' +
        'the same interfaces this page does and fails when an entry is missing, which is what makes ' +
        '“these are all the options” a gate rather than a promise.',
    ),
    ...REFERENCES.flatMap((reference) => [
      heading(reference.label, reference.id),
      prose(reference.opening[0] as string),
      prose(`<a class="more" href="/reference/${reference.id}">${escapeHtml(reference.title)} in full →</a>`),
    ]),
  ]
}

/** The outline column: every option on the page, which is what makes the section browsable. */
export function referenceOutline(id?: string): string {
  const reference = id ? BY_ID[id] : undefined
  if (!reference) {
    return onThisPage(
      REFERENCES.map((one, at) => ({ label: one.label, href: `#${one.id}`, current: at === 0 })),
      'The references',
    )
  }
  if (reference.kind === 'ports') {
    return onThisPage(
      [
        { label: 'Every port', href: '#every', current: true },
        ...ports().map((port) => ({ label: port.name, href: `#${port.name.toLowerCase()}` })),
      ],
      'On this page',
    )
  }
  if (reference.kind === 'directories') {
    return onThisPage(
      [
        { label: 'Every path the framework knows', href: '#paths', current: true },
        ...DIRECTORIES.map((directory) => ({
          label: directory.path,
          href: `#${directoryAnchor(directory.path)}`,
        })),
        { label: 'What a file may say', href: '#declares' },
      ],
      'On this page',
    )
  }
  const items = reference.groups.flatMap((group, index) => [
    { label: group.title, href: `#${groupAnchor(group)}`, current: index === 0 },
    ...groupDeclaration(group).fields.map((field) => ({
      label: field.name,
      href: `#${anchorOf(group, field)}`,
    })),
  ])
  return onThisPage(items, 'On this page')
}

/** One row of the provenance list. The same shape `outlines.ts` builds, for the same component. */
const fact = (label: string, value: string, options: { href?: string; code?: boolean } = {}) => ({
  label,
  value,
  href: options.href ?? '',
  code: options.code ?? false,
})

/** The provenance card under the outline: where this page came from, and what argues for it. */
export function referenceProv(id?: string): Record<string, unknown> {
  const reference = id ? BY_ID[id] : undefined
  if (!reference) {
    return {
      heading: 'This section',
      facts: [
        fact('References', String(REFERENCES.length)),
        fact('Ports', String(ports().length)),
        fact('Paths', String(conventionRows().length)),
      ],
      moreHref: '/api',
      moreLabel: 'Every export, module by module',
    } satisfies ProvProps
  }
  const files = [...new Set(reference.groups.map((group) => group.file))]
  return {
    heading: 'Where this came from',
    facts: [
      fact(
        reference.kind === 'declaration' ? 'Fields' : reference.kind === 'ports' ? 'Ports' : 'Paths',
        String(
          reference.kind === 'declaration'
            ? fieldCount(reference)
            : reference.kind === 'ports'
              ? ports().length
              : conventionRows().length,
        ),
      ),
      ...(files[0] ? [fact('Source', files[0], { href: `${REPO}/${files[0]}` })] : []),
      ...reference.seeAlso.map((link) => fact('See also', link.label, { href: link.href })),
    ],
    moreHref: '/reference',
    moreLabel: 'All references',
  } satisfies ProvProps
}

export { referenceIds }
