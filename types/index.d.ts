export type Git =
  | { isRepo: false }
  | {
      isRepo: true
      branch: string | null
      staged: number
      unstaged: number
      untracked: number
      ahead: number
      behind: number
    }

export type Limit = { percent: number; resetsAt: number | null }

export type Snapshot = {
  model: string
  effort: string | null
  permissionMode: string | null
  cwd: string
  env: string | null
  git: Git | null
  contextTokens: number
  contextWindow: number
  costUsd: number
  startedAt: number
  fiveHour: Limit | null
  sevenDay: Limit | null
  now: number
  tzOffsetMinutes: number
}

// What the chips change, as /config and the settings hold it
export type Controls = {
  modelAlias: string
  modelOptions: string[]
  thinking: boolean
  fast: boolean
}

// The chip whose picker is open in its place
export type Picker = 'model' | 'effort' | null

declare module 'claude-code' {
  interface PluginState {
    'statusline': { snapshot: Snapshot; controls: Controls; picker: Picker }
  }
}
