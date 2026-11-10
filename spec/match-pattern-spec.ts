import { expect } from 'chai'
import {
  matchesPattern,
  parseMatchPattern,
  patternCovers,
} from '../src/browser/match-pattern'

describe('match patterns', () => {
  it('matches a host and any of its subdomains with *.', () => {
    expect(matchesPattern('*://*.example.com/*', 'https://example.com/')).to.equal(true)
    expect(matchesPattern('*://*.example.com/*', 'https://a.b.example.com/x?y')).to.equal(true)
    expect(matchesPattern('*://*.example.com/*', 'https://badexample.com/')).to.equal(false)
  })

  it('does not let a path or query pose as the host', () => {
    // The old glob matcher let '.*' run across the '/', so this matched.
    expect(matchesPattern('*://*.example.com/*', 'https://evil.com/a.example.com/')).to.equal(false)
    expect(matchesPattern('*://*.example.com/*', 'https://evil.com/?.example.com/')).to.equal(false)
    expect(matchesPattern('https://example.com/*', 'https://example.com.evil.com/')).to.equal(false)
    expect(matchesPattern('https://example.com/*', 'https://user@evil.com/?example.com')).to.equal(false)
  })

  it('matches any host with a * host', () => {
    expect(matchesPattern('http://*/*', 'http://127.0.0.1:5555/')).to.equal(true)
    expect(matchesPattern('*://*/*', 'https://example.com/a?b')).to.equal(true)
    expect(matchesPattern('*://*/*', 'file:///etc/hosts')).to.equal(false)
  })

  it('takes * as http and https only', () => {
    expect(matchesPattern('*://example.com/*', 'http://example.com/')).to.equal(true)
    expect(matchesPattern('*://example.com/*', 'ftp://example.com/')).to.equal(false)
    expect(matchesPattern('*://example.com/*', 'file:///example.com/')).to.equal(false)
  })

  it('matches any port unless the pattern names one', () => {
    expect(matchesPattern('http://127.0.0.1/*', 'http://127.0.0.1:8473/page')).to.equal(true)
    expect(matchesPattern('http://127.0.0.1:80/*', 'http://127.0.0.1:8473/page')).to.equal(false)
    expect(matchesPattern('http://127.0.0.1:80/*', 'http://127.0.0.1/page')).to.equal(true)
  })

  it('matches the path and query as a glob', () => {
    expect(matchesPattern('https://example.com/a/*', 'https://example.com/a/b?c')).to.equal(true)
    expect(matchesPattern('https://example.com/a/*', 'https://example.com/b/a/')).to.equal(false)
    expect(matchesPattern('https://example.com/page?x*', 'https://example.com/page?xyz')).to.equal(true)
  })

  it('never matches browser or other schemes with <all_urls>', () => {
    expect(matchesPattern('<all_urls>', 'https://example.com/')).to.equal(true)
    expect(matchesPattern('<all_urls>', 'file:///etc/hosts')).to.equal(true)
    expect(matchesPattern('<all_urls>', 'peersky://settings')).to.equal(false)
    expect(matchesPattern('<all_urls>', 'chrome://settings')).to.equal(false)
    expect(matchesPattern('<all_urls>', 'chrome-extension://abc/page.html')).to.equal(false)
  })

  it('refuses invalid patterns with Chrome\'s messages', () => {
    expect(() => parseMatchPattern('not a pattern')).to.throw('Missing scheme separator.')
    expect(() => parseMatchPattern('gopher://x/*')).to.throw('Invalid scheme.')
    expect(() => parseMatchPattern('https://example.com')).to.throw('Missing path.')
    expect(() => parseMatchPattern('https://ex*mple.com/*')).to.throw('Invalid host wildcard.')
    expect(matchesPattern('not a pattern', 'https://example.com/')).to.equal(false)
  })

  it('knows when one pattern covers another', () => {
    expect(patternCovers('<all_urls>', 'https://a.example/*')).to.equal(true)
    expect(patternCovers('*://*.example.com/*', 'https://a.example.com/x/*')).to.equal(true)
    expect(patternCovers('https://a.example.com/*', '*://*.example.com/*')).to.equal(false)
    expect(patternCovers('https://a.example/*', 'https://b.example/*')).to.equal(false)
  })
})
