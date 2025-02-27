/* eslint-disable prefer-template */
/* eslint-disable no-template-curly-in-string */
import { existsSync, promises as fs } from 'fs'
import { format } from 'util'
import { relative } from 'pathe'
import c from 'picocolors'
import * as diff from 'diff'
import type { RawSourceMap } from 'source-map-js'
import { SourceMapConsumer } from 'source-map-js'
import cliTruncate from 'cli-truncate'
import { notNullish } from '../utils'
import type { Vitest } from '../node'
import { F_POINTER } from './figures'

interface ErrorWithDiff extends Error {
  name: string
  nameStr?: string
  stack?: string
  stackStr?: string
  showDiff?: boolean
  actual?: any
  expected?: any
  operator?: string
}

interface Position {
  line: number
  column: number
}

export async function printError(error: unknown, ctx: Vitest) {
  let e = error as ErrorWithDiff

  if (typeof error === 'string') {
    e = {
      message: error.split(/\n/g)[0],
      stack: error,
    } as any
  }

  const stackStr = e.stack || e.stackStr || ''
  const stacks = parseStack(stackStr)

  if (!stacks.length) {
    ctx.console.error(e)
  }
  else {
    const nearest = stacks.find((stack) => {
      return !stack.file.includes('vitest/dist')
      && ctx.server.moduleGraph.getModuleById(stack.file)
      && existsSync(stack.file)
    })

    printErrorMessage(e)
    await printStack(ctx, stacks, nearest, async(s, pos) => {
      if (s === nearest) {
        const sourceCode = await fs.readFile(nearest.file, 'utf-8')
        ctx.log(c.yellow(generateCodeFrame(sourceCode, 4, pos)))
      }
    })
  }

  handleImportOutsideModuleError(stackStr, ctx)

  if (e.showDiff)
    displayDiff(e.actual, e.expected)
}

const esmErrors = [
  'Cannot use import statement outside a module',
  'Unexpected token \'export\'',
]

function handleImportOutsideModuleError(stack: string, ctx: Vitest) {
  if (!esmErrors.some(e => stack.includes(e)))
    return

  const path = stack.split('\n')[0].trim()
  let name = path.split('/node_modules/').pop() || ''
  if (name?.startsWith('@'))
    name = name.split('/').slice(0, 2).join('/')
  else
    name = name.split('/')[0]

  ctx.console.error(c.yellow(
    `Module ${path} seems to be an ES Module but shipped in a CommonJS package. `
+ `You might want to create an issue to the package ${c.bold(`"${name}"`)} asking `
+ 'them to ship the file in .mjs extension or add "type": "module" in their package.json.'
+ '\n\n'
+ 'As a temporary workaround you can try to inline the package by updating your config:'
+ '\n\n'
+ c.gray(c.dim('// vitest.config.js'))
+ '\n'
+ c.green(`export default {
  test: {
    deps: {
      inline: [
        ${c.yellow(c.bold(`"${name}"`))}
      ]
    }
  }
}\n`)))
}

async function getSourcePos(ctx: Vitest, nearest: ParsedStack) {
  const mod = ctx.server.moduleGraph.getModuleById(nearest.file)
  const transformResult = mod?.ssrTransformResult
  const pos = await getOriginalPos(transformResult?.map as RawSourceMap | undefined, nearest)
  return pos
}

// TODO: handle big object and big string diff
function displayDiff(actual: string, expected: string) {
  console.error(c.gray(unifiedDiff(stringify(actual), stringify(expected))))
}

function printErrorMessage(error: ErrorWithDiff) {
  const errorName = error.name || error.nameStr || 'Unknown Error'

  console.error(c.red(`${c.bold(errorName)}: ${error.message}`))
}

async function printStack(
  ctx: Vitest,
  stack: ParsedStack[],
  highlight?: ParsedStack,
  onStack?: ((stack: ParsedStack, pos: Position) => void),
) {
  if (!stack.length)
    return

  for (const frame of stack) {
    const pos = await getSourcePos(ctx, frame) || frame
    const color = frame === highlight ? c.yellow : c.gray
    const path = relative(ctx.config.root, frame.file)

    ctx.log(color(` ${c.dim(F_POINTER)} ${[frame.method, c.dim(`${path}:${pos.line}:${pos.column}`)].filter(Boolean).join(' ')}`))
    await onStack?.(frame, pos)

    // reached at test file, skip the follow stack
    if (frame.file in ctx.state.filesMap)
      break
  }
  ctx.log()
}

function getOriginalPos(map: RawSourceMap | null | undefined, { line, column }: Position): Promise<Position | null> {
  return new Promise((resolve) => {
    if (!map)
      return resolve(null)

    const consumer = new SourceMapConsumer(map)
    const pos = consumer.originalPositionFor({ line, column })
    if (pos.line != null && pos.column != null)
      resolve(pos as Position)
    else
      resolve(null)
  })
}

const splitRE = /\r?\n/

export function posToNumber(
  source: string,
  pos: number | Position,
): number {
  if (typeof pos === 'number') return pos
  const lines = source.split(splitRE)
  const { line, column } = pos
  let start = 0

  if (line > lines.length)
    return source.length

  for (let i = 0; i < line - 1; i++)
    start += lines[i].length + 1

  return start + column
}

