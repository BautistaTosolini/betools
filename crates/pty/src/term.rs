//! Núcleo común de PtyManager y ShellManager: procesos en un pty, scrollback y ciclo de vida.
//! Las devoluciones de llamada (datos, salida) se invocan siempre fuera del candado.

use crate::decoder::Utf8Decoder;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

pub(crate) fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Salida guardada con tope en unidades UTF-16 (como `string.length` en JS), quedándose con el final.
pub(crate) struct Scrollback {
    text: String,
    units: usize,
    limit: usize,
}

impl Scrollback {
    fn new(limit: usize) -> Self {
        Self { text: String::new(), units: 0, limit }
    }

    fn push(&mut self, s: &str) {
        self.text.push_str(s);
        self.units += s.encode_utf16().count();
        if self.units <= self.limit {
            return;
        }
        let mut excess = self.units - self.limit;
        let mut cut = 0;
        for c in self.text.chars() {
            if excess == 0 {
                break;
            }
            let n = c.len_utf16();
            cut += c.len_utf8();
            excess = excess.saturating_sub(n);
            self.units -= n;
        }
        self.text.drain(..cut);
    }
}

/// Proceso vivo en un pty. Cada pieza tiene su propio candado para que una escritura bloqueada
/// no frene la lectura de salida.
pub(crate) struct Proc {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    size: Mutex<(u16, u16)>,
}

impl Proc {
    pub fn write(&self, data: &str) {
        let mut w = lock(&self.writer);
        let _ = w.write_all(data.as_bytes()).and_then(|_| w.flush());
    }

    pub fn resize(&self, cols: u16, rows: u16) {
        let r = lock(&self.master).resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 });
        if r.is_ok() {
            *lock(&self.size) = (cols, rows);
        }
    }

    pub fn size(&self) -> (u16, u16) {
        *lock(&self.size)
    }

    fn kill(&self) {
        let _ = lock(&self.killer).kill();
    }
}

pub(crate) struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
    pub env: HashMap<String, String>,
    pub cols: u16,
    pub rows: u16,
}

struct Entry {
    token: u64,
    proc: Arc<Proc>,
    buffer: Scrollback,
    // Hace atómicos "guardar en el scrollback + emitir" frente a `attach`: en Node ambas cosas ocurrían
    // en el mismo turno del event loop, acá corren en hilos distintos y sin esto un bloque podía
    // llegar dos veces (en el scrollback devuelto y como salida nueva).
    order: Arc<Mutex<()>>,
}

pub(crate) struct Pending<Q> {
    pub cols: u16,
    pub rows: u16,
    pub extra: Q,
}

struct Inner<Q> {
    entries: HashMap<String, Entry>,
    starting: HashMap<String, Pending<Q>>,
    next_token: u64,
}

pub(crate) enum Attached {
    /// Ya corre: lo acumulado para redibujar.
    Buffer(String),
    /// Está resolviendo variables: solo se actualizó el tamaño.
    Starting,
    /// La comprobación previa lo rechazó.
    Rejected,
    /// Quedó registrado como "arrancando": el llamador debe lanzar `finish_start`.
    Begun,
}

pub(crate) type DataFn = dyn Fn(&str, &str) + Send + Sync;
pub(crate) type ExitFn = dyn Fn(&str, i32) + Send + Sync;

pub(crate) struct Core<Q> {
    inner: Mutex<Inner<Q>>,
    limit: usize,
    on_data: Box<DataFn>,
    on_exit: Box<ExitFn>,
}

