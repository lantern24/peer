use block2::RcBlock;
use objc2::{rc::Retained, runtime::AnyObject, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSEvent, NSEventMask, NSWindow};
use std::ptr::NonNull;
use tauri::{AppHandle, Emitter, Manager};

pub(crate) struct Monitor {
    token: Retained<AnyObject>,
    // Installation, callbacks and removal all belong to AppKit's main thread.
    _main_thread: MainThreadMarker,
}

fn main_window_number(app: &AppHandle, _mtm: MainThreadMarker) -> Result<isize, String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    let native = window.ns_window().map_err(|error| error.to_string())?;
    // SAFETY: Tauri supplies its live NSWindow; the caller is on the main thread
    // and only borrows it for this call while the WebviewWindow is alive.
    Ok(unsafe { &*native.cast::<NSWindow>() }.windowNumber())
}

fn swipe_direction(x: f64, y: f64) -> Option<&'static str> {
    if x > 0.0 && x.abs() > y.abs() {
        Some("back")
    } else if x < 0.0 && x.abs() > y.abs() {
        Some("forward")
    } else {
        None
    }
}

impl Monitor {
    pub(crate) fn install(app: &AppHandle) -> Result<Self, String> {
        let mtm = MainThreadMarker::new().ok_or("Gesture monitor requires the main thread")?;
        let window_number = main_window_number(app, mtm)?;
        let native_app = NSApplication::sharedApplication(mtm);
        let app = app.clone();
        let handler = RcBlock::new(move |event: NonNull<NSEvent>| {
            // SAFETY: AppKit keeps the event alive during this local-monitor callback.
            let swipe = unsafe { event.as_ref() };
            // Local monitors receive only events delivered to this application.
            // Prefer the event's target; drivers may omit it, including during
            // activation when AppKit has not established a key window yet.
            let target = match swipe.windowNumber() {
                0 => native_app
                    .keyWindow()
                    .map(|window| window.windowNumber())
                    .unwrap_or(window_number),
                target => target,
            };
            if target != window_number {
                return event.as_ptr();
            }
            let Some(direction) = swipe_direction(swipe.deltaX(), swipe.deltaY()) else {
                return event.as_ptr();
            };
            // Logi Options+ Back/Forward sends NSEventTypeSwipe, not a DOM mouse
            // button. Consume it here so WebKit cannot also traverse document history.
            if let Err(error) = app.emit_to("main", "navigation-swipe", direction) {
                eprintln!("Unable to dispatch native history gesture: {error}");
                return event.as_ptr();
            }
            std::ptr::null_mut()
        });
        // SAFETY: The callback returns only the original live event or null. AppKit
        // copies the block and calls it on the main thread until removeMonitor.
        let token = unsafe {
            NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::Swipe, &handler)
        }
        .ok_or("AppKit could not install the history gesture monitor")?;
        Ok(Self {
            token,
            _main_thread: mtm,
        })
    }
}

impl Drop for Monitor {
    fn drop(&mut self) {
        // SAFETY: This is the token returned by addLocalMonitor; MainThreadMarker
        // prevents moving the owner off the main thread. Removal occurs once on exit.
        unsafe { NSEvent::removeMonitor(&self.token) };
    }
}

#[cfg(feature = "desktop-tests")]
mod test_input {
    use super::*;
    use objc2::{define_class, msg_send, runtime::NSObjectProtocol, DefinedClass, MainThreadOnly};
    use objc2_app_kit::{NSEventModifierFlags, NSEventType};

    pub(super) struct Swipe {
        pub x: f64,
        pub window_number: isize,
    }

    define_class!(
        // SAFETY: NSEvent permits subclassing; the overridden getters have the
        // AppKit signatures. This test event owns its data and implements no Drop.
        #[unsafe(super(NSEvent))]
        #[thread_kind = MainThreadOnly]
        #[ivars = Swipe]
        struct PeerTestSwipeEvent;

        unsafe impl NSObjectProtocol for PeerTestSwipeEvent {}

        impl PeerTestSwipeEvent {
            #[unsafe(method(type))]
            fn event_type(&self) -> NSEventType { NSEventType::Swipe }
            #[unsafe(method(modifierFlags))]
            fn modifier_flags(&self) -> NSEventModifierFlags { NSEventModifierFlags::empty() }
            #[unsafe(method(deltaX))]
            fn delta_x(&self) -> f64 { self.ivars().x }
            #[unsafe(method(deltaY))]
            fn delta_y(&self) -> f64 { 0.0 }
            #[unsafe(method(windowNumber))]
            fn window_number(&self) -> isize { self.ivars().window_number }
        }
    );

    pub(super) fn send(mtm: MainThreadMarker, swipe: Swipe) {
        let event = PeerTestSwipeEvent::alloc(mtm).set_ivars(swipe);
        // SAFETY: NSEvent's init initializes this allocated NSEvent subclass.
        let event: Retained<PeerTestSwipeEvent> = unsafe { msg_send![super(event), init] };
        // Exercise NSApplication's actual local-monitor dispatch without requiring
        // OS-wide Accessibility permission or emitting the frontend event directly.
        // Only inject horizontal gestures consumed by the monitor. A subclassed
        // NSEvent has no OS backing event for AppKit's default swipe responder.
        NSApplication::sharedApplication(mtm).sendEvent(&event);
    }
}

#[cfg(feature = "desktop-tests")]
#[tauri::command]
pub(crate) async fn test_swipe(app: AppHandle, back: bool, windowless: bool) -> Result<(), String> {
    let (sender, receiver) = tokio::sync::oneshot::channel();
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| {
            let mtm = MainThreadMarker::new().ok_or("Swipe injection requires the main thread")?;
            let window_number = if windowless {
                0
            } else {
                main_window_number(&handle, mtm)?
            };
            test_input::send(
                mtm,
                test_input::Swipe {
                    x: if back { 1.0 } else { -1.0 },
                    window_number,
                },
            );
            Ok(())
        })();
        let _ = sender.send(result);
    })
    .map_err(|error| error.to_string())?;
    receiver.await.map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::swipe_direction;

    #[test]
    fn recognizes_only_predominantly_horizontal_swipes() {
        assert_eq!(swipe_direction(1.0, 0.0), Some("back"));
        assert_eq!(swipe_direction(-1.0, 0.0), Some("forward"));
        assert_eq!(swipe_direction(1.0, -0.5), Some("back"));
        assert_eq!(swipe_direction(-1.0, 0.5), Some("forward"));
        for (x, y) in [
            (0.0, 0.0),
            (0.0, 1.0),
            (0.5, -1.0),
            (1.0, 1.0),
            (-1.0, -1.0),
        ] {
            assert_eq!(swipe_direction(x, y), None);
        }
    }
}
