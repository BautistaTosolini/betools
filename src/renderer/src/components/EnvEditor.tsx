import { useEffect, useState } from 'react'
import type { EnvScope, EnvSource, EnvVarMeta } from '../../../shared/types'

const api = window.clawhip

type Kind = EnvSource['kind']
// La versión web limita los tipos disponibles (sin referencias a AWS).
const ALLOWED = (window.clawhip as { envKinds?: Kind[] }).envKinds

const KIND_LABEL: Record<Kind, string> = {
  plain: 'Visible (not secret)',
  local: 'Encrypted local value',
  'aws-sm': 'AWS Secrets Manager',
  'aws-ssm': 'AWS SSM Parameter Store'
}

export function describeSource(s: EnvSource): string {
  if (s.kind === 'plain') return 'visible'
  if (s.kind === 'local') return 'encrypted local'
  if (s.kind === 'aws-sm') return `Secrets Manager · ${s.secretId}${s.jsonKey ? ` → ${s.jsonKey}` : ''} · ${s.profile}${s.region ? ` · ${s.region}` : ''}`
  return `SSM · ${s.name} · ${s.profile}${s.region ? ` · ${s.region}` : ''}`
}

const errMsg = (e: unknown) =>
  e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)

interface FormProps {
  scope: EnvScope
  // Si viene, se está reemplazando esa variable (el nombre no cambia).
  existing?: EnvVarMeta
  initialName?: string
  onDone(): void
  onCancel(): void
}

