import { describe, expect, it } from 'vitest'
import type { ConversationItem } from '../../src/shared/types'
import { handoffFile, handoffPrompt, handoffReply, handoffRequest } from '../../src/main/handoff'

const item = (kind: ConversationItem['kind'], text: string): ConversationItem => ({ kind, text, at: '2026-11-27T00:00:00Z' })

describe('handoff', () => {
  it('asks only for the context of the given point, with a token to find the reply', () => {
    const r = handoffRequest('  the Mongo connection ', 'ab12')
    expect(r.startsWith('[betools handoff ab12]')).toBe(true)
    expect(r).toContain('It will work on: the Mongo connection')
    expect(r).toContain('not a summary of everything')
    expect(r).toContain('Do not include secret values')
  })

  it('takes the assistant text after the request, ignoring earlier replies and tools', () => {
    const items = [
      item('assistant', 'old answer'),
      item('user', '[betools handoff ab12] Another…'),
      item('thinking', 'hmm'),
      item('assistant', '## Goal\nfix it'),
      item('tool', 'Read x'),
      item('assistant', '## Next\nrun tests')
    ]
    expect(handoffReply(items, 'ab12')).toBe('## Goal\nfix it\n\n## Next\nrun tests')
  })

  it('is null until Claude replies, or for another token', () => {
    expect(handoffReply([item('user', '[betools handoff ab12] x')], 'ab12')).toBeNull()
    expect(handoffReply([item('user', '[betools handoff zz99] x'), item('assistant', 'y')], 'ab12')).toBeNull()
  })

  it('builds the saved file and the first message of the new session', () => {
    expect(handoffFile({ from: 'ACME-7 api', fromId: 's1', focus: 'healthz', text: 'ctx', at: 'T' })).toBe(
      '<!-- betools handoff · from "ACME-7 api" (s1) · T -->\n\n# Handoff: healthz\n\nctx\n'
    )
    const p = handoffPrompt({ from: 'ACME-7 api', focus: 'healthz', text: 'ctx', file: '/h/x.md' })
    expect(p).toContain('("ACME-7 api")')
    expect(p).toContain('/h/x.md')
    expect(p).toContain('ctx\n\n---\nWork on: healthz')
  })
})
