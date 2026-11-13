//! Bounded parallelism for network transfers.
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Mutex,
    },
    thread,
};

use crate::error::Result;

/// Simultaneous transfers. A handful of connections removes most of the
/// per-request latency without straining the storage service or a phone.
pub(crate) const WORKERS: usize = 4;

/// Runs `work` for every item on up to `workers` threads.
///
/// `on_done` runs on the calling thread as each item finishes, in completion
/// order, so it may use state that is not shareable between threads (the
/// database, the progress callback). After the first failure no further items
/// are started; transfers already in flight finish, their results are
/// discarded, and the first error is returned.
pub(crate) fn for_each_parallel<T, R>(
    items: Vec<T>,
    workers: usize,
    work: impl Fn(&T) -> Result<R> + Sync,
    mut on_done: impl FnMut(T, R) -> Result<()>,
) -> Result<()>
where
    T: Send,
    R: Send,
{
    if items.is_empty() {
        return Ok(());
    }
    let workers = workers.clamp(1, items.len());
    let queue = Mutex::new(items.into_iter());
    let stop = AtomicBool::new(false);
    let (sender, receiver) = mpsc::channel::<(T, Result<R>)>();
    let mut first_error = None;
    thread::scope(|scope| {
        for _ in 0..workers {
            let sender = sender.clone();
            let (queue, stop, work) = (&queue, &stop, &work);
            scope.spawn(move || loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let next = queue.lock().expect("transfer queue poisoned").next();
                let Some(item) = next else {
                    break;
                };
                let result = work(&item);
                if sender.send((item, result)).is_err() {
                    break;
                }
            });
        }
        drop(sender);
        for (item, result) in receiver {
            if first_error.is_some() {
                continue;
            }
            if let Err(error) = result.and_then(|value| on_done(item, value)) {
                stop.store(true, Ordering::Relaxed);
                first_error = Some(error);
            }
        }
    });
    first_error.map_or(Ok(()), Err)
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::AtomicUsize;

    use super::*;
    use crate::error::BeverError;

    #[test]
    fn every_item_is_processed_once_and_finished_on_the_calling_thread() {
        let caller = thread::current().id();
        let mut finished = Vec::new();
        for_each_parallel(
            (0..50).collect::<Vec<u32>>(),
            WORKERS,
            |item| Ok(item * 2),
            |item, doubled| {
                assert_eq!(thread::current().id(), caller);
                finished.push((item, doubled));
                Ok(())
            },
        )
        .unwrap();
        finished.sort_unstable();
        assert_eq!(
            finished,
            (0..50).map(|item| (item, item * 2)).collect::<Vec<_>>()
        );
    }

    #[test]
    fn the_first_failure_stops_new_work_and_is_returned() {
        let started = AtomicUsize::new(0);
        let result = for_each_parallel(
            (0..200).collect::<Vec<u32>>(),
            2,
            |item| {
                started.fetch_add(1, Ordering::SeqCst);
                // Like a real transfer, each item takes a moment, so the
                // failure is noticed long before the queue could run dry.
                thread::sleep(std::time::Duration::from_millis(5));
                if *item == 3 {
                    Err(BeverError::Network("lost".into()))
                } else {
                    Ok(())
                }
            },
            |_, ()| Ok(()),
        );
        assert!(matches!(result, Err(BeverError::Network(_))));
        let started = started.load(Ordering::SeqCst);
        assert!(
            started < 100,
            "{started} transfers were started after a failure"
        );
    }

    #[test]
    fn a_failure_while_recording_a_result_is_returned_too() {
        let result = for_each_parallel(
            vec![1, 2, 3],
            2,
            |_| Ok(()),
            |_, ()| Err(BeverError::Invalid("cannot record".into())),
        );
        assert!(matches!(result, Err(BeverError::Invalid(_))));
        assert!(for_each_parallel(Vec::<u8>::new(), 4, |_| Ok(()), |_, ()| Ok(())).is_ok());
    }
}