// Formulario de alta/reemplazo. El valor es de solo escritura: nunca se precarga ni se muestra.
function EnvForm({ scope, existing, initialName, onDone, onCancel }: FormProps) {
  const [name, setName] = useState(existing?.name ?? initialName ?? '')
  const [kind, setKind] = useState<Kind>(existing?.source.kind ?? 'plain')
  const src = existing?.source
  // Solo las visibles se precargan; las secretas nunca.
  const [value, setValue] = useState(src?.kind === 'plain' ? src.value : '')
  const aws = src && (src.kind === 'aws-sm' || src.kind === 'aws-ssm') ? src : null
  const [profile, setProfile] = useState(aws?.profile ?? '')
  const [region, setRegion] = useState(aws?.region ?? '')
  const [secretId, setSecretId] = useState(src?.kind === 'aws-sm' ? src.secretId : '')
  const [jsonKey, setJsonKey] = useState(src?.kind === 'aws-sm' ? (src.jsonKey ?? '') : '')
  const [param, setParam] = useState(src?.kind === 'aws-ssm' ? src.name : '')
  const [profiles, setProfiles] = useState<string[]>([])
  const [secure, setSecure] = useState<{ ok: boolean; reason?: string }>({ ok: true })
  const [test, setTest] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    api.awsProfiles().then(setProfiles)
    api.secureStorage().then(setSecure)
  }, [])

  const source = (): EnvSource =>
    kind === 'plain'
      ? { kind: 'plain', value }
      : kind === 'local'
      ? { kind: 'local' }
      : kind === 'aws-sm'
        ? { kind: 'aws-sm', profile, region, secretId, jsonKey }
        : { kind: 'aws-ssm', profile, region, name: param }

  const save = async () => {
    setError(null)
    setBusy(true)
    try {
      await api.setEnv(scope, name.trim(), source(), kind === 'local' ? value : undefined)
      setValue('')
      onDone()
    } catch (e) {
      setError(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const runTest = async () => {
    setTest('Testing…')
    try {
      const r = await api.testEnvRef(source())
      setTest(`OK: read successfully (${r.length} characters). The value is not shown.`)
    } catch (e) {
      setTest(`Error: ${errMsg(e)}`)
    }
  }

  return (
    <div className="env-form" onKeyDown={(e) => e.key === 'Escape' && onCancel()}>
      <div className="env-grid">
        <label>
          Name
          <input
            value={name}
            disabled={!!existing}
            onChange={(e) => setName(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'))}
            placeholder="GITHUB_TOKEN"
            autoFocus={!existing}
          />
        </label>
        <label>
          Source
          <select value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {(Object.keys(KIND_LABEL) as Kind[]).filter((k) => !ALLOWED || ALLOWED.includes(k)).map((k) => (
              <option key={k} value={k} disabled={k === 'local' && !secure.ok}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {kind === 'plain' ? (
        <>
          <label>
            Value
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="vemo-prd" spellCheck={false} autoFocus={!!existing} />
          </label>
          <p className="muted small">Stored as plain text and shown in the UI. Do not use it for secrets.</p>
        </>
      ) : kind === 'local' ? (
        <>
          <label>
            Value {existing && <span className="muted small">(the current one is not shown; type a new one to replace it)</span>}
            <input
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="••••••••"
              autoFocus={!!existing}
            />
          </label>
          <p className="warn small">
            Only for your own values. Client credentials must not be stored on this machine: use an AWS reference.
          </p>
          {!secure.ok && <p className="error small">{secure.reason}</p>}
        </>
      ) : (
        <>
          <div className="env-grid">
            <label>
              AWS profile
              <input list="aws-profiles" value={profile} onChange={(e) => setProfile(e.target.value)} placeholder="client-prd-ro" />
              <datalist id="aws-profiles">
                {profiles.map((p) => (
                  <option key={p} value={p} />
                ))}
              </datalist>
            </label>
            <label>
              Region <span className="muted small">(optional)</span>
              <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="profile default" />
            </label>
          </div>
          {kind === 'aws-sm' ? (
            <div className="env-grid">
              <label>
                Secret (name or ARN)
                <input value={secretId} onChange={(e) => setSecretId(e.target.value)} placeholder="prod/api/token" />
              </label>
              <label>
                JSON key <span className="muted small">(optional)</span>
                <input value={jsonKey} onChange={(e) => setJsonKey(e.target.value)} placeholder="token" />
              </label>
            </div>
          ) : (
            <label>
              Parameter
              <input value={param} onChange={(e) => setParam(e.target.value)} placeholder="/client/prod/token" />
            </label>
          )}
          <p className="muted small">The value is read when the session starts and is not stored on this machine.</p>
          {test && <p className={`small ${test.startsWith('OK') ? 'ok' : test.startsWith('Error') ? 'error' : 'muted'}`}>{test}</p>}
        </>
      )}

      {error && <p className="error small">{error}</p>}
      <div className="actions">
        {(kind === 'aws-sm' || kind === 'aws-ssm') && <button onClick={runTest}>Test</button>}
        <span style={{ flex: 1 }} />
        <button onClick={onCancel}>Cancel</button>
        <button className="primary" disabled={busy} onClick={save}>
          {existing ? (kind === 'plain' ? 'Save' : 'Replace') : 'Add'}
        </button>
      </div>
    </div>
  )
}

interface Props {
  scope: EnvScope
  // Variables heredadas (de la carpeta) que se muestran como referencia y se pueden pisar.
  inherited?: { label: string; vars: EnvVarMeta[] }
  onChange?(): void
}

export function EnvEditor({ scope, inherited, onChange }: Props) {
  const [vars, setVars] = useState<EnvVarMeta[]>([])
  const [form, setForm] = useState<{ existing?: EnvVarMeta; name?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => api.listEnv(scope).then(setVars)
  useEffect(() => {
    load()
  }, [scope.kind, scope.id])

  const done = async () => {
    setForm(null)
    await load()
    onChange?.()
  }

  const remove = async (v: EnvVarMeta) => {
    if (!window.confirm(`Delete the variable ${v.name}?${v.source.kind === 'local' ? '\n\nThe encrypted value is removed.' : ''}`)) return
    try {
      await api.deleteEnv(scope, v.name)
      await done()
    } catch (e) {
      setError(errMsg(e))
    }
  }

  const own = new Set(vars.map((v) => v.name))

  return (
    <div className="env-editor">
      {inherited && inherited.vars.length > 0 && (
        <ul className="env-list inherited">
          {inherited.vars.map((v) => (
            <li key={v.name} className={own.has(v.name) ? 'overridden' : ''}>
              <span className="env-name">{v.name}</span>
              <span className="env-src">
                inherited from {inherited.label} · {v.source.kind === 'plain' ? v.source.value : describeSource(v.source)}
                {own.has(v.name) && ' · overridden in this session'}
              </span>
              {!own.has(v.name) && (
                <button className="btn-sm" onClick={() => setForm({ name: v.name })}>
                  Override
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <ul className="env-list">
        {vars.map((v) => (
          <li key={v.name}>
            <span className="env-name">{v.name}</span>
            {v.source.kind === 'plain' ? (
              <span className="env-value plain">{v.source.value}</span>
            ) : (
              <span className="env-value" title="The value is not shown">
                ••••••••
              </span>
            )}
            <span className="env-src">{describeSource(v.source)}</span>
            <span className="env-actions">
              <button className="btn-sm" onClick={() => setForm({ existing: v })}>
                {v.source.kind === 'plain' ? 'Edit' : 'Replace'}
              </button>
              <button className="btn-sm danger" onClick={() => remove(v)}>
                Delete
              </button>
            </span>
          </li>
        ))}
        {vars.length === 0 && !form && <li className="empty">No variables of its own.</li>}
      </ul>
      {error && <p className="error small">{error}</p>}
      {form ? (
        <EnvForm scope={scope} existing={form.existing} initialName={form.name} onDone={done} onCancel={() => setForm(null)} />
      ) : (
        <button onClick={() => setForm({})}>
          <span className="plus">+</span> Add variable
        </button>
      )}
    </div>
  )
}