impl<Q: Send + 'static> Core<Q> {
    pub fn new(limit: usize, on_data: Box<DataFn>, on_exit: Box<ExitFn>) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner { entries: HashMap::new(), starting: HashMap::new(), next_token: 0 }),
            limit,
            on_data,
            on_exit,
        })
    }

    pub fn emit_data(&self, key: &str, data: &str) {
        (self.on_data)(key, data);
    }

    pub fn emit_exit(&self, key: &str, code: i32) {
        (self.on_exit)(key, code);
    }

    pub fn is_running(&self, key: &str) -> bool {
        lock(&self.inner).entries.contains_key(key)
    }

    pub fn is_starting(&self, key: &str) -> bool {
        lock(&self.inner).starting.contains_key(key)
    }

    pub fn proc(&self, key: &str) -> Option<Arc<Proc>> {
        lock(&self.inner).entries.get(key).map(|e| e.proc.clone())
    }

    pub fn size(&self, key: &str) -> Option<(u16, u16)> {
        self.proc(key).map(|p| p.size())
    }

    /// Reengancha a un proceso vivo (redimensiona y devuelve el scrollback) o registra el arranque.
    /// `deliver` recibe el scrollback de un proceso vivo mientras ninguna salida nueva puede emitirse:
    /// lo que entregue llega al destino antes que cualquier bloque posterior.
    pub fn attach(&self, key: &str, cols: u16, rows: u16, extra: Q, precheck: impl FnOnce() -> bool, deliver: impl FnOnce(&str)) -> Attached {
        let mut g = loop {
            let order = lock(&self.inner).entries.get(key).map(|e| e.order.clone());
            if let Some(order) = order {
                let _o = lock(&order);
                let g = lock(&self.inner);
                // Si el proceso murió entre medio, se vuelve a evaluar.
                if let Some(e) = g.entries.get(key).filter(|e| Arc::ptr_eq(&e.order, &order)) {
                    e.proc.resize(cols, rows);
                    let text = e.buffer.text.clone();
                    drop(g);
                    deliver(&text);
                    return Attached::Buffer(text);
                }
                continue;
            }
            let g = lock(&self.inner);
            // Pudo arrancar justo ahora: se vuelve a evaluar con su candado de orden.
            if !g.entries.contains_key(key) {
                break g;
            }
        };
        if let Some(p) = g.starting.get_mut(key) {
            p.cols = cols;
            p.rows = rows;
            return Attached::Starting;
        }
        if !precheck() {
            return Attached::Rejected;
        }
        g.starting.insert(key.to_string(), Pending { cols, rows, extra });
        Attached::Begun
    }

    pub fn update_pending(&self, key: &str, f: impl FnOnce(&mut Pending<Q>)) -> bool {
        match lock(&self.inner).starting.get_mut(key) {
            Some(p) => {
                f(p);
                true
            }
            None => false,
        }
    }

    /// Cierra la fase "arrancando" y lanza el proceso, todo bajo el mismo candado: un `kill`
    /// concurrente o lo cancela antes (None) o mata el proceso ya registrado.
    /// `build` corre con el candado tomado y no debe llamar al manager.
    pub fn finish_start<R>(
        self: &Arc<Self>,
        key: &str,
        build: impl FnOnce(u16, u16, Q) -> (SpawnSpec, R),
    ) -> Option<Result<(Arc<Proc>, R), String>> {
        let mut g = lock(&self.inner);
        let pending = g.starting.remove(key)?;
        let (spec, extra) = build(pending.cols, pending.rows, pending.extra);
        g.next_token += 1;
        let token = g.next_token;
        let key_owned = key.to_string();
        let order = Arc::new(Mutex::new(()));
        let order_data = order.clone();
        let core = self.clone();
        let core_exit = self.clone();
        let key_exit = key_owned.clone();
        let spawned = spawn(
            spec,
            move |data| {
                let _o = lock(&order_data);
                // La entrada ya no es esta (se mató a propósito): se descarta.
                {
                    let mut g = lock(&core.inner);
                    match g.entries.get_mut(&key_owned) {
                        Some(e) if e.token == token => e.buffer.push(data),
                        _ => return,
                    }
                }
                core.emit_data(&key_owned, data);
            },
            move |code| {
                {
                    let mut g = lock(&core_exit.inner);
                    match g.entries.get(&key_exit) {
                        Some(e) if e.token == token => {
                            g.entries.remove(&key_exit);
                        }
                        _ => return,
                    }
                }
                core_exit.emit_exit(&key_exit, code);
            },
        );
        Some(match spawned {
            Ok(proc) => {
                g.entries.insert(key.to_string(), Entry { token, proc: proc.clone(), buffer: Scrollback::new(self.limit), order });
                Ok((proc, extra))
            }
            Err(e) => Err(e),
        })
    }

    pub fn kill(&self, key: &str) {
        let entry = {
            let mut g = lock(&self.inner);
            g.starting.remove(key);
            g.entries.remove(key)
        };
        if let Some(e) = entry {
            e.proc.kill();
        }
    }

    pub fn kill_all(&self) {
        let keys: Vec<String> = lock(&self.inner).entries.keys().cloned().collect();
        for k in keys {
            self.kill(&k);
        }
    }
}

