//! What the application works with, from the moment it starts.
//!
//! Tauri makes the window before it runs the application's set-up, and the
//! library is opened in set-up. On a desktop the window's page cannot load
//! meanwhile: the thread that would serve it is the one in set-up. On
//! Android the page is served by other threads, so its first command can
//! arrive while the library is still being opened. Asking Tauri for state
//! that is not there yet is a panic, and a panic ends the application; that
//! is how the first start after the device was restarted, when nothing is in
//! memory yet and opening takes longest, ended as soon as the page was up.
//!
//! So the state is kept here, in a place that exists before any window does,
//! and whoever asks for it before it is there waits for it.
use std::{
    sync::{Condvar, Mutex, OnceLock, PoisonError},
    time::Instant,
};

pub(crate) struct Startup<T> {
    value: OnceLock<T>,
    opened: Mutex<bool>,
    changed: Condvar,
}

impl<T> Default for Startup<T> {
    fn default() -> Self {
        Self {
            value: OnceLock::new(),
            opened: Mutex::new(false),
            changed: Condvar::new(),
        }
    }
}

impl<T> Startup<T> {
    /// Gives what set-up has made to everyone who asks, now or later. Only
    /// the first call counts.
    pub(crate) fn open(&self, value: T) {
        let _ = self.value.set(value);
        *self.opened.lock().unwrap_or_else(PoisonError::into_inner) = true;
        self.changed.notify_all();
    }

    /// What set-up made, waiting for it when set-up has not come that far.
    ///
    /// Set-up that fails ends the application, so nobody waits for good.
    /// Set-up itself must not ask before it has called [`Startup::open`].
    pub(crate) fn wait(&self) -> &T {
        if let Some(value) = self.value.get() {
            return value;
        }
        let asked = Instant::now();
        let mut opened = self.opened.lock().unwrap_or_else(PoisonError::into_inner);
        while !*opened {
            opened = self
                .changed
                .wait(opened)
                .unwrap_or_else(PoisonError::into_inner);
        }
        drop(opened);
        // Said in the device's log (Android: `adb logcat -s RustStdoutStderr`),
        // so that it can be seen how often a start is one of these.
        eprintln!(
            "Bever: a request came before the library was open and waited {} ms for it",
            asked.elapsed().as_millis()
        );
        self.value.get().expect("opened with a value")
    }
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            Arc,
        },
        thread,
        time::Duration,
    };

    use super::Startup;

    #[test]
    fn whoever_asks_before_set_up_is_done_waits_for_it() {
        let startup = Arc::new(Startup::<String>::default());
        let answered = Arc::new(AtomicUsize::new(0));
        let asking: Vec<_> = (0..4)
            .map(|_| {
                let (startup, answered) = (Arc::clone(&startup), Arc::clone(&answered));
                thread::spawn(move || {
                    let value = startup.wait().clone();
                    answered.fetch_add(1, Ordering::SeqCst);
                    value
                })
            })
            .collect();

        // Set-up takes its time; nobody is answered meanwhile.
        thread::sleep(Duration::from_millis(150));
        assert_eq!(answered.load(Ordering::SeqCst), 0);

        startup.open("the library".to_owned());
        for thread in asking {
            assert_eq!(thread.join().unwrap(), "the library");
        }
        assert_eq!(answered.load(Ordering::SeqCst), 4);
    }

    #[test]
    fn once_set_up_is_done_nobody_waits_and_it_is_not_done_again() {
        let startup = Startup::<u32>::default();
        startup.open(1);
        startup.open(2);
        assert_eq!(*startup.wait(), 1);
        assert_eq!(*startup.wait(), 1);
    }
}
