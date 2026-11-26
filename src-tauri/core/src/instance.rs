//! Instancia única por directorio de datos. Dos instancias reanudarían las mismas sesiones y escribirían
//! el mismo transcript; la segunda le pide a la primera que muestre la ventana y sale.
//! Es por userData (como el SingletonLock de Electron), no global: las instancias de prueba con otro
//! `--user-data-dir` conviven con la real.

use std::fs::{File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;
use std::time::{Duration, Instant};

pub enum Instance {
    /// Esta es la instancia que corre; hay que conservar el valor mientras viva la app.
    Primary(Primary),
    /// Ya había otra y se le avisó.
    Secondary,
}

pub struct Primary {
    _lock: File,
    listener: UnixListener,
}

impl Primary {
    /// Llama a `f` cada vez que una segunda instancia intenta arrancar.
    pub fn on_second(self, f: impl Fn() + Send + 'static) -> File {
        let Primary { _lock, listener } = self;
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut conn) = conn else { continue };
                let mut buf = [0u8; 16];
                if matches!(conn.read(&mut buf), Ok(n) if n > 0) {
                    f();
                }
            }
        });
        _lock
    }
}

/// `dir` es el directorio de datos; se crea si no existe.
pub fn acquire(dir: &Path) -> io::Result<Instance> {
    std::fs::create_dir_all(dir)?;
    let lock = OpenOptions::new().create(true).truncate(false).write(true).open(dir.join(".betools.lock"))?;
    let sock = dir.join(".betools.sock");
    if lock.try_lock().is_ok() {
        // Con el candado tomado, un socket que quede es de una ejecución anterior.
        let _ = std::fs::remove_file(&sock);
        let listener = UnixListener::bind(&sock)?;
        return Ok(Instance::Primary(Primary { _lock: lock, listener }));
    }
    // La primera puede estar todavía levantando el socket: se reintenta un momento.
    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match UnixStream::connect(&sock) {
            Ok(mut s) => {
                let _ = s.write_all(b"show\n");
                return Ok(Instance::Secondary);
            }
            Err(e) if Instant::now() >= deadline => return Err(e),
            Err(_) => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    #[test]
    fn second_instance_notifies_first() {
        let dir = tempfile::tempdir().unwrap();
        let Instance::Primary(p) = acquire(dir.path()).unwrap() else { panic!("expected primary") };
        let (tx, rx) = mpsc::channel();
        let _guard = p.on_second(move || tx.send(()).unwrap());
        assert!(matches!(acquire(dir.path()).unwrap(), Instance::Secondary));
        rx.recv_timeout(Duration::from_secs(2)).expect("la primera instancia no recibió el aviso");
    }

    #[test]
    fn other_dir_is_independent() {
        let a = tempfile::tempdir().unwrap();
        let b = tempfile::tempdir().unwrap();
        let ia = acquire(a.path()).unwrap();
        let ib = acquire(b.path()).unwrap();
        assert!(matches!(ia, Instance::Primary(_)));
        assert!(matches!(ib, Instance::Primary(_)));
    }

    #[test]
    fn stale_socket_is_replaced() {
        let dir = tempfile::tempdir().unwrap();
        // Restos de una ejecución anterior: socket sin nadie escuchando y sin candado tomado.
        drop(UnixListener::bind(dir.path().join(".betools.sock")).unwrap());
        assert!(matches!(acquire(dir.path()).unwrap(), Instance::Primary(_)));
    }
}
