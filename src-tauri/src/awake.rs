//! Asking the computer to stay awake while a synchronization runs.
//!
//! A first synchronization of a large library is hours of work with nobody
//! at the keyboard, and a computer left alone goes to sleep after the time
//! its owner set. The run would stop with it, and go on only when someone
//! woke the computer. While a run is going, Windows is told that the system
//! is needed; the screen turns off as it otherwise would.
//!
//! It is a request. Windows grants it on mains power, and on battery only
//! for as long as its own rules for standby allow. A run that is cut off by
//! sleep all the same loses nothing: its requests are made again when the
//! connection is back, and what a run does not finish the next one does.
//!
//! Android keeps a run alive with its foreground service; other systems are
//! left as they are.
use std::marker::PhantomData;

/// Holds the request for as long as it lives. It belongs to the thread that
/// made it, which is where the request is taken back.
pub(crate) struct Awake(PhantomData<*const ()>);

impl Awake {
    pub(crate) fn hold() -> Self {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Power::{
                SetThreadExecutionState, ES_CONTINUOUS, ES_SYSTEM_REQUIRED,
            };
            // SAFETY: takes flags only, and concerns this thread alone.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED) };
        }
        Self(PhantomData)
    }
}

impl Drop for Awake {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            use windows_sys::Win32::System::Power::{SetThreadExecutionState, ES_CONTINUOUS};
            // SAFETY: as above.
            unsafe { SetThreadExecutionState(ES_CONTINUOUS) };
        }
    }
}

#[cfg(all(test, windows))]
mod tests {
    use windows_sys::Win32::System::Power::{
        CallNtPowerInformation, SystemExecutionState, ES_SYSTEM_REQUIRED,
    };

    use super::Awake;

    /// What the system as a whole is asked to stay awake for, by anyone.
    fn asked_of_the_system() -> u32 {
        let mut state = 0_u32;
        // SAFETY: the buffer is the four bytes this level writes.
        let status = unsafe {
            CallNtPowerInformation(
                SystemExecutionState,
                std::ptr::null(),
                0,
                std::ptr::from_mut(&mut state).cast(),
                size_of::<u32>() as u32,
            )
        };
        assert_eq!(status, 0, "the system would not say");
        state
    }

    #[test]
    fn the_system_is_asked_to_stay_awake_while_the_request_is_held() {
        let awake = Awake::hold();
        assert_ne!(
            asked_of_the_system() & ES_SYSTEM_REQUIRED,
            0,
            "Windows does not know of the request"
        );
        drop(awake);
        // Another program may be asking the same, so that the system is
        // still needed says nothing; that this thread can ask again does.
        let again = Awake::hold();
        assert_ne!(asked_of_the_system() & ES_SYSTEM_REQUIRED, 0);
        drop(again);
    }
}
