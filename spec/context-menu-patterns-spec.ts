import { expect } from 'chai'
import { isMenuPattern, menuPatternMatches } from '../src/browser/api/context-menus'
import { tryParseMatchPattern } from '../src/browser/match-pattern'

// uBlock Origin's "Subscribe to filter list" item names abp: links with
// "abp:*", which Chrome takes: a menu item's patterns may have any scheme.
describe('context menu URL patterns', () => {
  it('take any scheme, as Chrome does', () => {
    expect(isMenuPattern('abp:*')).to.equal(true)
    expect(isMenuPattern('https://subscribe.adblockplus.org/*')).to.equal(true)
    expect(isMenuPattern('<all_urls>')).to.equal(true)
    expect(isMenuPattern('not a pattern')).to.equal(false)
    expect(isMenuPattern('*://missing-path')).to.equal(false)
    expect(isMenuPattern(42)).to.equal(false)
  })

  it('match a link of that scheme only', () => {
    expect(menuPatternMatches('abp:*', 'abp:subscribe?location=https%3A%2F%2Fa.example%2Flist.txt')).to.equal(true)
    expect(menuPatternMatches('abp:*', 'https://a.example/')).to.equal(false)
    expect(menuPatternMatches('abp:subscribe*', 'abp:other')).to.equal(false)
    expect(menuPatternMatches('https://*/*', 'https://a.example/x')).to.equal(true)
  })

  it('leave host access patterns as strict as before', () => {
    expect(tryParseMatchPattern('abp:*')).to.equal(undefined)
  })
})
