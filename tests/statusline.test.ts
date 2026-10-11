import type { CommandRunInput, ConfigSetInput, On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import { formatModel, modeOfLabels, parseGit } from '../hooks/register'

const NOW = Date.UTC(2026, 9, 11, 3, 0, 0)
const SURFACES = ['terminal', 'desktop'] as const

const band = (surface: (typeof SURFACES)[number], bodyColumns = 160) => ({
  plugin: 'statusline',
  surface,
  component: 'AbovePrompt' as const,
  props: {
    hasSurvey: false,
    isWorking: false,
    maxRows: 12,
    bodyColumns,
    scroll: { offset: 0, bodyRows: 12 },
    view: {},
  },
})

// Stands for the engine beneath the plugin: records each slash command and /config change
const recordChanges = (on: On) => {
  const commands: { command: string; args: string }[] = []
  const configs: { key: string; value: unknown }[] = []
  const toasts: string[] = []
  on('command.run', ($, e: CommandRunInput) => {
    commands.push({ command: e.command, args: e.args })

    return {}
  })
  on('config.set', ($, e: ConfigSetInput) => {
    configs.push({ key: e.key, value: e.value })

    return { value: e.value }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })

  return { commands, configs, toasts }
}

describe('band', () => {
  test('draws two lines: the session, then the three bars a measure reports', async ($, on) => {
    mock.clock(on, { now: NOW })
    on('session.measure', ($, e) => ({ changed: e.changed }))

    await $.session.measure({
      context: { tokens: 24_000, window: 200_000, percent: 12 },
      rateLimits: [
        {
          kind: 'five_hour',
          percentUsed: 41.6,
          resetsAt: new Date(NOW + (2 * 3600 + 15 * 60) * 1000).toISOString(),
        },
        { kind: 'seven_day', percentUsed: 7, resetsAt: '2026-10-14T14:00:00.000Z' },
      ],
      cost: { usd: 1.5 },
      changed: ['context', 'rateLimits', 'cost'],
    })

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(band(surface))
      const root = await ui.drawn()
      expect(root.type === 'Box' ? root.children : undefined).toHaveLength(2)

      expect(await ui.find({ type: 'Text', text: /\(24k\/200k\)/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /1\.50\$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /^42%$/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /↻2h15m/ })).toBeDefined()
      expect(await ui.find({ type: 'Text', text: /↻Oct 14 2pm/ })).toBeDefined()
      expect(await ui.find({ type: 'Button', key: 'compact' })).toBeUndefined()

      const rasters = await ui.findAll({ type: 'Raster' })
      if (surface === 'terminal') {
        expect(rasters.map(raster => raster.key)).toEqual(['context', 'five-hour', 'seven-day'])
        expect(new Set(rasters.map(raster => raster.props.columns)).size).toBe(1)
      } else {
        expect(rasters).toHaveLength(0)
      }

      await ui.unmount()
    }
  })

  test('shows the limits as loading before any measure', async $ => {
    for (const surface of SURFACES) {
      const ui = await $.ui.mount(band(surface))

      expect(await ui.findAll({ type: 'Text', text: /^ \(loading\.\.\)$/ })).toHaveLength(2)

      await ui.unmount()
    }
  })

  test('shares the room among the bars, from 4 to 40 cells', async $ => {
    const narrow = await $.ui.mount(band('terminal', 60))
    expect((await narrow.find({ type: 'Raster', key: 'five-hour' }))?.props.columns).toBe(4)
    await narrow.unmount()

    const wide = await $.ui.mount(band('terminal', 300))
    expect((await wide.find({ type: 'Raster', key: 'five-hour' }))?.props.columns).toBe(40)
    await wide.unmount()
  })
})

describe('permission mode', () => {
  test('shows the mode a prompt was submitted in', async ($, on) => {
    on('classic.UserPromptSubmit', () => ({}))
    await $.classic.UserPromptSubmit({ prompt: 'hi', permission_mode: 'bypassPermissions' })

    const ui = await $.ui.mount(band('terminal'))
    const mode = await ui.find({ type: 'Text', text: '⏵⏵ bypass permissions on' })
    expect(mode?.props.color).toBe('error')
    await ui.unmount()
  })

  test('reads the footer labels', () => {
    expect(modeOfLabels(['⏵⏵ bypass permissions on (shift+tab to cycle)'])).toBe('bypassPermissions')
    expect(modeOfLabels(['⏵⏵ accept edits on'])).toBe('acceptEdits')
    expect(modeOfLabels(['⏸ plan mode on'])).toBe('plan')
    expect(modeOfLabels(['⏵⏵ auto mode on'])).toBe('auto')
    expect(modeOfLabels([])).toBe('default')
  })
})

