#!/usr/bin/env node
// "claude" falso para las pruebas de punta a punta: imita lo que betools lee de Claude Code sin llamar a ningún
// modelo.
// - Modo -p (sonda de comandos de betools): imprime el mensaje "init" con slash_commands y espera.
// - Modo interactivo: dibuja pantallas con el formato de la TUI (pantalla completa), corre los hooks que llegan
//   con --settings (estado de la sesión), escribe el transcript .jsonl en ~/.claude/projects y registra cada
//   entrada que recibe en $FAKE_LOG (una línea JSON por evento) para que las pruebas la verifiquen.
// Según el prompt que llega:
//   work  → trabaja ~3 s (actividad, lista de tareas, una herramienta con resultado), responde y corre Stop.
//   ask   → menú de permiso numerado (Notification "permission_prompt").
//   mcp   → menú sin números ("New MCP server found").
//   form  → formulario MCP (elicitation) con opciones, sí/no y texto.
//   copy  → pide copiar al portapapeles con OSC 52.
//   long  → agrega 60 respuestas largas (para probar el scroll).
//   otro  → responde "Echo: <texto>".
import { execSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

const args = process.argv.slice(2)
const LOG = process.env.FAKE_LOG
const log = (ev) => LOG && appendFileSync(LOG, JSON.stringify({ t: Date.now(), ...ev }) + '\n')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (args.includes('-p')) {
  log({ ev: 'probe', baseUrl: process.env.ANTHROPIC_BASE_URL ?? null })
  process.stdout.write(
    JSON.stringify({ type: 'system', subtype: 'init', slash_commands: ['fake-init-skill', 'compact', 'context', 'workflow-launch-exec', '__hidden'] }) + '\n'
  )
  setTimeout(() => process.exit(0), 30_000)
} else {
  interactive()
}

function interactive() {
  const flag = (name) => {
    const i = args.indexOf(name)
    return i >= 0 ? args[i + 1] : undefined
  }
  const sessionId = flag('--resume') ?? flag('--session-id') ?? randomUUID()
  const settings = JSON.parse(flag('--settings') ?? '{}')
  log({
    ev: 'start',
    args: args.filter((a) => !a.startsWith('{')),
    sessionId,
    statusFile: !!process.env.CLAWHIP_STATUS_FILE,
    // Variables de prueba (E2E_*) que betools pasa al proceso, para verificar las de la sesión y la carpeta.
    env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith('E2E_')))
  })

  const dir = join(homedir(), '.claude', 'projects', process.cwd().replace(/[^a-zA-Z0-9]/g, '-'))
  mkdirSync(dir, { recursive: true })
  const transcript = join(dir, `${sessionId}.jsonl`)
  const write = (entry) => appendFileSync(transcript, JSON.stringify({ sessionId, cwd: process.cwd(), timestamp: new Date().toISOString(), ...entry }) + '\n')
  const assistant = (content) => write({ type: 'assistant', message: { id: 'msg_' + randomUUID(), role: 'assistant', model: 'claude-fake-1', content } })
  const user = (content, extra = {}) => write({ type: 'user', message: { role: 'user', content }, ...extra })

  // Hooks de betools (los mismos comandos que usaría Claude Code): escriben el estado en $CLAWHIP_STATUS_FILE.
  const hook = (event, payload = '{}') => {
    for (const group of settings.hooks?.[event] ?? [])
      for (const h of group.hooks ?? []) {
        try {
          execSync(h.command, { input: payload, shell: '/bin/sh', env: process.env, timeout: 5000 })
        } catch (e) {
          log({ ev: 'hook-error', event, message: String(e) })
        }
      }
    log({ ev: 'hook', event })
  }

  let cols = process.stdout.columns || 100
  let rows = process.stdout.rows || 30
  process.stdout.on('resize', () => {
    cols = process.stdout.columns
    rows = process.stdout.rows
    render()
  })

  const rule = () => '─'.repeat(cols)
  const history = ['● Fake Claude ready.']
  let input = ''
  let mode = { kind: 'prompt' }
  let busy = false
  let interrupted = false

  function draw(lines) {
    const body = lines.slice(-(rows - 1))
    process.stdout.write('\x1b[H\x1b[2J' + body.join('\r\n'))
  }

  function promptBox(extra = []) {
    const shown = input ? `❯ ${input}` : `❯ \x1b[2mTry "work", "ask", "form"…\x1b[22m`
    return [...extra, rule(), shown, rule(), '  ⏵⏵ auto mode on (shift+tab to cycle)']
  }

  function render() {
    if (mode.kind === 'prompt') return draw([...history.slice(-(rows - 8)), '', ...promptBox()])
    if (mode.kind === 'working') return draw([...history.slice(-(rows - 14)), '', ...mode.live, ...promptBox()])
    if (mode.kind === 'menu') {
      const { header, options, cursor, numbered, hint } = mode
      return draw([
        ...history.slice(-(rows - 16)),
        rule(),
        ...header.map((h) => `  ${h}`),
        ...options.map((o, i) => (numbered ? `  ${i === cursor ? '❯' : ' '} ${i + 1}. ${o}` : `  ${i === cursor ? '❯' : ' '} ${o}`)),
        '',
        `  ${hint}`
      ])
    }
    if (mode.kind === 'form') return draw([...history.slice(-(rows - 22)), rule(), ...formLines()])
  }

  // ---- formulario MCP (mismo formato que Claude Code 2.1.332) ----
  function formLines() {
    const f = mode
    const out = ['  MCP server “fake” requests your input', '', '  ⚠ DESTRUCTIVE OPERATION WARNING: The tool may delete things.', '  This operation could permanently alter resources.', '']
    f.fields.forEach((fd, i) => {
      const focused = f.focus === i
      const has = fd.value !== undefined && fd.value !== ''
      const mark = has ? '✔' : fd.required ? '*' : ' '
      let value
      if (fd.type === 'enum') value = focused ? (f.expanded ? '▾' : `▸ ${has ? fd.value : 'not set'}`) : has ? fd.value : 'not set'
      else if (fd.type === 'bool') value = has ? (fd.value ? '☒' : '☐') : focused ? '☐' : 'not set'
      else value = has ? fd.value : focused ? 'Type something…' : 'not set'
      out.push(`  ${focused ? '❯' : ' '} ${mark} ${fd.title}: ${value}`)
      if (focused && f.expanded) fd.choices.forEach((c, j) => out.push(`        ${f.choice === j ? '❯' : ' '} ${fd.value === c ? '◉' : '◯'} ${c}`))
      if (fd.desc) out.push(`        ${fd.desc}`)
    })
    out.push('', `  ${f.focus === 'accept' ? '❯' : ' '} Accept  ${f.focus === 'decline' ? '❯' : ' '} Decline`, '')
    out.push(f.expanded ? '  Esc to cancel · ↑/↓ to navigate · Space to select' : '  Esc to cancel · ↑/↓ to navigate · → to expand')
    return out
  }

  function formKey(k) {
    const f = mode
    const idx = typeof f.focus === 'number' ? f.focus : f.fields.length
    const fd = f.fields[f.focus]
    if (f.expanded) {
      if (k === 'up') f.choice = Math.max(0, f.choice - 1)
      else if (k === 'down') f.choice = Math.min(fd.choices.length - 1, f.choice + 1)
      else if (k === 'left') f.expanded = false
      else if (k === 'space') {
        fd.value = fd.choices[f.choice]
        f.expanded = false
      } else if (k === 'enter') {
        fd.value = fd.choices[f.choice]
        f.expanded = false
        f.focus = idx + 1 < f.fields.length ? idx + 1 : 'accept'
      }
      return render()
    }
    if (k === 'up') f.focus = idx === 0 ? 0 : idx - 1
    else if (k === 'down') f.focus = idx + 1 < f.fields.length ? idx + 1 : 'accept'
    else if ((k === 'left' || k === 'right') && typeof f.focus !== 'number') f.focus = f.focus === 'accept' ? 'decline' : 'accept'
    else if (k === 'right' && fd?.type === 'enum') {
      f.expanded = true
      f.choice = Math.max(0, fd.choices.indexOf(fd.value))
    } else if (k === 'space' && fd?.type === 'bool') fd.value = !fd.value
    else if (k === 'enter') {
      if (f.focus === 'accept' || f.focus === 'decline') return finishForm(f.focus)
      f.focus = idx + 1 < f.fields.length ? idx + 1 : 'accept'
    } else if (k.text && fd?.type === 'text') fd.value = (fd.value ?? '') + k.text
    else if (k === 'backspace' && fd?.type === 'text') fd.value = (fd.value ?? '').slice(0, -1)
    render()
  }

  function finishForm(action) {
    const content = Object.fromEntries(mode.fields.map((f) => [f.name, f.value]))
    log({ ev: 'form', action, content })
    history.push(`● Form ${action}: ${JSON.stringify(content)}`)
    assistant([{ type: 'text', text: `Form ${action}: ${JSON.stringify(content)}` }])
    endTurn()
  }

  // ---- turnos ----
  function endTurn() {
    mode = { kind: 'prompt' }
    busy = false
    write({ type: 'system', subtype: 'turn_duration', durationMs: 3200, isMeta: true })
    hook('Stop')
    render()
  }

  async function submit(text) {
    log({ ev: 'prompt', text })
    input = ''
    history.push(`❯ ${text}`)
    user(text)
    hook('UserPromptSubmit', JSON.stringify({ prompt: text }))
    busy = true
    const cmd = text.trim()
    if (cmd === 'work') return work()
    if (cmd === 'ask') {
      hook('Notification', JSON.stringify({ notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' }))
      mode = { kind: 'menu', id: 'ask', numbered: true, cursor: 0, header: ['Bash command', '', '  rm -rf build', '', 'Do you want to proceed?'], options: ['Yes', "Yes, and don't ask again", 'No, and tell Claude what to do differently (esc)'], hint: 'Esc to cancel · Tab to amend' }
      return render()
    }
    if (cmd === 'mcp') {
      mode = { kind: 'menu', id: 'mcp', numbered: false, cursor: 2, header: ['New MCP server found in this project: fake', '', 'MCP servers may execute code or access system resources.'], options: ['Use this MCP server', 'Use this and all future MCP servers in this project', 'Continue without using this MCP server'], hint: 'Enter to confirm · Esc to reject' }
      return render()
    }
    if (cmd === 'form') {
      hook('Notification', JSON.stringify({ notification_type: 'elicitation_dialog' }))
      mode = {
        kind: 'form',
        focus: 0,
        expanded: false,
        choice: 0,
        fields: [
          { name: 'decision', title: 'Decision', type: 'enum', choices: ['Approve', 'Reject'], required: true, desc: 'Approve or reject this operation.' },
          { name: 'confirm', title: 'Confirm', type: 'bool', desc: 'Are you sure?' },
          { name: 'name', title: 'Name', type: 'text' }
        ]
      }
      return render()
    }
    if (cmd === 'copy') {
      const b64 = Buffer.from('copied from fake claude ✓', 'utf8').toString('base64')
      process.stdout.write(`\x1b]52;c;${b64}\x07`)
      history.push('● Copied to clipboard.')
      assistant([{ type: 'text', text: 'Copied to clipboard.' }])
      return endTurn()
    }
    if (cmd === 'long') {
      for (let i = 1; i <= 60; i++) assistant([{ type: 'text', text: `Long answer ${i}.\n\n${'Lorem ipsum dolor sit amet. '.repeat(12)}` }])
      history.push('● Wrote 60 answers.')
      return endTurn()
    }
    history.push(`● Echo: ${text}`)
    assistant([{ type: 'text', text: `Echo: ${text}` }])
    endTurn()
  }

  async function work() {
    interrupted = false
    const todo = (done) => ['  ⎿  ' + (done > 0 ? '☒' : '☐') + ' Read the code', '     ' + (done > 1 ? '☒' : '☐') + ' Run the tests', '', '  ● Explore(Find components) · 3 tool uses']
    const toolId = 'toolu_' + randomUUID().replace(/-/g, '')
    for (let s = 0; s < 6 && !interrupted; s++) {
      mode = { kind: 'working', live: [`✻ Pondering… (${s}s · ↓ ${s * 100} tokens · esc to interrupt)`, ...todo(s > 2 ? (s > 4 ? 2 : 1) : 0), '  ⎿  Tip: Use /btw to ask a side question'] }
      render()
      if (s === 1) {
        assistant([{ type: 'thinking', thinking: 'I should run the tests first.' }])
        assistant([{ type: 'tool_use', id: toolId, name: 'Bash', input: { command: 'npm test', description: 'Run the tests' } }])
      }
      if (s === 4) user([{ type: 'tool_result', tool_use_id: toolId, content: 'ok' }], { toolUseResult: { stdout: '42 tests passed', stderr: '', interrupted: false } })
      await sleep(500)
    }
    if (interrupted) {
      user([{ type: 'text', text: '[Request interrupted by user]' }])
      history.push('  ⎿  Interrupted · What should Claude do instead?')
      mode = { kind: 'prompt' }
      busy = false
      return render()
    }
    history.push('● All 42 tests pass.')
    assistant([{ type: 'text', text: 'All **42 tests** pass.\n\n```sh\nnpm test\nnpm run e2e\n```' }])
    endTurn()
  }

  // ---- teclado ----
  function key(k) {
    if (mode.kind === 'menu') {
      const m = mode
      if (k === 'up') m.cursor = (m.cursor + m.options.length - 1) % m.options.length
      else if (k === 'down') m.cursor = (m.cursor + 1) % m.options.length
      else if (k.text && /^[1-9]$/.test(k.text) && m.numbered) m.cursor = Math.min(m.options.length - 1, Number(k.text) - 1)
      else if (k === 'esc') {
        log({ ev: 'menu', id: m.id, choice: null })
        history.push('● Cancelled.')
        return endTurn()
      }
      if (k === 'enter' || (k.text && /^[1-9]$/.test(k.text) && m.numbered)) {
        log({ ev: 'menu', id: m.id, choice: m.options[m.cursor] })
        history.push(`● You chose: ${m.options[m.cursor]}`)
        assistant([{ type: 'text', text: `You chose: ${m.options[m.cursor]}` }])
        return endTurn()
      }
      return render()
    }
    if (mode.kind === 'form') {
      if (k === 'esc') {
        log({ ev: 'form', action: 'cancel' })
        return endTurn()
      }
      return formKey(k)
    }
    if (mode.kind === 'working') {
      if (k === 'esc') interrupted = true
      return
    }
    if (k === 'enter') {
      if (input.trim() && !busy) void submit(input)
      return
    }
    if (k === 'backspace') input = input.slice(0, -1)
    else if (k.text) input += k.text
    render()
  }

  const KEYS = { '\x1b[A': 'up', '\x1b[B': 'down', '\x1b[C': 'right', '\x1b[D': 'left', '\r': 'enter', '\x7f': 'backspace', ' ': 'space', '\x1b': 'esc', '\t': 'tab' }
  if (process.stdin.isTTY) process.stdin.setRawMode(true)
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (data) => {
    log({ ev: 'input', data })
    if (data === '\x03') return log({ ev: 'ctrl-c' })
    // Pegado (bracketed paste): llega como texto.
    const pasted = /^\x1b\[200~([\s\S]*)\x1b\[201~$/.exec(data)
    if (pasted) return key({ text: pasted[1] })
    if (KEYS[data]) return key(mode.kind === 'prompt' && data === ' ' ? { text: ' ' } : KEYS[data])
    if (data === ' ' && mode.kind === 'form') return key('space')
    key({ text: data })
  })

  hook('SessionStart')
  write({ type: 'system', subtype: 'informational', content: 'Fake session started', isMeta: true, level: 'notice' })
  render()
}
