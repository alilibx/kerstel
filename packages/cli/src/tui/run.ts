import { formatReference } from "../reference";
import type { Theme } from "../ui/theme";
import { initialState, update, type Effect, type Event, type State } from "./app";
import type { UiData } from "./data";
import type { Frame } from "./frame";
import { KeyParser } from "./keys";
import { render } from "./render";
import type { Terminal } from "./terminal";

/**
 * The loop: terminal bytes become events, `update` returns the next state and
 * effects, effects run against the data, and each event redraws one frame.
 * An idle UI writes nothing. Resolves on quit; rejects, after restoring the
 * terminal, when a renderer or the reducer throws.
 */

/** A full redraw: cursor home, every row cleared to its end, nothing below. */
export function frameText(frame: Frame): string {
  return `\x1b[H${frame.map((row) => `${row}\x1b[K`).join("\r\n")}\x1b[J`;
}

/** One effect against the data, as the event it produces. */
export function runEffect(effect: Effect, data: UiData): Event {
  const reference = (ref: { scope: string; key: string }) => formatReference(ref.scope, ref.key);
  switch (effect.type) {
    case "reload":
      return { type: "loaded", ...data.load() };
    case "reveal":
      return { type: "revealed", id: effect.id, reference: reference(effect.ref), value: data.reveal(effect.ref) };
    case "store":
      if (!data.store(effect.ref, effect.value, effect.replace)) return { type: "conflict", reference: reference(effect.ref) };
      return { type: "stored", reference: reference(effect.ref) };
    case "remove":
      return { type: "removed", reference: reference(effect.ref), existed: data.remove(effect.ref) };
  }
}

export async function runUi(terminal: Terminal, data: UiData, theme: Theme): Promise<void> {
  let state: State = initialState(terminal.width, terminal.height);
  const parser = new KeyParser();
  terminal.start();
  try {
    await new Promise<void>((resolve, reject) => {
      let finished = false;
      const fail = (error: unknown) => {
        if (finished) return;
        finished = true;
        reject(error);
      };
      const draw = () => terminal.write(frameText(render(state, theme)));
      const apply = (effect: Effect) => {
        // After the frame that says "Loading…" or "Scanning…" is on screen.
        setTimeout(() => {
          if (finished) return;
          // A reveal cancelled by a key that arrived in the same read never
          // decrypts, so it never writes an audit row for a value not shown.
          if (effect.type === "reveal" && state.pendingReveal?.id !== effect.id) return;
          let event: Event;
          try {
            event = runEffect(effect, data);
          } catch (error) {
            // The store's own message: paths and errno text, never a value. Spec §4.7.
            event = { type: "error", message: (error as Error).message };
          }
          dispatch(event);
        }, 0);
      };
      const dispatch = (event: Event) => {
        if (finished) return;
        try {
          const result = update(state, event);
          state = result.state;
          if (state.quit) {
            finished = true;
            resolve();
            return;
          }
          draw();
          for (const effect of result.effects) apply(effect);
        } catch (error) {
          fail(error);
        }
      };
      terminal.onData((chunk) => {
        for (const input of parser.feed(chunk)) {
          dispatch(input.kind === "paste" ? { type: "paste", text: input.text } : { type: "key", key: input });
        }
      });
      terminal.onResize(() => dispatch({ type: "resize", width: terminal.width, height: terminal.height }));
      try {
        draw();
      } catch (error) {
        fail(error);
        return;
      }
      apply({ type: "reload" });
    });
  } finally {
    terminal.restore();
  }
}