describe('chips', () => {
  test('open a picker in place of the model and effort, and run the pick', async ($, on) => {
    const changes = recordChanges(on)

    for (const surface of SURFACES) {
      const ui = await $.ui.mount(band(surface))
      expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)

      await ui.press({ key: 'model-chip' })
      expect(await ui.find({ type: 'Button', key: 'model-chip' })).toBeUndefined()
      await ui.select({ key: 'model', value: 'sonnet' })
      expect(await ui.findAll({ type: 'Select' })).toHaveLength(0)
      expect(await ui.find({ type: 'Button', key: 'model-chip' })).toBeDefined()

      await ui.press({ key: 'effort-chip' })
      await ui.select({ key: 'effort', value: 'max' })
      expect((await ui.find({ type: 'Button', key: 'effort-chip' }))?.text).toBe('🎚️max')

      await ui.unmount()
    }

    expect(changes.commands).toEqual([
      { command: 'model', args: 'sonnet' },
      { command: 'effort', args: 'max' },
      { command: 'model', args: 'sonnet' },
      { command: 'effort', args: 'max' },
    ])
  })

  test('close a picker without a pick', async $ => {
    const ui = await $.ui.mount(band('terminal'))

    await ui.press({ key: 'model-chip' })
    expect(await ui.find({ type: 'Select', key: 'model' })).toBeDefined()
    await ui.press({ key: 'model-close' })
    expect(await ui.find({ type: 'Select', key: 'model' })).toBeUndefined()

    await ui.unmount()
  })

  test('draw no output style chip', async $ => {
    const ui = await $.ui.mount(band('terminal'))
    expect(await ui.find({ type: 'Button', key: 'style-chip' })).toBeUndefined()
    await ui.unmount()
  })

  test('toggle thinking through /config and open /fast', async ($, on) => {
    const changes = recordChanges(on)
    const ui = await $.ui.mount(band('terminal'))

    await ui.press({ key: 'thinking' })
    expect(changes.configs).toEqual([{ key: 'thinking', value: false }])
    expect(changes.toasts).toEqual(['Thinking off'])
    expect((await ui.find({ type: 'Button', key: 'thinking' }))?.text).toBe('💭thinking off')

    await ui.press({ key: 'fast' })
    expect(changes.commands).toEqual([{ command: 'fast', args: '' }])

    await ui.unmount()
  })
})

describe('thinking', () => {
  test('is drawn back on when the model refuses to turn it off', async ($, on) => {
    const toasts: string[] = []
    on('config.set', () => ({ deny: "Thinking can't be turned off for Opus 5.5" }))
    on('ui.toast', ($, e) => {
      toasts.push(e.text)

      return { value: undefined }
    })
    const ui = await $.ui.mount(band('terminal'))

    await ui.press({ key: 'thinking' })

    expect(toasts).toEqual(["thinking: Thinking can't be turned off for Opus 5.5"])
    expect((await ui.find({ type: 'Button', key: 'thinking' }))?.text).toBe('💭thinking')

    await ui.unmount()
  })
})

describe('formatModel', () => {
  test('names a model id as the status line did', () => {
    expect(formatModel('claude-opus-5-5')).toBe('Opus 5.5')
    expect(formatModel('claude-sonnet-5-5[1m]')).toBe('Sonnet 5.5[1m]')
    expect(formatModel('claude-sonnet-4-5-20250929')).toBe('Sonnet 4.5')
    expect(formatModel('Opus 5.5')).toBe('Opus 5.5')
  })
})

describe('parseGit', () => {
  test('counts staged, unstaged and untracked paths and reads ahead/behind', () => {
    const stdout = [
      '# branch.oid 843ab14',
      '# branch.head main',
      '# branch.upstream origin/main',
      '# branch.ab +2 -1',
      '1 M. N... 100644 100644 100644 a b src/a.ts',
      '1 .M N... 100644 100644 100644 a b src/b.ts',
      '1 MM N... 100644 100644 100644 a b src/c.ts',
      '2 R. N... 100644 100644 100644 a b R100 src/new.ts\tsrc/old.ts',
      'u UU N... 100644 100644 100644 100644 a b c src/d.ts',
      '? notes.md',
      '? tmp/x.log',
      '',
    ].join('\n')

    expect(parseGit(stdout)).toEqual({
      isRepo: true,
      branch: 'main',
      staged: 4,
      unstaged: 3,
      untracked: 2,
      ahead: 2,
      behind: 1,
    })
  })

  test('has no branch when detached and no arrows without an upstream', () => {
    expect(parseGit('# branch.oid 843ab14\n# branch.head (detached)\n')).toEqual({
      isRepo: true,
      branch: null,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      ahead: 0,
      behind: 0,
    })
  })
})
