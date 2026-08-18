import type { TestContext } from "node:test";
import type { TestRendererSetup } from "@opentui/core/testing";
import { testRender } from "@opentui/react/test-utils";
import { act, type ReactNode } from "react";

/** Point the in-process TUI at a sandbox home, and put it back after. */
export function homed(t: TestContext, home: string): void {
  const prior = process.env["PENGUIN_HOME"];
  process.env["PENGUIN_HOME"] = home;
  t.after(() => {
    if (prior === undefined) delete process.env["PENGUIN_HOME"];
    else process.env["PENGUIN_HOME"] = prior;
  });
}

export async function screen(node: ReactNode, width = 100, height = 24): Promise<TestRendererSetup> {
  const setup = await testRender(node, { width, height });
  await setup.flush();
  return setup;
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