export function numberToPos(
  source: string,
  offset: number | Position,
): Position {
  if (typeof offset !== 'number') return offset
  if (offset > source.length) {
    throw new Error(
      `offset is longer than source length! offset ${offset} > length ${source.length}`,
    )
  }
  const lines = source.split(splitRE)
  let counted = 0
  let line = 0
  let column = 0
  for (; line < lines.length; line++) {
    const lineLength = lines[line].length + 1
    if (counted + lineLength >= offset) {
      column = offset - counted + 1
      break
    }
    counted += lineLength
  }
  return { line: line + 1, column }
}

export function generateCodeFrame(
  source: string,
  indent = 0,
  start: number | Position = 0,
  end?: number,
  range = 2,
): string {
  start = posToNumber(source, start)
  end = end || start
  const lines = source.split(splitRE)
  let count = 0
  let res: string[] = []

  const columns = process.stdout.columns || 80

  function lineNo(no: number | string = '') {
    return c.gray(`${String(no).padStart(3, ' ')}| `)
  }

  for (let i = 0; i < lines.length; i++) {
    count += lines[i].length + 1
    if (count >= start) {
      for (let j = i - range; j <= i + range || end > count; j++) {
        if (j < 0 || j >= lines.length)
          continue

        const lineLength = lines[j].length

        // to long, maybe it's a minified file, skip for codeframe
        if (lineLength > 200)
          return ''

        res.push(lineNo(j + 1) + cliTruncate(lines[j], columns - 5 - indent))

        if (j === i) {
          // push underline
          const pad = start - (count - lineLength)
          const length = Math.max(1, end > count ? lineLength - pad : end - start)
          res.push(lineNo() + ' '.repeat(pad) + c.red('^'.repeat(length)))
        }
        else if (j > i) {
          if (end > count) {
            const length = Math.max(1, Math.min(end - count, lineLength))
            res.push(lineNo() + c.red('^'.repeat(length)))
          }
          count += lineLength + 1
        }
      }
      break
    }
  }

  if (indent)
    res = res.map(line => ' '.repeat(indent) + line)

  return res.join('\n')
}

function stringify(obj: any) {
  // TODO: handle more types
  return format(obj)
}

const stackFnCallRE = /at (.*) \((.+):(\d+):(\d+)\)$/
const stackBarePathRE = /at ?(.*) (.+):(\d+):(\d+)$/

interface ParsedStack {
  method: string
  file: string
  line: number
  column: number
}

function parseStack(stack: string): ParsedStack[] {
  const lines = stack.split('\n')
  const stackFrames = lines.map((raw) => {
    const line = raw.trim()
    const match = line.match(stackFnCallRE) || line.match(stackBarePathRE)
    if (!match)
      return null

    let file = match[2]
    if (file.startsWith('file://'))
      file = file.slice(7)

    return {
      method: match[1],
      file: match[2],
      line: parseInt(match[3]),
      column: parseInt(match[4]),
    }
  })
  return stackFrames.filter(notNullish)
}

/**
 * Returns unified diff between two strings with coloured ANSI output.
 *
 * @private
 * @param {String} actual
 * @param {String} expected
 * @return {string} The diff.
 */
export function unifiedDiff(actual: any, expected: any) {
  if (actual === expected)
    return ''

  const diffLimit = 10
  const indent = '  '
  let expectedLinesCount = 0
  let actualLinesCount = 0

  function preprocess(line: string) {
    if (line[0] === '+') {
      if (expectedLinesCount >= diffLimit) return
      expectedLinesCount++
      return (compact?: boolean) => {
        if (compact)
          return c.red(formatLine(line.slice(1)))

        line = line[0] + ' ' + line.slice(1)
        const isLastLine = expectedLinesCount === diffLimit
        return indent + c.red(`${formatLine(line)} ${isLastLine ? renderTruncateMessage(indent) : ''}`)
      }
    }
    if (line[0] === '-') {
      if (actualLinesCount >= diffLimit) return
      actualLinesCount++
      return (compact?: boolean) => {
        if (compact)
          return c.green(formatLine(line.slice(1)))

        line = line[0] + ' ' + line.slice(1)
        const isLastLine = actualLinesCount === diffLimit
        return indent + c.green(`${formatLine(line)} ${isLastLine ? renderTruncateMessage(indent) : ''}`)
      }
    }
    if (line.match(/@@/))
      return () => '--'
    if (line.match(/\\ No newline/))
      return null
    return () => indent + ' ' + line
  }
  const msg = diff.createPatch('string', actual, expected)
  const lines = msg.split('\n').splice(5)
  const cleanLines = lines.map(preprocess).filter(notBlank) as ((compact?: boolean) => string)[]

  // Compact mode
  if (expectedLinesCount === 1 && actualLinesCount === 1) {
    return (
      `\n${indent}${c.green('- expected')}   ${cleanLines[0](true)}\n${indent}${c.red('+ actual')}     ${cleanLines[1](true)}`
    )
  }

  return (
    `\n${indent}${c.green('- expected')}\n${indent}${c.red('+ actual')}\n\n${
      cleanLines.map(l => l()).join('\n')}`
  )
}

function formatLine(line: string) {
  return cliTruncate(line, (process.stdout.columns || 80) - 1)
}

function renderTruncateMessage(indent: string) {
  return `\n${indent}${c.dim('[...truncated]')}`
}

function notBlank(line: any) {
  return typeof line !== 'undefined' && line !== null
}
