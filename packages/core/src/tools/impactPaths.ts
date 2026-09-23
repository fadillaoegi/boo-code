/** Path helpers bersama untuk graph dampak dan pemilihan test. */

import { basename, dirname, extname, posix } from 'node:path'

export function normalizeChangedPath(value: string): string | undefined {
  const clean = value.replaceAll('\\', '/').replace(/^\.\//, '')
  if (!clean || [...clean].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
    || clean.startsWith('/') || clean === '..' || clean.startsWith('../') || clean.includes('/../')) return undefined
  return posix.normalize(clean)
}

export function isTestPath(path: string): boolean {
  const name = basename(path)
  return /(?:^|\/)(?:test|tests|__tests__|spec)(?:\/|$)/i.test(path)
    || /(?:\.test|\.spec)\.[^.]+$/i.test(name)
    || /(?:_test\.go|_test\.py|_spec\.rb|Test\.(?:java|kt|php|cs)|Tests\.swift)$/i.test(name)
}

/** Kandidat berbasis konvensi; pemanggil tetap memeriksa bahwa path benar-benar ada. */
export function conventionalTestCandidates(path: string): string[] {
  const extension = extname(path)
  if (!extension) return []
  const directory = dirname(path) === '.' ? '' : dirname(path)
  const filename = basename(path, extension)
  const sibling = (name: string) => directory ? `${directory}/${name}` : name
  const candidates = new Set<string>()

  if (/\.(?:[cm]?[jt]sx?|vue|svelte)$/i.test(extension)) {
    for (const suffix of ['test', 'spec']) {
      candidates.add(sibling(`${filename}.${suffix}${extension}`))
      candidates.add(sibling(`__tests__/${filename}.${suffix}${extension}`))
    }
    const relative = path.replace(/^(?:src|lib|app)\//, '')
    const testDirectory = dirname(relative) === '.' ? '' : `${dirname(relative)}/`
    const testName = basename(relative, extension)
    for (const root of ['test', 'tests']) for (const suffix of ['test', 'spec']) candidates.add(`${root}/${testDirectory}${testName}.${suffix}${extension}`)
  } else if (extension === '.go') {
    candidates.add(sibling(`${filename}_test.go`))
  } else if (extension === '.py') {
    candidates.add(sibling(`test_${filename}.py`))
    candidates.add(sibling(`${filename}_test.py`))
    const relative = path.replace(/^(?:src|lib|app)\//, '')
    const testDirectory = dirname(relative) === '.' ? '' : `${dirname(relative)}/`
    candidates.add(`tests/${testDirectory}test_${basename(relative, extension)}.py`)
    candidates.add(`test/${testDirectory}test_${basename(relative, extension)}.py`)
  } else if (extension === '.dart') {
    const relative = path.replace(/^lib\//, '')
    candidates.add(`test/${relative.slice(0, -extension.length)}_test.dart`)
    candidates.add(sibling(`${filename}_test.dart`))
  } else if (/\.(?:java|kt|cs|php)$/i.test(extension)) {
    candidates.add(sibling(`${filename}Test${extension}`))
    const testTree = path.replace(/^src\/main\//, 'src/test/')
    candidates.add(`${testTree.slice(0, -extension.length)}Test${extension}`)
    const relative = path.replace(/^(?:src|app|lib)\//, '')
    candidates.add(`tests/${relative.slice(0, -extension.length)}Test${extension}`)
  } else if (extension === '.rb') {
    candidates.add(sibling(`${filename}_spec.rb`))
    candidates.add(sibling(`${filename}_test.rb`))
    const relative = path.replace(/^(?:lib|app)\//, '')
    candidates.add(`spec/${relative.slice(0, -3)}_spec.rb`)
    candidates.add(`test/${relative.slice(0, -3)}_test.rb`)
  } else if (extension === '.rs') {
    candidates.add(`tests/${filename}.rs`)
  } else if (extension === '.swift') {
    candidates.add(sibling(`${filename}Tests.swift`))
  }
  return [...candidates]
}
