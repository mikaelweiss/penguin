import type { TestContext } from "node:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";

/** Point the in-process TUI at a sandbox home, and put it back after. */
export function homed(t: TestContext, box: { home: string; state: string }): void {
  set(t, "PENGUIN_HOME", box.home);
  set(t, "XDG_STATE_HOME", box.state);
}

function set(t: TestContext, name: string, value: string): void {
  const prior = process.env[name];
  process.env[name] = value;
  t.after(() => {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  });
}

export async function screen(node: ReactNode, width = 100, height = 24): Promise<TestRendererSetup> {
  const setup = await testRender(node, { width, height });
  await setup.flush();
  return setup;
}

/**
 * The first frame the predicate takes. `waitForFrame` stops as soon as the renderer is idle,
 * and a markdown block parses off the render loop and draws after that.
 */
export async function frameWith(
  setup: TestRendererSetup,
  predicate: (frame: string) => boolean,
  timeoutMs = 30_000,
): Promise<string> {
  const started = Date.now();
  for (;;) {
    const frame = setup.captureCharFrame();
    if (predicate(frame)) return frame;
    if (Date.now() - started > timeoutMs) throw new Error(`no frame took the predicate:\n${frame}`);
    await act(async () => {
      await new Promise((done) => setTimeout(done, 20));
    });
    await setup.flush();
  }
}

export async function press(setup: TestRendererSetup, keys: string[]): Promise<void> {
  for (const key of keys) {
    await act(async () => {
      setup.mockInput.pressKey(key);
    });
  }
  await setup.flush();
}

export async function typeText(setup: TestRendererSetup, text: string): Promise<void> {
  await act(async () => {
    await setup.mockInput.typeText(text);
  });
  await setup.flush();
}

export async function paste(setup: TestRendererSetup, text: string): Promise<void> {
  await act(async () => {
    await setup.mockInput.pasteBracketedText(text);
  });
  await setup.flush();
}
