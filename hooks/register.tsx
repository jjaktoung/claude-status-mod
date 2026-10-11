import { atom, read, update } from 'claude-code'
import type {
  ConfigRow,
  EngineInterface,
  Register,
  SessionContextUsage,
  SessionCost,
  SessionRateLimit,
  StateDollar,
} from 'claude-code'

import type { Controls, Git, Limit, Picker, Snapshot } from '../types'

// The status line, drawn as the band above the prompt in two lines:
// Line 1: 🧩 Model 🎚️effort 💭thinking 🏎️fast │ ⏵⏵ mode │ 🟢 Git (↑ahead ↓behind) │ 🧪 Env │ 🗂️ path 🔀(branch) │ 💵 cost │ ⏱️ duration
// Line 2: 📚 Context bar │ 🔋 5H bar │ 📅 7D bar
//   Context: MochaMaroon→LatteMaroon(40%)→Red(80-100%)
//   5H:      Lavender→Lavender(40%)→Blue(80%)→Red(100%)
//   7D:      Yellow→Yellow(40%)→Green(80%)→Red(100%)
// Model and effort open a picker in their own place; 💭thinking toggles thinking, 🏎️fast opens /fast.

const INITIAL: Snapshot = {
  model: 'Unknown',
  effort: null,
  permissionMode: null,
  cwd: '.',
  env: null,
  git: null,
  contextTokens: 0,
  contextWindow: 200_000,
  costUsd: 0,
  startedAt: 0,
  fiveHour: null,
  sevenDay: null,
  now: 0,
  tzOffsetMinutes: 0,
}

