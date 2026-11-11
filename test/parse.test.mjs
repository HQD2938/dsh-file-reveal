// Unit tests for the pure path rules inside lib/client.js.
//
// The browser half is a hand-written DSH client module: it is not an ES module
// (the loader executes `window.__ModuleLoader__.load`), so the test reads the
// file as text, runs it in a VM with a stub loader, and reaches the exported
// `__test` seam. No DOM is needed for these rules.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

let captured = null
const noop = () => {}
const sandbox = {
  console,
  URL,
  decodeURIComponent,
  Promise,
  Set,
  window: {
    navigator: { language: 'zh-CN' },
    localStorage: { getItem: () => null, setItem: noop },
    setTimeout: () => 0,
    clearTimeout: noop,
    getSelection: () => null,
    requestAnimationFrame: (callback) => callback(),
    __ModuleLoader__: {
      load(definition) {
        captured = definition
      },
    },
  },
}
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'lib/client.js' })

test('the client bundle registers one DSH client module', () => {
  assert.ok(captured, '__ModuleLoader__.load was called')
  assert.equal(captured.id, 'dsh-file-reveal')
  assert.equal(typeof captured.factory, 'function')
})

const reactStub = {
  createElement() {
    return null
  },
  useEffect: noop,
  useSyncExternalStore: noop,
}
const client = captured.factory((specifier) => {
  if (specifier === 'react') return reactStub
  throw new Error('unexpected require(): ' + specifier)
})

test('the plugin exports apply/inject and a JSON-safe test seam', () => {
  assert.equal(typeof client.apply, 'function')
  // The array was created in the VM realm, so copy it before deep comparison.
  assert.deepEqual(Array.from(client.inject), ['sessions', 'remote', 'remote.session', 'slots'])
  assert.equal(typeof client.__test.parsePathToken, 'function')
})

const { parsePathToken, resolveToAbsolute, baseName, stripWrapping } = client.__test

test('absolute Windows paths are recognized and kept', () => {
  assert.equal(parsePathToken('D:\\workspace\\reports\\out.xlsx'), 'D:\\workspace\\reports\\out.xlsx')
  assert.equal(parsePathToken('D:/workspace/reports/out.xlsx'), 'D:/workspace/reports/out.xlsx')
  assert.equal(parsePathToken('C:\\Users\\me\\Desktop'), 'C:\\Users\\me\\Desktop')
  assert.equal(parsePathToken('\\\\server\\share\\folder\\file.txt'), '\\\\server\\share\\folder\\file.txt')
})

test('wrapping quotes, brackets and punctuation are stripped', () => {
  assert.equal(parsePathToken('<D:\\a b\\file.txt>'), 'D:\\a b\\file.txt')
  assert.equal(parsePathToken('`D:\\a\\file.txt`'), 'D:\\a\\file.txt')
  assert.equal(parsePathToken('“D:\\a\\file.txt”，'), 'D:\\a\\file.txt')
  assert.equal(parsePathToken('（D:\\a\\file.txt）'), 'D:\\a\\file.txt')
  assert.equal(stripWrapping('  D:\\a\\file.txt  '), 'D:\\a\\file.txt')
})

test('line anchors are dropped', () => {
  assert.equal(parsePathToken('lib/index.js:42'), 'lib/index.js')
  assert.equal(parsePathToken('lib/index.js:42-58'), 'lib/index.js')
  assert.equal(parsePathToken('D:\\a\\file.md#L24'), 'D:\\a\\file.md')
  assert.equal(parsePathToken('D:\\a\\file.md#L24-L30'), 'D:\\a\\file.md')
  assert.equal(parsePathToken('D:\\a\\file.md#L24–30'), 'D:\\a\\file.md')
})

test('file:// URLs become native paths', () => {
  assert.equal(parsePathToken('file:///D:/a/b.txt'), 'D:\\a\\b.txt')
  assert.equal(parsePathToken('file:///D:/a/%E6%96%87%E4%BB%B6.txt'), 'D:\\a\\文件.txt')
})

test('relative paths with a file extension or explicit prefix are accepted', () => {
  assert.equal(parsePathToken('docs/assets/diagram.png'), 'docs/assets/diagram.png')
  assert.equal(parsePathToken('packages\\demo\\src\\client.js'), 'packages\\demo\\src\\client.js')
  assert.equal(parsePathToken('./out.csv'), './out.csv')
  assert.equal(parsePathToken('../out.csv'), '../out.csv')
  assert.equal(parsePathToken('docs/assets/'), 'docs/assets/')
  // A one-separator relative token with no extension is ambiguous with prose,
  // so it stays inert; two separators are accepted as a directory mention.
  assert.equal(parsePathToken('docs/assets'), null)
  assert.equal(parsePathToken('workspace/docs/assets'), 'workspace/docs/assets')
})

test('non-path inline tokens are rejected', () => {
  assert.equal(parsePathToken('node --check'), null)
  assert.equal(parsePathToken('https://example.com/a/b.txt'), null)
  assert.equal(parsePathToken('mailto:someone@example.com'), null)
  assert.equal(parsePathToken('@deepseek-ai/dsh-client-store'), null)
  assert.equal(parsePathToken('ctx.remote.session'), null)
  assert.equal(parsePathToken('app.asar'), null)
  assert.equal(parsePathToken('README.md'), null)
  assert.equal(parsePathToken('a/b'), null)
  assert.equal(parsePathToken('src/*.js'), null)
  assert.equal(parsePathToken('~/notes.txt'), null)
  assert.equal(parsePathToken('--out/file.txt'), null)
  assert.equal(parsePathToken('dsh-resource://changes-review/1'), null)
  assert.equal(parsePathToken(''), null)
  assert.equal(parsePathToken('x'.repeat(400)), null)
})

test('relative tokens resolve against a Windows session cwd', () => {
  assert.equal(
    resolveToAbsolute('docs/assets/diagram.png', 'D:\\workspace'),
    'D:\\workspace\\docs\\assets\\diagram.png',
  )
  assert.equal(
    resolveToAbsolute('./packages/demo/out.xlsx', 'D:\\workspace\\'),
    'D:\\workspace\\packages\\demo\\out.xlsx',
  )
  assert.equal(
    resolveToAbsolute('../other/f.txt', 'D:\\workspace\\plugins\\demo'),
    'D:\\workspace\\plugins\\other\\f.txt',
  )
  assert.equal(resolveToAbsolute('docs/assets/x.png', 'D:/workspace'), 'D:\\workspace\\docs\\assets\\x.png')
})

test('relative tokens resolve against a POSIX session cwd', () => {
  assert.equal(resolveToAbsolute('./out.txt', '/home/user/project'), '/home/user/project/out.txt')
  assert.equal(resolveToAbsolute('../out.txt', '/home/user/project/sub'), '/home/user/project/out.txt')
})

test('absolute tokens resolve to themselves and unresolvable relatives return null', () => {
  assert.equal(resolveToAbsolute('D:\\a\\b.txt', 'D:\\cwd'), 'D:\\a\\b.txt')
  assert.equal(resolveToAbsolute('docs/assets/x.png', undefined), null)
  assert.equal(resolveToAbsolute('docs/assets/x.png', ''), null)
  assert.equal(resolveToAbsolute('', 'D:\\cwd'), null)
})

test('baseName reads the last segment', () => {
  assert.equal(baseName('D:\\a\\b\\账单匹配结果.xlsx'), '账单匹配结果.xlsx')
  assert.equal(baseName('/home/u/file.txt'), 'file.txt')
})