fn spawn(
    spec: SpawnSpec,
    mut on_data: impl FnMut(&str) + Send + 'static,
    on_exit: impl FnOnce(i32) + Send + 'static,
) -> Result<Arc<Proc>, String> {
    let pair = native_pty_system()
        .openpty(PtySize { rows: spec.rows, cols: spec.cols, pixel_width: 0, pixel_height: 0 })
        .map_err(|e| e.to_string())?;
    let mut cmd = CommandBuilder::new(&spec.program);
    cmd.args(&spec.args);
    if let Some(cwd) = &spec.cwd {
        cmd.cwd(cwd);
    }
    // Entorno exacto: lo que no se pasa no se hereda.
    cmd.env_clear();
    for (k, v) in &spec.env {
        cmd.env(k, v);
    }
    let mut child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // Sin el extremo esclavo abierto acá, la lectura recibe EOF cuando el hijo termina.
    drop(pair.slave);
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let proc = Arc::new(Proc {
        killer: Mutex::new(child.clone_killer()),
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        size: Mutex::new((spec.cols, spec.rows)),
    });

    let (done_tx, done_rx) = mpsc::channel::<()>();
    std::thread::spawn(move || {
        let mut dec = Utf8Decoder::default();
        let mut buf = [0u8; 16 * 1024];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let s = dec.push(&buf[..n]);
                    if !s.is_empty() {
                        on_data(&s);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                // EIO en Linux: el hijo cerró el pty.
                Err(_) => break,
            }
        }
        let rest = dec.finish();
        if !rest.is_empty() {
            on_data(&rest);
        }
        let _ = done_tx.send(());
    });
    std::thread::spawn(move || {
        let code = match child.wait() {
            // node-pty informa 0 cuando el proceso murió por una señal.
            Ok(st) if st.signal().is_some() => 0,
            Ok(st) => st.exit_code() as i32,
            Err(_) => 1,
        };
        // Deja drenar la salida pendiente antes de avisar; si un nieto retiene el pty no se espera para siempre.
        let _ = done_rx.recv_timeout(Duration::from_millis(500));
        on_exit(code);
    });
    Ok(proc)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scrollback_keeps_the_tail_by_utf16_units() {
        let mut s = Scrollback::new(5);
        s.push("abc");
        s.push("defg");
        assert_eq!(s.text, "cdefg");
        s.push("😀"); // 2 unidades
        assert_eq!(s.text, "efg😀");
        s.push("😀😀");
        assert_eq!(s.text, "😀😀");
        assert_eq!(s.units, 4);
    }

    #[test]
    fn scrollback_drops_whole_char_when_cut_splits_a_pair() {
        let mut s = Scrollback::new(3);
        s.push("a😀b"); // 4 unidades, excede en 1: corta "a"
        assert_eq!(s.text, "😀b");
        s.push("c"); // 4 > 3: corta el par entero
        assert_eq!(s.text, "bc");
    }
}