// Until /config is first read: the choices this build lists, so every picker has options
const INITIAL_CONTROLS: Controls = {
  modelAlias: 'default',
  modelOptions: ['default', 'sonnet', 'opus', 'haiku', 'fable'],
  thinking: true,
  fast: false,
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']

const snapshot = atom({ plugin: 'statusline', key: 'snapshot' } as const, INITIAL)
const controls = atom({ plugin: 'statusline', key: 'controls' } as const, INITIAL_CONTROLS)
const picker = atom({ plugin: 'statusline', key: 'picker' } as const, null as Picker)

// Git, model, path and /config are read again on the next second once stale
let isStale = true

// The permission mode as the footer last showed it: drawn at once, before the next event records it
let liveMode: string | null = null

// ============================================================================
// Colors (Catppuccin Mocha / Latte)
// ============================================================================

type Rgb = readonly [number, number, number]
type Gradient = readonly [at0: Rgb, at40: Rgb, at80: Rgb, at100: Rgb]

const TEAL = '#94e2d5'
const PINK = '#f5c2e7'
const PEACH = '#fab387'
const GREEN = '#a6e3a1'
const SUBTEXT = '#a6adc8'
const LAVENDER = '#b4befe'
const YELLOW = '#f9e2af'
const OVERLAY = '#6c7086'
const LATTE_GREEN = '#40a02b'
const LATTE_YELLOW = '#df8e1d'
const LATTE_PINK = '#ea76cb'
const LATTE_SKY = '#04a5e5'
const MOCHA_MAROON = '#eba0ac'

const LATTE_RED: Rgb = [210, 15, 57]
const CONTEXT: Gradient = [[235, 160, 172], [230, 69, 83], LATTE_RED, LATTE_RED]
const FIVE_HOUR: Gradient = [[180, 190, 254], [114, 135, 253], [30, 102, 245], LATTE_RED]
const SEVEN_DAY: Gradient = [[249, 226, 175], [223, 142, 29], [64, 160, 43], LATTE_RED]

const hex = (rgb: Rgb) => `#${rgb.map(c => c.toString(16).padStart(2, '0')).join('')}`

const mix = (from: Rgb, to: Rgb, t: number): Rgb => [
  from[0] + Math.trunc(((to[0] - from[0]) * t) / 100),
  from[1] + Math.trunc(((to[1] - from[1]) * t) / 100),
  from[2] + Math.trunc(((to[2] - from[2]) * t) / 100),
]

const colorAt = ([at0, at40, at80, at100]: Gradient, percent: number): Rgb => {
  const pct = Math.min(100, Math.max(0, percent))
  if (pct < 40) return mix(at0, at40, Math.trunc((pct * 100) / 40))
  if (pct < 80) return mix(at40, at80, Math.trunc(((pct - 40) * 100) / 40))
  return mix(at80, at100, Math.trunc(((pct - 80) * 100) / 20))
}

// The footer's words and theme colors for each permission mode
const MODES: Record<string, { label: string; color: string }> = {
  default: { label: '⏵ default mode', color: 'inactive' },
  acceptEdits: { label: '⏵⏵ accept edits on', color: 'autoAccept' },
  plan: { label: '⏸ plan mode on', color: 'planMode' },
  bypassPermissions: { label: '⏵⏵ bypass permissions on', color: 'error' },
  auto: { label: '⏵⏵ auto mode on', color: 'warning' },
  dontAsk: { label: "⏵⏵ don't ask on", color: 'warning' },
}

// ============================================================================
// Bars: filled blocks shade along the gradient, empty ones take its end color
// ============================================================================

type Cell = { glyph: '█' | '░'; rgb: Rgb }

const barCells = (gradient: Gradient, percent: number, width: number): Cell[] => {
  const filled = Math.min(width, Math.max(0, Math.trunc((percent * width + 50) / 100)))
  const end = colorAt(gradient, percent)

  return Array.from({ length: width }, (_, i): Cell =>
    i < filled
      ? { glyph: '█', rgb: colorAt(gradient, Math.trunc((i * 100) / width)) }
      : { glyph: '░', rgb: end },
  )
}

const DEFAULT_BACKGROUND = 0x01000000

const packCells = (cells: readonly Cell[]) => {
  const words = new Uint32Array(cells.length * 3)
  cells.forEach(({ glyph, rgb: [r, g, b] }, i) => {
    words[i * 3] = glyph.codePointAt(0) ?? 0x20
    words[i * 3 + 1] = (r << 16) | (g << 8) | b
    words[i * 3 + 2] = DEFAULT_BACKGROUND
  })
  let binary = ''
  for (const byte of new Uint8Array(words.buffer)) binary += String.fromCharCode(byte)

  return btoa(binary)
}

// Terminal cells a text takes: an emoji takes two
const cellsOf = (text: string) => [...text].length + (text.match(/\p{Extended_Pictographic}/gu)?.length ?? 0)

// ============================================================================
// Formatting
// ============================================================================

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

// "claude-opus-5-5[1m]" → "Opus 5.5[1m]"; anything else as given
export const formatModel = (id: string) => {
  const match = /^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?(.*)$/.exec(id)
  if (match === null) return id
  const [, family = '', major, minor, suffix] = match

  return `${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}${suffix}`
}

// "2h15m" past an hour, "15m" under it
const formatDuration = (ms: number) => {
  const seconds = Math.max(0, Math.trunc(ms / 1000))
  const minutes = Math.trunc((seconds % 3600) / 60)

  return seconds >= 3600 ? `${Math.trunc(seconds / 3600)}h${minutes}m` : `${Math.trunc(seconds / 60)}m`
}

// 5H reset: "2h15m" from now
const formatTimeRemaining = (resetsAt: number, now: number) => {
  const remaining = Math.max(0, Math.trunc((resetsAt - now) / 1000))

  return `${Math.trunc(remaining / 3600)}h${Math.trunc((remaining % 3600) / 60)}m`
}

// 7D reset: "Jan 21 2pm", in the machine's local time
const formatResetDate = (resetsAt: number, tzOffsetMinutes: number) => {
  const local = new Date(resetsAt + tzOffsetMinutes * 60_000)
  const hour = local.getUTCHours()
  const day = String(local.getUTCDate()).padStart(2, '0')

  return `${MONTHS[local.getUTCMonth()]} ${day} ${hour % 12 || 12}${hour >= 12 ? 'pm' : 'am'}`
}

const tildify = (path: string, home: string | undefined) =>
  home !== undefined && home !== '' && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path

// The mode the footer's labels name: default when they name none
export const modeOfLabels = (labels: readonly string[]): string => {
  const text = labels.join(' ').toLowerCase()
  if (text.includes('bypass')) return 'bypassPermissions'
  if (text.includes('accept edits')) return 'acceptEdits'
  if (text.includes('plan mode')) return 'plan'
  if (text.includes('auto mode')) return 'auto'
  if (text.includes("don't ask") || text.includes('dont ask')) return 'dontAsk'

  return 'default'
}

// ============================================================================
// Reading the session
// ============================================================================

type Usage = {
  context: SessionContextUsage
  rateLimits: readonly SessionRateLimit[]
  cost?: SessionCost
}

const limitOf = (limits: readonly SessionRateLimit[], kind: string): Limit | null => {
  const limit = limits.find(one => one.kind === kind)
  if (limit === undefined) return null
  const resetsAt = limit.resetsAt === undefined ? Number.NaN : Date.parse(limit.resetsAt)

  return { percent: Math.round(limit.percentUsed), resetsAt: Number.isNaN(resetsAt) ? null : resetsAt }
}

const fromUsage = ({ context, rateLimits, cost }: Usage): Partial<Snapshot> => ({
  contextTokens: context.tokens ?? 0,
  contextWindow: context.window,
  fiveHour: limitOf(rateLimits, 'five_hour'),
  sevenDay: limitOf(rateLimits, 'seven_day'),
  ...(cost !== undefined && { costUsd: cost.usd }),
})

// One `git status` in place of the script's five git calls
const GIT_STATUS = ['git', '--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--untracked-files=all']

export const parseGit = (stdout: string): Git => {
  const git = { isRepo: true as const, branch: null as string | null, staged: 0, unstaged: 0, untracked: 0, ahead: 0, behind: 0 }

  for (const line of stdout.split('\n')) {
    if (line.startsWith('# branch.head ')) {
      const head = line.slice('# branch.head '.length)
      git.branch = head === '(detached)' ? null : head
    } else if (line.startsWith('# branch.ab ')) {
      const [, ahead = '+0', behind = '-0'] = line.slice(2).split(' ')
      git.ahead = Number(ahead.slice(1)) || 0
      git.behind = Number(behind.slice(1)) || 0
    } else if (/^[12u] /.test(line)) {
      if (line[2] !== '.') git.staged += 1
      if (line[3] !== '.') git.unstaged += 1
    } else if (line.startsWith('? ')) {
      git.untracked += 1
    }
  }

  return git
}

// undefined when git did not answer in time: the last reading stays
const readGit = async ($: EngineInterface, cwd: string): Promise<Git | undefined> => {
  try {
    const { exitCode, stdout } = await $.process.run(GIT_STATUS, { cwd, timeoutMs: 5_000 })

    return exitCode === 0 ? parseGit(stdout) : { isRepo: false }
  } catch {
    return undefined
  }
}

const readTzOffsetMinutes = async ($: EngineInterface) => {
  try {
    const { stdout } = await $.process.run(['date', '+%z'])
    const match = /^([+-])(\d\d)(\d\d)/.exec(stdout.trim())
    if (match === null) return 0
    const minutes = Number(match[2]) * 60 + Number(match[3])

    return match[1] === '-' ? -minutes : minutes
  } catch {
    return 0
  }
}

const isSame = <T extends object>(current: T, changes: Partial<T>) =>
  (Object.keys(changes) as (keyof T)[]).every(key => JSON.stringify(current[key]) === JSON.stringify(changes[key]))

// Each writes only what changed, so an unchanged reading draws nothing again
const patchSnapshot = async ($: StateDollar, changes: Partial<Snapshot>) => {
  if (isSame(await read($, snapshot), changes)) return

  await update($, snapshot, value => ({ ...value, ...changes }))
}

const patchControls = async ($: StateDollar, changes: Partial<Controls>) => {
  if (isSame(await read($, controls), changes)) return

  await update($, controls, value => ({ ...value, ...changes }))
}

// A choice row of /config: its value and the values it takes
const choiceOf = (rows: readonly ConfigRow[], key: string) => {
  const row = rows.find(one => one.key === key)
  if (row === undefined || typeof row.value !== 'string') return undefined

  return { value: row.value, options: [...(row.options ?? [row.value])] }
}

const refresh = async ($: EngineInterface) => {
  const cwd = await $.session.cwd()
  const [model, settings, env, home, git, rows] = await Promise.all([
    $.session.model(),
    $.settings.read(),
    $.env.get('CONDA_DEFAULT_ENV'),
    $.env.get('HOME'),
    readGit($, cwd),
    $.config.list(),
  ])
  await patchSnapshot($, { cwd: tildify(cwd, home), model, env: env || null, ...(git !== undefined && { git }) })

  // The effort the last request asked for wins; before any, the one settings hold
  if ((await read($, snapshot)).effort === null && typeof settings.effortLevel === 'string') {
    await patchSnapshot($, { effort: settings.effortLevel })
  }

  const modelRow = choiceOf(rows, 'model')
  await patchControls($, {
    thinking: rows.find(one => one.key === 'thinking')?.value !== false,
    fast: settings.fastMode === true,
    ...(modelRow && { modelAlias: modelRow.value, modelOptions: modelRow.options }),
  })
}

// The mode a settings-hook event carries for the main loop
const recordMode = async ($: StateDollar, e: { permission_mode?: string; agent_id?: string }) => {
  if (e.agent_id !== undefined || e.permission_mode === undefined) return
  liveMode = e.permission_mode
  await patchSnapshot($, { permissionMode: e.permission_mode })
}

// ============================================================================
// Changes: each goes through a slash command or /config, as the person's would
// ============================================================================

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// The command's own lines land in the transcript; only a failure is toasted
const runCommand = async ($: EngineInterface, command: string, args = '') => {
  try {
    await $.command.run({ command, args })
  } catch (error) {
    $.ui.toast(`/${[command, args].filter(Boolean).join(' ')}: ${messageOf(error)}`)
  }
  isStale = true
}

// Whether the row took the value; a refusal is toasted with its reason
const setConfig = async ($: EngineInterface, key: string, value: boolean | string, done: string) => {
  isStale = true
  try {
    const { deny } = await $.config.set({ key, value })
    $.ui.toast(deny === undefined ? done : `${key}: ${deny}`)

    return deny === undefined
  } catch (error) {
    $.ui.toast(`${key}: ${messageOf(error)}`)

    return false
  }
}

const changeModel = async ($: EngineInterface, alias: string) => {
  await patchControls($, { modelAlias: alias })
  await runCommand($, 'model', alias)
}

const changeEffort = async ($: EngineInterface, effort: string) => {
  await patchSnapshot($, { effort })
  await runCommand($, 'effort', effort)
}

// Drawn at once, and drawn back when the model refuses (Opus 5.5 always thinks)
const toggleThinking = async ($: EngineInterface) => {
  const thinking = !(await read($, controls)).thinking
  await patchControls($, { thinking })
  if (!(await setConfig($, 'thinking', thinking, thinking ? 'Thinking on' : 'Thinking off'))) {
    await patchControls($, { thinking: !thinking })
  }
}

// /fast asks in its own dialog; the next refresh reads what was picked
const openFast = async ($: EngineInterface) => {
  await runCommand($, 'fast')
}

// A picker's options, the current value first when the row does not list it
const optionsOf = (values: readonly string[], current: string | null) =>
  (current === null || values.includes(current) ? values : [current, ...values]).map(value => ({ value }))

// ============================================================================
// Hooks
// ============================================================================

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    const [usage, now, tzOffsetMinutes, home] = await Promise.all([
      $.session.usage(),
      $.clock.now(),
      readTzOffsetMinutes($),
      $.env.get('HOME'),
    ])
    await patchSnapshot($, {
      ...fromUsage(usage),
      startedAt: usage.startedAt,
      now,
      tzOffsetMinutes,
      cwd: tildify(e.cwd, home),
    })

    $.clock.every(1_000, () => {
      if (!isStale) return
      isStale = false
      refresh($).catch(() => undefined)
    })
    $.clock.every(30_000, () => {
      isStale = true
    })
    $.clock.every(60_000, () => {
      $.clock
        .now()
        .then(now => patchSnapshot($, { now }))
        .catch(() => undefined)
    })

    return started
  })

  on('session.measure', async ($, e, next) => {
    await patchSnapshot($, { ...fromUsage(e), now: await $.clock.now() })

    return next(e)
  })

  // Each request of the main loop: the effort it asks for, and tool results may have touched git
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      isStale = true
      await patchSnapshot($, { effort: e.effort === undefined ? null : String(e.effort) })
    }

    return yield* next(e)
  })

  on('turn.complete', ($, e, next) => {
    isStale = true

    return next(e)
  })

  // The settings-hook events carry the session's permission mode
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const result = await next(e)
    await recordMode($, e)

    return result
  }).catch(($, e, next) => next(e))

  on('classic.PostToolUse', async ($, e, next) => {
    const result = await next(e)
    await recordMode($, e)

    return result
  }).catch(($, e, next) => next(e))

  on('classic.Stop', async ($, e, next) => {
    const result = await next(e)
    await recordMode($, e)

    return result
  }).catch(($, e, next) => next(e))

  // The footer redraws on shift+tab: the band follows at once, the footer drawn as the engine draws it
  on('ui.render', { component: 'SessionMode' }, ($, e, next) => {
    const mode = modeOfLabels(e.props.modes)
    if (mode !== liveMode) {
      liveMode = mode
      $.ui.invalidate('ui.render')
    }

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    // The band is raised on these two alone; both draw the pickers
    if (e.props.hasSurvey || (e.surface !== 'terminal' && e.surface !== 'desktop')) return next(e)

    const s = await read($, snapshot)
    const c = await read($, controls)
    const open = await read($, picker)
    const { Box, Button, Select, Text } = $.ui.resolve(e)

    const togglePicker = (which: Exclude<Picker, null>) => () => {
      void update($, picker, current => (current === which ? null : which))
    }
    const closePicker = () => {
      void update($, picker, () => null)
    }

    // A chip's picker, drawn where the chip was: a pick applies and closes it
    const pickerIn = (
      key: string,
      label: string,
      options: { value: string }[],
      value: string | null,
      apply: (value: string) => Promise<void>,
    ) => (
      <Box flexDirection="row" columnGap={1}>
        <Select
          key={key}
          label={label}
          options={options}
          value={value ?? undefined}
          autoFocus
          onSelect={picked => {
            closePicker()
            void apply(picked)
          }}
        />
        <Button key={`${key}-close`} plain dimColor label="✕" onPress={closePicker} />
      </Box>
    )

    // ------------------------------------------------------------------------
    // Line 1: Model 🎚️effort 💭thinking 🏎️fast │ mode │ Git │ Env │ Path (branch) │ Cost │ Duration
    // ------------------------------------------------------------------------

    const model =
      open === 'model' ? (
        pickerIn('model', '🧩', optionsOf(c.modelOptions, c.modelAlias), c.modelAlias, alias => changeModel($, alias))
      ) : (
        <Button key="model-chip" plain onPress={togglePicker('model')}>
          {'🧩 '}
          <Text bold color={TEAL}>
            {formatModel(s.model)}
          </Text>
        </Button>
      )

    const effort =
      open === 'effort' ? (
        pickerIn('effort', '🎚️', optionsOf(EFFORTS, s.effort), s.effort, value => changeEffort($, value))
      ) : (
        <Button key="effort-chip" plain onPress={togglePicker('effort')}>
          <Text color={PEACH}>{`🎚️${s.effort ?? '–'}`}</Text>
        </Button>
      )

    const thinking = (
      <Button
        key="thinking"
        plain
        onPress={() => {
          void toggleThinking($)
        }}
      >
        {c.thinking ? <Text color={YELLOW}>💭thinking</Text> : <Text dimColor>💭thinking off</Text>}
      </Button>
    )

    const fast = (
      <Button
        key="fast"
        plain
        onPress={() => {
          void openFast($)
        }}
      >
        {c.fast ? <Text color={PEACH}>🏎️fast</Text> : <Text dimColor>🏎️fast off</Text>}
      </Button>
    )

    const permissionMode = liveMode ?? s.permissionMode ?? null
    const mode =
      permissionMode === null ? (
        <Text color={OVERLAY}>mode …</Text>
      ) : (
        <Text
          color={MODES[permissionMode]?.color ?? 'inactive'}
          dimColor={permissionMode === 'default'}
        >
          {MODES[permissionMode]?.label ?? `⏵⏵ ${permissionMode}`}
        </Text>
      )

    const git = s.git
    let gitStatus
    if (git === null) {
      gitStatus = <Text color={OVERLAY}>git …</Text>
    } else if (!git.isRepo) {
      gitStatus = <Text color={OVERLAY}>no git</Text>
    } else {
      const counts =
        (git.staged > 0 ? `+${git.staged}` : '') +
        (git.unstaged > 0 ? `!${git.unstaged}` : '') +
        (git.untracked > 0 ? `?${git.untracked}` : '')
      gitStatus = (
        <Text>
          {counts === '' ? (
            <Text color={GREEN}>🟢 git clean</Text>
          ) : (
            <Text color={LATTE_YELLOW}>🟡 dirty {counts}</Text>
          )}
          {(git.ahead > 0 || git.behind > 0) && ' '}
          {git.ahead > 0 && <Text color={LATTE_SKY}>↑{git.ahead}</Text>}
          {git.behind > 0 && <Text color={LATTE_PINK}>↓{git.behind}</Text>}
        </Text>
      )
    }

    const branch = git !== null && git.isRepo ? git.branch : null
    const elapsed = s.startedAt > 0 && s.now > s.startedAt ? s.now - s.startedAt : 0
    const sep = <Text color={OVERLAY}>│</Text>

    const line1 = (
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        {model}
        {effort}
        {thinking}
        {fast}
        {sep}
        {mode}
        {sep}
        {gitStatus}
        {sep}
        {s.env === null ? (
          <Text color={OVERLAY}>no env</Text>
        ) : (
          <Text>
            {'🧪 '}
            <Text color={PINK}>{s.env}</Text>
          </Text>
        )}
        {sep}
        <Text>
          {'🗂️ '}
          <Text color={SUBTEXT}>{s.cwd}</Text>
          {branch !== null && <Text color={LATTE_GREEN}>{` 🔀(${branch})`}</Text>}
        </Text>
        {sep}
        <Text>
          {'💵 '}
          <Text color={s.costUsd > 0 ? SUBTEXT : OVERLAY}>{`${s.costUsd.toFixed(2)}$`}</Text>
        </Text>
        {sep}
        <Text>
          {'⏱️ '}
          <Text color={elapsed >= 60_000 ? SUBTEXT : OVERLAY}>{formatDuration(elapsed)}</Text>
        </Text>
      </Box>
    )

    // ------------------------------------------------------------------------
    // Line 2: Context │ 5H │ 7D, the three bars sharing what the texts leave
    // ------------------------------------------------------------------------

    const contextPercent = s.contextWindow > 0 ? Math.trunc((s.contextTokens * 100) / s.contextWindow) : 0
    const contextTail = ` (${Math.trunc(s.contextTokens / 1000)}k/${Math.trunc(s.contextWindow / 1000)}k)`
    const fiveTail =
      s.fiveHour === null
        ? ' (loading..)'
        : s.fiveHour.resetsAt === null
          ? ''
          : ` ↻${formatTimeRemaining(s.fiveHour.resetsAt, s.now)}`
    const sevenTail =
      s.sevenDay === null
        ? ' (loading..)'
        : s.sevenDay.resetsAt === null
          ? ''
          : ` ↻${formatResetDate(s.sevenDay.resetsAt, s.tzOffsetMinutes)}`
    const fivePercent = s.fiveHour?.percent ?? 0
    const sevenPercent = s.sevenDay?.percent ?? 0

    const texts = [
      '📚 Context ',
      ` ${contextPercent}%${contextTail}`,
      ' │ 🔋 5H ',
      ` ${fivePercent}%${fiveTail}`,
      ' │ 📅 7D ',
      ` ${sevenPercent}%${sevenTail}`,
    ]
    const room = e.props.bodyColumns - texts.reduce((sum, text) => sum + cellsOf(text), 0)
    const width = Math.max(4, Math.min(40, Math.trunc(room / 3)))

    const bar = (key: string, gradient: Gradient, percent: number) => {
      const cells = barCells(gradient, percent, width)
      if (e.surface === 'terminal') {
        const { Raster } = $.ui.resolve(e)

        return <Raster key={key} columns={width} rows={1} cells={packCells(cells)} />
      }

      return (
        <Text>
          {cells.map(cell => (
            <Text color={hex(cell.rgb)}>{cell.glyph}</Text>
          ))}
        </Text>
      )
    }

    const figure = (gradient: Gradient, percent: number, tail: string, isLoading: boolean) => (
      <Text>
        {' '}
        <Text bold color={hex(colorAt(gradient, percent))}>{`${percent}%`}</Text>
        {isLoading ? <Text color={OVERLAY}>{tail}</Text> : tail}
      </Text>
    )

    const line2 = (
      <Box flexDirection="row">
        <Text>
          {'📚 '}
          <Text color={MOCHA_MAROON}>Context</Text>{' '}
        </Text>
        {bar('context', CONTEXT, contextPercent)}
        {figure(CONTEXT, contextPercent, contextTail, false)}
        <Text>
          <Text color={OVERLAY}> │ </Text>
          {'🔋 '}
          <Text color={LAVENDER}>5H</Text>{' '}
        </Text>
        {bar('five-hour', FIVE_HOUR, fivePercent)}
        {figure(FIVE_HOUR, fivePercent, fiveTail, s.fiveHour === null)}
        <Text>
          <Text color={OVERLAY}> │ </Text>
          {'📅 '}
          <Text color={YELLOW}>7D</Text>{' '}
        </Text>
        {bar('seven-day', SEVEN_DAY, sevenPercent)}
        {figure(SEVEN_DAY, sevenPercent, sevenTail, s.sevenDay === null)}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {line1}
        {line2}
      </Box>
    )
  })
}
