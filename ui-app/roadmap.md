# Roadmap — desktop UI milestones

- [x] Build the small, non-square voice-assistant widget screen for Ubuntu.
- [x] Add the liquid form that reacts to sound, matching the shared reference image.
- [x] Wire up the microphone, the chat, and a side drawer history stored on this device.
- [x] Verify the desktop and narrow-screen layouts.
- [x] Add CPU, RAM, VRAM and wireless-connection indicators on both sides of the
      widget; state explicitly that this is not real system data.
- [x] Verify the indicator layout on narrow screens and the existing chat flow.
- [x] Move the metrics inside the widget, on both sides of the audio form, as in
      the shared reference.
- [x] Rename the assistant to Jarvis in every visible area and verify the narrow
      screen.
- [x] Prepare the Jarvis widget as a source package that runs with Python on
      Ubuntu.
- [x] Verify the package contents and its start-up, and offer the download file.
- [x] Produce three distinct Jarvis visual designs from the new screen reference;
      review the images without adding functional code and present them for
      selection.
- [x] Rebuild the three designs while preserving every application heading, the
      services, the eight audio-lane metrics, the statuses and the event stream
      from the reference, then verify.
- [x] Create three new visual alternatives with the more advanced technological
      command-centre feel, keeping all mandatory fields, and review them visually.
- [x] Turn the white Quantum Glass design into the live page; verify the form that
      reacts to microphone input and the microphone on/off flow.
- [x] Rebuild the Jarvis screen as an Electron (TypeScript + React) desktop
      package; verify with a screenshot that the full interface opens in the
      Electron window, and offer the Ubuntu download file.
- [x] Connect the UI to the real agent over HTTP/SSE and verify on screen: live
      state, the 8-stage telemetry, chat history, the confirmation dialog and the
      Settings model dropdowns.
- [x] Add STT / LLM / TTS selection driven by the models actually present on disk,
      persisted to `~/.config/diji/env`, and verify the switch against a live agent.
