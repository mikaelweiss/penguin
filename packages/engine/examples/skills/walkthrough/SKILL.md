---
name: walkthrough
description: Writes the steps a person follows to see one change working: where to open it, what to do there, what to expect. Use when a change is built and a person is about to try it by hand.
---

# Walk the person to the change

A person is about to try this change without reading its code. Tell them where to go, what to do, and what they should see. The input holds what the change is for and the diff it made.

Read only. No edit, no commit, no server started, no gate run: penguin ran the gates already, and the person is the one who tries it.

## 1. Find the spot

Read the diff, then the code that puts it on screen: the route or navigation that reaches the changed view, the screen that renders it, the entry point that mounts it. Read until you can name the exact screen and how the app gets there.

## 2. Find how the app runs here

Read what the repository says about running it, in one batch: `package.json` scripts, the README, `AGENTS.md`, `CLAUDE.md`, compose files, `.env` examples, an Xcode scheme, a Tauri or Electron config. Take the local origin and the start command from there. Never guess a port.

Test accounts, seeded records, and known ids live in the same places, or in seed scripts and fixtures. Use them: a URL with a real id beats one with a placeholder, and a named login beats "sign in".

## 3. Say where to go

`open` is the one line that lands the person on the spot.

- A web app: one full URL to paste into a browser, origin and path, with real ids where the route needs them. When no id can be known, say in words how to reach the page from the one before it.
- An iOS, Android, or desktop app: the app or scheme to launch, the simulator or device when it matters, then the taps or clicks from launch to the screen.
- A CLI, script, library, or API: the one command to run, or the one request to send, from the repository root.

When the app needs a login first, name the account in `open`.

## 4. Say what to do and what to expect

`steps` are the actions on that screen, one per entry, in order, naming buttons, fields, tabs, and menus exactly as the screen shows them. Leave the list empty when arriving on the spot is enough.

`expect` says what is different now: what appears, what moves, what the app does that it did not before. Say what it looked like before when the difference is small. When the change could have broken something visible nearby, name the one thing to check still works. When the change has no screen, say what the command prints or the request returns.

## What never goes in

No file paths, class names, selectors, component names, or CSS. No lint, test, or build commands. No git. The person reads a screen, not a tree, and everything a machine can check has been checked.

Keep it short. One line to open, up to seven steps, a few lines to expect.
