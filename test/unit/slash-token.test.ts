import { describe, expect, it } from 'vitest'
import { applySlash, slashAt } from '../../src/renderer/src/slash-token'

describe('slashAt', () => {
  it('finds the command at the start and in the middle of the message', () => {
    expect(slashAt('/com', 4)).toEqual({ start: 0, end: 4, query: 'com' })
    expect(slashAt('please run /jira-t', 18)).toEqual({ start: 11, end: 18, query: 'jira-t' })
    expect(slashAt('a\n/', 3)).toEqual({ start: 2, end: 3, query: '' })
  })

  it('takes the rest of the word when the cursor is inside it', () => {
    expect(slashAt('use /jira now', 7)).toEqual({ start: 4, end: 9, query: 'jira' })
  })

  it('ignores a slash inside a word, a path, or a word already left behind', () => {
    expect(slashAt('and/or', 4)).toBeNull()
    expect(slashAt('see /home/x', 11)).toBeNull()
    expect(slashAt('see /home/x', 7)).toBeNull()
    expect(slashAt('/compact now', 12)).toBeNull()
  })
})

describe('applySlash', () => {
  it('replaces only that word and leaves the cursor after the command', () => {
    const text = 'please run /jira-t then commit'
    const tok = slashAt(text, 18)!
    expect(applySlash(text, tok, 'jira-ticket-comment')).toEqual({ text: 'please run /jira-ticket-comment then commit', caret: 32 })
    expect(applySlash('/co', slashAt('/co', 3)!, 'compact')).toEqual({ text: '/compact ', caret: 9 })
  })
})
