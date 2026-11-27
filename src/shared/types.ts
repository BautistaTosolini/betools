export interface Session {
  id: string
  name: string
  cwd: string
  createdAt: string
  lastActiveAt: string
  env?: EnvVarMeta[]
}

// Variables de entorno para el proceso claude. El valor NUNCA viaja a la interfaz:
// - local: cifrado con el llavero del sistema (safeStorage), para valores propios.
// - aws-sm / aws-ssm: solo la referencia; el valor se lee al lanzar la sesión (credenciales de clientes).
export type EnvSource =
  // Visible: no es secreta (AWS_PROFILE, AWS_REGION…); el valor se guarda en texto plano y se muestra.
  | { kind: 'plain'; value: string }
  | { kind: 'local' }
  | { kind: 'aws-sm'; profile: string; region?: string; secretId: string; jsonKey?: string }
  | { kind: 'aws-ssm'; profile: string; region?: string; name: string }

export interface EnvVarMeta {
  name: string
  source: EnvSource
  updatedAt: string
}

// Ámbito de una variable: una carpeta (la heredan sus sesiones) o una sesión (pisa a la carpeta).
export type EnvScope = { kind: 'folder' | 'session'; id: string }

// Carpeta = cliente. Las sesiones se agrupan por ruta: pertenecen a la carpeta cuyo path
// contiene su cwd (gana la más específica).
export interface Folder {
  id: string
  name: string
  color: string
  // Path principal: donde arrancan las sesiones nuevas de la carpeta.
  path: string
  // Otros paths que también cuentan como de esta carpeta (estructura vieja, repos en otro lado).
  extraPaths?: string[]
  collapsed?: boolean
  env?: EnvVarMeta[]
  // Comandos guardados que se corren en la terminal de una sesión de la carpeta (p. ej. aws sso login).
  commands?: SavedCommand[]
}

export interface SavedCommand {
  id: string
  name: string
  command: string
}

export interface StoreState {
  folders: Folder[]
  sessions: Session[]
  selectedId: string | null
  // Comandos guardados globales: se ofrecen en todas las sesiones (además de los de su carpeta).
  commands?: SavedCommand[]
}

export interface FolderSuggestion {
  name: string
  path: string
}

// stopped: el proceso no arrancó todavía (arranque lazy)
// idle:    corriendo, esperando un prompt
// working: Claude está trabajando
// waiting: Claude necesita tu respuesta (permiso, pregunta)
// done:    terminó un turno y todavía no lo miraste
// exited:  el proceso terminó
export type SessionStatus = 'stopped' | 'idle' | 'working' | 'waiting' | 'done' | 'exited'

export interface Settings {
  closeToTray: boolean
  autostart: boolean
  notifications: boolean
  eagerStart: boolean
  // Lanzar cada sesión (nueva o retomada) con --remote-control para manejarla desde claude.ai / el teléfono.
  remoteControl: boolean
}

export interface DiscoveredSession {
  id: string
  cwd: string
  // false si no se encontró una carpeta de trabajo que exista (no se puede importar).
  cwdExists: boolean
  title: string
  modifiedAt: string
  sizeKb: number
}

export type ArtifactSource = 'Write' | 'Edit' | 'MultiEdit' | 'NotebookEdit' | 'Bash'

export interface Artifact {
  path: string
  name: string
  ext: string
  // Herramientas que tocaron el archivo; "Bash" = detectado en un comando (heurística).
  sources: ArtifactSource[]
  isDocument: boolean
  firstAt: string
  lastAt: string
  exists: boolean
}

// Datos de la sesión que Claude Code pasa a su status line.
export interface SessionMeta {
  model: string | null
  // % de la ventana de contexto en uso.
  contextPct: number | null
}

// Límites del plan (Pro/Max) según Claude Code: ventana de 5 horas y semanal. resetsAt en segundos Unix.
export interface PlanWindow {
  pct: number
  resetsAt: number | null
}
export interface PlanLimits {
  fiveHour: PlanWindow | null
  sevenDay: PlanWindow | null
  updatedAt: number
}

// Tokens de hoy (hora local) sumando todos los transcripts de ~/.claude/projects.
export interface DailyTokens {
  day: string
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
  total: number
  messages: number
}

// Conversación de una sesión leída del transcript, para la pestaña "Rendered" (solo lectura).
// user: prompt tuyo · assistant: texto de Claude (Markdown) · tool: herramienta que usó (resumen de una línea)
// command: slash command o "!" · summary: marca de compactación
export interface ConversationItem {
  // answers: respuestas a AskUserQuestion (text = JSON [{q, a}])
  // thinking: razonamiento de Claude (solo cuando el transcript lo trae con texto)
  // notice: avisos de Claude Code (resumen al volver, tarea en segundo plano terminada, error de hook…)
  kind: 'user' | 'assistant' | 'tool' | 'command' | 'summary' | 'answers' | 'thinking' | 'notice'
  text: string
  at: string
  // Respuesta a la que pertenece (los bloques de texto de una misma respuesta se juntan).
  msgId?: string
  tool?: ToolCall
  // notice: tipo, para el ícono y el color
  level?: 'info' | 'warn' | 'error' | 'done'
}

// Llamada a una herramienta con su resultado (el ítem se actualiza cuando llega el resultado).
export interface ToolCall {
  id: string
  name: string
  input: string // entrada completa, legible (comando, ruta, JSON…)
  result?: string // recortado
  error?: boolean
  done: boolean
  // Edit/MultiEdit: cambios como texto viejo → nuevo
  edits?: { old: string; new: string }[]
}

// Comando o skill para el autocompletado de "/" en Rendered.
export interface SlashCommand {
  name: string
  description: string
  source: 'builtin' | 'user' | 'project' | 'plugin'
}

// Traspaso a una sesión nueva en curso: en cola (Claude ocupado), escribiéndose, o con error.
export interface HandoffState {
  state: 'queued' | 'writing'
  focus: string
  error?: string
}
