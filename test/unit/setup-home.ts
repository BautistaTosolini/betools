import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll } from 'vitest'

// Cada archivo de pruebas corre con un HOME propio y vacío, que se borra al terminar. os.homedir() lee $HOME en
// cada llamada, y los módulos que calculan rutas al importarse se importan después de este setup.
const home = mkdtempSync(join(tmpdir(), 'betools-test-home-'))
process.env.HOME = home
afterAll(() => rmSync(home, { recursive: true, force: true }))
